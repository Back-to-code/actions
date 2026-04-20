# Back-to-code Actions

Reusable composite actions for self-hosted ARC runners. Tool install + dep setup that leans on **host-mounted download caches** — zero network round-trips to GitHub cloud cache.

## Why custom actions?

CI on self-hosted runners (ARC on k3s, dind mode):
- Persistent host-path volumes for tool-cache, npm, composer, general `.cache`
- tmpfs working dir (RAM-backed, fast I/O)
- Limited network bandwidth

Standard `actions/cache` uploads/downloads to GitHub cloud. We skip entirely — package-manager download caches live on the runner node and persist across ephemeral pods. Install times: minutes → seconds.

## Caching philosophy — download cache, not artifacts

These actions **cache downloads, not build artifacts**. Every job runs a fresh `npm ci` / `composer install` / `pub get`, populated from the warm download cache on the host volume. We do **not** tar `node_modules` / `vendor` / `.dart_tool` and skip install on cache hit.

Rationale (learned the hard way):
- Postinstall scripts run every job → broken postinstalls surface on the PR that introduces them, not N PRs later when the cache finally misses.
- npm workspaces nesting, transitive version conflicts, and similar lockfile quirks can't produce a partial cached tree — there's nothing to go stale.
- A fresh `npm ci` against a warm `~/.npm` is fast (seconds). The tar-restore savings weren't worth the fragility.

**All workflows must use these actions for dep setup.** Never use `actions/cache`, `actions/setup-node` with `cache: 'npm'`, or manual `npm ci`/`composer install`/`pub get` — go through the composite actions so env + cache paths stay consistent.

## Available actions

### setup-node

Installs Node.js, runs `npm ci` against the host-mounted `~/.npm` download cache.

```yaml
- uses: Back-to-code/actions/setup-node@v1
```

| Input | Default | Description |
|-------|---------|-------------|
| `node-version` | `22` | Node.js version |
| `working-directory` | `.` | Directory with `package-lock.json` |

`npm ci` runs every invocation. Fast on warm `~/.npm`.

### setup-php

Switches PHP version, runs `composer install` against the host-mounted `~/.composer/cache` download cache.

```yaml
- uses: Back-to-code/actions/setup-php@v1
  with:
    working-directory: apps/api
```

| Input | Default | Description |
|-------|---------|-------------|
| `php-version` | `8.4` | PHP version (must be in runner image) |
| `working-directory` | `.` | Directory with `composer.json` |
| `composer-flags` | `''` | Extra flags for `composer install` |

PHP versions pre-installed via ondrej/php PPA. Action uses `update-alternatives` to switch — no download. Composer runs w/ `XDEBUG_MODE=off` for speed. `composer install` runs every invocation.

### setup-go

Installs Go, caches module downloads locally.

```yaml
- uses: Back-to-code/actions/setup-go@v1
  with:
    go-version: '1.26'
```

| Input | Default | Description |
|-------|---------|-------------|
| `go-version` | `1.26` | Go version |
| `working-directory` | `.` | Directory with `go.sum` |

Disables built-in `actions/setup-go` cloud cache. Caches `~/go/pkg/mod` via `local-cache` (download cache of immutable module tarballs — safe to tar). Go build cache (`~/.cache/go-build`) persists via runner host-path volume mount. `go mod download` runs on miss.

### setup-dart

Installs Dart SDK, runs `dart pub get` against the host-mounted `~/.pub-cache` download cache.

```yaml
- uses: Back-to-code/actions/setup-dart@v1
```

| Input | Default | Description |
|-------|---------|-------------|
| `sdk` | `stable` | Dart SDK version |
| `working-directory` | `.` | Directory with `pubspec.lock` |

`dart pub get` runs every invocation.

### setup-flutter

Installs Flutter SDK, runs `flutter pub get` against the host-mounted `~/.pub-cache` download cache.

```yaml
- uses: Back-to-code/actions/setup-flutter@v1
  with:
    flutter-version: stable
```

| Input | Default | Description |
|-------|---------|-------------|
| `flutter-version` | `stable` | Flutter version |
| `channel` | `stable` | Channel (stable, beta, master) |
| `working-directory` | `.` | Directory with `pubspec.lock` |

`flutter pub get` runs every invocation.

---

## Writing optimized workflows

### Rule 1: Always use `runs-on: self-hosted`

All CI jobs on self-hosted runners. Never `ubuntu-latest` or GitHub-hosted for CI checks — no cached deps/tools.

Exception: deploy workflows may use `ubuntu-latest` for security (ephemeral, no persistent credentials).

### Rule 2: Set concurrency groups

Every PR workflow **must** cancel in-progress runs on new push:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.head_ref }}
  cancel-in-progress: true
```

Deploy workflows — **never** cancel in-progress, queue instead:

```yaml
concurrency:
  group: deploy-production
  cancel-in-progress: false
```

### Rule 3: Set timeout-minutes on every job

Default timeout 6 hours. Hung job silently burns runner capacity. Set ~2x expected duration:

```yaml
jobs:
  lint:
    timeout-minutes: 10    # Expected: ~5 min
  test:
    timeout-minutes: 15    # Expected: ~8 min
```

### Rule 4: Use path filtering to skip irrelevant jobs

Use `dorny/paths-filter@v3` at job level to skip when files unchanged:

```yaml
jobs:
  changes:
    runs-on: self-hosted
    timeout-minutes: 5
    outputs:
      backend: ${{ steps.filter.outputs.backend }}
      frontend: ${{ steps.filter.outputs.frontend }}
    steps:
      - uses: dorny/paths-filter@v3
        id: filter
        with:
          filters: |
            backend:
              - 'src/api/**'
              - 'go.sum'
            frontend:
              - 'src/web/**'
              - 'package-lock.json'

  lint:
    needs: changes
    if: needs.changes.outputs.frontend == 'true'
    # ...
```

**Never** workflow-level `paths:` triggers — skips entire workflow → required status checks stay "Pending" forever.

### Rule 5: Gate job for required checks

Skipped jobs don't satisfy required checks. Use gate job:

```yaml
jobs:
  # ... all your conditional jobs ...

  ci-passed:
    name: CI Passed
    if: always()
    needs: [lint, test, build]  # List ALL conditional jobs
    runs-on: self-hosted
    timeout-minutes: 5
    steps:
      - if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')
        run: exit 1
```

Branch protection: mark **only** `CI Passed` as required:
- Skipped jobs (path filtering) → gate passes
- Failed jobs → gate fails
- Cancelled jobs → gate fails

**Keep all CI jobs in one workflow file.** Gate jobs only work within single workflow — `needs:` can't cross workflow boundaries. Split into separate files:
- No single gate watching all jobs
- Workflow-level `paths:` filters → skipped workflows → required checks "Pending" forever
- Multiple gate jobs = more required checks to maintain

Use job-level path filtering (`dorny/paths-filter`) inside one workflow + one gate job. Only split for genuinely different triggers (PR checks vs deploy vs scheduled).

### Rule 6: Service containers work in dind mode

Runners support `services:` containers. Docker images layer-cached on runner — repeated pulls near-instant.

```yaml
jobs:
  test:
    runs-on: self-hosted
    services:
      mysql:
        image: mysql:8.0
        env:
          MYSQL_ROOT_PASSWORD: password
          MYSQL_DATABASE: testing
        ports:
          - 3306:3306
        options: >-
          --health-cmd="mysqladmin ping"
          --health-interval=10s
          --health-timeout=5s
          --health-retries=5
          --health-start-period=30s
```

Use `--health-start-period` for MySQL (10-25s init). Redis/PostgreSQL start faster.

### Rule 7: Sparse checkout for monorepos

Job only needs part of repo → sparse checkout:

```yaml
- uses: actions/checkout@v4
  with:
    sparse-checkout: |
      apps/api
      .github
```

### Rule 8: Minimize permissions

Always declare minimum required:

```yaml
permissions:
  contents: read
```

Add more only when needed (e.g., `pull-requests: write` for posting comments).

---

## Complete workflow template

```yaml
name: PR Checks

on:
  pull_request:

permissions:
  contents: read

concurrency:
  group: pr-checks-${{ github.head_ref }}
  cancel-in-progress: true

jobs:
  # ── Detect what changed ────────────────────────────────────────
  changes:
    name: Detect changes
    runs-on: self-hosted
    timeout-minutes: 5
    outputs:
      backend: ${{ steps.filter.outputs.backend }}
      frontend: ${{ steps.filter.outputs.frontend }}
    steps:
      - uses: dorny/paths-filter@v3
        id: filter
        with:
          filters: |
            backend:
              - 'src/api/**'
              - 'composer.lock'
            frontend:
              - 'src/web/**'
              - 'package-lock.json'

  # ── Frontend ───────────────────────────────────────────────────
  lint:
    name: ESLint
    needs: changes
    if: needs.changes.outputs.frontend == 'true'
    runs-on: self-hosted
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: Back-to-code/actions/setup-node@v1
      - run: npm run lint

  typecheck:
    name: Type check
    needs: changes
    if: needs.changes.outputs.frontend == 'true'
    runs-on: self-hosted
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: Back-to-code/actions/setup-node@v1
      - run: npx vue-tsc --noEmit

  test-frontend:
    name: Frontend tests
    needs: changes
    if: needs.changes.outputs.frontend == 'true'
    runs-on: self-hosted
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: Back-to-code/actions/setup-node@v1
      - run: npm run test -- --coverage

  build:
    name: Build
    needs: changes
    if: needs.changes.outputs.frontend == 'true'
    runs-on: self-hosted
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: Back-to-code/actions/setup-node@v1
      - run: npm run build
        env:
          NODE_OPTIONS: '--max-old-space-size=4096'

  # ── Backend ────────────────────────────────────────────────────
  test-backend:
    name: Backend tests
    needs: changes
    if: needs.changes.outputs.backend == 'true'
    runs-on: self-hosted
    timeout-minutes: 15
    services:
      mysql:
        image: mysql:8.0
        env:
          MYSQL_ROOT_PASSWORD: password
          MYSQL_DATABASE: testing
        ports:
          - 3306:3306
        options: >-
          --health-cmd="mysqladmin ping"
          --health-interval=10s
          --health-timeout=5s
          --health-retries=5
          --health-start-period=30s
    steps:
      - uses: actions/checkout@v4
      - uses: Back-to-code/actions/setup-php@v1
      - run: |
          cp .env.example .env
          php artisan key:generate
          php artisan migrate:fresh --force
        env:
          DB_HOST: 127.0.0.1
          DB_DATABASE: testing
          DB_USERNAME: root
          DB_PASSWORD: password
      - run: php vendor/bin/pest
        env:
          DB_HOST: 127.0.0.1
          DB_DATABASE: testing
          DB_USERNAME: root
          DB_PASSWORD: password

  php-style:
    name: PHP style
    needs: changes
    if: needs.changes.outputs.backend == 'true'
    runs-on: self-hosted
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: Back-to-code/actions/setup-php@v1
      - run: composer run pint:ci

  # ── Gate ───────────────────────────────────────────────────────
  ci-passed:
    name: CI Passed
    if: always()
    needs: [lint, typecheck, test-frontend, build, test-backend, php-style]
    runs-on: self-hosted
    timeout-minutes: 5
    steps:
      - if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')
        run: exit 1
```

## Go project template

```yaml
name: PR Checks

on:
  pull_request:

permissions:
  contents: read

concurrency:
  group: pr-checks-${{ github.head_ref }}
  cancel-in-progress: true

jobs:
  lint:
    name: Lint
    runs-on: self-hosted
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: Back-to-code/actions/setup-go@v1
      - uses: golangci/golangci-lint-action@v6
        with:
          version: latest

  test:
    name: Test
    runs-on: self-hosted
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: Back-to-code/actions/setup-go@v1
      - run: go test ./...

  build:
    name: Build
    runs-on: self-hosted
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: Back-to-code/actions/setup-go@v1
      - run: go build ./...

  ci-passed:
    name: CI Passed
    if: always()
    needs: [lint, test, build]
    runs-on: self-hosted
    timeout-minutes: 5
    steps:
      - if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')
        run: exit 1
```

## Dart project template

```yaml
name: PR Checks

on:
  pull_request:

permissions:
  contents: read

concurrency:
  group: pr-checks-${{ github.head_ref }}
  cancel-in-progress: true

jobs:
  analyze:
    name: Analyze
    runs-on: self-hosted
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: Back-to-code/actions/setup-dart@v1
      - run: dart analyze

  test:
    name: Test
    runs-on: self-hosted
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: Back-to-code/actions/setup-dart@v1
      - run: dart test

  ci-passed:
    name: CI Passed
    if: always()
    needs: [analyze, test]
    runs-on: self-hosted
    timeout-minutes: 5
    steps:
      - if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')
        run: exit 1
```

## Flutter project template

```yaml
name: PR Checks

on:
  pull_request:

permissions:
  contents: read

concurrency:
  group: pr-checks-${{ github.head_ref }}
  cancel-in-progress: true

jobs:
  analyze:
    name: Analyze
    runs-on: self-hosted
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: Back-to-code/actions/setup-flutter@v1
      - run: flutter analyze

  test:
    name: Test
    runs-on: self-hosted
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: Back-to-code/actions/setup-flutter@v1
      - run: flutter test

  ci-passed:
    name: CI Passed
    if: always()
    needs: [analyze, test]
    runs-on: self-hosted
    timeout-minutes: 5
    steps:
      - if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')
        run: exit 1
```

---

## Common mistakes

| Mistake | Fix |
|---------|-----|
| `ubuntu-latest` for CI | `self-hosted` — cached deps, faster |
| Missing `concurrency` block | Add w/ `cancel-in-progress: true` |
| No `timeout-minutes` | Set on every job (~2x expected) |
| `actions/cache` | Use our setup actions (local cache) |
| `npm install` | `npm ci` (faster, deterministic) |
| Workflow-level `paths:` filter | `dorny/paths-filter` at job level |
| All jobs as required checks | Gate job pattern (only `CI Passed` required) |
| Missing health check on MySQL | Add `--health-start-period=30s` |
| `composer update` in CI | `composer install` (reads lockfile) |
| Default 90-day artifact retention | Set `retention-days: 3` or lower |

## Cache architecture

```
Host node (/opt/runner-cache/)
├── tool-cache/        → /opt/hostedtoolcache   (Node, Go, Dart, Flutter binaries)
├── npm/               → ~/.npm                  (npm download cache)
├── composer/          → ~/.composer/cache       (Composer download cache)
├── pub-cache/         → ~/.pub-cache            (Dart/Flutter pub download cache)
├── local-cache/       → ~/.cache                (general download caches — go-build, puppeteer, etc.)
└── docker/            → /var/lib/docker         (Docker layer cache for service containers)
```

Single-layer strategy: package-manager **download caches** live on host volumes. Every job installs fresh against a warm download cache.

| Tool | Cache path | Mounted via |
|------|-----------|-------------|
| npm | `~/.npm` | dedicated `npm` volume |
| composer | `~/.composer/cache` | dedicated `composer` volume |
| dart / flutter | `~/.pub-cache` | dedicated `pub-cache` volume |
| go | `~/go/pkg/mod` | via `local-cache` action (download cache — immutable hashed tarballs) |
| puppeteer | `~/.cache/puppeteer` | `.cache` volume (usually unused — set `PUPPETEER_EXECUTABLE_PATH` to system chrome) |

All persist across ephemeral runner pods via host-path volumes. Artifact directories (`node_modules`, `vendor`, `.dart_tool`) are never cached — they're reconstructed every job.
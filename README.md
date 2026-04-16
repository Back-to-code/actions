# Back-to-code Actions

Reusable composite actions for self-hosted ARC runners. Handle tool install + dep caching via **local filesystem cache** — zero network round-trips to GitHub cloud cache.

## Why custom actions?

CI runs on self-hosted runners (ARC on k3s, dind mode):
- Persistent host-path volumes for tool-cache, npm/composer cache, local-cache
- tmpfs working dir (RAM-backed, fast I/O)
- Limited network bandwidth

Standard `actions/cache` uploads/downloads to GitHub cloud. We skip entirely — deps cached locally on runner node. Install times: minutes → seconds.

**All workflows must use these actions for dep setup.** Never use `actions/cache`, `actions/setup-node` with `cache: 'npm'`, or manual `npm ci`/`composer install` without caching.

## Available actions

### setup-node

Installs Node.js, caches `node_modules` locally.

```yaml
- uses: Back-to-code/actions/setup-node@v1
```

| Input | Default | Description |
|-------|---------|-------------|
| `node-version` | `22` | Node.js version |
| `working-directory` | `.` | Directory with `package-lock.json` |

Skips `npm ci` on cache hit. Cache key from `package-lock.json` hash.

### setup-php

Switches PHP version, installs Composer deps with local vendor cache.

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

PHP versions pre-installed via ondrej/php PPA. Action uses `update-alternatives` to switch — no download. Composer runs with `XDEBUG_MODE=off` for speed.

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

Disables built-in `actions/setup-go` cloud cache. Caches `~/go/pkg/mod` locally. Go build cache (`~/.cache/go-build`) persists via runner host-path volume mount.

### setup-dart

Installs Dart SDK, caches pub deps locally.

```yaml
- uses: Back-to-code/actions/setup-dart@v1
```

| Input | Default | Description |
|-------|---------|-------------|
| `sdk` | `stable` | Dart SDK version |
| `working-directory` | `.` | Directory with `pubspec.lock` |

### setup-flutter

Installs Flutter SDK, caches pub deps locally.

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

In branch protection, mark **only** `CI Passed` as required:
- Skipped jobs (path filtering) → gate passes
- Failed jobs → gate fails
- Cancelled jobs → gate fails

**Keep all CI jobs in one workflow file.** Gate jobs only work within a single workflow — `needs:` can't cross workflow boundaries. If you split into separate workflow files per job:
- No way to create a single gate that watches all jobs
- Workflow-level `paths:` filters cause skipped workflows → required checks stay "Pending" forever
- Multiple gate jobs = more required checks to maintain

Use job-level path filtering (`dorny/paths-filter`) inside one workflow + one gate job. Only split workflows for genuinely different triggers (PR checks vs deploy vs scheduled).

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
| Using `ubuntu-latest` for CI | Use `self-hosted` — cached deps, faster |
| Missing `concurrency` block | Add with `cancel-in-progress: true` |
| No `timeout-minutes` | Set on every job (~2x expected) |
| Using `actions/cache` | Use our setup actions (local cache) |
| Using `npm install` | Use `npm ci` (faster, deterministic) |
| Workflow-level `paths:` filter | Use `dorny/paths-filter` at job level |
| All jobs as required checks | Gate job pattern (only `CI Passed` required) |
| Missing health check on MySQL | Add `--health-start-period=30s` |
| Running `composer update` in CI | Use `composer install` (reads lockfile) |
| Default 90-day artifact retention | Set `retention-days: 3` or lower |

## Cache architecture

```
Host node (/opt/runner-cache/)
├── tool-cache/        → /opt/hostedtoolcache   (Node, Go, Dart, Flutter binaries)
├── npm/               → ~/.npm                  (npm download cache)
├── composer/           → ~/.composer/cache       (Composer download cache)
├── local-cache/        → ~/.cache               (node_modules, vendor, go modules — tar archives)
└── docker/             → /var/lib/docker         (Docker layer cache for service containers)
```

Two-layer caching:
1. **Download cache** (npm/composer dirs) — speeds install even on cold `node_modules`/`vendor`
2. **Artifact cache** (local-cache tars) — skips install entirely on lockfile match

Both persist across ephemeral runner pods via host-path volumes.
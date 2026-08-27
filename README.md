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
| `node-version` | `22.20.0` | Node.js version |
| `working-directory` | `.` | Directory with `package-lock.json` |

On a GitHub-hosted fallback runner the download cache comes from `actions/cache` instead of the host volume — see [Runner fallback](#runner-fallback). Note that an exact patch pin absent from that image's tool-cache costs a download on every job; a major-only value like `'22'` resolves to the preinstalled build and costs nothing.

`npm ci` runs every invocation with `--prefer-offline --no-audit --no-fund`:
- `--prefer-offline` skips registry metadata lookups when the warm `~/.npm` cache satisfies the lockfile.
- `--no-audit` skips the audit POST to the registry (audit belongs in a dedicated job, not every install).
- `--no-fund` skips funding output.

Postinstall scripts still run every invocation — the flags only affect network round-trips, not script execution.

### setup-pnpm

Installs Node.js, enables pnpm via corepack, runs `pnpm install --frozen-lockfile` against a cached pnpm store.

```yaml
- uses: Back-to-code/actions/setup-pnpm@v2
```

| Input | Default | Description |
|-------|---------|-------------|
| `node-version` | `24.16.0` | Node.js version (same ARC tool-cache note as setup-node) |
| `working-directory` | `.` | Directory with `package.json` + `pnpm-lock.yaml` |

pnpm comes from **corepack** (bundled with Node), so its version is whatever `package.json` `"packageManager"` pins (e.g. `"pnpm@9.12.0"`) — set that field for a deterministic version. The content-addressable store is cached like setup-go's module cache: a host-mounted `local-cache` on ARC (no cloud round-trip), `actions/cache` on a GitHub-hosted fallback. `pnpm install --frozen-lockfile` runs every invocation (the `npm ci` equivalent — fails if the lockfile is out of date), fast on a warm store; install scripts always execute.

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
| `extensions` | Laravel-shaped set | **Hosted only.** Extensions for `shivammathur/setup-php`. Ignored on ARC. |
| `coverage` | `none` | `none`, `pcov`, or `xdebug`. On ARC, anything but `xdebug` unloads the image's always-on xdebug (segfaults deep recursion; pcov stays available). Hosted installs the named driver. |

PHP versions pre-installed via ondrej/php PPA. Action uses `update-alternatives` to switch — no download. Composer runs w/ `XDEBUG_MODE=off` for speed. `composer install` runs every invocation.

The `extensions` input is hosted-only because the ARC image already carries every extension; a GitHub-hosted runner installs only what it is told. `coverage` applies on both runner kinds: declare the driver on coverage and mutation jobs (`xdebug` if the job sets `XDEBUG_MODE=coverage`, `pcov` otherwise) — the default `none` keeps xdebug unloaded on ARC (always-loaded xdebug segfaults deep-recursion workloads like Scramble generation) and skips the ~15s driver install on hosted. See [Runner fallback](#runner-fallback).

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

### codeowner-gate

Enforces code-owner approval on a PR, publishing a `Codeowner gate` commit
status on the PR head SHA. Passes when the PR author is a code owner, or when a
code owner's latest review is an approval — letting owners self-merge while
requiring an owner approval for everyone else (native branch rules can't express
the author bypass). Reads CODEOWNERS from the base ref via the API and never
checks out PR code, so a PR can't edit CODEOWNERS or the gate to forge a pass.

Drive it from its own workflow — the trigger and permissions must live in the
calling repo:

```yaml
name: Codeowner Gate
on:
  pull_request_target:
    types: [opened, synchronize, reopened]
  pull_request_review:
    types: [submitted, dismissed]
permissions:
  contents: read
  pull-requests: read
  statuses: write
concurrency:
  group: codeowner-gate-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  codeowner-gate:
    name: Evaluate codeowner gate
    runs-on: self-hosted-kata
    timeout-minutes: 5
    steps:
      - uses: Back-to-code/actions/codeowner-gate@v1
```

`pull_request_target` (not `pull_request`) so the gate runs the base branch's
trusted workflow + action with a writable token. No inputs — the status context
is fixed to `Codeowner gate` to match the org `protect-internal` ruleset's
required check. Owner matching is global (any `@login` in CODEOWNERS), not
path-scoped.

---

## Runner fallback

`setup-node` and `setup-php` work on GitHub-hosted runners as well as ARC. This is **not** a
relaxation of [Rule 1](#rule-1-always-use-runs-on-self-hosted) — self-hosted stays the default and
the recommendation. It exists so a repo can ride out an ARC outage without rewriting its workflow.

Each action branches on `runner.environment`:

| | ARC (`self-hosted`) | GitHub-hosted |
|---|---|---|
| PHP | `update-alternatives`, image-provided | `shivammathur/setup-php` prebuilt binaries (~3-5s) |
| Node | image / tool-cache | image-preinstalled Node |
| npm downloads | host-mounted `~/.npm` | `actions/cache` on `~/.npm` |
| Composer downloads | host-mounted `~/.composer/cache` | `actions/cache` on Composer's `cache-files-dir` |

The caching philosophy is identical on both sides — **download cache, never a `node_modules` or
`vendor` tarball**. `npm ci` and `composer install` still run on every job, so postinstall breakage
still surfaces on the PR that introduces it.

A repo makes itself flippable by putting the runner in a variable, which needs no merge to change:

```yaml
runs-on: ${{ vars.CI_RUNNER || 'self-hosted' }}
```

```bash
gh variable set CI_RUNNER --body ubuntu-latest   # flip during an outage
gh variable delete CI_RUNNER                     # back to ARC
```

### Expect one cold run per flip

No `actions/cache` entry survives a fleet change in either direction, and this is worth knowing
before someone spends an afternoon on it. The ARC image ships no `zstd`, so `actions/cache` falls
back to gzip there (`cache.tgz -z`) while GitHub runners use zstd
(`cache.tzst --use-compress-program zstdmt`). Compression is part of the cache version, so every key
misses — including bare prefixes with matching entries present.

Measured on kendo's first hosted run: Rector 412s, then 51s once it had saved its own zstd copy. It
self-heals on the second run. Closing the gap properly means adding `zstd` to the **btc-runway
runner image** — GitHub's own docs ask for GNU tar and zstd on self-hosted runners for exactly this
reason.

---

## Writing optimized workflows

### Rule 1: Always use `runs-on: self-hosted`

All CI jobs on self-hosted runners. Never `ubuntu-latest` or GitHub-hosted for CI checks — no cached deps/tools.

Exception: deploy workflows may use `ubuntu-latest` for security (ephemeral, no persistent credentials).

Exception: during an ARC outage, see [Runner fallback](#runner-fallback). The setup actions handle both runner types, so the switch is a variable rather than a workflow rewrite.

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

### Rule 9: SHA-pin third-party actions

Pin **every** `uses:` to a full commit SHA with the version as a trailing comment. Applies to all suppliers, including ally-controlled (`Back-to-code/actions/*`) — moving tags can be re-pointed silently, SHA cannot.

```yaml
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
- uses: Back-to-code/actions/setup-node@<sha> # v1
- uses: dorny/paths-filter@de90cc6fb38fc0963ad72b210f1f284cd68cea36 # v3.0.2
- uses: github/codeql-action/upload-sarif@<sha> # v4
```

Why:
- ISO 27001 A.5.21 requires commit-pinning for supply-chain integrity regardless of supplier trust.
- Tag-pin (`@v4`) re-resolves on each run → upstream tag move (compromise or rewrite) flows in undetected.
- SHA + version comment keeps Dependabot / human review readable.

Dependabot can manage SHA bumps:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

> The workflow examples below use moving tags (`@v4`, `@v1`) for readability. **Real workflows must SHA-pin** per Rule 9.

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
| Moving-tag pin (`@v4`) | SHA-pin + `# v4` comment (Rule 9) |

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
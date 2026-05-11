# Contributing

## Workflow

1. Branch from `main`.
2. Edit action code.
3. Commit using [Conventional Commits](https://www.conventionalcommits.org/).
4. Open PR → merge to `main`.
5. Release workflow auto-tags + publishes.

## Commit message format

`<type>: <description>`

| Type | Bump | Use for |
|------|------|---------|
| `fix:` | patch (v1.0.0 → v1.0.1) | bug fixes |
| `feat:` | minor (v1.0.0 → v1.1.0) | new inputs, new features |
| `feat!:` or `BREAKING CHANGE:` in body | major (v1.0.0 → v2.0.0) | removed inputs, changed defaults |
| `docs:`, `chore:`, `refactor:`, `ci:`, `test:` | patch | non-functional changes |

Examples:

```
fix: handle missing cache directory
feat: add node-version-file input
feat!: drop Node 18 support

BREAKING CHANGE: minimum Node version is now 20.
```

## Versioning

We follow [SemVer](https://semver.org/).

Two tag types per release:
- **Immutable** `vX.Y.Z` — pinned to one commit forever.
- **Floating major** `vX` — moves to latest X.x.x.

Consumers pin SHA + `# v1` comment. Dependabot auto-updates within major.

## Release process

Fully automated. On merge to `main`:

1. `.github/workflows/release.yml` reads commits since last tag.
2. Determines bump from commit prefixes.
3. Creates new `vX.Y.Z` tag.
4. Moves floating `vX` tag.
5. Publishes GitHub Release with changelog.

No manual tagging. No release PRs.

## Breaking changes

`feat!:` creates a new major (e.g. `v2.0.0` + floating `v2`). Old floating `v1` stays at last 1.x — existing consumers keep working. Migrate consumers
manually; Dependabot won't cross majors by default.

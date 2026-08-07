# Contributing

AniCode supports Node.js >=22.15.0 without an artificial future-major ceiling. CI verifies the
minimum version, the Node 24 LTS release baseline, and `current`, which follows the latest stable
Node.js release. Node 24 remains selected by `.nvmrc` for reproducible release builds. Development
and CI require npm >=10.9.2; the reproducible release gate remains pinned to npm >=11.5.1 <12. Run
`nvm use` before installing the locked dependency graph with `npm ci` when reproducing the release
environment.

Before opening a pull request, run:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run codegen:check
npm test
npm run build:cli
npm run build:app
npm run build:vscode
npm audit --omit=dev --audit-level=high
```

User-visible CLI changes require a Changeset (`npm run changeset`). Keep patches focused, add a
regression test, and never weaken a permission, credential, network, IPC, or execution boundary to
make a test pass. Pull requests must pass required CI and receive owner review.

Report vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.

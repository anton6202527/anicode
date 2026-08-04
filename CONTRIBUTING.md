# Contributing

AniCode supports Node.js 22.15+ and 24.x; Node 24 is selected by `.nvmrc` and used for release
builds. Development and CI support npm 10.9.2 through 11.x; the release gate requires npm 11.5.1+.
Run `nvm use` before installing the locked dependency graph with `npm ci`.

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

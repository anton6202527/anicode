# Contributing

AniCode supports current Node.js 22 and 24 runtimes; Node 24 is used for release builds. Install the
locked dependency graph with `npm ci`.

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

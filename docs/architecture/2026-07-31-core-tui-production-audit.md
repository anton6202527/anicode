# Core / TUI production-readiness audit

Audit date: 2026-07-31

## Decision

The repository already has a substantial production foundation: strict TypeScript, cross-platform
Node 22/24 CI, durable sessions, permission policy, secret backends, bounded HTTP bodies, loopback
defaults, bearer authentication, rate limiting, telemetry redaction, signing-enforcing desktop
packaging, an OIDC-ready npm publishing workflow, multi-platform CLI smoke tests, and extensive TUI
regression coverage.

This review did not replace those systems. It closed the remaining repository-local P0 gaps found
in the daemon boundary, clients, and release path. A release is still not honestly “production
approved” until the external gates in the final section have passed in the target organization.

## Findings and implemented controls

| Priority | Finding                                                                                                                                                                               | Implemented control                                                                                                                                                                                                                                                                                                            | Verification                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| P0       | The default Unix socket was the shared, predictable `/tmp/anicode.sock`. Another local account could race the path or impersonate the endpoint.                                       | The default is now per user: `$XDG_RUNTIME_DIR/anicode/anicode.sock`, otherwise `<tmp>/anicode-<uid>/anicode.sock`; Windows uses a per-user named pipe. The dedicated directory is `0700` and a Unix socket is explicitly `0600`. Custom parent directories are never chmodded.                                                | Deterministic path, directory-mode, socket-mode, active-socket and platform tests.   |
| P0       | Parsed NDJSON was syntactically checked but optional request fields could have the wrong runtime type; negative fork indexes were accepted.                                           | The protocol boundary now validates non-negative request IDs/indexes, canonical session IDs, required non-empty strings, optional model/idempotency/trace fields, and bounded metadata before dispatch.                                                                                                                        | Protocol unit tests plus daemon end-to-end tests.                                    |
| P0       | A connected IPC or HTTP peer could accept a request and never respond, retaining pending promises indefinitely.                                                                       | IPC has connection and per-request deadlines plus a 256 in-flight cap. HTTP JSON requests have abortable deadlines and `dispose()` now cancels them. Defaults allow long agent turns but remain finite and are configurable.                                                                                                   | Half-open peer and timeout tests.                                                    |
| P0       | HTTP JSON responses and unfinished SSE frames could grow without a client-side bound; SSE startup could wait forever for a snapshot.                                                  | JSON reads are streamed through a byte ceiling; SSE frames have an individual 4 MiB ceiling, envelope shape validation, a 15-second initial-snapshot deadline, and listener failure isolation.                                                                                                                                 | Oversized-response, oversized-frame and stalled-snapshot tests.                      |
| P0       | A local stdio MCP could emit an unterminated frame or unlimited stderr; the embedded AniCode MCP server accepted unbounded input and unlimited concurrent calls.                      | Both MCP directions now use 4 MiB frames. The client drains stderr, handles spawn failure, caps in-flight requests and terminates bad peers. The server validates arguments, caps concurrency at 32 and bounds tool results.                                                                                                   | Oversized-frame, missing-executable, timeout and end-to-end MCP tests.               |
| P0       | The custom Chrome DevTools WebSocket accepted non-loopback endpoints and trusted declared frame sizes; CDP commands had no deadline. `anicode exec` could read unlimited piped stdin. | DevTools is loopback-only, handshake/frame/fragmented-message sizes are bounded, callbacks are isolated, and commands have configurable deadlines plus an in-flight cap. Non-interactive CLI input is capped at 4 MiB.                                                                                                         | WebSocket frame/endpoint tests, real headless-browser test and oversized-stdin test. |
| P0       | npm publishing and GitHub Release assets could proceed without re-validating the exact source revision through the complete source/test/build gate.                                   | `npm run verify:release` now sequentially runs formatting, lint, typecheck, codegen drift, all tests, three dependency audits, clean-room CLI package smoke, app/VS Code builds, and bundle budgets. Both publishing paths run it with PostgreSQL and hard timeouts; asset builds depend on validation of the tagged revision. | Local release-gate command plus `actionlint` and workflow review.                    |
| P1       | GitHub Release assets had checksums but no provenance tied to the workflow identity and commit.                                                                                       | VSIX and desktop checksum manifests now feed immutable-SHA-pinned `actions/attest@v4`; jobs have only the OIDC/attestation permissions required for this operation.                                                                                                                                                            | Consumers can run `gh attestation verify <asset> -R <owner>/<repo>`.                 |
| P1       | Some CI/release jobs could consume the platform maximum runtime when a test or packager hung.                                                                                         | Explicit 10–90 minute job deadlines were added according to workload.                                                                                                                                                                                                                                                          | `actionlint` and workflow review.                                                    |

These choices follow current primary guidance: MCP recommends stdio or restricted Unix IPC for
local servers and explicit authorization for HTTP; GitHub recommends OIDC-backed artifact
attestations for downloadable binaries; npm trusted publishing supplies short-lived OIDC
credentials and automatic provenance for public packages.

Primary references:

- [MCP security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
- [Node.js v24 `net` documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/net.html)
- [GitHub artifact attestation guide](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)
- [`actions/attest` v4 reference](https://github.com/actions/attest/blob/v4/README.md)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)

## Release gate

Run the repository-local release candidate gate with the supported Node/npm toolchain:

```bash
npm ci
npm run verify:release
```

The command deliberately fails on any formatter drift, warning, type error, generated SDK drift,
test failure, high production advisory, disallowed build advisory, invalid registry signature,
packaging regression, build failure, or bundle budget overrun.

## External gates that cannot be fabricated in this checkout

These remain mandatory before describing a particular build as production approved:

1. Commit and review a real-model `packages/eval/baseline.json`, enable the OIDC-backed nightly
   eval, and require a non-regressing run for the exact release candidate. No baseline is currently
   committed, so the model-quality gate is not yet operational.
2. Configure npm trusted publishing for this repository/workflow and disallow token publishing after
   the OIDC path has been verified.
3. Put signing/notarization secrets in a protected `release` environment, exercise macOS and Windows
   signing, download each artifact, verify its checksum and GitHub attestation, and test rollback.
4. Run the documented terminal matrix on macOS Terminal/iTerm2, VS Code Terminal, kitty/WezTerm,
   Windows Terminal/WSL, SSH/tmux, IME and screen reader paths. Unit tests cannot certify terminal
   emulator behavior.
5. Run a measured canary for at least 30 days, replace provisional SLOs with observed baselines, wire
   paging/retention/restore drills, and record capacity and cost ceilings.

Until those organization- and environment-dependent checks pass, the accurate status is:
repository-local production controls implemented; release approval pending external evidence.

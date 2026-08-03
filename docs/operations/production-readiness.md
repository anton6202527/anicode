# Production operations

This document is the operational contract for a production AniCode deployment. Passing unit tests
alone is not a release decision.

## Release gate

A release candidate must have green required CI on Linux, macOS, and Windows; zero high or critical
runtime dependency advisories; a reviewed model-eval baseline and non-regressing eval run; signed
Windows binaries; signed and notarized macOS binaries; immutable Action SHAs; and a tested rollback.
Never bootstrap a baseline in a gating run.

The repository-local gate is `npm run verify:release`. The npm and GitHub Release paths run the same
gate with PostgreSQL available before Changesets may publish or tagged assets may build, instead of
assuming a separate CI workflow finished first.

The GitHub `release` workflow expects `MACOS_CSC_LINK`, `MACOS_CSC_KEY_PASSWORD`,
`WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD`, `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, and
`APPLE_API_ISSUER` as protected environment secrets. Missing signing material fails the release.
Linux AppImage artifacts are unsigned and must be distributed with GitHub provenance/checksums.
VSIX and desktop release assets are attested from their generated SHA-256 manifests. After download,
verify both layers (replace the repository placeholder):

```bash
shasum -a 256 -c anicode-<platform>-SHA256SUMS.txt
gh attestation verify <downloaded-asset> -R <owner>/<repository>
```

The optional socket daemon uses a per-user endpoint rather than a shared `/tmp` socket. On POSIX the
default is `$XDG_RUNTIME_DIR/anicode/anicode.sock`, falling back to
`<os-temp>/anicode-<uid>/anicode.sock`; its directory/socket modes are `0700`/`0600`. Windows uses a
per-user named pipe. A custom Unix `--socket` is accepted only when its parent is a real directory,
owned by the current uid, with exact mode `0700`; both the launcher and the listener revalidate it.

The loopback HTTP daemon defaults to `127.0.0.1:8327`; port `8317` remains reserved for the built-in
CLI Proxy provider. `anicode serve` always provisions a private bearer-token file after the listener
has bound successfully and prints the file path, never the token. Except for `/healthz` and
`/global/health`, every REST, SSE, artifact, and model-discovery request requires that bearer token.
Prefer `--http-token-file` or `ANICODE_HTTP_TOKEN_FILE`; raw token flags and environment variables
are compatibility mechanisms and can leak through process inspection or shell history. The server
rejects non-loopback binds. Remote access requires a same-host HTTPS/mTLS reverse proxy and must not
remove bearer authentication, rate limits, body limits, or SSE backpressure.

## Workspace and execution boundary

Every production launcher that accepts a cwd must configure both `WorkspaceTrustStore` and an exact
canonical `workspaceScope`. An untrusted or uninspectable workspace runs in restricted mode: Core
forces `plan`, replaces the tool set with `read`/`glob`/`grep`, and disables project env/config,
writes, permission persistence, PatchSet, MCP, LSP, hooks, browser, network, skills, subagents, and
project extensions. Trust is granted only in a real interactive terminal:

```bash
anicode trust status --cwd "$PWD" --json
anicode trust grant --cwd "$PWD"
anicode trust revoke --cwd "$PWD"
```

The grant confirmation binds to the inspected canonical identity and execution-surface hash. A
change while the prompt is open invalidates the operation. Scoped managers hide foreign sessions
from lists and reject known foreign IDs before reading transcript content or constructing a model.
Legacy JSONL compatibility migration is session-lazy: listing merges metadata only, then the scoped
manager authorizes canonical path plus device/inode before that session's transcript is read or
written into the primary store. A same-id legacy record from another workspace is never merged.
Do not deploy an unscoped manager as a multi-project tenant boundary.

Network-enabled execution must use the controlled egress proxy. CONNECT is TLS-only and requires an
unencrypted SNI that exactly matches the authorized DNS authority; ECH, missing/mismatched SNI,
literal-IP authorities, private destinations, and re-resolution after policy approval are rejected.
Container images must be digest-pinned and run with an internal network, read-only rootfs, dropped
capabilities, no privilege escalation, and resource limits. Kubernetes PVC/source mounts remain
read-only; Kubernetes `workspace-write` is intentionally unavailable until a trusted control-plane
PatchSet committer exists. Validate the deployed CNI with
`deploy/remote-runtime/verify-isolation.sh` after every network-policy or cluster upgrade.

The long-lived proxy control credential must never traverse the runner-facing proxy listener.
Remote Runtime requires `ANICODE_RUNTIME_PROXY_CONTROL_URL` to be a credential-free HTTPS origin;
`ANICODE_RUNTIME_PROXY_URL` may be an internal HTTP endpoint because jobs receive only a unique,
short-lived execution capability. The TLS ingress/mesh for the control URL must restrict callers to
the control-plane workload and preserve bearer authentication. Missing either the control URL or a
scoped credential issuer makes a network-enabled container/Job fail closed.

Remote Runtime itself rejects plaintext non-loopback binding. Select either native TLS with the
certificate/private key loaded through `SecretBackend`, or an explicit `trusted-proxy` contract
whose ClusterIP backend is reachable only from the independently verified TLS gateway. Every
accepted job persists its authorized actor, tenant, workspace, capability, decision time, and hard
expiry; workers revalidate after claim, immediately before execution, and periodically while a job
runs. The built-in OIDC grant is bounded by both token `exp` and `ANICODE_REMOTE_GRANT_TTL_MS`.
Immediate external role revocation requires a custom authoritative `authorizeExecution` check;
short TTL alone is not real-time revocation.

Cancellation of an unclaimed job is terminal immediately. Cancellation of a leased job is first
recorded as `cancellation_requested`; only the worker holding the matching fencing lease may mark it
`cancelled` after the runtime stops. A lost acknowledgement lease is reported as an indeterminate
failure, not as proof that side effects stopped. Before upgrading PostgreSQL to the authorization
envelope format, drain old queued Remote Runtime jobs; legacy jobs without a valid envelope fail
closed.

## Live model discovery

`/model` asks the authoritative Local/IPC/HTTP host to query each provider's authenticated model
catalog. Models from a provider that times out or fails authentication are hidden for that refresh;
newly returned compatible text/tool models appear without a client release. Selection and one-shot
model overrides are revalidated. Discovery uses catalog requests rather than completion prompts, so
opening the picker does not spend inference tokens or consume completion quota. A successful model
listing is an availability hint, not a guarantee that the next generation will survive concurrent
quota or a provider outage. Transient failures never persistently delete the offline catalog;
`--list-models` remains a static inventory, not a liveness result.

## SLO and alerting

Initial service objectives, to be replaced with measured targets after a 30-day canary:

| Signal                                            | Target                            | Page when                |
| ------------------------------------------------- | --------------------------------- | ------------------------ |
| HTTP/session API availability                     | 99.9% monthly                     | 5-minute burn > 14.4×    |
| Command acceptance latency                        | p95 < 500 ms                      | p95 > 1 s for 15 min     |
| Remote execution terminal success                 | ≥ 99% excluding user cancellation | < 97% for 15 min         |
| Duplicate side-effect executions                  | 0                                 | any confirmed occurrence |
| Credential-policy denials caused by configuration | < 0.1%                            | > 1% for 10 min          |

Export OTLP only through the credential broker and controlled network proxy. Telemetry is disabled
unless `OTEL_EXPORTER_OTLP_ENDPOINT` is explicitly configured. Never export prompt text, file
contents, credentials, authorization headers, or tool output.

## Data, backup, and retention

Local data is stored under the selected state directory in a mode-0600 SQLite WAL database. Back up
the database with SQLite's online backup mechanism or a filesystem snapshot that includes the DB,
`-wal`, and `-shm` files. Test restore quarterly into an isolated environment before declaring a
backup successful.

`SqliteRuntimeDatabase.prune()` provides a transactional retention pass. Defaults are 90 days for
audit and artifacts, 30 days for terminal commands/jobs and snapshotted events, and 7 days for sent
outbox records. It never deletes user sessions/messages. Operators must schedule it, record the
result, and choose longer periods where legal/audit obligations require them. PostgreSQL and S3
deployments require equivalent lifecycle policies and tested restores.

Explicit session deletion is different from `prune()`. A durable SQLite/PostgreSQL lifecycle row is
atomically moved to `deleting`; from that transition onward new load/send/recovery/artifact leases
are rejected. The owner drains or expires older leases, purges transcript, command inbox, outbox,
runtime stream, PatchSet journals and artifacts, and then commits a content-free
`session.deleted` tombstone. The fence is process-crossing and binds both canonical workspace path
and device/inode identity; do not describe its placement in terms of JavaScript's “first await”.
Artifact download leases cover the complete async-iterator lifetime rather than only `open()`.
Deletion aborts and drains active readers, and S3 iterator cleanup cancels the upstream body, so a
completed `deleteSession` cannot leave an older HTTP response streaming payload bytes.

S3 deletion first writes a permanent, content-free marker outside the mutable session prefix. The
marker makes reads and future uploads fail closed, then the whole session prefix (including every
version and delete marker in a versioned bucket) is purged in bounded batches. A producer process
can die while S3 is still accepting an earlier request, so instant physical-zero is not a valid
distributed guarantee. `S3ArtifactStore` performs restart-safe reconciliation of every retained
marker (production default every 60 seconds); alert on any reconciliation failure and run the same
reconciler from an independent maintenance workload so cleanup does not depend on application
uptime. Set `ANICODE_ARTIFACT_DELETE_RECONCILE_MS` to the measured erasure SLO, never to zero in
production. Every S3 request is abort-bounded by `ANICODE_ARTIFACT_S3_REQUEST_TIMEOUT_MS` (120 s by
default), so a stalled backend cannot wedge the collector forever. Required IAM includes bucket versioning/list-version access and permanent
`DeleteObjectVersion`; Object Lock/MFA-delete failures must leave deletion retryable. Legacy global
content-addressed blobs remain read-compatible and require an offline reference inventory before
reclamation. A deleted database row alone is never proof that payload bytes are gone.

The implementation-level P0/P1 contract and regression invariants are recorded in
[Core / TUI / CLI P0/P1 production closure](../architecture/2026-08-03-p0-p1-closure.md).

## Incident and rollback

1. Stop new remote leases and revoke affected broker credentials.
2. Preserve audit records, traces, release digests, and runner logs without copying prompt content.
3. Roll back to the last signed release; do not replay executions whose outcome is `indeterminate`.
4. Restore data only after schema compatibility and migration checksums are verified.
5. Publish a security advisory when confidentiality or integrity was affected.

Desktop crash dumps remain local by default. Upload requires both
`ANICODE_CRASH_REPORT_UPLOAD=1` and an HTTPS `ANICODE_CRASH_REPORT_URL`; operators must obtain user
consent and publish their own retention/privacy terms before enabling it. Auto-update can be disabled
with `ANICODE_AUTO_UPDATE=0` for managed fleets.

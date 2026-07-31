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
per-user named pipe. Operators overriding `--socket` own the parent-directory access policy.

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

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
`APPLE_API_ISSUER` as protected environment secrets. They are referenced only by the single
platform signing step: checkout, toolchain setup, dependency installation, registry audits,
version mutation, checksumming, attestation and upload do not receive them. The temporary Apple
API key file is mode `0600` and removed by a shell trap. Missing signing material fails the release.
Linux AppImage artifacts are unsigned and must be distributed with GitHub provenance/checksums.
VSIX and desktop release assets are attested from their generated SHA-256 manifests. After download,
verify both layers (replace the repository placeholder):

```bash
shasum -a 256 -c anicode-<platform>-SHA256SUMS.txt
gh attestation verify <downloaded-asset> -R <owner>/<repository>
```

Every release job that installs dependencies uses `npm ci --ignore-scripts`. This still verifies the lockfile's
registry URLs and integrity hashes without executing package lifecycle code. The next step checks
`npm audit signatures` and compares every `hasInstallScript` lockfile node against the exact
package/version `allowScripts` list; only then does `npm rebuild` run those reviewed lifecycle
scripts. Any new lifecycle package, stale allowlist entry, non-npm tarball, or missing SHA-512
integrity fails closed.

For a GitHub Release, `set-release-version.mjs` runs before the complete release gate. Validation
and every platform build check out the event's exact `github.sha` and apply the same deterministic
version mutation, so signed assets are not produced from a post-gate manifest. Build jobs have
read-only repository permissions. Separate publication jobs download already-built assets and hold
the OIDC, attestation and release-upload permissions; they do not check out or execute repository
code.

The main-branch npm path is split into three jobs. A read-only job runs the complete gate and packs
the CLI tarball with lifecycle scripts disabled. A contents-write job, with no OIDC permission and
no persisted checkout credential, may update the Changesets version PR. Only when Changesets reports
that no version changes remain does a third job receive `id-token: write`; that job has no checkout,
downloads the gated tarball, verifies its SHA-256 and embedded name/version, and publishes the
tarball with `--ignore-scripts --provenance`. An already-published version is a no-op only when the
registry's SHA-512 integrity is byte-identical; a version collision or registry error fails closed.

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

## Credential boundary

Normal host startup must not enumerate an OS Keychain service or persist inherited environment
credentials. Values loaded from a trusted workspace `.env`, the host environment, or a service
manager are registered only in that process's `CredentialBroker` and removed from its mutable
environment. In particular, a project credential must never overwrite a global Keychain item or be
reused by a later workspace merely because the environment variable name matches.

Persistent references are opt-in and exact. `ANICODE_CREDENTIAL_KEYS` accepts a bounded
comma-separated list of sensitive environment-variable names; it rejects wildcards, `env:` prefixes
and non-credential names. If an environment value exists, that process-local value wins without
writing the backend. Otherwise a Keychain backend registers a lazy `env:NAME` reference
and reads only that item when an authorized provider/tool actually needs it. The allowlist accepts
only canonical uppercase names with a built-in, narrow audience/host/tool scope; control-plane and
unknown secret names are scrubbed from runtime children but cannot become generic provider
credentials. Availability checks perform no backend I/O, successful reference reads are cached in
the broker and invalidated by registration, rotation or revocation, and repeated provider
diagnostics do not perform a `has` read followed by a second value read. Vault/KMS deployments also
require the explicit list; because the currently bound provider API is synchronous, the host
hydrates only those exact names during stack creation. It never discovers credentials with an
unbounded startup `list`.

Provider diagnostics and default-model selection are metadata-only. A `configured` availability
result means that an exact lazy reference was registered; it does not claim that the backend value
exists or that the OS has granted access. Session create/open/resume (including a cold resume) and
fork validate provider/model metadata without constructing an SDK client or resolving a secret.
Each session materializes a provider only on its first real `send`/`stream`; concurrent first use of
the same model is single-flight, and a failed materialization is not cached, so an unlock or
credential repair can recover on a later send. Provider credential aliases are considered in their
declared order using pure availability metadata. Once resolution starts reading one exact configured
reference, denial, lock, timeout or a missing value ends that attempt; it does not open additional
fallback Keychain items after the failure.

Trusted production sessions apply the same rule to search: they select the first metadata-available
`TAVILY_API_KEY`, then `BRAVE_SEARCH_API_KEY`, without resolving either value. The selected reference
is opened only by the first `web_search` call and is injected exclusively by `NetworkProxy` with its
declared audience, host, tool and header scope. Session status reports only ready/disabled state and
provider name; it never includes a credential id, backend error or secret. `webfetch` remains the
tool for known URLs. Untrusted workspaces expose neither network tool.

A model cannot silently replace an unavailable search/fetch tool with a shell HTTP client. Native
sandboxes do not advertise shell networking and force it off again at execution, because a child can
create a new POSIX session outside the original process group. Only OCI/container runtimes that can
prove whole-workload teardown expose it. There, every foreground `bash` request with `network=true`
requires a fresh interactive approval even in auto/bypass mode and even when hooks, remembered
decisions or allow rules would otherwise approve the command. Headless hosts fail closed, clients do
not offer persistent approval for this case, and background network shells are rejected so later
`write_stdin` calls cannot reuse a one-time grant. Network-enabled shell execution remains
process-scoped behind the AniCode proxy; it never changes host proxy, DNS or route configuration.

OS Keychain writes and deletes are user actions, not startup side effects:

```bash
OPENAI_API_KEY='...' anicode credentials import OPENAI_API_KEY
ANICODE_CREDENTIAL_KEYS=OPENAI_API_KEY anicode --model openai/gpt-5
anicode credentials remove OPENAI_API_KEY
```

When the configured backend is OS Keychain, the remaining operations which can open that store are
deliberate and exact: the first real use of a selected lazy provider (and a later use after its
bounded cache expires if a new broker resolution is needed); authenticated catalog validation after
the user confirms one provider/model in `/model`; connection of an explicitly enabled authenticated
MCP integration; an explicitly launched remote/GitHub/control-plane service hydrating its declared
keys; an authorized exact OAuth provider lookup; and the explicit `anicode auth migrate`
compatibility path. Import/remove, OAuth logout and credential rotation are mutations rather than
hidden reads, but they also intentionally open the selected store. Diagnostics, default selection,
create/open/resume, picker browsing, `credentials list`, `auth list`, static `--list-models`, and
ordinary history listing do not.

`anicode credentials list` reports the configured allowlist only; it does not claim that an item
exists and does not query the secret backend. The production OS Keychain backend exposes no bulk
enumeration operation. OAuth `AuthStore` uses one exact credential key per provider. Keychain-backed
entries are indexed by a local `0600` state file containing only provider/type/expiry metadata and
durable revocation tombstones. Consequently `auth list` never opens Keychain, and a crash during
physical cleanup cannot revive a removed legacy credential. During the compatibility window, an
exact provider read and `auth list` may still read the legacy `auth.json` file as a read-only
fallback, but ordinary reads never migrate, rewrite or delete it. Only explicit
`anicode auth migrate` reads the historical Keychain `auth-index:v1`, checks destination conflicts,
makes the local state authoritative, and then clears the migrated legacy sources.

The native Keychain module is loaded only inside a short-lived helper process, not the AniCode main
process. CLI and VSIX requests use bounded stdin/stdout. The packaged Electron app keeps the
`RunAsNode` fuse disabled and instead forks a one-shot Node-enabled `utilityProcess` only for an
explicit credential operation; its bounded request/response travels through `parentPort`. The
utility entry is inside the signed ASAR, its current-platform N-API binding is explicitly unpacked,
and its `cwd` is a real executable directory rather than an ASAR virtual directory. Neither path
places credential data in argv, inherited application/cloud-token environment variables, temporary
files or logs. Calls have a hard deadline (10 seconds by default, bounded to 60 seconds), bounded
messages, and force-close the exact helper PID with `SIGKILL` on timeout or cancellation. This is a
native-failure and hang containment boundary, not a general-purpose OS sandbox. If a write or delete
times out, is cancelled, or loses a valid completion response, it raises a typed `indeterminate`
mutation outcome: the change may already have committed, so callers must not convert it to a safe
failure, blindly retry a different value, or issue a compensating delete.

Automation browsers are a separate host-credential boundary: Chrome can initialize its own safe
storage even when AniCode's business credential backend is disabled. Every Chrome instance owned
by the built-in browser tool uses a newly created, current-user `0700` profile below the canonical
temporary directory. macOS is forced to `--use-mock-keychain`; Linux is forced to
`--password-store=basic`. Callers cannot override those switches, the profile, or the loopback-only
CDP address/ephemeral port. Spawn failure, connection failure, explicit close and normal host drain
all remove the managed profile after terminating the exact browser tree. The curated Chrome
DevTools MCP also uses its upstream `--isolated` mode and explicit mock/basic Chrome arguments.
Attaching to an existing user browser is not an implicit fallback; it is a separate, explicit user
boundary. None of these controls writes host Keychain, Secret Service, proxy, DNS, route, firewall
or certificate settings.

A successful reference read is cached inside the broker for a bounded interval (one hour by
default, configurable up to 24 hours) and its credential version to avoid repeated OS authorization
prompts. Later broker resolution observes external rotation or deletion after that TTL; negative
results are cached briefly to stop probe loops from repeatedly opening authorization UI.
`anicode credentials remove` revokes the durable item immediately for new processes. A materialized
third-party SDK/provider client may retain its own copy outside the broker and is not forcibly
refreshed by the broker TTL or an in-process broker revoke. Recycle those clients—and with the
current session host, restart every host which used that credential—to apply revocation or rotation
reliably.

Credential rotation fences broker-mediated use before starting external I/O: the broker invalidates
outstanding leases and cached values, freezes the current registration, and makes the credential
unavailable while the write is pending. Activation is a compare-and-swap against that fenced
registration, so a concurrent revoke or replacement cannot resurrect the old logical credential
after a delayed write. This fence cannot erase copies already handed to materialized third-party
clients; those clients must be recycled as described above. Any backend error, abort or async hard
deadline (30 seconds by default, bounded to five minutes) is treated as an indeterminate write and
quarantines broker reads. The deadline bounds the caller's wait even if a backend ignores its abort
signal, but it cannot prove that the external write stopped. The broker neither confirms by
rereading nor rolls back with delete. A quarantined rotation permits only a forward retry with the
same backend instance, target key, candidate value and expiry. `CredentialRotationManager` retains
that pending issued candidate, reuses it for the retry, and makes issue-plus-write single-flight per
credential. It snapshots and validates policy routing at registration, checks an opaque broker
generation before and after issuance, and shares one absolute deadline across issuance and backend
write. A timed-out issuer receives an abort signal; if it ignores cancellation and fulfills late,
the manager adopts the same candidate into pending reconciliation instead of issuing another or
losing it. A revoke/re-register generation change prevents that candidate from overwriting operator
recovery and requires explicit discard/reconciliation. Audit delivery is asynchronous,
observational, and restricted to fixed failure categories, so an issuer cannot inject secrets or
change the completed rotation result.

Explicit pending-candidate discard calls an idempotent `revokeIssued(candidate, signal)` hook. Each
cleanup attempt is single-flight and bounded by the policy `timeoutMs`; timeout sends the abort
signal, returns a fixed non-secret failure, retains the exact candidate for retry, and permanently
prevents that candidate from being activated. A retry repeats cleanup for that same candidate, and
late rejection from an earlier attempt is observed rather than becoming an unhandled rejection.
This deadline only bounds how long the manager waits and requests cooperative cancellation. It
cannot terminate callback code which ignores the signal, so a third-party cleanup implementation
requiring forced termination must run behind a Worker or independent process boundary.

The async deadline cannot preempt an arbitrary synchronous `SyncSecretBackend.putSync`. The built-in OS
Keychain implementation is bounded because its synchronous native call runs in the deadline-bound
helper described above; an in-memory backend has no external I/O. Production composition must reject
or process-isolate a third-party synchronous backend unless it provides an equivalent hard deadline
and preserves indeterminate mutation semantics when completion proof is lost.

Within one `CredentialBroker`, a backend's stable, non-secret `credentialNamespace` plus exact key
also prevents two credential IDs or wrapper objects from aliasing the same physical target. Target
ownership, rotation single-flight, quarantine and the manager's pending issued candidate are all
in-memory, process-local state; they are neither a cross-process lock nor crash-safe reconciliation.
A multi-replica deployment or a deployment which must recover across rotator restarts needs one
active rotator chosen by an external distributed lease or leader election, backend-side CAS/version
fencing, and issuer/backend idempotency keys or a durable rotation journal with explicit
reconciliation. It must reconcile an unknown prior write before issuing a different candidate. An
issuer which creates an external credential but never fulfills its promise cannot be recovered from
an in-memory manager alone; production issuers therefore need an idempotency/reconciliation handle,
not merely an AbortSignal.

Hermetic tests and builds set both `ANICODE_CREDENTIAL_BACKEND=memory` and
`ANICODE_DISABLE_OS_KEYCHAIN=1`. The latter is enforced inside `OsKeychainSecretBackend`, before a
native credential API call, so a forgotten composition override fails closed. Every workspace test
script and every release-gate child carries both settings. Local Electron `pack`/`dist` delete all
inherited Electron signing/notarization authority (`CSC_*`, `WIN_CSC_*`, `APPLE_*` and related
variables), disable certificate discovery and force unsigned, non-publishing output for both build
phases, while forcing AniCode's business credential backend to memory with OS Keychain disabled.
VSIX packaging removes publisher tokens and common credential environment variables, uses a
one-shot temporary HOME/config tree with `VSCE_STORE=file`, and carries the same memory/sentinel
settings; the temporary tree is deleted afterward. Only the isolated, secret-scoped desktop release
signing step enables certificate discovery. AniCode's business Keychain remains disabled there too.

## Workspace and execution boundary

Every production launcher that accepts a cwd must configure both `WorkspaceTrustStore` and an exact
canonical `workspaceScope`. An untrusted workspace runs in restricted mode. In an interactive
`default` session, Core retains its built-in read/search tools plus individually approved
write/edit/apply-patch and offline sandboxed shell tools; it disables project env/config,
permission persistence, session PatchSets, MCP, LSP, hooks, browser, network, skills, subagents,
project memory and project extensions. Explicit automatic modes become read-only. If inspection
itself fails, Core enters a strict read-only safety boundary and exposes only `read`/`glob`/`grep`. Trust is granted only in a
real interactive terminal:

```bash
anicode trust status --cwd "$PWD" --json
anicode trust grant --cwd "$PWD"
anicode trust revoke --cwd "$PWD"
```

Workspace Trust enables reviewed project capabilities but is not itself a shell sandbox or tool
approval. The trusted local interactive TUI has a separate, explicit host default: it starts at the
highest permission level and auto-approves, while still enforcing explicit deny/ask rules, the
sandbox, network policy, credential boundary, runtime, and exact workspace scope. Untrusted,
remote, daemon/HTTP, and headless entry points retain conservative defaults.

Production local factories reject `ANICODE_SANDBOX_FAIL_CLOSED=0` and
`ANICODE_TRANSACTIONAL_SHELL=0`; neither setting is a supported production downgrade. Declarative
modules and project command hooks require a genuine core-attested
`TransactionalExecutionRuntime(ContainerIsolatedRuntime)` backed by a digest-pinned image.
Native and restricted production modes do not execute project hooks.
Model-visible shell commands are rejected before spawn when they directly invoke native host
credential clients. On macOS the child-only Seatbelt profile additionally denies Keychain security
service Mach lookups, so an interpreter cannot bypass the command-name guard through
Security.framework. Linux hides the host home and credential paths and removes Secret Service/
agent session channels inside its namespace. These are child execution controls only; they do not
change the host credential store or its configuration.
After a command-hook abort or timeout, the Agent retains its durable drive fence until the hook's
`close-confirmed` boundary has finished cleanup. A cleanup-proof failure is propagated, retained by
the hook runner, and prevents later command hooks from starting on top of an unproved process tree.

Local production hosts accept HTTP MCP only. If any configured MCP entry is stdio, the complete
set is rejected before the connector is invoked, so no child can be spawned as a side effect of
validation. LSP is disabled unless the runtime advertises and enforces
`managedProcessBoundary=close-confirmed`; `prepare()` describes launch mechanics but is not a
containment or termination guarantee. Current production runtimes intentionally keep LSP disabled.

Every tool registered in a production extension slot must carry an unforgeable, process-local core
WeakSet provenance brand that exactly matches its execution boundary. A structural
`trusted-in-process`, `isolated-module`, or `managed-external` marker is metadata, not proof, and is
rejected without its corresponding core brand. A host-supplied `tools()` registry is only an
enable/disable mask for supported built-ins; production creates fresh built-in implementations and
never executes same-name replacement objects from that registry. Third-party tools must use either
a data-only `isolated-module` manifest or a managed adapter constructed by core. The preferred
boundary is a data-only manifest naming one self-contained ESM entry bundle and its SHA-256 digest.
Before dispatch, a core-owned adapter opens the entry
without following links, performs a bounded identity-stable read, and verifies its digest. Only
those exact bytes and bounded JSON input cross into the container; the child verifies the digest
again and imports the bytes through a data URL. The original path and workspace are never mounted.
Production execution requires a digest-pinned OCI image with PID and mount isolation, no network,
and CPU, memory, process-count, input, output, progress, concurrency and wall-time limits.
`filesystem-read`, `filesystem-write`, and `network` capabilities currently fail closed until
scoped workspace projections and per-execution proxy-only networks are implemented. Cancellation,
timeout and runner shutdown do not become model-visible terminal results until removal of the exact
owned container has been verified. The OCI controller first creates an inert container, verifies
its immutable ID plus random owner label, checks cancellation again, and only then starts that ID.
An ambiguous create is never started and is retained for reconciliation instead of being converted
to success by a timing delay. A handler which ignores cancellation is therefore killable at this
boundary. Native child processes and `worker_threads` are not treated as a security boundary for
untrusted code; Node's Permission Model is defense in depth inside the container, not a replacement
for OCI isolation or a transaction for external side effects.

`trusted-in-process` is reserved for reviewed, host-owned code carrying the non-exported core
provenance brand; merely copying that marker never grants trust. It is not an escape hatch for a
third-party JavaScript closure: an in-process promise which ignores its signal cannot be forcibly
stopped. Managed MCP tools are created by a core adapter and declare their transport semantics
separately. Production rejects stdio
MCP before spawning it: a normal native child/process group cannot contain a server that creates a
new session, so it cannot truthfully provide a force-termination guarantee. It may be enabled only
after a persistent sidecar is owned by a cgroup, OCI container, or Windows Job Object and cleanup is
proved by that boundary's stable identity. HTTP MCP cancellation closes local transport work but
cannot prove whether a remote operation committed, so its outcome is reported as indeterminate and
must not be automatically replayed as though it never ran.

The grant confirmation binds to the inspected canonical identity and execution-surface hash. A
change while the prompt is open invalidates the operation. Scoped managers hide foreign sessions
from lists and reject known foreign IDs before reading transcript content or constructing a model.
Legacy JSONL compatibility migration is session-lazy: listing merges metadata only, then the scoped
manager authorizes canonical path plus device/inode before that session's transcript is read or
written into the primary store. A same-id legacy record from another workspace is never merged.
Do not deploy an unscoped manager as a multi-project tenant boundary.

Network-enabled host execution must use the controlled egress proxy. Declarative third-party
modules currently fail closed when they request `network`: a shared `--internal` container network
and proxy environment variables do not prove proxy-only egress or prevent east-west traffic. This
restriction does not modify the operating system's DNS, routes, firewall, or global proxy settings.
CONNECT is TLS-only and requires an
unencrypted SNI that exactly matches the authorized DNS authority; ECH, missing/mismatched SNI,
literal-IP authorities, private destinations, and re-resolution after policy approval are rejected.
Container images must be digest-pinned and run with a read-only rootfs, dropped capabilities, no
privilege escalation, and resource limits. The local OCI backend uses `--network=none`; Kubernetes
network jobs require the separately deployed proxy-only CNI policy. Kubernetes PVC/source mounts
remain read-only, and Kubernetes `workspace-write` is intentionally unavailable until a trusted
control-plane PatchSet committer exists. Validate the deployed CNI with
`deploy/remote-runtime/verify-isolation.sh` after every network-policy or cluster upgrade.

The local OCI backend executes only a trusted absolute Docker/Podman CLI and binds every lifecycle
operation to one explicit local unix/npipe daemon endpoint. Docker Desktop and Podman-machine hosts
should set `ANICODE_CONTAINER_ENGINE_ENDPOINT`; do not rely on a mutable current context. A
crash-safe SQLite owner lock serializes the bounded orphan journal. The journal records whether a
name is merely reserved, a create may be in flight, or an immutable container ID was proved.
Cleanup first proves the random owner label, resolves the name to that immutable ID, and uses only
the ID for stop/remove and final absence checks. A `creating` record plus an absent name is not
proof: it remains journaled for operator/restart reconciliation. Failure to prove absence is a
`RuntimeTerminationError`, not success.

Kubernetes follows the same activation rule. A Job POST always creates `spec.suspend: true`; only a
JSON Patch which tests both the returned Job UID and owner token may set `suspend: false`. Cleanup
never retries an ambiguous create POST. It discovers the original deterministic name, deletes with
UID preconditions, and waits for both that Job UID and its Pods to disappear. Execution-scoped proxy
Secrets use the same owner/UID deletion proof, and their credential is revoked even when the API
cannot prove physical deletion. Runtime shutdown first fences new work, aborts active workloads,
allows their independent cleanup calls to finish, and closes the API transport only after the run
set has drained.

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
closed. The remote client likewise does not fire-and-forget cancellation: it submits with a stable
per-execution idempotency identity, sends DELETE independently of the caller's aborted signal, and
polls to a known terminal outcome. An ambiguous submission, unreachable cancellation proof, or an
`indeterminate` server outcome raises `RuntimeTerminationError` and must not be replayed.

## Live model discovery

Opening, searching, scrolling, or closing `/model` uses the static provider/model metadata from the
authoritative Local/IPC/HTTP host and does not resolve a credential. After the user confirms one
provider/model with Enter or Tab, the host queries only that provider's authenticated catalog and
accepts the selection only when the exact model is returned with compatible text/tool capabilities.
Direct model selection and one-shot overrides receive the same selected-provider validation; a
model outside the bundled catalog can therefore be submitted explicitly as
`/model provider/model` and accepted when that provider advertises it. Discovery uses a catalog
request rather than a completion prompt, so it does not spend inference tokens or consume
completion quota. A successful listing is an availability hint, not a guarantee that the next
generation will survive concurrent quota or a provider outage. Transient failures never
persistently delete the offline catalog; `--list-models` remains a static inventory, not a liveness
result.

Ollama readiness probes accept only credential-free loopback URLs. AniCode does not resolve or run
`ollama` from `PATH` by default. Optional auto-start requires both
`ANICODE_OLLAMA_AUTO_START=1` and `ANICODE_OLLAMA_EXECUTABLE` set to an absolute regular executable
owned by the current user or root and not group/world-writable; a failed startup is process-tree
terminated. Remote Ollama deployments must be registered as a controlled network provider instead
of using this loopback exception.

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

SQLite is the required local production session primary; PostgreSQL is the required shared or
distributed primary. JSONL is only a legacy import format and a single-writer fallback. Its
per-session hard-link owner file serializes cooperating individual operations, preventing byte
interleaving while append-tail recovery, create, rewrite, load, or delete runs. It does not turn a
sequence such as `load` followed later by `rewrite` into a compare-and-swap transaction: another
writer may append between those calls and an old rewrite can overwrite that append. Do not use
JSONL as a multi-writer production database.

JSONL locking deliberately fails closed. AniCode does not infer abandonment from lock age or
automatically unlink a lock left by a crashed owner, because portable Node filesystem APIs cannot
atomically compare an inode/token and unlink the same directory entry. If a lock remains, first
stop every AniCode process which can access that session directory; only then remove the exact lock
path printed by the error. Never use a wildcard or recursive cleanup for this procedure. The
hard-link publication contract assumes a local filesystem with reliable same-directory hard-link
semantics; network and distributed filesystems are not a supported JSONL coordination boundary.

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

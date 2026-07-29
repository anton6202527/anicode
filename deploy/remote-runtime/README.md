# Remote Runtime deployment

This deployment runs a PostgreSQL-backed control plane and creates one short-lived Kubernetes Job per execution. Each Job copies a read-only source workspace into a private `emptyDir`; the writable copy and Pod identity disappear after completion. Runner egress is denied by default. For network-enabled jobs, the control plane resolves and pins the in-cluster proxy address before creating the Job; the runner NetworkPolicy allows only proxy Pods and gives the runner no DNS or public egress. A binary therefore cannot bypass policy by ignoring `HTTP_PROXY` or tunnelling through runner DNS.

Before applying:

1. Build and sign the control-plane and runner images, then replace both `@sha256:REPLACE_WITH_DIGEST` values.
2. Create `anicode-runtime-config` with `oidc-issuer`, `oidc-audience`, `oidc-jwks-uri`, `vault-address`, `vault-role`, `vault-prefix`, and an explicit `network-allow-domains`. Store the PostgreSQL URL in Vault KV under `runtime:DATABASE_URL`; the control plane exchanges its projected, audience-bound service-account JWT and never receives the database credential as an environment variable. A KMS-backed deployment can use the same credential key by changing the backend env configuration.
3. Provide an RWX storage class for `anicode-workspaces`, or replace the PVC with the organization’s workspace artifact hydrator.
4. Install a NetworkPolicy-capable CNI and verify the deny policy with a direct-socket escape test before admitting workloads.
5. Verify that the chosen CNI enforces Pod-selector egress for traffic addressed through the proxy Service ClusterIP; CNI/service-DNAT behavior is part of the deployment acceptance test.

The control plane's OTLP exporter also uses a hostname/port allowlisted `NetworkProxy`; if the collector requires authentication, set `ANICODE_OTEL_CREDENTIAL_ID` to a Vault/KMS key reference instead of putting a token in `OTEL_EXPORTER_OTLP_HEADERS`.

The runner Job has no service-account token, runs non-root with seccomp, drops all Linux capabilities, uses a read-only root filesystem, has CPU/memory/PID/deadline limits, and is deleted after its result is collected.

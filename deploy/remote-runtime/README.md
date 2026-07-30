# Remote Runtime deployment

This deployment runs a PostgreSQL-backed control plane and creates one short-lived Kubernetes Job per execution. Each Job copies a read-only source workspace into a private `emptyDir`; the writable copy and Pod identity disappear after completion. Runner egress is denied by default. For network-enabled jobs, the control plane resolves and pins the in-cluster proxy address before creating the Job; the runner NetworkPolicy allows only proxy Pods and gives the runner no DNS or public egress. A binary therefore cannot bypass policy by ignoring `HTTP_PROXY` or tunnelling through runner DNS.

Before applying:

1. Build and sign the control-plane and runner images, then replace both `@sha256:REPLACE_WITH_DIGEST` values.
2. Create `anicode-runtime-config` with `oidc-issuer`, `oidc-audience`, `oidc-jwks-uri`, `vault-address`, `vault-role`, `vault-prefix`, and an explicit `network-allow-domains`. Store the PostgreSQL URL under `runtime:DATABASE_URL` and a randomly generated proxy client credential (at least 192 bits) under `runtime:PROXY_CLIENT_TOKEN`. Both control plane and proxy fetch these values through workload identity; neither secret is placed in a Kubernetes `env.value` field. A KMS-backed deployment can use the same credential keys by changing the backend configuration.
3. Provide an RWX storage class for `anicode-workspaces`, or replace the PVC with the organization’s workspace artifact hydrator.
4. Install a NetworkPolicy-capable CNI and verify the deny policy with a direct-socket escape test before admitting workloads.
5. Verify that the chosen CNI enforces Pod-selector egress for traffic addressed through the proxy Service ClusterIP; CNI/service-DNAT behavior is part of the deployment acceptance test.

The control plane's OTLP exporter and OIDC JWKS retrieval use a hostname/port allowlisted `NetworkProxy`; if the collector requires authentication, set `ANICODE_OTEL_CREDENTIAL_ID` to a Vault/KMS key reference instead of putting a token in `OTEL_EXPORTER_OTLP_HEADERS`.

After rollout, run `./deploy/remote-runtime/verify-isolation.sh`. It fails unless images are digest-pinned, Pod Security is `restricted`, direct IPv4/IPv6, metadata and DNS egress are blocked, authenticated proxy routing works, and unrelated Pods cannot reach the proxy. NetworkPolicy YAML alone is not an acceptance test: the cluster CNI must enforce it.

The runner Job has no service-account token, runs non-root with seccomp, drops all Linux capabilities, uses a read-only root filesystem, has CPU/memory/PID/deadline limits, and is deleted after its result is collected.

## GitHub control plane

The same manifest also contains the `anicode-github-control` Deployment/Service. It accepts GitHub webhooks, verifies the Broker-held webhook secret plus expected repository/installation/SHA, persists jobs in PostgreSQL, and dispatches the headless `github-agent.yml` workflow. Configure the GitHub App ID, installation, owner and repository in `anicode-runtime-config`; store `github:APP_PRIVATE_KEY` and `github:WEBHOOK_SECRET` in Vault/KMS. Long-lived `GITHUB_TOKEN`, `GH_TOKEN`, private-key and webhook-secret environment variables are rejected at startup.

The workflow must target an Actions Runner Controller ephemeral runner scale set. Set the repository/organization variables referenced by `.github/workflows/github-agent.yml`, enable GitHub OIDC for Vault, and grant the App only the repository permissions requested by the installation-token source. Validate review, repair and merge-group Check Runs against branch protection before enabling automatic repair.

## Health and shutdown

- Remote Runtime: `/healthz` is liveness; `/readyz` checks PostgreSQL and the execution backend and fails during drain.
- GitHub control plane: `/healthz` is liveness; `/readyz` checks PostgreSQL and fails during drain.
- Both processes stop accepting work on SIGTERM, drain workers, flush OTLP, then close proxy/database resources. Collector failure is reported but cannot prevent resource cleanup.

The complete architecture/configuration archive is in `docs/architecture/2026-07-30-production-runtime-closure.md`.

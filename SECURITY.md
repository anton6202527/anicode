# Security policy

## Supported versions

Security fixes are applied to the latest release and `main`. Older releases are not supported.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's **Report a vulnerability** form in the repository
Security tab. Include affected versions, impact, reproduction steps, and any suggested mitigation.
Please do not include real API keys, prompts, workspace contents, or personal data.

We aim to acknowledge a report within 2 business days, provide an initial assessment within
5 business days, and coordinate disclosure after a fix is available. Critical issues may trigger
revocation of releases or credentials before a public advisory is published.

## Security boundaries

- Provider credentials must enter through documented environment variables or the credential
  broker; they must never be committed, placed in query strings, or copied into issue reports.
- Local HTTP APIs bind to loopback. Any remote exposure requires an operator-managed HTTPS/mTLS
  reverse proxy and network policy.
- Anthropic subscription OAuth is disabled for third-party production use pending explicit written
  authorization. Use an API key or an officially supported enterprise integration.
- Release installers are accepted only when CI produced the signed/notarized artifact from a tagged
  commit. Checksums and GitHub attestations should be verified before redistribution.

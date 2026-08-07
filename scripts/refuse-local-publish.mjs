#!/usr/bin/env node

process.stderr.write(
  [
    "Direct local npm publishing is disabled.",
    "Commit a Changeset and merge it to main, then merge the generated Version Packages PR.",
    "The release workflow publishes the already-gated tarball with npm Trusted Publishing, OIDC provenance, and integrity checks.",
  ].join("\n") + "\n",
);
process.exitCode = 1;

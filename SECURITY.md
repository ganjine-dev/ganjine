# Security

Please report vulnerabilities privately through **Security → Report a vulnerability** on the GitHub repository, not in an issue. Include the output of `./ganjine version` and leave out your own data.

Supported: the latest release.

What Ganjine does and does not protect against is written down in `docs/adr/0005-triggers-and-trust-boundary.md`, `0006-signed-ledger.md` and `0007-ganjine-up-and-live-events.md`. A way around what those documents promise is a vulnerability. A process running as the operator can stop services and edit code, and that is a documented limit.

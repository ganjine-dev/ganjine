# ADR 0008 — Open source

- Status: **accepted** by the operator on 2026-11-01
- Date: 2026-11-01

## Decision

- **Name.** Ganjine (گنجینه). "Vault" collided with HashiCorp Vault and its `vault` CLI.
- **Clean start.** The public repo has no history from the private project. Operator data and the operator's asset agent stay private.
- **License.** AGPL-3.0-or-later, so hosted versions share their changes too.
- **Contributions.** Issues and PRs, with a DCO sign-off and no CLA. Relicensing later would need every contributor's consent.
- **Governance.** `GOVERNANCE.md`: one Founder, sole Owner of the organization. GitHub cannot make a grant irrevocable, so the Founder's position depends on nobody else holding Owner.
- **Ledger files are per install.** `ledger.pub` and the anchor moved from `framework/` to `.ganjine/ledger/`, because a tracked key would lock every clone out. `GANJINE_LEDGER_DIR` lets an operator keep them in a private repo.
- **The Claude Agent SDK is optional.** It is not free software, so it loads on first use, and `NOTICE` adds an AGPL section 7 permission for combining with it.
- **The chain format keeps its first name.** The `vault-ledger-v1` labels stay, because changing them would invalidate signed history.
- **Agent reports.** `AGENTS.md`: an agent offers an issue, removes private data, shows the text, and files only on a yes.

## Data carries forward

A clone install must be able to move into any later official release with its data, signatures and key. This blocks a release if it fails.

## GNU

A project cannot declare itself part of GNU. The GNU project evaluates and accepts packages. Agent runs still depend on non-free software, so evaluation waits until they do not.

## Consequences

- The anchor is no longer in git by default, which weakens rollback detection unless the operator sets `GANJINE_LEDGER_DIR`.
- Only macOS can run the signer.
- Issues and PRs are a new way for hostile text to reach agents. They are data, as in `adr/0005`.

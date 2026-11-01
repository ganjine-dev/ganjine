# ADR 0009 — Drafts, finalize and page ownership

- Status: **accepted** by the operator on 2026-11-01
- Date: 2026-11-01

## Context

Every `page put` is signed at once, so work in progress fills the chain for good. A signed entry cannot be removed, so nothing can be squashed afterwards. Two writers on one address also have no check: the last one silently becomes the latest.

## Decision

Work in progress stays out of the chain, and a page changes only on top of the version the writer saw.

- **Draft.** `ganjine page draft` keeps one replaceable copy per address in `page_drafts`, tied to an open session. A draft is not a record: it is unsigned, has no history, and page reads never return it. The face shows it only at `/drafts/...` and in its session, marked as a draft.
- **Hold.** While a draft exists, only its session can write that address. Others are refused, including with `page put`.
- **Finalize.** `ganjine page finalize` signs the draft as one page version and removes it, in one transaction. The steps before it leave no trace, which is the squash.
- **Base.** A draft remembers the latest version when it opened. Finalize is refused if the page has moved on. The session reads the new version, merges, and drafts again with `--base <id>`.
- **Append only after that.** `page put` to a page last written by another agent needs `--base <latest id>`. An agent refreshing its own page needs none, so temporal agents and rebuilds keep working.
- **Closing.** A session with drafts cannot close until it finalizes or discards them.
- **Release.** `page discard <address>` without `--session` is the operator's way to free a hold left by a dead session. The draft is lost.

## What this does not stop

These rules keep cooperating agents from overwriting each other. They are not a security boundary. The session and agent names are claimed, not proven, until per-agent keys (`adr/0006` step 3), and a writer can name any session. The ledger still prevents rewriting history.

All sessions write as the agent `session`, so two sessions are only told apart through a hold or a base. Drafts give them both.

`page_drafts` is not chained. Anyone with database access can change a draft, so it is shown as unverified, and it becomes trustworthy only when finalized.

## Consequences

- Existing records and signatures are untouched. The migration adds one table.
- Chain growth now reflects decisions, not edits.
- A writer that does not know the latest version gets a refusal, with the id it needs.

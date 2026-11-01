# ADR 0004 — Working sessions: where the operator asks questions

- Status: **proposed**
- Date: 2026-11-01

## Context

The operator wants one long sitting: ask a question, an agent explores and fetches, charts appear in the browser, the operator gives feedback, and they iterate until concluding. The sitting must survive, so later agents can read it and reuse its data and charts.

## Options

1. **Prompt box in the face, running the Agent SDK.** Pleasant, but the face becomes a read-write app with a process manager, streaming, auth and cost controls. Chrome sync and repo work would need their own path.
2. **Claude Code as the operator's session; the face as its output.** Needs no new chat UI, already has Chrome and the repo, and the operator already works there. The face only has to show a session live.
3. **Both now.** Twice the work before the workflow is known.

## Decision

Option 2, accepted by the operator on 2026-11-01. The operator opens Claude Code directly, with whatever model, effort, permissions and resume flags they want, and starts with `/analyze <question>`. Sessions are framework data rather than Claude Code data, so a prompt box could later be a second writer of the same thing.

## Shape

- A session is a record stream tagged `session:<id>` plus pages under `/sessions/<id>/`: questions, findings, feedback, decisions, data, answers and a conclusion.
- `ganjine session ...` is plumbing for the agent. The operator never needs to type it. `.claude/commands/analyze.md` holds the working rules.
- Claude Code's resume and Ganjine's session are separate. Resume restores the conversation; `ganjine session show` restores the work, so a brand-new conversation can continue a session too.
- The face has a Sessions section. An open session's page refreshes itself when something is added. It is the only page allowed to poll, and only its own origin.
- Later agents read closed sessions through `ganjine session show`, or `read_records` by tag.

## Consequences

- The operator asks in the terminal and reads in the browser.
- Whole-market data still needs the ingest path before charts can span the market or years of history.

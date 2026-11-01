# ADR 0005 — Triggers after a movement, and the trust boundary

- Status: **accepted** by the operator on 2026-11-01
- Date: 2026-11-01

## Context

The first real movement left the dashboard stale, and nothing said what a movement owes the system. The same question raised another: pages are stored content, read back into the operator's live browser. If whoever can write the store can also run code in that browser, then A writing a row gains execution on B, and the payload waits for B's next visit.

## Decision: the spine

**Content stored in Ganjine is data at every layer, all the way down. It never becomes an instruction.** A CPU only executes what the program counter fetches, and the OS marks data pages non-executable. Each layer above repeats that rule, so a failed layer leaves the one below it standing:

| Layer | Who could turn data into code | Guard |
|---|---|---|
| Store | Anyone who reaches Postgres. A superuser can drop triggers and run `COPY ... PROGRAM` | Loopback only. Later: separate roles, face read-only |
| Page | Writing HTML | Pages are JSON. HTML exists only at read time, so a renderer fix also covers old versions |
| Renderer | Unescaped values, malformed rows | Everything escaped, markdown has no HTML, a row is never trusted to match the contract |
| Browser | Scripts, fetches, navigation | CSP, no inline script, charts cannot load or link, embeds sandboxed with an opaque origin |
| Origin | DNS rebinding, a remote site reading loopback | Loopback Host names only |
| Operator | A link to a file | Links leaving Ganjine show their host. Nothing downloads without a click |
| Agent | **Reading text is its execution path.** A row can carry instructions | Read content is data. Text never authorises an action. Unattended agents hold only narrow tools. Sessions with Chrome or a shell treat records as untrusted |

Merely being in RAM is not exposure: bytes that are read but never fetched as instructions do nothing unless a parser bug corrupts control flow. So the renderer and the agent, which parse this content, are the layers that matter most.

Escaping does not protect truth. Someone with write access can change a number without any script. Append-only triggers do not stop a superuser, so integrity needs its own guard, in Phase 5.

## Decision: triggers

A movement owes: a fresh sync, a rebuilt panel that reconciles with the broker, and a line in Recent movements linking its report. The rule alone failed: a movement reached the dashboard with its choice unrecorded. So `ganjine react`, started by `ganjine up`, runs the reactions in `agents/local/reactions.json`. Each names a record kind and a fixed command. Nothing from an event or a record reaches that command, so stored text cannot choose what runs, and an event only causes a rebuild through the verified read path. A reaction may run `ganjine run <agent>` for a temporal agent. It cannot follow `page_version`, which would loop.

A movement records the operator's choice in `result` and links an outcome page, not the options that came before it.

## Consequences

- Any new block kind, renderer or agent tool is reviewed against the table above.
- A rebuild uses the latest snapshot. Fresh broker numbers still need a sync with the operator logged in.
- Phase 5 gains: database roles, tamper evidence for records, and agents reading records as fenced data.

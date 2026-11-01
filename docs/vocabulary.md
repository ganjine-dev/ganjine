# Vocabulary

Authoritative. `HANDOFF.md §3` mirrors this table. Use these words exactly; do not invent synonyms. Add a row when a new concept enters the system, in the same commit that introduces it.

| Term | Meaning |
|---|---|
| **Operator** | The human. Describes items, provides inputs, reads the dashboard, directs agents. |
| **Item** | Anything the operator decides to track. The atomic unit of the system. An item is not typed by the framework; its meaning is given by its categories and its agent. |
| **Input** | Data attached to an item by the operator or fetched by an agent: files, numbers, URLs, API pulls, parameters. Every input is a record. |
| **Category** | A node in the category system. An item can belong to many categories. Categories can be nested (tree) and related to each other (graph edges). Tags are flat categories. |
| **Panel** | The content an asset agent produces for one item. A panel is one or more pages. |
| **Page / Subpage** | A unit of dashboard content. Pages have a stable address, a current version, and a version history. |
| **Address** | The stable path of a page, e.g. `/items/<item>/overview`. Never changes once assigned. |
| **Page version** | One immutable rendering of a page's content, produced by one run at one time. Also a record. |
| **Block** | A typed unit inside a page version's content (`markdown`, `table`, `chart`, `kv`, `embed`, `ref`). See `content-contract.md`. |
| **Face** | The framework-owned shell of the dashboard: layout, navigation, item index, category browser, history, agent browser, health. |
| **Developer agent** | A Claude Code session working in this repo. Builds the framework, writes asset agents, spawns and schedules temporal agents. |
| **Asset agent** | An agent (prompt + tools + code) responsible for one item or one class of items. Writes that item's panel. |
| **Temporal agent** | A scheduled, pre-instructed Claude Agent SDK session that wakes up, does a bounded job, writes records and pages, and exits. |
| **Instruction** | The versioned definition of an agent: system prompt, tools, input spec, output contract. Lives under `agents/`. |
| **Schedule** | A cron-like rule in the database that says when a temporal agent runs and with what input. |
| **Session** | One sitting of an agent. Six types: **developer**, **sync**, **explore** and **capital** have the operator present; **refresh** and **hunt** are temporal agents. |
| **Working session** | One operator sitting in Claude Code, stored in Ganjine: questions, findings, feedback, decisions, data, answers and a conclusion. Started with `/analyze`. Later agents can read it. |
| **Finding** | A conclusion written as a record by a hunt session. A later capital or explore session can start from it. |
| **Movement** | A change to an account's capital, written as a record with a status (proposed, pending, executed). Ganjine proposes; the operator places it at the broker. A status change is a new record under the same key. |
| **Draft** | A session's unsigned working copy of a page. Not a record. Only that session can write the page while it exists. |
| **Finalize** | Sign a draft as one page version and remove it. |
| **Trigger** | The work a committed event owes the system, such as a refresh after a movement. |
| **Reaction** | A trigger as data: a record kind and a fixed command, run by `ganjine react`. |
| **Ledger** | The signed hash chain over records. A record not in it, or that fails against it, is refused on read. See `adr/0006-signed-ledger.md`. |
| **Signer** | The separate process that holds the ledger's private key and signs only what extends the chain. |
| **Event** | A hint that a record was committed, from `/events` or `ganjine watch`. Not a fact: read through the verified path. |
| **Trust boundary** | A point where stored content meets something that can act on it: a browser, an agent, a shell. Content stays data across it. See `adr/0005-triggers-and-trust-boundary.md`. |
| **Run** | One execution of a temporal (or asset) agent. Has a start, an end, a status, a log, and a set of records it produced. |
| **Record** | Any stored fact: input, output, page version, run, log line, error, event. Timestamped, tagged, immutable. |
| **Snapshot** | The state of a page (or the whole dashboard) at a point in time. Derived from records; what "history" shows. |
| **As-of** | A query modifier: resolve a page, item or run to its state at a given date. |
| **Health** | The framework's own observability state per component: status, last checked, last ok, last error. |
| **Phase** | A unit of the roadmap. Each phase ends with something the operator can open and use. Run with `/roadmap`. |

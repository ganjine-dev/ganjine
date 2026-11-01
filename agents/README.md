# agents/

Versioned agent instructions. The runtime references them by folder name + git sha.

- `developer/` — extra guidance for the developer agent (the Claude Code session). Root `CLAUDE.md` is primary.
- `asset/<name>/` — one folder per asset agent; owns one item's (or one class of items') panel.
- `temporal/<name>/` — one folder per temporal agent. Required files: `INSTRUCTION.md`, `tools.json`, `input.schema.json`, `output.md`, `README.md` (see `HANDOFF.md §9`).

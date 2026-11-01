# ADR 0007 — One entry point, and live events

- Status: **accepted** by the operator on 2026-11-01
- Date: 2026-11-01

## Context

Turning Ganjine on took several terminal commands. The operator wants one thing to open: it authenticates them, unlocks the key, starts the system and shows the dashboard. Every Claude agent on the host then reads and commits through it, and the operator watches it change. A and B are the same person, so Ganjine is a shared, signed workspace for many agents, presented in one place.

## Decision

- **`ganjine up` is the entry point, and `Ganjine.app` opens it.** It starts Postgres, migrates, unlocks, starts the signer and the face, and opens the dashboard. On first run it also creates the key and seals existing rows. `ganjine down` stops it.
- **Touch ID or password.** `ganjine-unlock`, a small compiled helper (`deploy/macos/`), asks macOS for the device owner, then reads the key. This replaces the empty-access-list Keychain item in `adr/0006`, which could only ask for a password. The item is created by the helper, so macOS releases it to that exact binary without a second prompt. Any other program, or a changed helper, gets a Keychain prompt.
- **The signer stays a separate process.** The face parses stored content, so the key must never share its memory.
- **Live updates use Postgres NOTIFY.** A trigger on `records` announces each commit. The face forwards it over SSE at `/events`, and open pages reload when something relevant lands. This replaces the session polling from `adr/0004`.
- **`ganjine watch` gives agents the same stream.** One agent can react to another's commit.
- **An event is a hint, not a fact.** Anyone with database access can send NOTIFY. It carries only ids and labels, and the reader must fetch through the verified read path.

- **`Ganjine.app` is a small status window.** It shows state, services, numbers and the dashboard link, and starts Ganjine when nothing blocks it. When something does, it shows what to check and what to run. `ganjine status` is the source, so agents see the same diagnosis.
- **Ganjine never assumes a busy port is its own.** It reads the holder first. `ganjine kill` acts only on a process it has just read as holding Ganjine's ports or socket, and never on the container runtime. Starting beside a holder uses the next free port.

## The agent contract

Agents on the host use `ganjine` and nothing else. `record put` and `page put` commit, `record query` reads, `watch` listens. Presentation goes through the content contract, so every agent's output lands in one dashboard.

- **Enforced by the system:** a row written around `ganjine` is not signed, so it is refused on read. History cannot be rewritten. No agent can obtain the key without the operator approving a prompt.
- **Not enforced:** agents share the operator's user account. One with a shell can stop services or edit the framework code, including the verifier. Git shows that, and the signed chain still holds, but it is not impossible. Only a separate OS user would make it so.
- **Writer identity is claimed, not proven** until per-agent keys (`adr/0006` step 3).
- **Agent-to-agent text is the main injection path.** What one agent commits another reads, so records stay data: text in them never authorises an action (`adr/0005`).

## Consequences

- A Touch ID prompt the operator did not cause should be denied: some process is asking for the key.
- The face holds one extra Postgres connection, and all pages may open a same-origin stream.

---
description: Run one or more roadmap phases in order, respecting phase gates. Usage — /roadmap <from> [to <to>]
---

Run roadmap phases for Ganjine. Arguments: `$ARGUMENTS`

## Parse the arguments

- `/roadmap 2` → run phase 2 only.
- `/roadmap 1 to 3`, `/roadmap 1-3`, `/roadmap 1 3` → run phases 1, 2, 3 in order.
- `/roadmap` with no arguments → report the current phase and its checklist status, do no work.
- `/roadmap status` → same as no arguments.
- `/roadmap next` → run the first phase whose checklist is incomplete.

## Before any work

1. Read `HANDOFF.md`, `ROADMAP.md`, `CLAUDE.md`, `docs/vocabulary.md`, and every file in `docs/adr/`.
2. Find the current state: the lowest phase in `ROADMAP.md` with unchecked items.
3. **Gate check.** If the requested `from` phase is greater than the current phase, do not skip ahead. Either finish the current phase first (if it is small and unblocked) or stop and report what is incomplete.
4. **Blocker check.** For each phase in range, look at its "Blocked by" line in `ROADMAP.md`. If it names an open question from `HANDOFF.md §14` that has no answer recorded (in an ADR or in `ROADMAP.md`), stop before that phase and list the question.

## For each phase in range, in order

1. Announce the phase in one line.
2. Work through its checklist in `ROADMAP.md`. Tick items as they become true, not before.
3. Any hard-to-reverse choice gets an ADR in `docs/adr/` first (Status: proposed). If the ADR needs the operator, stop here.
4. Finish the phase: the operator must be able to open or run something. Say what and how.
5. Commit: `Phase N: <summary>`.
6. Move to the next phase in range only if this one's checklist is fully ticked.

## At the end

- Update `ROADMAP.md` with status, what changed, and the next concrete step.
- Fix `HANDOFF.md` if anything in it is now false.
- Final message: phases completed, what is now usable, what is next, open questions for the operator. Keep it short.

Do not do work outside the requested range. Do not add dependencies a phase does not need. Do not guess on open questions.

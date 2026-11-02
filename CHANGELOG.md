# Changelog

Format: [Keep a Changelog](https://keepachangelog.com). Versions: [SemVer](https://semver.org).

## Unreleased

- Drafts: `ganjine page draft`, `finalize` and `discard`. Sessions work unsigned and sign one final version.
- A session holds a page while drafting, and a page last written by another agent needs `--base`.
- Content contract version 2 adds the `timeline` block, the standard chart over time. Version 1 pages render as before.
- Forecast layer: any forecaster behind a JSON protocol, with answers stored as `forecast` records. `ganjine series put` and `ganjine forecast run`.
- A page with only `timeline` blocks now loads the chart library.
- A timeline can carry `markers`: dated vertical lines with labels.
- A session page is now a contents page: conclusion, a card per page, and notes folded away.
- First forecaster: TimesFM 2.5, in `agents/forecasters/timesfm/`. It's optional and needs `uv`.

## 0.1.0 - 2026-11-01

First public version. Source only, macOS only, and early.

- Append-only record store, categories, and date-addressable pages.
- Web dashboard with live updates, loopback only.
- Temporal agents: scheduler, runner and scoped tools.
- Signed hash chain, verified on read, with a Touch ID unlock on macOS.
- `ganjine up`, `Ganjine.app`, `ganjine status` and `ganjine watch`.
- `ganjine react`: fixed commands run when a record kind commits, started by `ganjine up`.
- App icon.

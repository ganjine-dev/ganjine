# Changelog

Format: [Keep a Changelog](https://keepachangelog.com). Versions: [SemVer](https://semver.org).

## Unreleased

- Drafts: `ganjine page draft`, `finalize` and `discard`. Sessions work unsigned and sign one final version.
- A session holds a page while drafting, and a page last written by another agent needs `--base`.

## 0.1.0 - 2026-11-01

First public version. Source only, macOS only, and early.

- Append-only record store, categories, and date-addressable pages.
- Web dashboard with live updates, loopback only.
- Temporal agents: scheduler, runner and scoped tools.
- Signed hash chain, verified on read, with a Touch ID unlock on macOS.
- `ganjine up`, `Ganjine.app`, `ganjine status` and `ganjine watch`.
- `ganjine react`: fixed commands run when a record kind commits, started by `ganjine up`.
- App icon.

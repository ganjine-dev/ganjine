# ADR 0003 — Blob storage

- Status: **accepted** (operator, 2026-11-01)
- Date: 2026-11-01

## Context

Records and `embed` blocks reference files. History must keep rendering, so a blob reference has to outlive any change of storage. The local stack is Docker Compose; the target is Kubernetes.

## Options

1. **Postgres large objects** — one backup, but files bloat the database and do not move to S3 cleanly.
2. **Local disk behind an S3-shaped interface** — simple now, with a path to S3-compatible storage.
3. **S3-compatible from the start** — the end state, but it adds a service to run before anything needs it.

## Decision

Option 2. The framework talks to a small `put` / `get` / `exists` interface with S3-style semantics: flat keys, whole-object writes, no in-place update. The only implementation for now is local disk, rooted at `GANJINE_BLOB_DIR`.

Blobs are content-addressed. A blob reference is `blob:sha256:<hex>`, says nothing about location, and is what `blob_ref` and `embed.blob` store. The object key is `sha256/<hex>`, which is the same on disk and in a bucket.

## Consequences

- Moving to S3-compatible storage means adding one implementation and copying objects. No record or page version changes.
- Blobs are immutable by construction, which matches the record store.
- Blobs on disk are not covered by a Postgres backup. Phase 5 backups must include them, and k8s needs a persistent volume or S3 by then.

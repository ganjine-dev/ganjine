# ADR 0006 — Signed hash chain over records

- Status: **accepted** by the operator on 2026-11-01 (steps 1 and 2)
- Date: 2026-11-01

## Context

`adr/0005` left integrity open. Append-only triggers do not stop a Postgres superuser, who can change a number with no script at all. The operator proposed signing each record and rejecting at read time anything that does not verify.

## Decision

Records are chained and signed. Verification happens on read.

- **Ledger.** A `ledger` table holds one entry per record: `seq`, `record_id`, `prev_hash`, `entry_hash`, `signature`. `records` itself is unchanged.
- **Hash.** `record_hash` is SHA-256 of the canonical JSON of the record as read back from Postgres, because `jsonb` reorders keys. `entry_hash` covers the seq, the previous entry hash and the record hash, so deleting or reordering breaks the chain.
- **Signature.** Ed25519 over `entry_hash`. One key pair, no CA. The public key is `ledger.pub`, in the install's ledger directory, outside the database (`adr/0008`).
- **Signer.** A separate process, `ganjine signer start`, holds the private key in memory and listens on a socket only its user can open. The key lives in the macOS Keychain, released only after the operator authenticates (`adr/0007`). Agents never see it.
- **The signer is the sequencer.** It keeps the head and signs only what extends it, so it cannot be used to rewrite history. If a commit is lost after signing, the latest batch can be signed again. That is the one exception.
- **Signing happens inside the write.** Just before COMMIT, under an advisory lock. A background sealer would sign whatever an attacker inserted. Signing at commit keeps a rollback from leaving a gap.
- **Head outside Postgres.** The signer writes a signed `.ganjine/ledger/head.json`. `ganjine ledger anchor` copies it to `ledger.anchor.json` in the ledger directory. Keep that directory in a private repo with `GANJINE_LEDGER_DIR`, so an old head cannot quietly return.
- **Reads.** `getRecord`, `queryRecords`, sessions and page reads check the hash, the signature and that a page version matches its record. A single read that fails is refused. A list drops the row. The face reports the count and never renders it.
- **Full walk.** `ganjine ledger verify`, and the face every minute, walk the chain. This catches deletions, which a read of one row cannot see. The result is on Health, and a failure shows on every page.
- **Blobs.** Content-addressed, so a blob is re-hashed when read.

## Activation

The ledger is off until `ledger.pub` exists. `ganjine up` creates it on first run, so no agent ever handles the key. Once on, it fails closed: with the signer stopped, nothing can be written. Existing rows are sealed once, by `ganjine ledger seal-existing`, which refuses to run if the ledger already has entries. That proves nothing changed after that moment, not before it.

## What this does not stop

- **A lie written by a real writer.** A signature proves who wrote something, not that it is true. Per-agent keys are step 3.
- **A process running as the operator's user.** It can open the socket and append, and can replace the latest batch. It cannot read the key without the Keychain prompt, and it cannot rewrite older history. The anchor bounds what it can replace.
- **Deleting `ledger.pub`.** That turns the ledger off, and Health reports it as off. Git shows the deletion only if the directory is kept in a private repo.
- **Tables outside `records`.** `items`, `categories`, `pages.latest_version_id`, `run_logs` and `health` are not chained. Item and category changes and run logs are mirrored as records, so the truth can be rebuilt. The face still reads those tables directly.

## Consequences

- Every write needs the signer. After a restart the operator opens Ganjine and authenticates.
- Writes are serial. That is fine for one operator.
- The cost is one Ed25519 verify per row read.

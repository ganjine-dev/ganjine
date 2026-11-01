# Ganjine

گنجینه: a treasury, a place where valuable things are kept.

**Agents write, Ganjine hosts.** An operator describes what they own or follow. Claude agents analyse it and write pages to one shared dashboard. Everything is an append-only record, signed into a hash chain and verified when it is read.

- **Records, not overwrites.** Every input, page version and run is kept, and any page can be read as of a date.
- **One face, flexible content.** The framework owns the shell. Agents own the content, as JSON blocks: text, tables, charts and sandboxed views.
- **Signed.** A separate signer holds the key behind Touch ID. Agents can append, but they cannot forge or rewrite history.
- **Local.** The dashboard and Postgres listen on loopback only. Your data stays on your machine.

## Status

`0.1.0`, early, and macOS only for now, because the signer's key lives in the macOS Keychain. It has been used by one operator. The face has no login, so keep it on loopback. No asset agent ships yet.

Ganjine does not place trades and gives no financial advice. Analysis written by agents can be wrong.

## Start

Needs macOS 14+, Node 23.6+, Xcode command line tools and Docker.

```sh
cd framework && npm install && cd ..
docker compose -f deploy/docker-compose.yml up -d
deploy/macos/install.sh
./ganjine up
```

The first `up` creates your key and asks for Touch ID or your password. The dashboard opens at `http://127.0.0.1:4400`. `Ganjine.app` in `~/Applications` does the same with a status window.

Agent runs also need the optional `@anthropic-ai/claude-agent-sdk`, which `npm install` adds. It is not free software (`NOTICE`), and `npm install --omit=optional` leaves it out.

## Learn more

- [`HANDOFF.md`](HANDOFF.md): the design
- [`docs/`](docs/): vocabulary, content contract and decisions
- [`ROADMAP.md`](ROADMAP.md): what is next

## Found a problem?

Tell your agent, or open an [issue](https://github.com/ganjine-dev/ganjine/issues). Agents follow [`AGENTS.md`](AGENTS.md): they offer to file it, show you the text, and wait for your yes. Run `./ganjine version` and leave your data out. See [`CONTRIBUTING.md`](CONTRIBUTING.md) to send a change and [`SECURITY.md`](SECURITY.md) for vulnerabilities.

## License

[AGPL-3.0-or-later](LICENSE), with one added permission in [`NOTICE`](NOTICE). The project is run under [`GOVERNANCE.md`](GOVERNANCE.md).

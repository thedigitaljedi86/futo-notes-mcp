# futo-notes-mcp

An **unofficial** [Model Context Protocol](https://modelcontextprotocol.io) server for a
self-hosted [FUTO Notes](https://notes.futo.tech/) sync server. Lets an MCP-compatible
assistant (Claude Desktop, Claude Code, etc.) list, read, write, delete, and search your
own end-to-end-encrypted notes.

**Not affiliated with or endorsed by FUTO Holdings, Inc.** FUTO Notes is end-to-end
encrypted — the sync server only ever stores opaque AES-256-GCM blobs and cannot itself
answer "what notes exist" or "what do they say." This project reimplements the client-side
encryption independently (see [Provenance](#provenance) below) so it can talk to your own
server and actually decrypt/encrypt content, compatible with the real app.

## Requirements

- A FUTO Notes sync server you already run and control (see the app's own
  "Settings → Sync" for how to self-host one). This project is only a client for it.
- Node.js >= 20.

## Install

```bash
npm install
npm run build
```

## Configure

This server takes its config from environment variables — set them in your MCP client's
server config (e.g. Claude Desktop's `mcpServers` block supports `env`):

```json
{
  "mcpServers": {
    "futo-notes": {
      "command": "node",
      "args": ["/path/to/futo-notes-mcp/dist/index.js"],
      "env": {
        "FUTO_NOTES_SERVER_URL": "http://futo-notes.local:3005",
        "FUTO_NOTES_PASSWORD": "your-futo-notes-password"
      }
    }
  }
}
```

`FUTO_NOTES_PASSWORD` is the single password the FUTO Notes app itself asks for under
Settings → Sync — it's used both to log in to the server and to unwrap the vault's
encryption key. There is currently no OS-keychain integration (see
[Roadmap](#roadmap)), so keep this config file itself protected like any other credential
store.

Note: the FUTO Notes server speaks **plain HTTP** on your LAN by default (TLS is only
added if you put a reverse proxy in front of it for remote access) — use `http://`, not
`https://`, unless you've set that up yourself.

### Local cache

To avoid re-downloading every note on each call, the server keeps a small sync cache in
your OS's user cache directory (e.g. `~/.cache/futo-notes-mcp/cache.json` on Linux). It
holds each note's object ID, version, and **path in plaintext** — note paths are titles,
so they may be sensitive. Note *content* is never cached. The file is written with `0600`
permissions; delete it at any time to force a full resync.

## Tools

| Tool | Description |
|---|---|
| `list_notes({ folder? })` | List note paths, optionally under a folder |
| `read_note({ path })` | Read a note's decrypted markdown content |
| `write_note({ path, content })` | Create or update a note |
| `delete_note({ path })` | Delete a note |
| `search_notes({ query })` | Full-text search across all notes (decrypts everything — can be slow on a large vault) |

A note's **path is its title** (e.g. `"Work/Meeting notes.md"`) — there is no separate
title field. Tags are just inline `#hashtags` in the markdown content.

## Provenance

FUTO Notes has no official third-party API/SDK. The encryption scheme and note format
implemented here (`src/crypto.ts`) were derived by reading the public
[futo-notes](https://github.com/futo-org/futo-notes) app source
(`crates/futo-notes-core/src/e2ee/`) and
[futo-notes-server](https://gitlab.futo.org/futo-notes/futo-notes-server) source and
design docs — no code was copied, only the wire format and cryptographic parameters
(PBKDF2-HMAC-SHA256, AES-256-GCM, the note frame layout) were reproduced for
interoperability. Those upstream projects are licensed under FUTO's own
[Source First License 1.1](https://fsl.software/) (non-commercial); this repository is an
independent client implementation, licensed separately under MIT (see `LICENSE`), and
does not redistribute any FUTO code.

Test vectors in `test/crypto.test.ts` were independently cross-checked in both Node.js and
Python before being committed, to confirm byte-for-byte compatibility with the app's Rust
reference implementation.

**Because this crypto is reverse-engineered rather than officially documented**, treat it
with appropriate caution: back up your vault before relying on this for writes, and please
open an issue if you find a compatibility gap with a newer app version.

## Roadmap

- Cross-platform OS-keychain support for the password (instead of plain env var), e.g.
  via `@napi-rs/keyring`.
- Pagination for very large vaults (`list_notes`/`search_notes` currently fetch all
  objects in one call).

## Development

```bash
npm test    # runs the crypto known-answer-test suite
```

## License

MIT — see `LICENSE`. Not affiliated with FUTO Holdings, Inc.

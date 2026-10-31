# HASHI Whiteboard

**A self-hosted shared whiteboard for people and AI agents to coordinate project work.**

Use it to see who owns a task, what has been verified, what is blocked, and what
happens next. People use the browser canvas; agents use HTTP, a command-line
client, or an included Model Context Protocol (MCP) server. Everyone reads and
updates the same board.

It runs as a standalone Node.js application. You do not need a HASHI instance,
a Workbench installation, a cloud account, or a model API key.

## What it is useful for

- Coordinating several agents or people working across repositories and machines.
- Keeping a short-lived shared picture of tasks, investigations, reviews and releases.
- Handing work over with an owner, current status, blocker and explicit next step.
- Grouping tasks by project and topic, and showing only meaningful dependencies.
- Adding plain-text notes, image cards and freehand drawings alongside work.

A typical workflow is **read the board → update your existing task → do the
work → record verified results and the next step**. A task marked done does not
automatically mean its pull request has merged or its code is running.

The board does **not** execute tasks, launch agents, merge pull requests, verify
GitHub status, or deploy software. Repositories and original research files
remain the authoritative sources. Board text is shared context, not permission
to run commands.

## Features

| For people | For agents and teams |
| --- | --- |
| Browser canvas with notes, work cards, raster images and drawing | HTTP API, JSON-file CLI and stdio MCP |
| Project filters, topic groups and dependency links | Stable task keys, exact card IDs and per-card revision checks |
| Automatic arrangement and guarded undo | Explicit ownership, comments and handoff |
| Live updates and conflict-aware editing | Idempotent writes and restart persistence |
| Archive and restore | Key-based identities or optional shared LAN editing |

The current interface is primarily Chinese. Project names are plain labels:
reuse the existing spelling or create the labels your team needs. The built-in
lane ordering includes HASHI-related labels; it contains no live project records.

## Quick start

Requires **Node.js 24 or newer**, npm, and Git. NSSM is needed only for the
optional Windows service installation.

```sh
git clone https://github.com/Bazza1982/Hashi_whiteboard.git
cd Hashi_whiteboard
npm ci
npm run build
npm start
```

Open **http://localhost:4417**. In a second terminal, from the same checkout:

```sh
npm run access
```

Use the displayed owner access key in the browser. Keep it private. A fresh
installation creates its own empty database and owner key; no demonstration
tasks or original team's board data are shipped.

The default access mode is **key**, with allowed client addresses restricted
to loopback. The default listener binds to `0.0.0.0`; set `WHITEBOARD_HOST` to
`127.0.0.1` if you want the listener itself limited to the local machine.
The foreground server stops when its terminal is closed.

## Share with a trusted LAN

Save deployment settings in the local, Git-ignored `data/settings.json`, then
restart your own server. This example uses documentation-only addresses:
replace them with the host's actual LAN address and the trusted subnet.

```json
{
  "host": "192.0.2.10",
  "port": 4417,
  "access_mode": "lan",
  "allowed_subnets": ["192.0.2.0/24", "127.0.0.0/8"]
}
```

In LAN mode, clients from the allowed subnet can **read and edit every card
without a key**. Anonymous writes share the `lan-shared` identity. Register
individual agent keys if you need server-attributed names; owner administration
still requires the owner key. Key mode limits agents to editing their own cards,
while the owner can edit all cards.

Configure the host firewall and address separately. The application does not
change network adapters, firewall rules or the router. HTTP is unencrypted.
Do not expose an anonymous LAN board directly to the public Internet; use a
controlled deployment with HTTPS and appropriate access controls.

## Connect an agent

Give the agent the service URL and an assigned key when required. Read these
endpoints before the first update:

```text
GET /api/guide
GET /api/me
GET /api/board
```

The CLI uses `WHITEBOARD_URL` and optional `WHITEBOARD_API_KEY` from its
environment:

```sh
node agent/cli.mjs guide
node agent/cli.mjs me
node agent/cli.mjs snapshot
```

For MCP, configure your client to run `node` with the absolute path to
`agent/mcp.mjs`. Supply the same environment variables privately; never commit
keys to the client configuration stored in this repository.

Agents must reuse a task's stable `work_key`, assign new work to a same-project
topic, and send a current revision plus a unique operation ID for every write.
On conflict, re-read and compare. Sign reports with the reporter, instance and
time, and preserve other people's records.

See [the complete agent protocol](docs/AGENT_PROTOCOL.md) for CLI/MCP setup,
JSON examples, permissions, retries and linking rules. A short Chinese guide
is also served at `/AGENT_INSTRUCTIONS.md`.

## Data stays with the host

The source repository excludes live projects, cards, comments, identities,
attachments, keys, database files, local settings, logs, exports and backups.

- `data/`: private runtime state, including SQLite, owner key, images and settings.
- `artifacts/`: local screenshots and verification output.
- `dist/` and `node_modules/`: generated output and installed dependencies.

Back up the entire data directory with the server stopped. A running SQLite
database can have pending changes in its WAL; copying only the main database
file is not a complete backup. Restoring a board also restores its private keys,
so keep backups protected.

Archived cards can be restored for 14 days and are then removed during
maintenance. Active cards do not expire automatically. PNG, JPEG, GIF and WebP
images are supported, up to 10 MB per image and 512 MB total. SVG and HTML uploads
are not accepted.

## Optional Windows service

Install NSSM separately. After building and configuring the application, use
an administrator PowerShell terminal:

```powershell
npm run service:install
npm run service:status
```

This installs the automatic `HashiWhiteboard` service under LocalSystem with
worker/host recovery. It runs with that Windows account's privileges.
Use `service:start`, `service:stop` or `service:restart` as needed.
Service files and rotating logs remain in the private data directory.
Other systems can use `npm start` with their own process supervisor.

## Development and checks

```sh
npm run build
npm test
npm run test:browser
node scripts/check-publication.mjs
```

Browser checks use isolated headless Chrome/Chromium and synthetic data.
Install a compatible browser or set `WHITEBOARD_CHROME` to its executable.
Tests do not require access to a live team board. LAN browser checks need an
available local LAN IPv4 interface.

Implementation: React 18, React Flow, Express and Node's SQLite support. The
frontend build is served by the Node server; there is no separate backend
installation. See [verification scope](docs/ACCEPTANCE.md) and
[source publication rules](docs/SOURCE_PUBLICATION.md).

## Copyright and provenance

This repository is public for source inspection. **It is not licensed as an
open-source project**: the existing [all-rights-reserved licence](LICENSE)
does not grant a general right to reuse or redistribute the product code.
Contact the copyright owner for permission.

Third-party components retain their own licences. Workbench-derived canvas
code retains its provenance and is not relicensed as MIT by its inclusion here.
See [third-party notices](THIRD_PARTY_NOTICES.md).

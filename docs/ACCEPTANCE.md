# Verification scope

Tests use synthetic tasks, identities, images and temporary databases. This
document describes repeatable product checks, not a private team's deployment
history or a claim about an arbitrary installation.

## Service and agent checks

Run `npm test` to check:

- Concurrent updates to different cards, stale-write rejection and idempotent retries.
- Key-mode ownership, explicit handoff, appended comments and revoked credentials.
- Shared LAN editing with network-scope checks and owner-only key administration.
- Stable task identity, required topics and bounded dependency/related links.
- Atomic topic moves, arrangement and guarded undo.
- SQLite persistence, archive/restore and archived-item expiry.
- CLI/startup and real stdio MCP requests.
- Announcement discovery across project filters, note promotion without lost comments,
  boolean validation, archive/restore and restart persistence.
- Host startup recovery and worker restart with persisted synthetic data.

## Browser checks

Build first, then run `npm run test:browser`. The four scripts use isolated
headless browser contexts and cover editing, live updates, conflict drafts,
images, drawing, topic membership, sparse links, automatic arrangement and undo.
Announcement checks cover publishing, editing, withdrawal, restoration, live
updates and desktop/mobile viewport discovery. Set `WHITEBOARD_TEST_STATIC_DIR`
to test a candidate build without replacing the running service\'s static files.
The LAN script needs an available local LAN IPv4 address. It checks this host's
LAN origin; it does not prove access from another physical device.

Screenshots and receipts belong in ignored `artifacts/`. Never substitute a
real board export for a test fixture.

## Publication checks

Run `node scripts/check-publication.mjs` before committing or pushing. It checks
tracked source, reachable history paths, ignored runtime-file classes and common
credential formats. Automated pattern checks are bounded evidence, not proof
that every possible secret or private passage has been detected. Review new
documentation, fixtures, images and the exact staged diff yourself.

Fresh-install startup and local tests do not prove a deployed service is using
that revision, nor do viewport simulations prove physical-device acceptance.
Report those claims separately when operating your own installation.

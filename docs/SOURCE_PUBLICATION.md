# Source publication boundary

Publish application source, synthetic tests, dependency manifests, generic
documentation and licence/provenance notices only. Public visibility does not
change the existing all-rights-reserved product licence.

Never commit live board projects, cards, comments, identities, SQLite files,
images, exports, backups, logs, credentials, local settings or deployment
receipts. Keep runtime state in ignored `data/`, generated output in ignored
`dist/`, and local verification material in ignored `artifacts/`.
Private projects and local configuration are also ignored.

Before a push, inspect the exact staged diff and run:

```sh
node scripts/check-publication.mjs
```

Ignore rules do not remove tracked files or erase old commits. Review every
commit that will become public, including documentation, author metadata and
commit messages. Keep operational history and local backups private. Preserve
unknown local changes; do not include them in a release accidentally.

The public repository starts from its own existing main branch and receives a
reviewed source snapshot. Private development history and deployment reports
are not part of that snapshot. Do not merge a private development branch into
this repository merely to synchronize files.

For a fresh installation, run `npm ci`, `npm run build`, then `npm start`.
A fresh data directory creates its own keys and empty board. Never distribute
the original data directory to make a clone work.

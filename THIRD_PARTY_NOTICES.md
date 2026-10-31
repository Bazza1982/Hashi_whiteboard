# Third-party notices and provenance

HASHI Whiteboard is licensed under the [MIT License](LICENSE).
The repository's own code, including the Workbench-derived copies described
below, is included in this MIT release. Third-party dependencies retain their
own upstream licences and copyright notices.

- React Flow (`@xyflow/react` 12.12.0): https://github.com/xyflow/xyflow — copyright the xyflow contributors; MIT.
- React / React DOM 18.3.1: https://github.com/facebook/react — copyright Meta Platforms, Inc. and affiliates; MIT.
- Express 4.22.3: https://github.com/expressjs/express — copyright its contributors; MIT.
- Vite and its React plugin: https://github.com/vitejs/vite — MIT.
- Playwright: https://github.com/microsoft/playwright — Apache-2.0.

Installed transitive dependencies retain the licence identifiers and notices
provided by their packages; the application licence does not replace them.
Distributions must retain applicable third-party notices.

## Workbench-derived code

The card frame in `src/BoardCard.jsx` adapts the interaction pattern of HASHI
Workbench Canvas NodeFrame/NoteNode. The copies in
`shared/canvas/canvas_layout.js` and
`shared/canvas/canvas_edge_semantics.js` originate from the HASHI Workbench
Canvas deterministic layout planner and relationship flow rules.
`shared/tidy.mjs` adapts that planner to this board's projects and topics.

These copies are released under MIT as part of HASHI Whiteboard at the
copyright owner's direction. This grant applies to the code published in this
repository; it does not change the licence of other Workbench code outside it.
No Workbench runtime service is required or imported.

SQLite storage, the lightweight agent interface and this standalone shared-board
domain are implemented in this repository.

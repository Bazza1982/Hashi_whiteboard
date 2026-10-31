# Third-party notices and provenance

React Flow (`@xyflow/react` 12.12.0), React 18.3.1, React DOM 18.3.1 and Express 4.22.3 are used under their MIT licences. Vite, its React plugin and Playwright are development dependencies under their respective upstream licences. Distributions must retain their package licence notices.

- React Flow: https://github.com/xyflow/xyflow — Copyright (c) the xyflow contributors; MIT.
- React / React DOM: https://github.com/facebook/react — Copyright (c) Meta Platforms, Inc. and affiliates; MIT.
- Express: https://github.com/expressjs/express — Copyright (c) its contributors; MIT.
- Vite: https://github.com/vitejs/vite — MIT.
- Playwright: https://github.com/microsoft/playwright — Apache-2.0.

The simplified card frame in `src/BoardCard.jsx` adapts the interaction pattern of HASHI Workbench Canvas NodeFrame/NoteNode. Workbench's mature Canvas is private product material, not generally MIT-licensed. Public visibility of this repository does not relicense that product material; the product licence remains all rights reserved. SQLite storage, the lightweight agent interface and this standalone shared-board domain are implemented here; no Workbench runtime service is copied or imported.

`shared/canvas/canvas_layout.js` and `shared/canvas/canvas_edge_semantics.js` reuse the existing private HASHI Workbench Canvas deterministic layout planner and relationship flow rules, at the owner's request. They remain private Workbench product material with their original provenance; no general open-source licence is granted. `shared/tidy.mjs` adapts that planner to this board's projects and topics. No Workbench runtime or service is required or modified.

// Project/topic adapter for the existing private Workbench Canvas planner.
import { computeTidyLayoutPlan } from "./canvas/canvas_layout.js";
import { PROJECT_LANES } from "./layout.mjs";
import { relationOf } from "./relations.mjs";

const statusRank = { blocked: 0, in_progress: 1, planned: 2, done: 3 };
const sortCards = (a, b) =>
  (statusRank[a.status] ?? 2) - (statusRank[b.status] ?? 2) ||
  Date.parse(b.updated_at) - Date.parse(a.updated_at) ||
  a.id.localeCompare(b.id);

export function tidyProjects(cards, edges, measurements = []) {
  const sizes = new Map(measurements.map((m) => [m.id, m]));
  const size = (c) => ({
    width: 292,
    height: sizes.get(c.id)?.height || (c.kind === "topic" ? 400 : 650),
  });
  const parentOf = new Map(
    edges
      .filter((e) => relationOf(e) === "contains")
      .map((e) => [e.target, e.source]),
  );
  const projects = [
    ...new Set([...PROJECT_LANES, ...cards.map((c) => c.project)]),
  ].sort((a, b) => {
    const rank = (p) =>
      PROJECT_LANES.includes(p) ? PROJECT_LANES.indexOf(p) : 100;
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  const positions = [];
  let x = 0;
  for (const project of projects) {
    const projectCards = cards.filter((c) => c.project === project);
    let y = 0,
      projectWidth = 292;
    const topics = projectCards
      .filter((c) => c.kind === "topic")
      .sort((a, b) => {
        const rank = (c) =>
          Math.min(
            3,
            ...projectCards
              .filter((v) => parentOf.get(v.id) === c.id)
              .map((v) => statusRank[v.status] ?? 2),
          );
        return (
          rank(a) - rank(b) ||
          a.title.localeCompare(b.title) ||
          a.id.localeCompare(b.id)
        );
      });
    const grouped = new Set();
    for (const topic of topics) {
      positions.push({ id: topic.id, position: { x, y } });
      y += size(topic).height + 72;
      const children = projectCards
        .filter((c) => parentOf.get(c.id) === topic.id && c.kind !== "topic")
        .sort(sortCards);
      const childIds = new Set(children.map((c) => c.id));
      for (const c of children) grouped.add(c.id);
      const plan = computeTidyLayoutPlan(
        children.map((c, index) => ({
          id: c.id,
          type: "task",
          position: c.position,
          measured: size(c),
          data: { title: `${String(index).padStart(4, "0")} ${c.title}` },
        })),
        edges
          .filter(
            (e) =>
              relationOf(e) === "depends_on" &&
              childIds.has(e.source) &&
              childIds.has(e.target),
          )
          .map((e) => ({ ...e, relation: "depends_on" })),
        {
          origin: { x: 0, y: 0 },
          rowGap: 80,
          columnGap: 368,
        },
      );
      let height = 0;
      for (const p of plan.positions) {
        positions.push({
          id: p.id,
          position: { x: x + p.position.x, y: y + p.position.y },
        });
        const s = size(children.find((c) => c.id === p.id));
        projectWidth = Math.max(projectWidth, p.position.x + s.width);
        height = Math.max(height, p.position.y + s.height);
      }
      y += height + 140;
    }
    // Legacy loose cards remain visible until deliberately assigned a topic.
    for (const c of projectCards
      .filter((c) => c.kind !== "topic" && !grouped.has(c.id))
      .sort(sortCards)) {
      positions.push({ id: c.id, position: { x, y } });
      y += size(c).height + 64;
    }
    x += projectWidth + 128;
  }
  return positions;
}

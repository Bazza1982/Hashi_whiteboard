export const PROJECT_LANES = [
  "Hashi",
  "Workbench",
  "Agent Presence",
  "Hashi Whiteboard",
];
export const LANE_WIDTH = 360;

export function newCardPosition(project, cards) {
  const active = cards.filter((c) => !c.archived_at);
  const group = active.filter((c) => c.project === project);
  if (group.length)
    return {
      x: Math.min(...group.map((c) => c.position.x)),
      y: Math.max(...group.map((c) => c.position.y)) + 700,
    };
  const lane = PROJECT_LANES.indexOf(project);
  return {
    x:
      lane >= 0
        ? lane * LANE_WIDTH
        : Math.max(
            (PROJECT_LANES.length - 1) * LANE_WIDTH,
            ...active.map((c) => c.position.x),
          ) + LANE_WIDTH,
    y: 0,
  };
}

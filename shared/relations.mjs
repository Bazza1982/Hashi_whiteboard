import { fail } from "./contract.mjs";

export const RELATIONS = ["contains", "depends_on", "related"];
export const RELATION_LABELS = {
  contains: "主题归属",
  depends_on: "依赖",
  related: "相关",
};
export const relationOf = (edge) => edge.relation || "related";
export const flowEndpoints = (edge) =>
  relationOf(edge) === "depends_on"
    ? { source: edge.target, target: edge.source }
    : { source: edge.source, target: edge.target };

export function validateConnection(
  source,
  target,
  relation,
  label,
  cards,
  edges,
) {
  fail(
    RELATIONS.includes(relation),
    "relation_required",
    "Choose relation: contains, depends_on or related. Read /api/guide linking first.",
  );
  fail(
    source.id !== target.id,
    "self_edge",
    "A card cannot connect to itself.",
  );
  const ids = new Set(cards.filter((c) => !c.archived_at).map((c) => c.id));
  const active = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  const exists = active.find(
    (e) =>
      (e.source === source.id && e.target === target.id) ||
      (relation === "related" &&
        e.source === target.id &&
        e.target === source.id),
  );
  fail(
    !exists,
    "edge_exists",
    "This relationship already exists. Reuse it; do not add another line.",
    409,
    { existing_id: exists?.id },
  );
  if (relation === "contains") {
    fail(
      source.kind === "topic" && target.kind !== "topic",
      "invalid_membership",
      "contains must run from one topic card to a non-topic card. Nested topics are not supported.",
    );
    fail(
      source.project === target.project,
      "project_mismatch",
      "A topic and its cards must use the same exact project name.",
    );
    const parent = active.find(
      (e) => relationOf(e) === "contains" && e.target === target.id,
    );
    fail(
      !parent,
      "topic_exists",
      "A card may belong to only one topic. Use the atomic /api/cards/:id/topic endpoint to move it.",
      409,
      { topic_id: parent?.source },
    );
  } else if (relation === "depends_on") {
    fail(
      source.kind === "work" && target.kind === "work",
      "invalid_dependency",
      "Only work cards have dependencies; source is the dependent task and target is its prerequisite.",
    );
    fail(
      label.length >= 4,
      "reason_required",
      "Explain why the task cannot proceed without this prerequisite (at least 4 characters).",
    );
    const dependencies = active.filter((e) => relationOf(e) === "depends_on");
    fail(
      dependencies.filter((e) => e.source === source.id).length < 3,
      "dependency_limit",
      "At most 3 direct prerequisites per task. Remove redundant/transitive links instead of connecting every card.",
      409,
    );
    const reaches = (from, to) => {
      const seen = new Set(),
        queue = [from];
      for (let i = 0; i < queue.length; i++) {
        const id = queue[i];
        if (id === to) return true;
        if (seen.has(id)) continue;
        seen.add(id);
        queue.push(
          ...dependencies.filter((e) => e.source === id).map((e) => e.target),
        );
      }
      return false;
    };
    fail(
      !reaches(target.id, source.id),
      "dependency_cycle",
      "This dependency would create a cycle.",
      409,
    );
    fail(
      !reaches(source.id, target.id),
      "redundant_dependency",
      "The prerequisite is already reachable through another dependency. Keep only direct links.",
      409,
    );
  } else {
    fail(
      label.length >= 4,
      "reason_required",
      "State the concrete relationship (at least 4 characters). A shared project or instance is not a relationship.",
    );
    const related = active.filter((e) => relationOf(e) === "related");
    fail(
      !related.some(
        (e) =>
          [source.id, target.id].includes(e.source) ||
          [source.id, target.id].includes(e.target),
      ),
      "related_limit",
      "Each card may have at most one extra related link. Use topic membership for grouping.",
      409,
    );
    const parentOf = (id) =>
      active.find((e) => relationOf(e) === "contains" && e.target === id)
        ?.source;
    fail(
      !parentOf(source.id) || parentOf(source.id) !== parentOf(target.id),
      "redundant_relation",
      "These cards already share a topic. Do not add related links between topic siblings.",
      409,
    );
  }
}

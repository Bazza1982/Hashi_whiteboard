// Data-driven workflow definition for board cards.
// Stages, labels, allowed transitions and the round budget live in the board
// database and can be edited at runtime; nothing here is the only truth.
import { fail } from "./contract.mjs";

export const WORKFLOW_VERSION = 1;
export const STAGE_KEY = /^[a-z][a-z0-9_]{0,39}$/;
export const CATEGORIES = ["active", "halted", "terminal"];
// A category fixes the coarse status family; the stage names the exact status
// so a freshly created card can stay "planned" while already on its first stage.
const CATEGORY_STATUS = {
  active: ["planned", "in_progress"],
  halted: ["blocked"],
  terminal: ["done"],
};

export const DEFAULT_STAGES = [
  {
    key: "initiated",
    label: "已立项",
    label_en: "Initiated",
    category: "active",
    status: "planned",
    allowed_next: ["claimed", "blocked", "archived"],
    human_gate: false,
    counts_round: false,
    deprecated: false,
  },
  {
    key: "claimed",
    label: "已认领",
    label_en: "Claimed",
    category: "active",
    status: "in_progress",
    allowed_next: ["working", "blocked", "archived"],
    human_gate: false,
    counts_round: false,
    deprecated: false,
  },
  {
    key: "working",
    label: "进行中",
    label_en: "Working",
    category: "active",
    status: "in_progress",
    allowed_next: ["in_review", "testing", "blocked", "archived"],
    human_gate: false,
    counts_round: false,
    deprecated: false,
  },
  {
    key: "in_review",
    label: "待评审",
    label_en: "In review",
    category: "active",
    status: "in_progress",
    allowed_next: ["approved", "changes_requested", "testing", "blocked"],
    human_gate: false,
    counts_round: false,
    deprecated: false,
  },
  {
    key: "changes_requested",
    label: "需修改",
    label_en: "Changes requested",
    category: "active",
    status: "in_progress",
    allowed_next: ["working", "in_review", "blocked", "archived"],
    human_gate: false,
    // Entering rework spends one round of the review budget.
    counts_round: true,
    deprecated: false,
  },
  {
    key: "testing",
    label: "测试中",
    label_en: "Testing",
    category: "active",
    status: "in_progress",
    allowed_next: ["approved", "changes_requested", "blocked"],
    human_gate: false,
    counts_round: false,
    deprecated: false,
  },
  {
    key: "approved",
    label: "已通过",
    label_en: "Approved",
    category: "active",
    status: "in_progress",
    allowed_next: ["merged", "completed", "blocked"],
    human_gate: false,
    counts_round: false,
    deprecated: false,
  },
  {
    key: "merged",
    label: "已合并",
    label_en: "Merged",
    category: "terminal",
    status: "done",
    allowed_next: ["deployed", "completed"],
    human_gate: true,
    counts_round: false,
    deprecated: false,
  },
  {
    key: "deployed",
    label: "已部署",
    label_en: "Deployed",
    category: "terminal",
    status: "done",
    allowed_next: ["completed"],
    human_gate: true,
    counts_round: false,
    deprecated: false,
  },
  {
    key: "completed",
    label: "已完成",
    label_en: "Completed",
    category: "terminal",
    status: "done",
    allowed_next: ["archived"],
    human_gate: false,
    counts_round: false,
    deprecated: false,
  },
  {
    key: "archived",
    label: "已收尾",
    label_en: "Archived",
    category: "terminal",
    status: "done",
    allowed_next: [],
    human_gate: false,
    counts_round: false,
    deprecated: false,
  },
  {
    key: "blocked",
    label: "已熔断",
    label_en: "Blocked",
    category: "halted",
    status: "blocked",
    allowed_next: ["claimed", "working", "archived"],
    human_gate: false,
    counts_round: false,
    deprecated: false,
  },
];

export const DEFAULT_WORKFLOW = {
  version: WORKFLOW_VERSION,
  initial: "initiated",
  max_rounds: 3,
  stages: DEFAULT_STAGES,
  projects: {},
};

const text = (value, name, max, required = true) => {
  fail(
    typeof value === "string" && (!required || value.trim().length > 0),
    "invalid_workflow",
    `${name} must be a ${required ? "non-empty " : ""}string of at most ${max} characters.`,
  );
  const clean = value.trim();
  fail(
    clean.length <= max,
    "invalid_workflow",
    `${name} must be at most ${max} characters.`,
  );
  return clean;
};
const flag = (value, name, fallback = false) => {
  if (value === undefined || value === null) return fallback;
  fail(
    typeof value === "boolean",
    "invalid_workflow",
    `${name} must be true or false.`,
  );
  return value;
};
export function coerceRounds(value, name = "max_rounds") {
  if (value === undefined || value === null || value === "") return null;
  const n =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value).trim(), 10);
  fail(
    Number.isSafeInteger(n) && n >= 1 && n <= 50,
    "invalid_max_rounds",
    `${name} must be an integer between 1 and 50, or empty to inherit.`,
  );
  return n;
}

/** Validate and normalise a stage list. Throws BoardError with a readable reason. */
export function validateStages(input) {
  fail(
    Array.isArray(input) && input.length > 0,
    "invalid_workflow",
    "stages must be a non-empty array.",
  );
  fail(
    input.length <= 60,
    "invalid_workflow",
    "A workflow may define at most 60 stages. Remove or deprecate unused stages.",
  );
  const seen = new Set();
  const stages = input.map((raw, index) => {
    fail(
      raw && typeof raw === "object" && !Array.isArray(raw),
      "invalid_workflow",
      `stages[${index}] must be an object.`,
    );
    const key = text(
      raw.key ?? "",
      `stages[${index}].key`,
      40,
      true,
    ).toLowerCase();
    fail(
      STAGE_KEY.test(key),
      "invalid_workflow",
      `Stage key "${key}" must be lowercase letters, digits and underscores, starting with a letter.`,
    );
    fail(!seen.has(key), "invalid_workflow", `Duplicate stage key: ${key}.`);
    seen.add(key);
    const category = text(
      raw.category ?? "",
      `stages.${key}.category`,
      20,
      true,
    );
    fail(
      CATEGORIES.includes(category),
      "invalid_workflow",
      `Stage ${key}: category must be ${CATEGORIES.join(", ")}.`,
    );
    const status = text(
      raw.status ?? CATEGORY_STATUS[category][0],
      `stages.${key}.status`,
      20,
    );
    fail(
      CATEGORY_STATUS[category].includes(status),
      "invalid_workflow",
      `Stage ${key}: a ${category} stage uses status ${CATEGORY_STATUS[category].join(" or ")}, not ${status}.`,
    );
    const next = raw.allowed_next ?? [];
    fail(
      Array.isArray(next) && next.length <= 20,
      "invalid_workflow",
      `Stage ${key}: allowed_next must be an array of at most 20 stage keys.`,
    );
    const allowed = [
      ...new Set(
        next.map((n) =>
          text(n, `stages.${key}.allowed_next`, 40, true).toLowerCase(),
        ),
      ),
    ];
    fail(
      !allowed.includes(key),
      "invalid_workflow",
      `Stage ${key} cannot list itself in allowed_next.`,
    );
    return {
      key,
      label: text(raw.label ?? "", `stages.${key}.label`, 60, true),
      label_en: text(raw.label_en ?? "", `stages.${key}.label_en`, 60, false),
      category,
      status,
      allowed_next: allowed,
      human_gate: flag(raw.human_gate, `stages.${key}.human_gate`),
      counts_round: flag(raw.counts_round, `stages.${key}.counts_round`),
      deprecated: flag(raw.deprecated, `stages.${key}.deprecated`),
    };
  });
  const keys = new Set(stages.map((s) => s.key));
  for (const stage of stages)
    for (const target of stage.allowed_next)
      fail(
        keys.has(target),
        "invalid_workflow",
        `Stage ${stage.key} points at "${target}", which is not a stage in this workflow.`,
      );
  return stages;
}

function requireFuseTarget(stages, scope) {
  fail(
    fuseTarget(stages),
    "invalid_workflow",
    `${scope}needs a halted stage an agent may enter (category "halted" with human_gate false); the round fuse sends cards there when the rework budget runs out. Marking the only halted stage as human_gate:true would leave the fuse nowhere to stop.`,
  );
}

export function validateWorkflow(
  input,
  { initial, max_rounds, projects } = {},
) {
  const stages = validateStages(input?.stages ?? input);
  requireFuseTarget(stages, "This workflow ");
  const keys = new Set(stages.map((s) => s.key));
  const initialKey = text(
    initial ?? input?.initial ?? "initiated",
    "initial",
    40,
    true,
  ).toLowerCase();
  fail(
    keys.has(initialKey),
    "invalid_workflow",
    `initial stage "${initialKey}" is not defined in stages.`,
  );
  const initialStage = stages.find((s) => s.key === initialKey);
  fail(
    !initialStage.deprecated,
    "invalid_workflow",
    `initial stage "${initialKey}" must not be deprecated.`,
  );
  const rounds = coerceRounds(max_rounds ?? input?.max_rounds ?? 3) ?? 3;
  const projectInput = projects ?? input?.projects ?? {};
  fail(
    projectInput &&
      typeof projectInput === "object" &&
      !Array.isArray(projectInput),
    "invalid_workflow",
    "projects must be an object keyed by project name.",
  );
  const overrides = {};
  for (const [name, override] of Object.entries(projectInput)) {
    fail(
      name.trim().length > 0 && name.length <= 2000,
      "invalid_workflow",
      "Project names in projects must be 1–2000 characters.",
    );
    fail(
      override && typeof override === "object" && !Array.isArray(override),
      "invalid_workflow",
      `projects["${name}"] must be an object.`,
    );
    const projectStages = override.stages
      ? validateStages(override.stages)
      : stages;
    if (override.stages)
      requireFuseTarget(projectStages, `projects["${name}"] `);
    const projectRounds = coerceRounds(override.max_rounds);
    const projectInitial = override.initial
      ? text(
          override.initial,
          `projects["${name}"].initial`,
          40,
          true,
        ).toLowerCase()
      : initialKey;
    fail(
      projectStages.some((s) => s.key === projectInitial),
      "invalid_workflow",
      `projects["${name}"].initial "${projectInitial}" is not one of its stages.`,
    );
    overrides[name] = {
      ...(override.stages ? { stages: projectStages } : {}),
      ...(projectRounds !== null ? { max_rounds: projectRounds } : {}),
      ...(override.initial ? { initial: projectInitial } : {}),
    };
  }
  // The counter is optimistic-locking state, not the schema version.
  const counter =
    Number.isSafeInteger(input?.version) && input.version >= 1
      ? input.version
      : 1;
  return {
    version: counter,
    schema_version: WORKFLOW_VERSION,
    initial: initialKey,
    max_rounds: rounds,
    stages,
    projects: overrides,
  };
}

/** Read a stored document, falling back to the built-in template when absent or stale. */
export function normalizeWorkflow(stored) {
  if (!stored || typeof stored !== "object")
    return validateWorkflow(DEFAULT_WORKFLOW);
  try {
    return validateWorkflow(stored);
  } catch {
    // A damaged document must not make the board unreadable.
    return validateWorkflow(DEFAULT_WORKFLOW);
  }
}

/** Merge global defaults with a project override. */
export function resolveWorkflow(stored, project = "") {
  const base = normalizeWorkflow(stored);
  const override = project ? base.projects[project] : null;
  if (!override)
    return {
      version: base.version,
      initial: base.initial,
      max_rounds: base.max_rounds,
      stages: base.stages,
      scope: "global",
      project: project || "",
    };
  return {
    version: base.version,
    initial: override.initial || base.initial,
    max_rounds: override.max_rounds ?? base.max_rounds,
    stages: override.stages || base.stages,
    scope: "project",
    project,
  };
}

export function stageIndex(stages) {
  return new Map(stages.map((stage) => [stage.key, stage]));
}

/**
 * The stage that receives a card whose rework budget ran out.
 * It is configuration, not a fixed key: any live halted stage an agent may
 * enter serves. A halted stage behind a human gate cannot be entered
 * automatically, so it never takes that role.
 */
export function fuseTarget(stages) {
  return (
    stages.find((s) => s.category === "halted" && !s.deprecated && !s.human_gate) ||
    null
  );
}

// Legacy cards only carry the coarse status; map it to the closest stage.
const CANONICAL_STAGE = {
  planned: "initiated",
  in_progress: "working",
  blocked: "blocked",
  done: "completed",
};
export function defaultStageForStatus(stages, status) {
  const index = stageIndex(stages);
  const preferred = CANONICAL_STAGE[status];
  const canonical = preferred && index.get(preferred);
  if (canonical && !canonical.deprecated) return canonical.key;
  const byStatus = stages.find((s) => s.status === status && !s.deprecated);
  if (byStatus) return byStatus.key;
  const wanted =
    status === "blocked" ? "halted" : status === "done" ? "terminal" : "active";
  const stage =
    stages.find((s) => s.category === wanted && !s.deprecated) ||
    stages.find((s) => !s.deprecated) ||
    stages[0];
  return stage.key;
}

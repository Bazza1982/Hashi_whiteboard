import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  BoardError,
  fail,
  text,
  exactKeys,
  cardContent,
  version,
  position,
  CARD_FIELDS,
  WORKFLOW_FIELDS,
} from "../shared/contract.mjs";
import { newCardPosition } from "../shared/layout.mjs";
import { relationOf, validateConnection } from "../shared/relations.mjs";
import { tidyProjects } from "../shared/tidy.mjs";
import {
  DEFAULT_WORKFLOW,
  resolveWorkflow,
  validateWorkflow,
  normalizeWorkflow,
  stageIndex,
  defaultStageForStatus,
  fuseTarget,
} from "../shared/workflow.mjs";

export const hash = (value) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const decode = (row) => (row ? JSON.parse(row.document) : null);

function summarizeBody(fullBody = "") {
  const lines = String(fullBody || "").split(/\r?\n/);
  const signatures = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\s*更新者[：:]/.test(line));
  const signature = signatures.at(-1);
  const lastAuthor = signature
    ? signature.line
        .replace(/^\s*更新者[：:]\s*/, "")
        .split(/[｜|]/)[0]
        .trim()
    : "";
  const latestLines = lines
    .slice(signature ? signature.index + 1 : 0)
    .filter((line) => !/^\s*(负责人|更新者|更新时间|时间)[：:]/.test(line))
    .join("\n")
    .trim();
  const previewSource = latestLines || String(fullBody || "").trim();
  return {
    last_author: lastAuthor,
    body_preview: previewSource.slice(0, 240),
    body_length: String(fullBody || "").length,
  };
}

// Empty workflow fields are inherited, not stored. Keep cards that never used
// the feature free of the new keys so an unrelated edit stays a content edit.
function withoutEmptyWorkflowFields(content, existing = null) {
  for (const key of WORKFLOW_FIELDS) {
    const empty = content[key] === "" || content[key] === null;
    const wasEmpty =
      existing?.[key] === undefined ||
      existing?.[key] === "" ||
      existing?.[key] === null;
    if (empty && wasEmpty) delete content[key];
  }
  return content;
}

function applyUpdatedBy(card, actor, patch = {}) {
  const next = {
    ...card,
    ...patch,
    updated_at: now(),
    updated_by: actor.id,
  };
  if (actor.display_actor) next.updated_by_display = actor.display_actor;
  else delete next.updated_by_display;
  return next;
}
export class BoardStore {
  constructor(directory, adminKey, { sharedEdit = false } = {}) {
    this.sharedEdit = sharedEdit;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, "whiteboard.sqlite"));
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS actors (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL, work_key TEXT, document TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS unique_work ON entities(work_key) WHERE kind='card' AND work_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS entities_kind_idx ON entities(kind);
      CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, card_id TEXT NOT NULL, document TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS comments_card_idx ON comments(card_id);
      CREATE TABLE IF NOT EXISTS operations (actor_id TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(actor_id,key));
      CREATE TABLE IF NOT EXISTS activity (seq INTEGER PRIMARY KEY AUTOINCREMENT, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, mime TEXT NOT NULL, body BLOB NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS layouts (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS workflow_events_card_revision ON workflow_events(card_id, revision);
      CREATE INDEX IF NOT EXISTS workflow_events_card_idx ON workflow_events(card_id);
      INSERT OR IGNORE INTO metadata VALUES('revision','0');`);
    this.db
      .prepare(
        `INSERT INTO actors(id,name,role,token_hash) VALUES('human-owner','白板主人','human',?) ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash`,
      )
      .run(hash(adminKey));
    if (sharedEdit)
      this.db
        .prepare(
          `INSERT OR IGNORE INTO actors(id,name,role,token_hash) VALUES('lan-shared','局域网协作','lan',?)`,
        )
        .run(hash(randomUUID()));
  }
  close() {
    this.db.close();
  }
  actor(id) {
    return (
      this.db
        .prepare("SELECT id,name,role,disabled FROM actors WHERE id=?")
        .get(id) || null
    );
  }
  authenticate(token) {
    return (
      this.db
        .prepare(
          "SELECT id,name,role,disabled FROM actors WHERE token_hash=? AND disabled=0",
        )
        .get(hash(token || "")) || null
    );
  }
  actors() {
    return this.db
      .prepare("SELECT id,name,role,disabled FROM actors ORDER BY name")
      .all();
  }
  revision() {
    return Number(
      this.db.prepare("SELECT value FROM metadata WHERE key='revision'").get()
        .value,
    );
  }
  workflowMemo() {
    const value =
      this.db.prepare("SELECT value FROM metadata WHERE key='workflow'").get()
        ?.value || "";
    if (this._wfValue !== value) {
      let stored = null;
      if (value) {
        try {
          stored = JSON.parse(value);
        } catch {
          stored = null;
        }
      }
      this._wfValue = value;
      this._wfBase = normalizeWorkflow(stored);
      this._wfCache = new Map();
    }
    return this._wfBase;
  }
  /** Resolved workflow for a project: global template merged with its override. */
  workflow(project = "") {
    const base = this.workflowMemo();
    const key = `${this._wfValue}\u0000${project}`;
    let resolved = this._wfCache.get(key);
    if (!resolved) {
      resolved = resolveWorkflow(base, project);
      if (this._wfCache.size > 64) this._wfCache.clear();
      this._wfCache.set(key, resolved);
    }
    return resolved;
  }
  /** A positive round budget, or null when the value means "inherit". */
  roundBudget(value) {
    if (value === undefined || value === null || value === "") return null;
    const n =
      typeof value === "number"
        ? value
        : Number.parseInt(String(value).trim(), 10);
    return Number.isSafeInteger(n) && n >= 1 ? n : null;
  }
  effectiveMaxRounds(card, workflow, incoming) {
    return (
      this.roundBudget(incoming) ??
      this.roundBudget(card?.max_rounds) ??
      workflow.max_rounds
    );
  }
  /** Add derived stage display fields without rewriting the stored card. */
  decorateCard(card, workflow) {
    if (!card || card.kind !== "work") return card;
    const index = stageIndex(workflow.stages);
    const key =
      card.stage && index.has(card.stage)
        ? card.stage
        : defaultStageForStatus(workflow.stages, card.status);
    const stage = index.get(key);
    const round =
      Number.isSafeInteger(card.round) && card.round >= 1 ? card.round : 1;
    const maxRounds = this.effectiveMaxRounds(card, workflow);
    return {
      ...card,
      stage: key,
      stage_label: stage?.label || key,
      stage_label_en: stage?.label_en || "",
      stage_category: stage?.category || "active",
      stage_deprecated: Boolean(stage?.deprecated),
      round,
      max_rounds: maxRounds,
      // The card's own override, or null when it inherits. A reader that has a
      // fresher project/global budget can resolve the number itself instead of
      // reusing a value that was resolved when its snapshot was taken.
      max_rounds_own: this.roundBudget(card.max_rounds),
      rounds_remaining: Math.max(0, maxRounds - round),
    };
  }
  updateWorkflow(actor, data) {
    fail(
      actor.role === "human",
      "admin_required",
      "Only the human board owner can change the workflow definition.",
      403,
    );
    exactKeys(data, [
      "expected_version",
      "project",
      "stages",
      "max_rounds",
      "initial",
      "reset",
    ]);
    const base = this.workflow("");
    fail(
      Number.isSafeInteger(data.expected_version),
      "version_required",
      "expected_version must be the integer returned by GET /api/workflow.",
    );
    fail(
      base.version === data.expected_version,
      "workflow_conflict",
      "The workflow changed. Read GET /api/workflow, compare, then edit deliberately.",
      409,
      { current: base },
    );
    const project = String(data.project || "").trim();
    fail(
      project.length <= 2000,
      "invalid_workflow",
      "project must be at most 2000 characters.",
    );
    const stored = this.workflowMemo();
    let document;
    if (project) {
      const projects = { ...stored.projects };
      if (data.reset === true) delete projects[project];
      else {
        fail(
          ["stages", "max_rounds", "initial"].some(
            (key) => data[key] !== undefined,
          ),
          "empty_changes",
          `Supply stages, max_rounds or initial for project "${project}", or reset:true to drop its override.`,
        );
        // A project override is edited field by field: keep the parts this
        // request does not mention so a max_rounds-only edit cannot silently
        // drop the project's own stage list or initial stage.
        const override = { ...(projects[project] || {}) };
        if (data.stages !== undefined) override.stages = data.stages;
        if (data.max_rounds !== undefined)
          override.max_rounds = data.max_rounds;
        if (data.initial !== undefined) override.initial = data.initial;
        projects[project] = override;
      }
      document = { ...stored, projects, version: stored.version + 1 };
    } else if (data.reset === true) {
      document = { ...DEFAULT_WORKFLOW, version: stored.version + 1 };
    } else {
      document = {
        ...stored,
        initial: data.initial ?? stored.initial,
        max_rounds: data.max_rounds ?? stored.max_rounds,
        stages: data.stages ?? stored.stages,
        version: stored.version + 1,
      };
    }
    const validated = validateWorkflow(document);
    this.assertCardsCanStillMove(validated, project);
    this.db
      .prepare(
        "INSERT INTO metadata(key,value) VALUES('workflow',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(validated));
    this._wfValue = undefined;
    this._wfCache = null;
    return {
      action: "workflow.updated",
      workflow: this.workflow(project),
      version: validated.version,
    };
  }
  /**
   * A definition edit must not strand cards that already exist: a live card
   * whose stage disappears would fail its next move with unknown_stage, and a
   * non-terminal stage with nowhere to go is a dead end.
   */
  assertCardsCanStillMove(document, project = "") {
    const stranded = [];
    for (const card of this.list("card")) {
      if (card.kind !== "work" || card.archived_at || !card.stage) continue;
      if (project && card.project !== project) continue;
      const index = stageIndex(resolveWorkflow(document, card.project).stages);
      const stage = index.get(card.stage);
      const name = card.work_key || card.id;
      // A listed target that is itself gone or deprecated cannot be entered,
      // so listing one is not a way out: only a live next stage keeps a card
      // movable.
      const reachable = stage
        ? stage.allowed_next.filter((key) => {
            const next = index.get(key);
            return next && !next.deprecated;
          })
        : [];
      if (!stage)
        stranded.push(
          `${name} stands on "${card.stage}", which this definition removes`,
        );
      else if (stage.category !== "terminal" && reachable.length === 0)
        stranded.push(
          stage.allowed_next.length
            ? `${name} stands on "${stage.key}", whose only next stages (${stage.allowed_next.join(", ")}) would all be unreachable`
            : `${name} stands on "${stage.key}", which would have no next stage`,
        );
      if (stranded.length >= 5) break;
    }
    fail(
      !stranded.length,
      "workflow_strands_cards",
      `This definition would leave existing cards unable to move: ${stranded.join("; ")}. Keep those stages, add a reachable next stage, or move the cards first.`,
      409,
      { stranded },
    );
  }
  /**
   * Whether a stage may be entered at all: it must be live and, when it needs a
   * human decision, the actor must be that human. Both update entry points — the
   * stage field and the legacy coarse-status field — share this guard, so the
   * coarse field cannot be used as a side door into a gated stage. Creation
   * applies the same two rules with its own wording.
   */
  requireEnterable(actor, stage) {
    fail(
      !stage.deprecated,
      "stage_deprecated",
      `Stage "${stage.key}" is deprecated and cannot be entered.`,
      409,
    );
    if (stage.human_gate)
      fail(
        actor.role === "human",
        "human_gate_required",
        `Stage "${stage.key}" needs a human decision on the board; an agent cannot promote a card into it.`,
        403,
        { stage: stage.key, human_gate: true },
      );
  }
  /** Validate a stage change, spend a review round and fuse over-long rework. */
  planTransition({ actor, card, workflow, from, to, changes }) {
    const index = stageIndex(workflow.stages);
    const target = index.get(to);
    fail(
      target,
      "unknown_stage",
      `Unknown stage "${to}". Read GET /api/workflow for this project's stages.`,
      400,
      { stages: workflow.stages.map((stage) => stage.key) },
    );
    const currentKey =
      from || defaultStageForStatus(workflow.stages, card.status);
    const current = index.get(currentKey);
    fail(
      current,
      "unknown_stage",
      `This card sits on stage "${currentKey}", which the current workflow does not define.`,
      409,
    );
    fail(
      current.allowed_next.includes(to),
      "invalid_transition",
      `Stage "${currentKey}" cannot move to "${to}". Allowed next: ${current.allowed_next.join(", ") || "none"}.`,
      409,
      { from: currentKey, to, allowed_next: current.allowed_next },
    );
    this.requireEnterable(actor, target);
    // Leaving a halted stage is a recovery, not another round of rework: it
    // spends no budget and is never fused straight back where it came from.
    const leavingHalt = current.category === "halted";
    let nextRound =
      Number.isSafeInteger(card.round) && card.round >= 1 ? card.round : 1;
    if (target.counts_round && !leavingHalt) nextRound += 1;
    // A max_rounds carried by this same edit is the budget in force for it,
    // including an explicit clear, which falls back to the workflow budget.
    const changedBudget = Boolean(
      changes && Object.prototype.hasOwnProperty.call(changes, "max_rounds"),
    );
    const maxRounds = changedBudget
      ? (this.roundBudget(changes.max_rounds) ?? workflow.max_rounds)
      : this.effectiveMaxRounds(card, workflow);
    let stage = target;
    let blocker;
    let reason = "";
    // Only a move that actually spends a round of rework can trip the fuse; a
    // card left over budget by an earlier budget change still finishes its
    // ordinary moves instead of being halted for walking forward.
    if (!leavingHalt && target.counts_round && nextRound > maxRounds) {
      const halted = fuseTarget(workflow.stages);
      fail(
        halted,
        "workflow_invalid",
        "This workflow defines no halted stage an agent may enter, so the round fuse cannot stop rework. Add a halted stage with human_gate false.",
        409,
      );
      if (halted.human_gate)
        fail(
          actor.role === "human",
          "human_gate_required",
          `Stage "${halted.key}" needs a human decision on the board; the round fuse cannot place a card there.`,
          403,
          { stage: halted.key, human_gate: true },
        );
      reason = `Round ${nextRound} exceeded max_rounds ${maxRounds}; the card was fused into ${halted.key}.`;
      stage = halted;
      // The fuse reason is always recorded; an earlier blocker stays behind it.
      const prior = String(changes.blocker || card.blocker || "").trim();
      blocker = prior && prior !== reason ? `${reason} ${prior}` : reason;
    }
    return {
      from: currentKey,
      requested: to,
      stage: stage.key,
      status: stage.status,
      category: stage.category,
      round: nextRound,
      max_rounds: maxRounds,
      blocker,
      reason,
      counts_round: Boolean(target.counts_round) && !leavingHalt,
      human_gate: Boolean(target.human_gate),
      fused: stage.key !== target.key,
      recovered: leavingHalt && stage.key !== currentKey,
    };
  }
  /** One event per (card, revision); the unique index makes it idempotent. */
  recordTransition(card, actor, workflow, plan) {
    const prior = this.db
      .prepare("SELECT seq FROM workflow_events WHERE card_id=? AND revision=?")
      .get(card.id, card.revision);
    if (prior) return null;
    const event = {
      event_id: `${card.id}:${card.revision}`,
      card_id: card.id,
      work_key: card.work_key || "",
      project: card.project,
      revision: card.revision,
      from_stage: plan.from,
      to_stage: card.stage,
      requested_stage: plan.requested,
      category: plan.category,
      round: card.round,
      max_rounds: plan.max_rounds,
      actor: actor.id,
      ...(actor.display_actor
        ? { actor_display: actor.display_actor.name }
        : {}),
      status: card.status,
      implementer: card.implementer || "",
      reviewer: card.reviewer || "",
      tester: card.tester || "",
      pr_url: card.pr_url || "",
      head_sha: card.head_sha || "",
      last_verdict: card.last_verdict || "",
      test_env: card.test_env || "",
      next_step: card.next_step || "",
      ...(plan.reason ? { reason: plan.reason } : {}),
      ...(plan.fused ? { fused: true } : {}),
      ...(plan.entry ? { entry: plan.entry } : {}),
      at: now(),
    };
    const info = this.db
      .prepare(
        "INSERT INTO workflow_events(card_id,revision,document) VALUES(?,?,?)",
      )
      .run(card.id, card.revision, "{}");
    const seq = Number(info.lastInsertRowid);
    event.seq = seq;
    this.db
      .prepare("UPDATE workflow_events SET document=? WHERE seq=?")
      .run(JSON.stringify(event), seq);
    return event;
  }
  /** Highest seq that was dropped by the retention window, 0 when none yet. */
  eventsFloor() {
    const raw = this.db
      .prepare("SELECT value FROM metadata WHERE key='workflow_events_floor'")
      .get()?.value;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  }
  workflowEvents({ after = 0, limit = 100, card_id = "" } = {}) {
    const boundedLimit = Math.max(
      1,
      Math.min(500, Number.isInteger(limit) ? limit : 100),
    );
    const cursor = Number.isInteger(after) && after >= 0 ? after : 0;
    const oldest = this.db
      .prepare("SELECT MIN(seq) AS s FROM workflow_events")
      .get()?.s;
    const retainedFrom = Number.isSafeInteger(oldest) ? oldest : null;
    // A cursor behind the retention window would otherwise look like a clean
    // continuation. Say so, and resume from the oldest event still stored.
    const floor = this.eventsFloor();
    const expired = retainedFrom !== null && cursor < retainedFrom - 1;
    const start = expired ? Math.max(cursor, floor) : cursor;
    const rows = this.db
      .prepare(
        `SELECT seq, document FROM workflow_events WHERE seq > ?${card_id ? " AND card_id = ?" : ""} ORDER BY seq ASC LIMIT ?`,
      )
      .all(start, ...(card_id ? [card_id] : []), boundedLimit + 1)
      .map((row) => decode(row));
    const events = rows.slice(0, boundedLimit);
    return {
      events,
      next_cursor: events.length ? events[events.length - 1].seq : start,
      has_more: rows.length > boundedLimit,
      oldest_seq: retainedFrom,
      ...(expired
        ? {
            gap: {
              after: cursor,
              until: (retainedFrom ?? 1) - 1,
              skipped: (retainedFrom ?? 1) - 1 - cursor,
            },
            resync:
              "This cursor is older than the retained event window. Read GET /api/board for the current card state, then continue from next_cursor; the skipped transitions cannot be replayed.",
          }
        : {}),
    };
  }
  get(id, kind = "card") {
    const entity = decode(
      this.db
        .prepare("SELECT document FROM entities WHERE id=? AND kind=?")
        .get(id, kind),
    );
    fail(
      entity,
      "not_found",
      `${kind} id does not exist. Read the board and use the exact id.`,
      404,
    );
    return entity;
  }
  list(kind) {
    return this.db
      .prepare("SELECT document FROM entities WHERE kind=? ORDER BY rowid")
      .all(kind)
      .map(decode);
  }
  save(kind, entity) {
    this.db
      .prepare(
        `INSERT INTO entities(id,kind,work_key,document) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document`,
      )
      .run(entity.id, kind, entity.work_key || null, JSON.stringify(entity));
    return entity;
  }
  requireOwner(actor, entity) {
    fail(
      this.sharedEdit || actor.role === "human" || entity.owner_id === actor.id,
      "owner_mismatch",
      "This item belongs to another actor. Comment or request an explicit handoff.",
      403,
      { owner_id: entity.owner_id, id: entity.id },
    );
  }
  requireRevision(entity, expected, field = "revision") {
    version(expected, `expected_${field}`);
    fail(
      entity[field] === expected,
      "revision_conflict",
      "The item changed. Read current, compare, and deliberately compose a new request. Do not blindly retry.",
      409,
      { current: entity },
    );
  }
  requireLive(card) {
    fail(
      !card.archived_at,
      "card_archived",
      "This card is archived. Restore it explicitly before editing.",
      409,
      { id: card.id },
    );
  }
  comment(cardId, actor, body, system = false) {
    const item = {
      id: randomUUID(),
      card_id: cardId,
      actor_id: actor.id,
      ...(actor.display_actor
        ? { reported_by: actor.display_actor.name, reported_by_verified: false }
        : {}),
      body,
      system,
      created_at: now(),
    };
    this.db
      .prepare("INSERT INTO comments VALUES(?,?,?)")
      .run(item.id, cardId, JSON.stringify(item));
    return item;
  }
  readCard(
    id,
    { commentsLimit = null, commentsOffset = 0, commentsOrder = "asc" } = {},
  ) {
    const stored = this.get(id);
    const card = this.decorateCard(stored, this.workflow(stored.project));
    const total = Number(
      this.db
        .prepare("SELECT count(*) AS n FROM comments WHERE card_id=?")
        .get(id)?.n || 0,
    );
    const desc = commentsOrder === "desc";
    if (Number.isInteger(commentsLimit) && commentsLimit > 0) {
      const limit = Math.min(200, commentsLimit);
      const offset = Math.max(
        0,
        Number.isInteger(commentsOffset) ? commentsOffset : 0,
      );
      const comments = this.db
        .prepare(
          `SELECT document FROM comments WHERE card_id=? ORDER BY rowid ${desc ? "DESC" : "ASC"} LIMIT ? OFFSET ?`,
        )
        .all(id, limit, offset)
        .map(decode);
      return {
        ...card,
        comments,
        total_comments: total,
        has_more: offset + comments.length < total,
        comments_limit: limit,
        comments_offset: offset,
        comments_order: desc ? "desc" : "asc",
      };
    }
    const comments = this.db
      .prepare(
        `SELECT document FROM comments WHERE card_id=? ORDER BY rowid ${desc ? "DESC" : "ASC"}`,
      )
      .all(id)
      .map(decode);
    return {
      ...card,
      comments,
      total_comments: total,
      has_more: false,
    };
  }
  _commentCounts() {
    return new Map(
      this.db
        .prepare("SELECT card_id,count(*) AS n FROM comments GROUP BY card_id")
        .all()
        .map((x) => [x.card_id, x.n]),
    );
  }
  _topicMap() {
    const map = new Map();
    for (const e of this.list("edge")) {
      if (relationOf(e) === "contains") map.set(e.target, e.source);
    }
    return map;
  }
  listCards({
    project = "",
    kind = "",
    status = "",
    work_key = "",
    topic_id = "",
    instance = "",
    q = "",
    archived = false,
    limit = 50,
    offset = 0,
  } = {}) {
    const boundedLimit = Math.max(
      1,
      Math.min(200, Number.isInteger(limit) ? limit : 50),
    );
    const boundedOffset = Math.max(0, Number.isInteger(offset) ? offset : 0);
    const qLower = String(q || "")
      .trim()
      .toLowerCase();
    const instLower = String(instance || "")
      .trim()
      .toLowerCase();
    const topics = this._topicMap();
    const counts = this._commentCounts();
    const matched = this.list("card")
      .filter((c) => {
        if (!archived && c.archived_at) return false;
        if (project && c.project !== project) return false;
        if (kind && c.kind !== kind) return false;
        if (status && c.status !== status) return false;
        if (work_key && c.work_key !== work_key) return false;
        const cardTopic = topics.get(c.id) || "";
        if (topic_id && cardTopic !== topic_id) return false;
        if (
          instLower &&
          !String(c.instance || "")
            .toLowerCase()
            .includes(instLower)
        )
          return false;
        if (qLower) {
          const hit = [
            c.title,
            c.work_key,
            c.next_step,
            c.blocker,
            c.instance,
            c.branch,
            c.body,
          ].some((v) =>
            String(v || "")
              .toLowerCase()
              .includes(qLower),
          );
          if (!hit) return false;
        }
        return true;
      })
      .sort(
        (a, b) =>
          String(b.updated_at || "").localeCompare(
            String(a.updated_at || ""),
          ) || a.id.localeCompare(b.id),
      );
    const total = matched.length;
    const page = matched
      .slice(boundedOffset, boundedOffset + boundedLimit)
      .map((row) => {
        const c = this.decorateCard(row, this.workflow(row.project));
        const summary = summarizeBody(c.body || "");
        return {
          id: c.id,
          kind: c.kind,
          work_key: c.work_key,
          project: c.project,
          topic_id: topics.get(c.id) || null,
          title: c.title,
          status: c.status,
          stage: c.stage,
          stage_label: c.stage_label,
          stage_category: c.stage_category,
          round: c.round,
          max_rounds: c.max_rounds,
          rounds_remaining: c.rounds_remaining,
          last_verdict: c.last_verdict,
          head_sha: c.head_sha,
          merge_status: c.merge_status,
          pr_url: c.pr_url,
          repository: c.repository,
          branch: c.branch,
          instance: c.instance,
          owner_id: c.owner_id,
          revision: c.revision,
          layout_revision: c.layout_revision,
          next_step: c.next_step,
          blocker: c.blocker,
          announcement: Boolean(c.announcement),
          archived_at: c.archived_at,
          updated_at: c.updated_at,
          updated_by: c.updated_by,
          ...(c.updated_by_display
            ? { updated_by_display: c.updated_by_display }
            : {}),
          comment_count: counts.get(c.id) || 0,
          last_author: summary.last_author,
          body_preview: summary.body_preview,
          body_length: summary.body_length,
        };
      });
    const nextOffset = boundedOffset + page.length;
    const hasMore = nextOffset < total;
    return {
      total,
      limit: boundedLimit,
      offset: boundedOffset,
      has_more: hasMore,
      next_cursor: hasMore ? String(nextOffset) : null,
      cards: page,
    };
  }
  announcements() {
    return this.list("card")
      .filter(
        (c) => c.kind === "note" && c.announcement === true && !c.archived_at,
      )
      .sort(
        (a, b) =>
          b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id),
      );
  }
  snapshot({ project = "", archived = false, compact = false } = {}) {
    const cards = this.list("card").filter(
      (c) =>
        (archived || !c.archived_at) && (!project || c.project === project),
    );
    const ids = new Set(cards.map((c) => c.id));
    const counts = this._commentCounts();
    const workflow = this.workflow(project || "");
    return {
      contract: "hashi_whiteboard/v1",
      revision: this.revision(),
      ...(compact ? { compact: true } : {}),
      workflow: compact
        ? {
            version: workflow.version,
            initial: workflow.initial,
            max_rounds: workflow.max_rounds,
            scope: workflow.scope,
            project: workflow.project,
          }
        : workflow,
      announcements: this.announcements(),
      cards: cards.map((row) => {
        // Each card is projected through its own project's definition, so the
        // board and the card detail cannot disagree about stage or budget.
        const c = this.decorateCard(row, this.workflow(row.project));
        const count = counts.get(c.id) || 0;
        if (!compact) return { ...c, comment_count: count };
        const summary = summarizeBody(c.body || "");
        return {
          ...c,
          body: "",
          last_author: summary.last_author,
          body_preview: summary.body_preview,
          body_length: summary.body_length,
          comment_count: count,
        };
      }),
      edges: this.list("edge").filter(
        (e) => ids.has(e.source) && ids.has(e.target),
      ),
      strokes: this.list("stroke").filter(
        (s) => !project || s.project === project,
      ),
      actors: this.actors(),
      activity: this.db
        .prepare("SELECT document FROM activity ORDER BY seq DESC LIMIT 80")
        .all()
        .map(decode),
    };
  }
  write(actor, key, fingerprint, fn) {
    fail(
      typeof key === "string" && /^[A-Za-z0-9._:-]{8,160}$/.test(key),
      "idempotency_key_required",
      "Send Idempotency-Key (8–160 safe characters; a UUID is recommended).",
    );
    this.db.exec("BEGIN IMMEDIATE");
    let result, event;
    try {
      const prior = this.db
        .prepare("SELECT * FROM operations WHERE actor_id=? AND key=?")
        .get(actor.id, key);
      if (prior) {
        fail(
          prior.fingerprint === fingerprint,
          "idempotency_conflict",
          "This Idempotency-Key was used for a different request.",
          409,
        );
        this.db.exec("COMMIT");
        return JSON.parse(prior.response);
      }
      const value = fn();
      const sequence = this.revision() + 1;
      this.db
        .prepare("UPDATE metadata SET value=? WHERE key='revision'")
        .run(String(sequence));
      event = {
        seq: sequence,
        actor_id: actor.id,
        ...(actor.display_actor
          ? {
              reported_by: actor.display_actor.name,
              reported_by_verified: false,
            }
          : {}),
        action: value.action,
        item_id:
          value.item_id ||
          value.card?.id ||
          value.edge?.id ||
          value.stroke?.id ||
          null,
        ...(value.card?.project ? { project: value.card.project } : {}),
        at: now(),
      };
      this.db
        .prepare("INSERT INTO activity(document) VALUES(?)")
        .run(JSON.stringify(event));
      result = { ...value, board_revision: sequence };
      this.db
        .prepare("INSERT INTO operations VALUES(?,?,?,?,?)")
        .run(actor.id, key, fingerprint, JSON.stringify(result), now());
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
    // Notification delivery cannot turn a committed operation into a failed write.
    try {
      this.onChange?.(event);
    } catch (error) {
      console.error("Board event delivery failed:", error.message);
    }
    return result;
  }
  createCard(actor, data) {
    exactKeys(data, ["kind", "work_key", "topic_id", ...CARD_FIELDS]);
    const { topic_id, ...fields } = data;
    const content = withoutEmptyWorkflowFields(cardContent(fields));
    const prior = content.work_key
      ? decode(
          this.db
            .prepare(
              "SELECT document FROM entities WHERE work_key=? AND kind='card'",
            )
            .get(content.work_key),
        )
      : null;
    fail(
      !prior,
      "work_key_exists",
      "This work_key already exists. Read its exact card; do not create a duplicate.",
      409,
      {
        existing_id: prior?.id,
        owner_id: prior?.owner_id,
        archived: Boolean(prior?.archived_at),
      },
    );
    if (content.kind === "work" && !topic_id) {
      const topics = this.list("card")
        .filter(
          (c) =>
            c.kind === "topic" &&
            !c.archived_at &&
            c.project === content.project,
        )
        .map((t) => ({
          id: t.id,
          work_key: t.work_key,
          title: t.title,
          project: t.project,
        }));
      fail(
        false,
        "topic_required",
        "New work requires topic_id. Read the board, reuse a topic in the same project, or create kind:topic with a stable work_key first.",
        400,
        { required_fields: ["topic_id"], project: content.project, topics },
      );
    }
    let topic;
    if (topic_id) {
      topic = this.get(text(topic_id, "topic_id", 80, true));
      this.requireLive(topic);
      fail(
        topic.kind === "topic" && content.kind !== "topic",
        "invalid_membership",
        "Choose an existing topic card; topics cannot be nested.",
      );
      fail(
        topic.project === content.project,
        "project_mismatch",
        "Topic and new card must use the same project.",
      );
    }
    fail(
      this.list("card").length < 2000,
      "board_full",
      "Archive and clear old work before adding more cards.",
      409,
    );
    if (content.asset_id)
      fail(
        this.asset(content.asset_id),
        "asset_not_found",
        "asset_id does not exist.",
        404,
      );
    const workflow = this.workflow(content.project);
    let stageKey = "";
    if (content.kind === "work") {
      const index = stageIndex(workflow.stages);
      // An explicit stage wins; otherwise the coarse status picks the stage, so
      // a card cannot be born on "initiated" while claiming it is done.
      stageKey =
        content.stage ||
        (content.status === "planned"
          ? workflow.initial
          : defaultStageForStatus(workflow.stages, content.status));
      const stage = index.get(stageKey);
      fail(
        stage,
        "unknown_stage",
        `Unknown stage "${stageKey}". Read GET /api/workflow for this project's stages.`,
        400,
        { stages: workflow.stages.map((s) => s.key) },
      );
      fail(
        !stage.deprecated,
        "stage_deprecated",
        `Stage "${stageKey}" is deprecated and cannot be entered.`,
        409,
      );
      if (stage.human_gate)
        fail(
          actor.role === "human",
          "human_gate_required",
          `Stage "${stageKey}" needs a human decision; create the card on an earlier stage instead.`,
          403,
          { stage: stageKey, human_gate: true },
        );
      // The coarse status always follows the stage that was actually chosen.
      if (content.status !== stage.status) {
        content.status = stage.status;
        if (content.status === "blocked")
          fail(
            content.blocker,
            "blocker_required",
            "A blocked work card must explain blocker.",
          );
        if (content.status === "done")
          fail(
            content.body,
            "result_required",
            "A completed work card must describe the result in body.",
          );
      }
    }
    const cardPosition = newCardPosition(
      content.project,
      this.list("card").filter((c) => !c.announcement),
    );
    const card = {
      ...content,
      ...(content.kind === "work" ? { stage: stageKey, round: 1 } : {}),
      id: randomUUID(),
      owner_id: actor.id,
      created_by: actor.id,
      revision: 1,
      layout_revision: 1,
      position: cardPosition,
      created_at: now(),
      updated_at: now(),
      updated_by: actor.id,
      ...(actor.display_actor
        ? { updated_by_display: actor.display_actor }
        : {}),
      archived_at: null,
    };
    this.save("card", card);
    const edge = topic
      ? this.addEdge(actor, {
          source: topic.id,
          target: card.id,
          relation: "contains",
          label: "主题归属",
        }).edge
      : null;
    return {
      action: "card.created",
      card: this.decorateCard(card, workflow),
      ...(edge ? { edge } : {}),
    };
  }
  updateCard(actor, id, data) {
    exactKeys(data, ["expected_revision", "changes"]);
    const card = this.get(id);
    this.requireOwner(actor, card);
    this.requireLive(card);
    this.requireRevision(card, data.expected_revision);
    fail(
      data.changes && Object.keys(data.changes).length,
      "empty_changes",
      "Supply at least one changed content field.",
    );
    const changes = { ...data.changes };
    const workflow = this.workflow(String(changes.project ?? card.project));
    const storedStage = card.stage || "";
    const index = stageIndex(workflow.stages);
    let plan = null;
    // Where the card stands. A card that predates the feature has no stored
    // stage, so it stands on whatever its coarse status resolves to — the same
    // stage a reader sees. That is the "from" its first explicit pick must be
    // judged against; using an empty "from" would let that pick skip the graph,
    // the human gate and the event.
    const fromStage =
      storedStage || defaultStageForStatus(workflow.stages, card.status);
    // A card that never used the feature keeps its coarse status as an ordinary
    // content edit and its stage derived on read; once it names a stage, every
    // way of moving it — the stage field, the legacy coarse status field, or
    // both in one edit — travels the same validated transition, so no field can
    // move a card the graph forbids.
    if (card.kind === "work") {
      const sendsStage = changes.stage !== undefined;
      const sendsStatus = changes.status !== undefined;
      // The detail panel offers an empty stage as "follow the work status", so
      // only a named stage is a deliberate pick; an empty one is resolved from
      // the coarse status exactly like a status edit.
      const explicit = sendsStage ? String(changes.stage ?? "").trim() : "";
      const wantedStatus = sendsStatus
        ? String(changes.status ?? "").trim()
        : "";
      // A coarse status that really changed asks for the stage carrying it; an
      // unchanged one asks for no move at all.
      const derived =
        !explicit && wantedStatus && wantedStatus !== card.status
          ? defaultStageForStatus(workflow.stages, wantedStatus)
          : "";
      const requested = explicit || derived;
      const target = requested ? index.get(requested) : null;
      // A stage and a status sent together must agree. Applying half of the
      // pair would store a card whose stage and status contradict each other.
      if (explicit && wantedStatus && target)
        fail(
          wantedStatus === target.status,
          "status_stage_conflict",
          `Stage "${target.key}" carries status "${target.status}", but this edit also asks for "${wantedStatus}". Send the stage alone to move the card, or send the status alone so it can pick the stage.`,
          409,
          {
            stage: target.key,
            status: target.status,
            requested_status: wantedStatus,
          },
        );
      // A legacy card only moves when it names a stage; a coarse-status-only
      // edit stays the old content edit it always was.
      const moves = storedStage
        ? Boolean(requested) && requested !== fromStage
        : Boolean(explicit) && explicit !== fromStage;
      if (moves) {
        plan = this.planTransition({
          actor,
          card,
          workflow,
          from: fromStage,
          to: requested,
          changes,
        });
        // Which field moved the card is recorded on the event; the rules, the
        // round budget in force and the fuse are the same either way.
        if (!explicit) plan.entry = "status";
        changes.stage = plan.stage;
        changes.status = plan.status;
        if (plan.blocker !== undefined) changes.blocker = plan.blocker;
      }
    }
    const content = withoutEmptyWorkflowFields(
      cardContent(changes, card),
      card,
    );
    if (content.project !== card.project) {
      fail(
        !this.list("edge").some(
          (e) =>
            relationOf(e) === "contains" &&
            (e.source === id || e.target === id),
        ),
        "project_has_topic",
        "A linked card cannot change projects. Keep the current project and topic; do not break membership.",
        409,
      );
    }
    if (content.asset_id)
      fail(
        this.asset(content.asset_id),
        "asset_not_found",
        "asset_id does not exist.",
        404,
      );
    const next = applyUpdatedBy(card, actor, {
      ...content,
      ...(card.kind === "work" && (content.stage || storedStage)
        ? {
            stage: content.stage || storedStage,
            round: plan
              ? plan.round
              : Number.isSafeInteger(card.round) && card.round >= 1
                ? card.round
                : 1,
          }
        : {}),
      revision: card.revision + 1,
    });
    this.save("card", next);
    const chosen = plan;
    // One event per real stage move; an edit that leaves the stage in place
    // (a fused card asked to re-enter its own stage) records nothing.
    const moved =
      chosen &&
      (chosen.stage !== storedStage ||
        chosen.round !==
          (Number.isSafeInteger(card.round) && card.round >= 1
            ? card.round
            : 1));
    const transition = moved
      ? this.recordTransition(next, actor, workflow, chosen)
      : null;
    return {
      action: "card.updated",
      card: this.decorateCard(next, workflow),
      ...(transition ? { transition } : {}),
    };
  }
  layout(actor, id, data) {
    exactKeys(data, ["expected_layout_revision", "position"]);
    const card = this.get(id);
    this.requireOwner(actor, card);
    this.requireLive(card);
    this.requireRevision(
      card,
      data.expected_layout_revision,
      "layout_revision",
    );
    const next = {
      ...card,
      position: position(data.position),
      layout_revision: card.layout_revision + 1,
    };
    this.save("card", next);
    return { action: "card.moved", card: next };
  }
  addComment(actor, id, data) {
    exactKeys(data, ["body"]);
    const card = this.get(id);
    this.requireLive(card);
    const comment = this.comment(
      id,
      actor,
      text(data.body, "body", 8000, true),
    );
    return { action: "comment.added", item_id: id, comment };
  }
  archive(actor, id, data) {
    exactKeys(data, ["expected_revision", "archived"]);
    const card = this.get(id);
    this.requireOwner(actor, card);
    this.requireRevision(card, data.expected_revision);
    fail(
      typeof data.archived === "boolean",
      "invalid_archived",
      "archived must be true or false.",
    );
    if (data.archived && card.kind === "topic") {
      const live = new Set(
        this.list("card")
          .filter((c) => !c.archived_at)
          .map((c) => c.id),
      );
      fail(
        !this.list("edge").some(
          (e) =>
            relationOf(e) === "contains" &&
            e.source === id &&
            live.has(e.target),
        ),
        "topic_not_empty",
        "Move or archive the topic's active cards before archiving it.",
        409,
      );
    }
    if (!data.archived) {
      const parent = this.list("edge").find(
        (e) => relationOf(e) === "contains" && e.target === id,
      );
      if (parent) this.requireLive(this.get(parent.source));
    }
    const next = applyUpdatedBy(card, actor, {
      archived_at: data.archived ? now() : null,
      revision: card.revision + 1,
    });
    this.save("card", next);
    return {
      action: data.archived ? "card.archived" : "card.restored",
      card: next,
    };
  }
  handoff(actor, id, data) {
    exactKeys(data, ["expected_revision", "new_owner_id", "note"]);
    const card = this.get(id);
    this.requireOwner(actor, card);
    this.requireLive(card);
    this.requireRevision(card, data.expected_revision);
    const nextOwner = this.actor(
      text(data.new_owner_id, "new_owner_id", 80, true),
    );
    fail(
      nextOwner && !nextOwner.disabled,
      "actor_not_found",
      "Choose an exact, active actor id from the board.",
      404,
    );
    const note = text(data.note, "note", 4000, true);
    const next = applyUpdatedBy(card, actor, {
      owner_id: nextOwner.id,
      revision: card.revision + 1,
    });
    this.save("card", next);
    this.comment(
      id,
      actor,
      `Handoff ${card.owner_id} → ${nextOwner.id}: ${note}`,
      true,
    );
    return { action: "card.handed_off", card: next };
  }
  createActor(actor, data) {
    fail(
      actor.role === "human",
      "admin_required",
      "Only the human owner can register an actor.",
      403,
    );
    exactKeys(data, ["name"]);
    const name = text(data.name, "name", 100, true);
    const normalized = name.normalize("NFKC").toLowerCase();
    fail(
      !this.actors().some(
        (a) =>
          !a.disabled && a.name.normalize("NFKC").toLowerCase() === normalized,
      ),
      "actor_name_exists",
      "An active actor already uses this display name. Include the instance or choose a distinct name.",
      409,
    );
    const token = `wb_${randomBytes(32).toString("base64url")}`,
      id = randomUUID();
    this.db
      .prepare("INSERT INTO actors(id,name,role,token_hash) VALUES(?,?,?,?)")
      .run(id, name, "agent", hash(token));
    return {
      action: "actor.created",
      item_id: id,
      actor: this.actor(id),
      token,
    };
  }
  revokeActor(actor, id) {
    fail(
      actor.role === "human",
      "admin_required",
      "Only the human owner can revoke an actor.",
      403,
    );
    fail(
      !["human-owner", "lan-shared"].includes(id) && this.actor(id),
      "invalid_actor",
      "Select a registered agent id.",
    );
    this.db.prepare("UPDATE actors SET disabled=1 WHERE id=?").run(id);
    return { action: "actor.revoked", item_id: id };
  }
  addEdge(actor, data) {
    exactKeys(data, ["source", "target", "label", "relation"]);
    const source = this.get(text(data.source, "source", 80, true)),
      target = this.get(text(data.target, "target", 80, true));
    this.requireOwner(actor, data.relation === "contains" ? target : source);
    this.requireLive(source);
    this.requireLive(target);
    const label = text(data.label ?? "", "label", 160);
    validateConnection(
      source,
      target,
      data.relation,
      label,
      this.list("card"),
      this.list("edge"),
    );
    fail(
      this.list("edge").length < 5000,
      "board_full",
      "Too many connections.",
      409,
    );
    const edge = {
      id: randomUUID(),
      source: source.id,
      target: target.id,
      label,
      relation: data.relation,
      owner_id: actor.id,
      revision: 1,
      created_at: now(),
    };
    this.save("edge", edge);
    return { action: "edge.created", edge };
  }
  setTopic(actor, id, data) {
    exactKeys(data, ["expected_topic_id", "topic_id"]);
    text(data.expected_topic_id, "expected_topic_id", 80);
    const card = this.get(id);
    this.requireOwner(actor, card);
    this.requireLive(card);
    const current = this.list("edge").find(
      (e) => relationOf(e) === "contains" && e.target === id,
    );
    fail(
      (data.expected_topic_id ?? "") === (current?.source || ""),
      "topic_conflict",
      "Topic membership changed. Read the board and compare before moving this card.",
      409,
      { topic_id: current?.source || "" },
    );
    if (current?.source === data.topic_id)
      return { action: "topic.unchanged", item_id: id, edge: current };
    if (current)
      this.db.prepare("DELETE FROM entities WHERE id=?").run(current.id);
    const { edge } = this.addEdge(actor, {
      source: data.topic_id,
      target: id,
      relation: "contains",
      label: "主题归属",
    });
    const edges = this.list("edge");
    const siblings = new Set(
      edges
        .filter(
          (e) => relationOf(e) === "contains" && e.source === data.topic_id,
        )
        .map((e) => e.target),
    );
    const redundant = edges.filter(
      (e) =>
        relationOf(e) === "related" &&
        ((e.source === id && siblings.has(e.target)) ||
          (e.target === id && siblings.has(e.source))),
    );
    for (const e of redundant) this.requireOwner(actor, e);
    for (const e of redundant)
      this.db.prepare("DELETE FROM entities WHERE id=?").run(e.id);
    return {
      action: "topic.changed",
      item_id: id,
      edge,
      removed_related_edges: redundant.map((e) => e.id),
    };
  }
  graphStamp(project) {
    const cards = this.list("card").filter(
      (c) =>
        !c.archived_at &&
        !c.announcement &&
        (!project || c.project === project),
    );
    const ids = new Set(cards.map((c) => c.id));
    return hash(
      JSON.stringify({
        cards: cards.map((c) => [c.id, c.project, c.kind]).sort(),
        edges: this.list("edge")
          .filter((e) => ids.has(e.source) || ids.has(e.target))
          .map((e) => [e.id, e.source, e.target, relationOf(e)])
          .sort(),
      }),
    );
  }
  tidy(actor, data) {
    exactKeys(data, ["project", "expected_revision", "measurements"]);
    fail(
      Number.isSafeInteger(data.expected_revision) &&
        this.revision() === data.expected_revision,
      "board_changed",
      "The board changed. Read the latest snapshot, review, then arrange again.",
      409,
    );
    const project = text(data.project ?? "", "project", 2000);
    const cards = this.list("card").filter(
      (c) =>
        !c.archived_at &&
        !c.announcement &&
        (!project || c.project === project),
    );
    for (const c of cards) this.requireOwner(actor, c);
    const measurements = data.measurements || [];
    fail(
      Array.isArray(measurements) && measurements.length <= 2000,
      "invalid_measurements",
      "Supply at most 2000 measured card sizes.",
    );
    const seen = new Set();
    for (const m of measurements) {
      exactKeys(m, ["id", "width", "height"]);
      fail(
        typeof m.id === "string" &&
          !seen.has(m.id) &&
          Number.isFinite(m.width) &&
          m.width >= 32 &&
          m.width <= 2000 &&
          Number.isFinite(m.height) &&
          m.height >= 24 &&
          m.height <= 2000,
        "invalid_measurements",
        "Sizes must be finite, positive and unique per card (max 2000 px).",
      );
      seen.add(m.id);
    }
    const ids = new Set(cards.map((c) => c.id));
    const edges = this.list("edge").filter(
      (e) => ids.has(e.source) && ids.has(e.target),
    );
    const positions = tidyProjects(cards, edges, measurements);
    // A single-project arrange must not overlap other project lanes.
    if (project && positions.length) {
      const offset =
        Math.min(...cards.map((c) => c.position.x)) -
        Math.min(...positions.map((c) => c.position.x));
      for (const p of positions) p.position.x += offset;
      const measured = new Map(measurements.map((m) => [m.id, m]));
      const others = this.list("card").filter(
        (c) => !c.archived_at && !c.announcement && c.project !== project,
      );
      for (const p of positions)
        for (const other of others) {
          const h = measured.get(p.id)?.height || 650,
            oh = measured.get(other.id)?.height || 650;
          fail(
            !(
              p.position.x < other.position.x + 316 &&
              p.position.x + 316 > other.position.x &&
              p.position.y < other.position.y + oh + 24 &&
              p.position.y + h + 24 > other.position.y
            ),
            "layout_scope_overlap",
            "This project needs more space. Arrange the whole board to keep projects apart.",
            409,
          );
        }
    }
    const byId = new Map(cards.map((c) => [c.id, c]));
    const moves = positions.filter((p) => {
      position(p.position);
      const c = byId.get(p.id);
      return c.position.x !== p.position.x || c.position.y !== p.position.y;
    });
    if (!moves.length)
      return { action: "layout.unchanged", layout_id: null, moved: 0 };
    const before = [],
      after = [];
    for (const p of moves) {
      const c = byId.get(p.id);
      before.push({ id: c.id, position: c.position });
      const next = {
        ...c,
        position: p.position,
        layout_revision: c.layout_revision + 1,
      };
      this.save("card", next);
      after.push({ id: c.id, layout_revision: next.layout_revision });
    }
    const record = {
      id: randomUUID(),
      actor_id: actor.id,
      project,
      before,
      after: cards.map((c) => ({
        id: c.id,
        layout_revision: this.get(c.id).layout_revision,
      })),
      graph: this.graphStamp(project),
      at: now(),
    };
    this.db
      .prepare("INSERT INTO layouts VALUES(?,?)")
      .run(record.id, JSON.stringify(record));
    this.db.exec(
      "DELETE FROM layouts WHERE rowid NOT IN (SELECT rowid FROM layouts ORDER BY rowid DESC LIMIT 20)",
    );
    return {
      action: "layout.tidied",
      layout_id: record.id,
      moved: moves.length,
    };
  }
  undoLayout(actor, data) {
    exactKeys(data, ["layout_id"]);
    const record = decode(
      this.db
        .prepare("SELECT document FROM layouts WHERE id=?")
        .get(text(data.layout_id, "layout_id", 80, true)),
    );
    fail(
      record && !record.undone,
      "layout_expired",
      "This layout is no longer undoable. Only the last 20 arrangements are retained.",
      409,
    );
    fail(
      this.sharedEdit || actor.role === "human" || record.actor_id === actor.id,
      "owner_mismatch",
      "Only the arranger or board owner may undo this layout.",
      403,
    );
    fail(
      record.graph === this.graphStamp(record.project),
      "layout_conflict",
      "Cards or relationships changed after arrangement. Undo was cancelled; nothing moved.",
      409,
    );
    for (const after of record.after) {
      const c = this.get(after.id);
      this.requireOwner(actor, c);
      this.requireRevision(c, after.layout_revision, "layout_revision");
    }
    for (const before of record.before) {
      const c = this.get(before.id);
      this.save("card", {
        ...c,
        position: before.position,
        layout_revision: c.layout_revision + 1,
      });
    }
    record.undone = now();
    this.db
      .prepare("UPDATE layouts SET document=? WHERE id=?")
      .run(JSON.stringify(record), record.id);
    return { action: "layout.undone", moved: record.before.length };
  }
  addStroke(actor, data) {
    exactKeys(data, ["points", "color", "width", "project"]);
    fail(
      Array.isArray(data.points) &&
        data.points.length >= 2 &&
        data.points.length <= 4096,
      "invalid_points",
      "points must contain 2–4096 [x,y] positions.",
    );
    const points = data.points.map((p) => {
      fail(
        Array.isArray(p) &&
          p.length === 2 &&
          p.every((n) => Number.isFinite(n) && Math.abs(n) <= 100000),
        "invalid_points",
        "Each point must be a finite [x,y] pair within ±100000.",
      );
      return p;
    });
    const color = data.color || "#355bd9",
      width = data.width ?? 3;
    fail(
      /^#[a-f0-9]{6}$/i.test(color) &&
        Number.isFinite(width) &&
        width >= 1 &&
        width <= 12,
      "invalid_pen",
      "color must be #RRGGBB; width 1–12.",
    );
    fail(
      this.list("stroke").length < 5000,
      "board_full",
      "Clear old drawings before adding more.",
      409,
    );
    const stroke = {
      id: randomUUID(),
      points,
      color,
      width,
      project: text(data.project ?? "general", "project", 2000, true),
      owner_id: actor.id,
      revision: 1,
      created_at: now(),
    };
    this.save("stroke", stroke);
    return { action: "stroke.created", stroke };
  }
  removeEntity(actor, id, kind, data) {
    exactKeys(data, ["expected_revision"]);
    const entity = this.get(id, kind);
    this.requireOwner(actor, entity);
    this.requireRevision(entity, data.expected_revision);
    if (kind === "edge" && relationOf(entity) === "contains") {
      const child = this.get(entity.target);
      fail(
        child.kind !== "work" || child.archived_at,
        "membership_required",
        "Move a work card with /api/cards/:id/topic; do not delete its only topic connection.",
        409,
      );
    }
    this.db.prepare("DELETE FROM entities WHERE id=? AND kind=?").run(id, kind);
    return { action: `${kind}.removed`, item_id: id };
  }
  asset(id) {
    return this.db.prepare("SELECT * FROM assets WHERE id=?").get(id) || null;
  }
  addAsset(buffer) {
    let mime = "";
    if (
      buffer
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      mime = "image/png";
    else if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255)
      mime = "image/jpeg";
    else if (["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString()))
      mime = "image/gif";
    else if (
      buffer.subarray(0, 4).toString() === "RIFF" &&
      buffer.subarray(8, 12).toString() === "WEBP"
    )
      mime = "image/webp";
    fail(
      mime,
      "invalid_image",
      "Only PNG, JPEG, GIF and WebP images are supported.",
    );
    const total = this.db
      .prepare("SELECT coalesce(sum(length(body)),0) AS n FROM assets")
      .get().n;
    fail(
      total + buffer.length <= 512 * 1024 * 1024,
      "assets_full",
      "Image storage limit (512 MB) reached. Clear archived content.",
      413,
    );
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO assets VALUES(?,?,?,?)")
      .run(id, mime, buffer, now());
    return { action: "asset.uploaded", item_id: id, asset_id: id, mime };
  }
  prune(timestamp = Date.now()) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const expired = this.list("card").filter(
        (c) =>
          c.archived_at &&
          timestamp - Date.parse(c.archived_at) > 14 * 86400000,
      );
      for (const c of expired) {
        this.db.prepare("DELETE FROM entities WHERE id=?").run(c.id);
        this.db.prepare("DELETE FROM comments WHERE card_id=?").run(c.id);
      }
      const ids = new Set(this.list("card").map((c) => c.id));
      for (const e of this.list("edge"))
        if (!ids.has(e.source) || !ids.has(e.target))
          this.db.prepare("DELETE FROM entities WHERE id=?").run(e.id);
      const used = new Set(
        this.list("card")
          .map((c) => c.asset_id)
          .filter(Boolean),
      );
      for (const a of this.db.prepare("SELECT id,created_at FROM assets").all())
        if (!used.has(a.id) && timestamp - Date.parse(a.created_at) > 86400000)
          this.db.prepare("DELETE FROM assets WHERE id=?").run(a.id);
      this.db
        .prepare("DELETE FROM operations WHERE created_at<?")
        .run(new Date(timestamp - 7 * 86400000).toISOString());
      this.db.exec(
        "DELETE FROM activity WHERE seq NOT IN (SELECT seq FROM activity ORDER BY seq DESC LIMIT 2000)",
      );
      this.db.exec(
        "DELETE FROM workflow_events WHERE seq NOT IN (SELECT seq FROM workflow_events ORDER BY seq DESC LIMIT 5000)",
      );
      // Remember the last seq the window dropped so a late consumer is told
      // its cursor expired instead of silently resuming with a hole.
      const retained = this.db
        .prepare("SELECT MIN(seq) AS s FROM workflow_events")
        .get()?.s;
      if (Number.isSafeInteger(retained) && retained - 1 > this.eventsFloor())
        this.db
          .prepare(
            "INSERT INTO metadata(key,value) VALUES('workflow_events_floor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          )
          .run(String(retained - 1));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

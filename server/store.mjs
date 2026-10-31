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
} from "../shared/contract.mjs";
import { newCardPosition } from "../shared/layout.mjs";
import { relationOf, validateConnection } from "../shared/relations.mjs";
import { tidyProjects } from "../shared/tidy.mjs";

export const hash = (value) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const decode = (row) => (row ? JSON.parse(row.document) : null);
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
      CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, card_id TEXT NOT NULL, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (actor_id TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(actor_id,key));
      CREATE TABLE IF NOT EXISTS activity (seq INTEGER PRIMARY KEY AUTOINCREMENT, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, mime TEXT NOT NULL, body BLOB NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS layouts (id TEXT PRIMARY KEY, document TEXT NOT NULL);
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
      body,
      system,
      created_at: now(),
    };
    this.db
      .prepare("INSERT INTO comments VALUES(?,?,?)")
      .run(item.id, cardId, JSON.stringify(item));
    return item;
  }
  readCard(id) {
    const card = this.get(id);
    return {
      ...card,
      comments: this.db
        .prepare("SELECT document FROM comments WHERE card_id=? ORDER BY rowid")
        .all(id)
        .map(decode),
    };
  }
  snapshot({ project = "", archived = false } = {}) {
    const cards = this.list("card").filter(
      (c) =>
        (archived || !c.archived_at) && (!project || c.project === project),
    );
    const ids = new Set(cards.map((c) => c.id));
    const counts = new Map(
      this.db
        .prepare("SELECT card_id,count(*) AS n FROM comments GROUP BY card_id")
        .all()
        .map((x) => [x.card_id, x.n]),
    );
    return {
      contract: "hashi_whiteboard/v1",
      revision: this.revision(),
      cards: cards.map((c) => ({ ...c, comment_count: counts.get(c.id) || 0 })),
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
        action: value.action,
        item_id:
          value.item_id ||
          value.card?.id ||
          value.edge?.id ||
          value.stroke?.id ||
          null,
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
    const content = cardContent(fields);
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
    fail(
      content.kind !== "work" || topic_id,
      "topic_required",
      "New work requires topic_id. Read the board, reuse a topic in the same project, or create kind:topic with a stable work_key first.",
    );
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
    const cardPosition = newCardPosition(content.project, this.list("card"));
    const card = {
      ...content,
      id: randomUUID(),
      owner_id: actor.id,
      created_by: actor.id,
      revision: 1,
      layout_revision: 1,
      position: cardPosition,
      created_at: now(),
      updated_at: now(),
      updated_by: actor.id,
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
    return { action: "card.created", card, ...(edge ? { edge } : {}) };
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
    const content = cardContent(data.changes, card);
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
    const next = {
      ...card,
      ...content,
      revision: card.revision + 1,
      updated_at: now(),
      updated_by: actor.id,
    };
    this.save("card", next);
    return { action: "card.updated", card: next };
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
    const next = {
      ...card,
      archived_at: data.archived ? now() : null,
      revision: card.revision + 1,
      updated_at: now(),
      updated_by: actor.id,
    };
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
    const next = {
      ...card,
      owner_id: nextOwner.id,
      revision: card.revision + 1,
      updated_at: now(),
      updated_by: actor.id,
    };
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
      (c) => !c.archived_at && (!project || c.project === project),
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
      (c) => !c.archived_at && (!project || c.project === project),
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
        (c) => !c.archived_at && c.project !== project,
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
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

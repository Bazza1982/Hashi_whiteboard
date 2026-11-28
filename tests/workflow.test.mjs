import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, work, ADMIN } from "./helpers.mjs";

const patch = async (f, id, token, changes, key = randomUUID()) => {
  const read = await f.call(`/api/cards/${id}`, { token });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  return f.call(`/api/cards/${id}`, {
    token,
    method: "PATCH",
    key,
    body: { expected_revision: read.body.card.revision, changes },
  });
};

const createWork = async (f, key, extra = {}, token = ADMIN) =>
  f.call("/api/cards", {
    token,
    method: "POST",
    body: await f.work(key, extra),
  });

test("the workflow is data: stages can be added and relabelled without touching old cards", async (t) => {
  const f = await fixture();
  t.after(() => f.close());

  const initial = await f.call("/api/workflow");
  assert.equal(initial.status, 200);
  const keys = initial.body.workflow.stages.map((s) => s.key);
  for (const key of [
    "initiated",
    "claimed",
    "working",
    "in_review",
    "changes_requested",
    "testing",
    "approved",
    "merged",
    "deployed",
    "completed",
    "archived",
    "blocked",
  ])
    assert.ok(keys.includes(key), `default workflow is missing ${key}`);
  assert.equal(initial.body.workflow.max_rounds, 3);
  assert.equal(initial.body.workflow.scope, "global");

  // Add a custom stage and let "working" reach it, plus relabel "in_review".
  const stages = initial.body.workflow.stages.map((stage) =>
    stage.key === "working"
      ? { ...stage, allowed_next: [...stage.allowed_next, "signed_off"] }
      : stage.key === "in_review"
        ? { ...stage, label: "等评审中" }
        : stage,
  );
  stages.push({
    key: "signed_off",
    label: "已验收签字",
    label_en: "Signed off",
    category: "terminal",
    status: "done",
    allowed_next: [],
    human_gate: false,
    counts_round: false,
  });
  const updated = await f.call("/api/workflow", {
    method: "PUT",
    body: { expected_version: initial.body.workflow.version, stages },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.version, initial.body.workflow.version + 1);

  const after = await f.call("/api/workflow");
  const index = new Map(after.body.workflow.stages.map((s) => [s.key, s]));
  assert.equal(index.get("signed_off").label, "已验收签字");
  assert.equal(index.get("in_review").label, "等评审中");

  // A card can now use the new stage, and the label is resolved on read.
  const created = await createWork(f, "workflow/custom-stage", {
    body: "result recorded",
  });
  const card = created.body.card;
  assert.equal(card.stage, "initiated");
  assert.equal(card.round, 1);
  assert.equal(card.max_rounds, 3);
  for (const stage of ["claimed", "working", "signed_off"]) {
    const moved = await patch(f, card.id, ADMIN, { stage });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.card.stage, stage);
  }
  const read = await f.call(`/api/cards/${card.id}`);
  assert.equal(read.body.card.stage_label, "已验收签字");
  assert.equal(read.body.card.stage_category, "terminal");
  assert.equal(read.body.card.status, "done");
});

test("cards created before the feature stay readable and are only written when moved", async (t) => {
  const f = await fixture();
  t.after(() => f.close());

  // Simulate a legacy row: no stage, no round, coarse status only.
  const legacy = {
    kind: "work",
    work_key: "workflow/legacy-card",
    title: "旧卡",
    body: "old body",
    project: "acceptance",
    status: "in_progress",
    next_step: "",
    blocker: "",
    repository: "",
    branch: "",
    instance: "",
    pr_url: "",
    merge_status: "not_opened",
    asset_id: "",
    announcement: false,
    id: randomUUID(),
    owner_id: "human-owner",
    created_by: "human-owner",
    revision: 1,
    layout_revision: 1,
    position: { x: 0, y: 0 },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    updated_by: "human-owner",
    archived_at: null,
  };
  f.store.save("card", legacy);

  const read = await f.call(`/api/cards/${legacy.id}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.card.stage, "working");
  assert.equal(read.body.card.stage_label, "进行中");
  assert.equal(read.body.card.round, 1);

  // A plain content edit must not invent workflow fields on the stored card.
  const edited = await patch(f, legacy.id, ADMIN, { title: "旧卡改名" });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const stored = f.store.get(legacy.id);
  assert.equal(stored.stage, undefined);
  assert.equal(stored.round, undefined);
  assert.equal(stored.title, "旧卡改名");

  // Moving it once persists an explicit stage and round.
  const moved = await patch(f, legacy.id, ADMIN, { stage: "in_review" });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const afterMove = f.store.get(legacy.id);
  assert.equal(afterMove.stage, "in_review");
  assert.equal(afterMove.round, 1);
});

test("only allowed transitions pass and the rejection names the allowed next stages", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const created = await createWork(f, "workflow/transitions");
  const id = created.body.card.id;

  const illegal = await patch(f, id, ADMIN, { stage: "merged" });
  assert.equal(illegal.status, 409);
  assert.equal(illegal.body.error.code, "invalid_transition");
  assert.deepEqual(illegal.body.error.allowed_next, [
    "claimed",
    "working",
    "blocked",
    "archived",
  ]);

  const unknown = await patch(f, id, ADMIN, { stage: "not_a_stage" });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, "unknown_stage");
  assert.ok(unknown.body.error.stages.includes("initiated"));

  for (const stage of ["claimed", "working", "in_review"])
    assert.equal(
      (await patch(f, id, ADMIN, { stage })).status,
      200,
      `moving to ${stage} should succeed`,
    );
  const read = await f.call(`/api/cards/${id}`);
  assert.equal(read.body.card.stage, "in_review");
  assert.equal(read.body.card.round, 1);
});

test("rework spends rounds and fuses into the halted stage once the budget runs out", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const created = await createWork(f, "workflow/round-fuse", {
    body: "done enough",
    max_rounds: 2,
  });
  const id = created.body.card.id;
  assert.equal(created.body.card.max_rounds, 2);

  for (const stage of ["claimed", "working", "in_review"])
    assert.equal((await patch(f, id, ADMIN, { stage })).status, 200);

  const rework = await patch(f, id, ADMIN, { stage: "changes_requested" });
  assert.equal(rework.status, 200, JSON.stringify(rework.body));
  assert.equal(rework.body.card.stage, "changes_requested");
  assert.equal(rework.body.card.round, 2);
  assert.equal(rework.body.card.rounds_remaining, 0);

  assert.equal((await patch(f, id, ADMIN, { stage: "in_review" })).status, 200);

  const fused = await patch(f, id, ADMIN, { stage: "changes_requested" });
  assert.equal(fused.status, 200, JSON.stringify(fused.body));
  assert.equal(fused.body.card.stage, "blocked");
  assert.equal(fused.body.card.status, "blocked");
  assert.equal(fused.body.card.round, 3);
  assert.match(fused.body.card.blocker, /max_rounds 2/);
  assert.equal(fused.body.transition.fused, true);
  assert.match(fused.body.transition.reason, /exceeded max_rounds 2/);

  const events = await f.call(`/api/workflow/events?card_id=${id}`);
  const last = events.body.events.at(-1);
  assert.equal(last.from_stage, "in_review");
  assert.equal(last.to_stage, "blocked");
  assert.equal(last.requested_stage, "changes_requested");
  assert.equal(last.fused, true);
});

test("max_rounds resolves card over project over global", async (t) => {
  const f = await fixture();
  t.after(() => f.close());

  const global = (await f.call("/api/workflow")).body.workflow;
  assert.equal(global.max_rounds, 3);

  const scoped = await f.call("/api/workflow", {
    method: "PUT",
    body: {
      expected_version: global.version,
      project: "acceptance",
      max_rounds: 1,
    },
  });
  assert.equal(scoped.status, 200, JSON.stringify(scoped.body));

  const acceptance = await f.call("/api/workflow?project=acceptance");
  assert.equal(acceptance.body.workflow.scope, "project");
  assert.equal(acceptance.body.workflow.max_rounds, 1);
  assert.equal((await f.call("/api/workflow")).body.workflow.max_rounds, 3);

  const projectCard = await createWork(f, "workflow/rounds-project");
  assert.equal(projectCard.body.card.max_rounds, 1);

  const own = await createWork(f, "workflow/rounds-card", { max_rounds: 5 });
  assert.equal(own.body.card.max_rounds, 5);
  for (const stage of ["claimed", "working", "in_review"]) {
    const moved = await patch(f, own.body.card.id, ADMIN, { stage });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.card.max_rounds, 5);
  }

  // The project budget of 1 fuses on the very first rework.
  const id = projectCard.body.card.id;
  for (const stage of ["claimed", "working", "in_review"])
    assert.equal((await patch(f, id, ADMIN, { stage })).status, 200);
  const fused = await patch(f, id, ADMIN, { stage: "changes_requested" });
  assert.equal(fused.body.card.stage, "blocked");
  assert.match(fused.body.card.blocker, /max_rounds 1/);

  const cleared = await f.call("/api/workflow", {
    method: "PUT",
    body: {
      expected_version: (await f.call("/api/workflow")).body.workflow.version,
      project: "acceptance",
      reset: true,
    },
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(
    (await f.call("/api/workflow?project=acceptance")).body.workflow.max_rounds,
    3,
  );
});

test("a human gate stops agents from promoting merged or deployed", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { actor, token } = await f.addActor("workflow-agent");
  const created = await createWork(
    f,
    "workflow/human-gate",
    { body: "shipped" },
    token,
  );
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.card.id;
  assert.equal(created.body.card.owner_id, actor.id);

  for (const stage of ["claimed", "working", "in_review", "approved"])
    assert.equal(
      (await patch(f, id, token, { stage })).status,
      200,
      `agent should reach ${stage}`,
    );

  const blocked = await patch(f, id, token, { stage: "merged" });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, "human_gate_required");
  assert.equal(blocked.body.error.human_gate, true);

  const human = await patch(f, id, ADMIN, { stage: "merged" });
  assert.equal(human.status, 200, JSON.stringify(human.body));
  assert.equal(human.body.card.stage, "merged");

  // Creation straight onto a gated stage is refused for agents too.
  const jump = await f.call("/api/cards", {
    token,
    method: "POST",
    body: await f.work("workflow/human-gate-create", {
      body: "x",
      stage: "merged",
    }),
  });
  assert.equal(jump.status, 403);
  assert.equal(jump.body.error.code, "human_gate_required");
});

test("transition events are monotonic, keyed by revision and never duplicated", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const created = await createWork(f, "workflow/events", {
    body: "body",
    implementer: "kqs@HASHI8",
    reviewer: "reviewer@HASHI6",
    tester: "tester@HASHI5",
    head_sha: "0123456789abcdef0123456789abcdef01234567",
    test_env: "HASHI6",
  });
  const id = created.body.card.id;

  const key = "events-fixed-key-0001";
  const base = (await f.call(`/api/cards/${id}`)).body.card.revision;
  const body = { expected_revision: base, changes: { stage: "claimed" } };
  const first = await f.call(`/api/cards/${id}`, {
    method: "PATCH",
    key,
    body,
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  // The identical request with the identical key replays the stored response,
  // so one revision can never produce two events.
  const replay = await f.call(`/api/cards/${id}`, {
    method: "PATCH",
    key,
    body,
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);

  for (const stage of ["working", "in_review"]) {
    const moved = await patch(f, id, ADMIN, { stage });
    assert.equal(moved.status, 200);
  }

  const feed = await f.call(`/api/workflow/events?card_id=${id}`);
  assert.equal(feed.status, 200);
  assert.equal(feed.body.events.length, 3);
  const seqs = feed.body.events.map((e) => e.seq);
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
  );
  assert.equal(new Set(seqs).size, seqs.length);

  const [claimed, working, review] = feed.body.events;
  assert.equal(claimed.from_stage, "initiated");
  assert.equal(claimed.to_stage, "claimed");
  assert.equal(working.to_stage, "working");
  assert.equal(review.to_stage, "in_review");
  assert.equal(review.event_id, `${id}:${review.revision}`);
  assert.equal(review.work_key, "workflow/events");
  assert.equal(review.project, "acceptance");
  assert.equal(review.category, "active");
  assert.equal(review.round, 1);
  assert.equal(review.max_rounds, 3);
  assert.equal(review.actor, "human-owner");
  assert.equal(review.implementer, "kqs@HASHI8");
  assert.equal(review.reviewer, "reviewer@HASHI6");
  assert.equal(review.tester, "tester@HASHI5");
  assert.equal(review.test_env, "HASHI6");
  assert.equal(review.head_sha, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(typeof review.next_step, "string");
  assert.equal(typeof review.at, "string");

  // Cursor paging never rewinds or repeats.
  const page = await f.call(
    `/api/workflow/events?card_id=${id}&after=${claimed.seq}&limit=1`,
  );
  assert.equal(page.body.events.length, 1);
  assert.equal(page.body.events[0].seq, working.seq);
  assert.equal(page.body.next_cursor, working.seq);
  assert.equal(page.body.has_more, true);

  // A rejected transition writes no event.
  const before = (await f.call(`/api/workflow/events?card_id=${id}`)).body
    .events.length;
  assert.equal((await patch(f, id, ADMIN, { stage: "initiated" })).status, 409);
  assert.equal(
    (await f.call(`/api/workflow/events?card_id=${id}`)).body.events.length,
    before,
  );
});

test("workflow edits need the human owner, a fresh version and a valid graph", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { token } = await f.addActor("workflow-editor");
  const current = (await f.call("/api/workflow")).body.workflow;

  const denied = await f.call("/api/workflow", {
    token,
    method: "PUT",
    body: { expected_version: current.version, max_rounds: 2 },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "admin_required");

  const stale = await f.call("/api/workflow", {
    method: "PUT",
    body: { expected_version: current.version + 5, max_rounds: 2 },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "workflow_conflict");

  const dangling = await f.call("/api/workflow", {
    method: "PUT",
    body: {
      expected_version: current.version,
      stages: current.stages.map((s) =>
        s.key === "initiated"
          ? { ...s, allowed_next: [...s.allowed_next, "ghost"] }
          : s,
      ),
    },
  });
  assert.equal(dangling.status, 400);
  assert.equal(dangling.body.error.code, "invalid_workflow");
  assert.match(dangling.body.error.message, /ghost/);

  const zero = await f.call("/api/workflow", {
    method: "PUT",
    body: { expected_version: current.version, max_rounds: 0 },
  });
  assert.equal(zero.status, 400);
  assert.equal(zero.body.error.code, "invalid_max_rounds");

  const duplicate = await f.call("/api/workflow", {
    method: "PUT",
    body: {
      expected_version: current.version,
      stages: [...current.stages, { ...current.stages[0] }],
    },
  });
  assert.equal(duplicate.status, 400);
  assert.equal(duplicate.body.error.code, "invalid_workflow");
});

test("a deprecated stage cannot be entered but existing cards stay readable", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const current = (await f.call("/api/workflow")).body.workflow;
  const deprecated = await f.call("/api/workflow", {
    method: "PUT",
    body: {
      expected_version: current.version,
      stages: current.stages.map((s) =>
        s.key === "claimed" ? { ...s, deprecated: true } : s,
      ),
    },
  });
  assert.equal(deprecated.status, 200, JSON.stringify(deprecated.body));

  const created = await createWork(f, "workflow/deprecated");
  const blocked = await patch(f, created.body.card.id, ADMIN, {
    stage: "claimed",
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, "stage_deprecated");

  // A card that sits on the deprecated stage can still be read and moved out.
  const legacy = await createWork(f, "workflow/deprecated-read");
  f.store.save("card", {
    ...f.store.get(legacy.body.card.id),
    stage: "claimed",
    round: 1,
    status: "in_progress",
  });
  const read = await f.call(`/api/cards/${legacy.body.card.id}`);
  assert.equal(read.body.card.stage, "claimed");
  assert.equal(read.body.card.stage_deprecated, true);
  const moved = await patch(f, legacy.body.card.id, ADMIN, {
    stage: "working",
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
});

test("snapshot and card directory expose the resolved stage display fields", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const created = await createWork(f, "workflow/projection", {
    body: "body",
    head_sha: "abcdef1234567",
  });
  const id = created.body.card.id;

  const snapshot = await f.call("/api/board");
  const fromBoard = snapshot.body.cards.find((c) => c.id === id);
  assert.equal(fromBoard.stage, "initiated");
  assert.equal(fromBoard.stage_label, "已立项");
  assert.equal(fromBoard.round, 1);
  assert.equal(fromBoard.max_rounds, 3);
  assert.equal(snapshot.body.workflow.initial, "initiated");
  assert.ok(snapshot.body.workflow.stages.length >= 12);

  const compact = await f.call("/api/board?compact=1");
  assert.equal(compact.body.workflow.max_rounds, 3);
  assert.equal(compact.body.workflow.stages, undefined);
  assert.equal(
    compact.body.cards.find((c) => c.id === id).stage_label,
    "已立项",
  );

  const directory = await f.call("/api/cards?work_key=workflow/projection");
  const listed = directory.body.cards[0];
  assert.equal(listed.stage, "initiated");
  assert.equal(listed.rounds_remaining, 2);
  assert.equal(listed.head_sha, "abcdef1234567");
});

// ---------------------------------------------------------------------------
// Review round 2: the seven blocking findings.
// ---------------------------------------------------------------------------

const stagesNow = async (f, project = "") =>
  (
    await f.call(
      `/api/workflow${project ? `?project=${encodeURIComponent(project)}` : ""}`,
    )
  ).body.workflow;
const putWorkflow = async (f, body) =>
  f.call("/api/workflow", { method: "PUT", body });
const versionNow = async (f) =>
  (await f.call("/api/workflow")).body.workflow.version;

test("workflow reads need the same identity as the board in key and lan mode", async (t) => {
  const keyed = await fixture();
  t.after(() => keyed.close());
  const anon = await keyed.call("/api/workflow", { token: "" });
  assert.equal(anon.status, 401);
  assert.equal(anon.body.error.code, "unauthorized");
  assert.equal(
    (await keyed.call("/api/workflow/events", { token: "" })).status,
    401,
  );
  assert.equal((await keyed.call("/api/board", { token: "" })).status, 401);
  assert.equal((await keyed.call("/api/workflow")).status, 200);

  const lan = await fixture({ accessMode: "lan" });
  t.after(() => lan.close());
  assert.equal((await lan.call("/api/workflow", { token: "" })).status, 200);
  assert.equal(
    (await lan.call("/api/workflow/events", { token: "" })).status,
    200,
  );
});

test("editing only a project budget keeps the project stages and initial", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const base = await stagesNow(f);
  const stages = [
    ...base.stages,
    {
      key: "project_start",
      label: "项目起点",
      label_en: "Project start",
      category: "active",
      status: "planned",
      allowed_next: ["working"],
      human_gate: false,
      counts_round: false,
    },
  ];
  const first = await putWorkflow(f, {
    expected_version: base.version,
    project: "phase2",
    stages,
    initial: "project_start",
    max_rounds: 5,
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));

  const created = await f.call("/api/cards", {
    method: "POST",
    body: await f.work("workflow/project-start", { project: "phase2" }),
  });
  assert.equal(
    created.body.card.stage,
    "project_start",
    JSON.stringify(created.body),
  );

  // A later budget-only edit must not drop the override's own stages/initial.
  const second = await putWorkflow(f, {
    expected_version: await versionNow(f),
    project: "phase2",
    max_rounds: 2,
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const resolved = await stagesNow(f, "phase2");
  assert.equal(resolved.scope, "project");
  assert.equal(resolved.initial, "project_start");
  assert.equal(resolved.max_rounds, 2);
  assert.ok(resolved.stages.some((s) => s.key === "project_start"));

  const moved = await patch(f, created.body.card.id, ADMIN, {
    stage: "working",
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.card.stage, "working");
});

test("a definition that would strand an existing card is rejected", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const created = await createWork(f, "workflow/stranded");
  const id = created.body.card.id;
  await patch(f, id, ADMIN, { stage: "claimed" });

  const stages = (await stagesNow(f)).stages
    .filter((s) => s.key !== "claimed")
    .map((s) => ({
      ...s,
      allowed_next: s.allowed_next.filter((n) => n !== "claimed"),
    }));
  const res = await putWorkflow(f, {
    expected_version: await versionNow(f),
    stages,
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, "workflow_strands_cards");
  assert.match(res.body.error.message, /claimed/);

  // The stored definition is untouched, so the card still moves.
  const moved = await patch(f, id, ADMIN, { stage: "working" });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
});

test("the board and the card detail agree on a project-specific stage and budget", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const base = await stagesNow(f);
  const stages = [
    ...base.stages,
    {
      key: "project_start",
      label: "项目起点",
      label_en: "Project start",
      category: "active",
      status: "planned",
      allowed_next: ["working"],
      human_gate: false,
      counts_round: false,
    },
  ];
  const put = await putWorkflow(f, {
    expected_version: base.version,
    project: "phase2",
    stages,
    initial: "project_start",
    max_rounds: 5,
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const created = await f.call("/api/cards", {
    method: "POST",
    body: await f.work("workflow/projection-phase2", { project: "phase2" }),
  });
  const id = created.body.card.id;

  const unfiltered = await f.call("/api/board");
  const onBoard = unfiltered.body.cards.find((c) => c.id === id);
  const detail = await f.call(`/api/cards/${id}`);
  assert.equal(onBoard.stage, "project_start");
  assert.equal(onBoard.max_rounds, 5);
  assert.equal(onBoard.stage, detail.body.card.stage);
  assert.equal(onBoard.max_rounds, detail.body.card.max_rounds);

  // Relabelling is visible on the board without rewriting the card.
  const relabelled = stages.map((s) =>
    s.key === "project_start" ? { ...s, label: "项目开始" } : s,
  );
  const edit = await putWorkflow(f, {
    expected_version: await versionNow(f),
    project: "phase2",
    stages: relabelled,
    initial: "project_start",
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  const after = await f.call("/api/board");
  assert.equal(
    after.body.cards.find((c) => c.id === id).stage_label,
    "项目开始",
  );
});

test("the fuse lands on the configured halted stage and the definition must keep one", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const base = await stagesNow(f);

  const gated = base.stages.map((s) =>
    s.key === "blocked" ? { ...s, human_gate: true } : s,
  );
  const refused = await putWorkflow(f, {
    expected_version: base.version,
    stages: gated,
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, "invalid_workflow");
  assert.match(refused.body.error.message, /halted/);

  const renamed = base.stages.map((s) => ({
    ...(s.key === "blocked"
      ? { ...s, key: "paused", label: "已暂停", label_en: "Paused" }
      : s),
    allowed_next: s.allowed_next.map((n) => (n === "blocked" ? "paused" : n)),
  }));
  const put = await putWorkflow(f, {
    expected_version: await versionNow(f),
    stages: renamed,
    max_rounds: 1,
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));

  const created = await createWork(f, "workflow/fuse-target");
  const id = created.body.card.id;
  await patch(f, id, ADMIN, { stage: "claimed" });
  await patch(f, id, ADMIN, { stage: "working" });
  await patch(f, id, ADMIN, { stage: "in_review" });
  const fused = await patch(f, id, ADMIN, { stage: "changes_requested" });
  assert.equal(fused.status, 200, JSON.stringify(fused.body));
  assert.equal(fused.body.card.stage, "paused");
  assert.equal(fused.body.card.status, "blocked");
  assert.equal(fused.body.transition.fused, true);
  assert.match(fused.body.card.blocker, /paused/);
});

test("a budget cleared in the same edit is already in force, and the fuse reason survives", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const created = await createWork(f, "workflow/budget-edit", {
    max_rounds: 1,
  });
  const id = created.body.card.id;
  assert.equal(created.body.card.max_rounds, 1);
  await patch(f, id, ADMIN, { stage: "claimed" });
  await patch(f, id, ADMIN, { stage: "working" });
  await patch(f, id, ADMIN, {
    stage: "in_review",
    blocker: "waiting on vendor",
  });

  // Clearing the card budget inherits the workflow's 3 in this very move.
  const moved = await patch(f, id, ADMIN, {
    stage: "changes_requested",
    max_rounds: "",
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.card.stage, "changes_requested");
  assert.equal(moved.body.card.round, 2);
  assert.equal(moved.body.card.max_rounds, 3);
  assert.equal(moved.body.transition.fused, undefined);

  // Now fuse for real: a single round budget with an existing blocker.
  await patch(f, id, ADMIN, { max_rounds: 1 });
  await patch(f, id, ADMIN, { stage: "working" });
  await patch(f, id, ADMIN, { stage: "in_review" });
  const fused = await patch(f, id, ADMIN, { stage: "changes_requested" });
  assert.equal(fused.status, 200, JSON.stringify(fused.body));
  assert.equal(fused.body.card.stage, "blocked");
  assert.match(fused.body.card.blocker, /exceeded max_rounds 1/);
  assert.match(fused.body.card.blocker, /waiting on vendor/);
});

test("a fused card can leave the halted stage without another round or a self-transition", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const created = await createWork(f, "workflow/fuse-exit", { max_rounds: 1 });
  const id = created.body.card.id;
  await patch(f, id, ADMIN, { stage: "claimed" });
  await patch(f, id, ADMIN, { stage: "working" });
  await patch(f, id, ADMIN, { stage: "in_review" });
  const fused = await patch(f, id, ADMIN, { stage: "changes_requested" });
  assert.equal(fused.body.card.stage, "blocked");
  const round = fused.body.card.round;

  const left = await patch(f, id, ADMIN, {
    stage: "archived",
    body: "wrapped up",
  });
  assert.equal(left.status, 200, JSON.stringify(left.body));
  assert.equal(left.body.card.stage, "archived");
  assert.equal(left.body.card.round, round);
  assert.equal(left.body.transition.from_stage, "blocked");
  assert.equal(left.body.transition.to_stage, "archived");

  const events = await f.call(`/api/workflow/events?card_id=${id}`);
  assert.equal(
    events.body.events.filter(
      (e) => e.from_stage === "blocked" && e.to_stage === "blocked",
    ).length,
    0,
  );
});

test("stage and coarse status never contradict each other on save", async (t) => {
  const f = await fixture();
  t.after(() => f.close());

  const done = await createWork(f, "workflow/status-done", {
    status: "done",
    body: "result recorded",
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.card.stage, "completed");
  assert.equal(done.body.card.status, "done");

  const working = await createWork(f, "workflow/status-working", {
    stage: "working",
  });
  assert.equal(working.body.card.stage, "working");
  assert.equal(working.body.card.status, "in_progress");

  const id = working.body.card.id;
  const blocked = await patch(f, id, ADMIN, {
    status: "blocked",
    blocker: "operator unavailable",
  });
  assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
  assert.equal(blocked.body.card.stage, "blocked");
  assert.equal(blocked.body.card.status, "blocked");
  assert.equal(blocked.body.transition.from_stage, "working");
  assert.equal(blocked.body.transition.entry, "status");

  const detail = await f.call(`/api/cards/${id}`);
  assert.equal(detail.body.card.stage, "blocked");
  assert.equal(detail.body.card.status, "blocked");
});

test("a cursor behind the retained event window is told it expired", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const db = f.store.db;
  const insert = db.prepare(
    "INSERT INTO workflow_events(card_id,revision,document) VALUES(?,?,?)",
  );
  for (let i = 1; i <= 5003; i++)
    insert.run(
      "synthetic",
      i,
      JSON.stringify({ seq: i, card_id: "synthetic", revision: i }),
    );

  f.store.prune(Date.now());

  const resumed = await f.call("/api/workflow/events?after=0");
  assert.equal(resumed.status, 200);
  assert.ok(resumed.body.gap, "an expired cursor must be reported as a gap");
  assert.equal(resumed.body.gap.after, 0);
  assert.equal(resumed.body.gap.until, 3);
  assert.equal(resumed.body.gap.skipped, 3);
  assert.match(resumed.body.resync, /api\/board/);
  assert.equal(resumed.body.oldest_seq, 4);
  assert.equal(resumed.body.events[0].seq, 4);

  const fresh = await f.call("/api/workflow/events?after=3");
  assert.equal(fresh.body.gap, undefined);
  assert.equal(fresh.body.events[0].seq, 4);
});

test("the legacy status entry grants no permission a gated stage would refuse", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { token } = await f.addActor("status-agent");
  // Put a human gate on a stage the coarse status field can reach on its own.
  const stages = (await stagesNow(f)).stages.map((s) =>
    s.key === "completed" ? { ...s, human_gate: true } : s,
  );
  const saved = await putWorkflow(f, {
    expected_version: await versionNow(f),
    stages,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const created = await createWork(
    f,
    "workflow/status-gate",
    { body: "x" },
    token,
  );
  const id = created.body.card.id;
  for (const stage of ["claimed", "working", "in_review", "approved"]) {
    const step = await patch(f, id, token, { stage });
    assert.equal(step.status, 200, `${stage}: ${JSON.stringify(step.body)}`);
  }

  const byStage = await patch(f, id, token, { stage: "completed" });
  assert.equal(byStage.status, 403);
  assert.equal(byStage.body.error.code, "human_gate_required");

  // The coarse field must not be a side door into the same stage.
  const byStatus = await patch(f, id, token, { status: "done" });
  assert.equal(byStatus.status, 403, JSON.stringify(byStatus.body));
  assert.equal(byStatus.body.error.code, "human_gate_required");
  assert.equal(byStatus.body.error.stage, "completed");

  const after = await f.call(`/api/cards/${id}`);
  assert.equal(after.body.card.stage, "approved");
  assert.equal(after.body.card.status, "in_progress");
  const events = (await f.call("/api/workflow/events?after=0")).body.events;
  assert.equal(
    events.filter((e) => e.card_id === id && e.to_stage === "completed").length,
    0,
    "a refused move must not leave a transition event behind",
  );

  // A human still walks through the gate, through either entry point.
  const human = await patch(f, id, ADMIN, { status: "done" });
  assert.equal(human.status, 200, JSON.stringify(human.body));
  assert.equal(human.body.card.stage, "completed");
  assert.equal(human.body.transition.entry, "status");
});

test("deprecating a card's only next stage is refused instead of stranding it", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const base = (await stagesNow(f)).stages;
  const extended = [
    ...base,
    {
      key: "handoff",
      label: "交接",
      label_en: "Hand-off",
      category: "active",
      status: "in_progress",
      allowed_next: ["qa"],
    },
    {
      key: "qa",
      label: "质检",
      label_en: "QA",
      category: "active",
      status: "in_progress",
      allowed_next: ["blocked"],
    },
  ];
  const seeded = await putWorkflow(f, {
    expected_version: await versionNow(f),
    stages: extended,
  });
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
  const created = await createWork(f, "workflow/only-next", {
    body: "x",
    stage: "handoff",
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.card.id;

  // Hand-off can only reach the stage that is about to be deprecated, so
  // accepting this definition would leave the card with nowhere to go.
  const refused = await putWorkflow(f, {
    expected_version: await versionNow(f),
    stages: extended.map((s) =>
      s.key === "qa" ? { ...s, deprecated: true } : s,
    ),
  });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "workflow_strands_cards");
  assert.match(refused.body.error.message, /workflow\/only-next/);
  assert.match(refused.body.error.message, /handoff/);

  // The stored definition is untouched, so the card still reaches its stage.
  const moved = await patch(f, id, ADMIN, { stage: "qa" });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));

  // Deprecating a stage some other live target can replace is still allowed.
  const ok = await putWorkflow(f, {
    expected_version: await versionNow(f),
    stages: extended.map((s) =>
      s.key === "working" ? { ...s, deprecated: true } : s,
    ),
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test("a card carries its own budget apart from the inherited one", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const inherited = await createWork(f, "workflow/own-budget-inherit");
  assert.equal(inherited.body.card.max_rounds, 3);
  assert.equal(inherited.body.card.max_rounds_own, null);
  const own = await createWork(f, "workflow/own-budget-set", { max_rounds: 5 });
  assert.equal(own.body.card.max_rounds_own, 5);

  // Raising the project budget must be visible without re-reading the card:
  // the resolved number moves, the card's own override does not.
  const raised = await putWorkflow(f, {
    expected_version: await versionNow(f),
    project: "acceptance",
    max_rounds: 8,
  });
  assert.equal(raised.status, 200, JSON.stringify(raised.body));
  const workflow = await stagesNow(f, "acceptance");
  assert.equal(workflow.max_rounds, 8);
  const inheritCard = await f.call(`/api/cards/${inherited.body.card.id}`);
  assert.equal(inheritCard.body.card.max_rounds_own, null);
  const ownCard = await f.call(`/api/cards/${own.body.card.id}`);
  assert.equal(
    ownCard.body.card.max_rounds,
    5,
    "an override outlives the project budget",
  );
});
test("a coarse status cannot jump the stage graph", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const created = await createWork(f, "workflow/status-graph", {
    body: "x",
  });
  const id = created.body.card.id;
  assert.equal(created.body.card.stage, "initiated");

  // initiated cannot reach completed in one hop, whichever field asks for it.
  const byStage = await patch(f, id, ADMIN, { stage: "completed" });
  assert.equal(byStage.status, 409);
  assert.equal(byStage.body.error.code, "invalid_transition");

  const byStatus = await patch(f, id, ADMIN, { status: "done" });
  assert.equal(byStatus.status, 409, JSON.stringify(byStatus.body));
  assert.equal(byStatus.body.error.code, "invalid_transition");
  assert.deepEqual(byStatus.body.error.allowed_next, [
    "claimed",
    "working",
    "blocked",
    "archived",
  ]);

  const untouched = await f.call(`/api/cards/${id}`);
  assert.equal(untouched.body.card.stage, "initiated");
  assert.equal(untouched.body.card.status, "planned");
  const after = (await f.call("/api/workflow/events?after=0")).body.events;
  assert.equal(
    after.filter((e) => e.card_id === id).length,
    0,
    "a refused move must not leave an event",
  );

  // The same status walks in as soon as the graph allows the hop.
  for (const stage of ["claimed", "working", "in_review", "approved"]) {
    const step = await patch(f, id, ADMIN, { stage });
    assert.equal(step.status, 200, `${stage}: ${JSON.stringify(step.body)}`);
  }
  const done = await patch(f, id, ADMIN, {
    status: "done",
    body: "finished",
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.card.stage, "completed");
  assert.equal(done.body.card.status, "done");
  assert.equal(done.body.transition.entry, "status");
});

test("a stage and a status sent in one edit must agree", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const created = await createWork(f, "workflow/both-fields", {
    stage: "working",
  });
  const id = created.body.card.id;
  assert.equal(created.body.card.status, "in_progress");

  const conflict = await patch(f, id, ADMIN, {
    stage: "working",
    status: "blocked",
    blocker: "operator away",
  });
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.error.code, "status_stage_conflict");
  const kept = await f.call(`/api/cards/${id}`);
  assert.equal(kept.body.card.stage, "working");
  assert.equal(kept.body.card.status, "in_progress");
  assert.equal(kept.body.card.blocker, "");

  const agreed = await patch(f, id, ADMIN, {
    stage: "blocked",
    status: "blocked",
    blocker: "operator away",
  });
  assert.equal(agreed.status, 200, JSON.stringify(agreed.body));
  assert.equal(agreed.body.card.stage, "blocked");
  assert.equal(agreed.body.card.status, "blocked");
});

test("the event reports the budget this edit leaves in force", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const created = await createWork(f, "workflow/budget-event", {
    stage: "working",
    max_rounds: 2,
  });
  const id = created.body.card.id;
  assert.equal(created.body.card.max_rounds, 2);

  const moved = await patch(f, id, ADMIN, {
    status: "blocked",
    blocker: "waiting",
    max_rounds: 7,
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.card.max_rounds, 7);
  assert.equal(moved.body.transition.max_rounds, 7);
  assert.equal(moved.body.transition.entry, "status");

  const events = (await f.call(`/api/workflow/events?card_id=${id}`)).body
    .events;
  const last = events.at(-1);
  assert.equal(last.to_stage, "blocked");
  assert.equal(
    last.max_rounds,
    7,
    "a consumer must not read the stale budget from the event",
  );
});

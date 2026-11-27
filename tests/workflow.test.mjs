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

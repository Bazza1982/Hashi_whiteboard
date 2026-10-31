import test from "node:test";
import assert from "node:assert/strict";
import { fixture, work } from "./helpers.mjs";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

const post = (f, route, body, extra = {}) =>
  f.call(route, { method: "POST", body, ...extra });
const topic = async (f, name, project = "Hashi") => {
  const r = await post(f, "/api/cards", {
    kind: "topic",
    work_key: "topic/test/" + name.toLowerCase(),
    project,
    title: name,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.card;
};
const make = async (f, key, t, extra = {}) => {
  const r = await post(
    f,
    "/api/cards",
    work("organization/" + key, {
      title: key,
      project: t.project,
      topic_id: t.id,
      ...extra,
    }),
  );
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.card;
};
const edge = (
  f,
  source,
  target,
  relation = "depends_on",
  label = "必须等待前置接口完成",
) =>
  post(f, "/api/edges", {
    source: source.id,
    target: target.id,
    relation,
    label,
  });

test("new work joins exactly one same-project topic atomically; reassignment cannot race or orphan it", async (t) => {
  const f = await fixture({ accessMode: "lan" });
  t.after(() => f.close());
  const a = await topic(f, "Session"),
    b = await topic(f, "Release"),
    other = await topic(f, "Other", "Workbench");
  const before = (await f.call("/api/board")).body;
  assert.equal(
    (await post(f, "/api/cards", work("missing/topic"))).body.error.code,
    "topic_required",
  );
  assert.equal(
    (
      await post(
        f,
        "/api/cards",
        work("bad/project", { topic_id: a.id, project: "Workbench" }),
      )
    ).body.error.code,
    "project_mismatch",
  );
  assert.equal(
    (await f.call("/api/board")).body.cards.length,
    before.cards.length,
  );
  const c = await make(f, "one", a);
  let snapshot = (await f.call("/api/board")).body;
  assert.equal(
    snapshot.edges.filter((e) => e.target === c.id && e.relation === "contains")
      .length,
    1,
  );
  assert.equal(
    (await edge(f, b, c, "contains")).body.error.code,
    "topic_exists",
  );
  assert.equal(
    (await edge(f, a, b, "contains")).body.error.code,
    "invalid_membership",
  );
  const membership = snapshot.edges.find((e) => e.target === c.id);
  assert.equal(
    (
      await f.call("/api/edges/" + membership.id, {
        method: "DELETE",
        body: { expected_revision: 1 },
      })
    ).body.error.code,
    "membership_required",
  );
  const badMove = await post(f, "/api/cards/" + c.id + "/topic", {
    expected_topic_id: a.id,
    topic_id: other.id,
  });
  assert.equal(badMove.body.error.code, "project_mismatch");
  assert.equal(
    (await f.call("/api/board")).body.edges.find((e) => e.target === c.id).id,
    membership.id,
    "failed move rolls back removal",
  );
  const moves = await Promise.all(
    [b, other].map((v) =>
      post(f, "/api/cards/" + c.id + "/topic", {
        expected_topic_id: a.id,
        topic_id: v.id,
      }),
    ),
  );
  assert.equal(moves[0].status, 200);
  assert.equal(moves[1].body.error.code, "topic_conflict");
  const current = (await f.call("/api/cards/" + c.id)).body.card;
  assert.equal(current.revision, c.revision);
  assert.equal(current.layout_revision, c.layout_revision);
  const key = randomUUID(),
    payload = {
      source: b.id,
      target: c.id,
      relation: "contains",
      label: "主题归属",
    };
  assert.equal(
    (await post(f, "/api/edges", payload, { key })).body.error.code,
    "edge_exists",
  );
  assert.equal(
    (
      await post(f, "/api/cards/" + b.id + "/archive", {
        expected_revision: 1,
        archived: true,
      })
    ).body.error.code,
    "topic_not_empty",
  );
});

test("sparse typed links reject duplicate, cyclic, redundant, sibling and excessive relationships", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const a = await topic(f, "A"),
    b = await topic(f, "B");
  const [one, two, three, four, five] = await Promise.all(
    ["one", "two", "three", "four", "five"].map((k) => make(f, k, a)),
  );
  const external = await make(f, "external", b),
    external2 = await make(f, "external2", b);
  assert.equal((await edge(f, one, two)).status, 200);
  assert.equal((await edge(f, two, three)).status, 200);
  assert.equal((await edge(f, one, two)).body.error.code, "edge_exists");
  assert.equal((await edge(f, three, one)).body.error.code, "dependency_cycle");
  assert.equal(
    (await edge(f, one, three)).body.error.code,
    "redundant_dependency",
  );
  assert.equal((await edge(f, one, four)).status, 200);
  assert.equal((await edge(f, one, five)).status, 200);
  assert.equal(
    (await edge(f, one, external)).body.error.code,
    "dependency_limit",
  );
  assert.equal(
    (await edge(f, two, four, "related")).body.error.code,
    "redundant_relation",
  );
  assert.equal(
    (await edge(f, two, external, "related", "两处共享同一个界面入口")).status,
    200,
  );
  assert.equal(
    (await edge(f, two, external2, "related")).body.error.code,
    "related_limit",
  );
  assert.equal(
    (await edge(f, external, two, "related")).body.error.code,
    "edge_exists",
  );
  assert.equal(
    (await edge(f, four, external2, "related", "x")).body.error.code,
    "reason_required",
  );
  assert.equal((await edge(f, b, two)).body.error.code, "invalid_dependency");
  assert.equal(
    (await edge(f, four, external2, "whatever")).body.error.code,
    "relation_required",
  );
});

test("arrangement is atomic, measured and project-separated; safe undo survives restart and preserves newer content", async () => {
  const f = await fixture({ accessMode: "lan" }),
    directory = f.dataDir;
  let reopened;
  try {
    const a = await topic(f, "Release"),
      b = await topic(f, "Chat", "Workbench");
    const one = await make(f, "dependent", a),
      two = await make(f, "prerequisite", a),
      third = await make(f, "other-project", b);
    await edge(f, one, two);
    const snapshot = (await f.call("/api/board")).body;
    const measurements = snapshot.cards.map((c) => ({
      id: c.id,
      width: 292,
      height: c.kind === "topic" ? 220 : 520,
    }));
    const body = { expected_revision: snapshot.revision, measurements };
    const key = randomUUID(),
      arranged = await post(f, "/api/layout/tidy", body, { key });
    assert.equal(arranged.status, 200, JSON.stringify(arranged.body));
    assert.ok(arranged.body.layout_id);
    assert.deepEqual(
      (await post(f, "/api/layout/tidy", body, { key })).body,
      arranged.body,
    );
    const after = (await f.call("/api/board")).body;
    for (const c of after.cards) {
      const old = snapshot.cards.find((x) => x.id === c.id);
      assert.equal(c.revision, old.revision);
      assert.equal(c.body, old.body);
      assert.equal(c.owner_id, old.owner_id);
      for (const d of after.cards.filter((d) => d.id !== c.id)) {
        const h = measurements.find((m) => m.id === c.id).height,
          dh = measurements.find((m) => m.id === d.id).height;
        assert.ok(
          !(
            c.position.x < d.position.x + 292 &&
            c.position.x + 292 > d.position.x &&
            c.position.y < d.position.y + dh &&
            c.position.y + h > d.position.y
          ),
          "arrangement must not overlap cards",
        );
      }
    }
    const find = (id) => after.cards.find((c) => c.id === id);
    assert.ok(
      find(two.id).position.x < find(one.id).position.x,
      "prerequisite precedes dependent",
    );
    assert.ok(
      Math.max(
        ...after.cards
          .filter((c) => c.project === a.project)
          .map((c) => c.position.x + 292),
      ) <
        Math.min(
          ...after.cards
            .filter((c) => c.project === b.project)
            .map((c) => c.position.x),
        ),
    );
    assert.equal(
      (await post(f, "/api/layout/tidy", body)).body.error.code,
      "board_changed",
    );
    await f.call("/api/cards/" + third.id, {
      method: "PATCH",
      body: {
        expected_revision: 1,
        changes: { body: "A newer verified report" },
      },
    });
    await f.close(false);
    reopened = await fixture({ directory, accessMode: "lan" });
    assert.equal(
      (
        await post(reopened, "/api/layout/undo", {
          layout_id: arranged.body.layout_id,
        })
      ).status,
      200,
    );
    const undone = (await reopened.call("/api/board")).body;
    for (const c of undone.cards)
      assert.deepEqual(
        c.position,
        snapshot.cards.find((x) => x.id === c.id).position,
      );
    assert.equal(
      undone.cards.find((c) => c.id === third.id).body,
      "A newer verified report",
    );
    assert.equal(
      (
        await post(reopened, "/api/layout/undo", {
          layout_id: arranged.body.layout_id,
        })
      ).body.error.code,
      "layout_expired",
    );
    const again = await post(reopened, "/api/layout/tidy", {
      expected_revision: undone.revision,
      measurements,
    });
    const moved = (await reopened.call("/api/cards/" + one.id)).body.card;
    await reopened.call("/api/cards/" + one.id + "/layout", {
      method: "PATCH",
      body: {
        expected_layout_revision: moved.layout_revision,
        position: { x: 77, y: 99 },
      },
    });
    const beforeConflict = (await reopened.call("/api/board")).body;
    assert.equal(
      (
        await post(reopened, "/api/layout/undo", {
          layout_id: again.body.layout_id,
        })
      ).body.error.code,
      "revision_conflict",
    );
    assert.deepEqual(
      (await reopened.call("/api/board")).body.cards.map((c) => c.position),
      beforeConflict.cards.map((c) => c.position),
      "failed undo cannot partially move any card",
    );
    const final = (await reopened.call("/api/board")).body;
    const thirdLayout = await post(reopened, "/api/layout/tidy", {
      expected_revision: final.revision,
      measurements,
    });
    await make(reopened, "new-structure", b);
    assert.equal(
      (
        await post(reopened, "/api/layout/undo", {
          layout_id: thirdLayout.body.layout_id,
        })
      ).body.error.code,
      "layout_conflict",
    );
  } finally {
    await f.close(false);
    if (reopened) await reopened.close(false);
    rmSync(directory, { recursive: true, force: true });
  }
});

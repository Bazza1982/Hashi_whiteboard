import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.mjs";

async function startTempServer(t, { accessMode = "lan" } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "wb-upgrade-test-"));
  const instance = createApp({
    dataDir,
    adminKey: "admin-key-for-whiteboard-upgrade-tests-0123456789",
    accessMode,
    allowedSubnets: ["127.0.0.0/8"],
  });
  const server = http.createServer(instance.app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  t.after(() => {
    server.close();
    instance.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { baseUrl, store: instance.store };
}

async function jsonReq(baseUrl, pathname, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(method !== "GET" ? { "Idempotency-Key": randomUUID() } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json(), bytes: Number(res.headers.get("content-length") || 0) };
}

test("compact board, /api/cards directory, comment pagination, structured 400, and X-Whiteboard-Actor", async (t) => {
  const { baseUrl } = await startTempServer(t, { accessMode: "lan" });

  // 1. Create a topic
  const topicRes = await jsonReq(baseUrl, "/api/cards", {
    method: "POST",
    body: {
      kind: "topic",
      work_key: "topic/workbench/perf",
      project: "Workbench",
      title: "Performance Topic",
      body: "Topic description",
    },
  });
  assert.equal(topicRes.status, 200);
  const topicId = topicRes.body.card.id;

  // 2. Structured 400 on missing topic_id
  const missingTopic = await jsonReq(baseUrl, "/api/cards", {
    method: "POST",
    body: {
      kind: "work",
      work_key: "workbench/perf/item-1",
      project: "Workbench",
      title: "Work without topic",
      body: "Body",
    },
  });
  assert.equal(missingTopic.status, 400);
  assert.equal(missingTopic.body.error.code, "topic_required");
  assert.deepEqual(missingTopic.body.error.required_fields, ["topic_id"]);
  assert.equal(missingTopic.body.error.topics.some((x) => x.id === topicId), true);

  // 3. Create work card with long body (including signature) and X-Whiteboard-Actor
  const longBody = "A".repeat(500) + "\nNEEDLE_DEEP_IN_BODY\n---\n更新者：alice@HASHI4｜时间：2026-11-24T23:00:00+11:00\nLatest progress summary here";
  const workRes = await jsonReq(baseUrl, "/api/cards", {
    method: "POST",
    headers: { "X-Whiteboard-Actor": "xiaofang@A9_MAX" },
    body: {
      kind: "work",
      work_key: "workbench/perf/item-1",
      project: "Workbench",
      topic_id: topicId,
      title: "Long Body Work",
      status: "in_progress",
      instance: "A9_MAX",
      body: longBody,
    },
  });
  assert.equal(workRes.status, 200);
  assert.deepEqual(workRes.body.card.updated_by_display, { name: "xiaofang@A9_MAX", verified: false });
  const workId = workRes.body.card.id;

  // 4. Add 15 comments and verify descending pagination
  for (let i = 1; i <= 15; i += 1) {
    const cRes = await jsonReq(baseUrl, `/api/cards/${workId}/comments`, {
      method: "POST",
      headers: { "X-Whiteboard-Actor": "xiaofang@A9_MAX" },
      body: { body: `Comment #${i}` },
    });
    assert.equal(cRes.status, 200);
    assert.equal(cRes.body.comment.reported_by, "xiaofang@A9_MAX");
    assert.equal(cRes.body.comment.reported_by_verified, false);
  }

  const pagedDetail = await jsonReq(baseUrl, `/api/cards/${workId}?comments_limit=5&comments_order=desc`);
  assert.equal(pagedDetail.status, 200);
  assert.equal(pagedDetail.body.card.total_comments, 15);
  assert.equal(pagedDetail.body.card.has_more, true);
  assert.equal(pagedDetail.body.card.comments.length, 5);
  assert.equal(pagedDetail.body.card.comments[0].body, "Comment #15");

  // 5. Compact snapshot preserves last_author + latest progress preview
  const compact = await jsonReq(baseUrl, "/api/board?compact=1");
  assert.equal(compact.status, 200);
  assert.equal(compact.body.compact, true);
  const compactWork = compact.body.cards.find((c) => c.id === workId);
  assert.equal(compactWork.body, "");
  assert.equal(compactWork.last_author, "alice@HASHI4");
  assert.equal(compactWork.body_preview, "Latest progress summary here");
  assert.equal(compactWork.body_length, longBody.length);
  assert.equal(compactWork.comment_count, 15);

  // 6. /api/cards directory filtering finds deep body text
  const dirRes = await jsonReq(baseUrl, "/api/cards?project=Workbench&kind=work&status=in_progress&q=NEEDLE_DEEP_IN_BODY");
  assert.equal(dirRes.status, 200);
  assert.equal(dirRes.body.total, 1);
  assert.equal(dirRes.body.cards[0].topic_id, topicId);
  assert.equal(dirRes.body.cards[0].body, undefined);

  // 7. Updating/archiving/restoring/handing off without X-Whiteboard-Actor clears previous updated_by_display
  const updateNoHeader = await jsonReq(baseUrl, `/api/cards/${workId}`, {
    method: "PATCH",
    body: { expected_revision: workRes.body.card.revision, changes: { status: "blocked", blocker: "waiting" } },
  });
  assert.equal(updateNoHeader.status, 200);
  assert.equal(updateNoHeader.body.card.updated_by_display, undefined);

  const archiveWithHeader = await jsonReq(baseUrl, `/api/cards/${workId}/archive`, {
    method: "POST",
    headers: { "X-Whiteboard-Actor": "archiver@A9_MAX" },
    body: { expected_revision: updateNoHeader.body.card.revision, archived: true },
  });
  assert.equal(archiveWithHeader.status, 200);
  assert.deepEqual(archiveWithHeader.body.card.updated_by_display, { name: "archiver@A9_MAX", verified: false });

  const restoreNoHeader = await jsonReq(baseUrl, `/api/cards/${workId}/archive`, {
    method: "POST",
    body: { expected_revision: archiveWithHeader.body.card.revision, archived: false },
  });
  assert.equal(restoreNoHeader.status, 200);
  assert.equal(restoreNoHeader.body.card.updated_by_display, undefined);

  const handoffWithHeader = await jsonReq(baseUrl, `/api/cards/${workId}/handoff`, {
    method: "POST",
    headers: { "X-Whiteboard-Actor": "handoff@A9_MAX" },
    body: { expected_revision: restoreNoHeader.body.card.revision, new_owner_id: "human-owner", note: "handoff test" },
  });
  assert.equal(handoffWithHeader.status, 200);
  assert.deepEqual(handoffWithHeader.body.card.updated_by_display, { name: "handoff@A9_MAX", verified: false });
});

test("benchmark: 1000 active + 10000 archived cards keep directory <= 50KB and P95 < 200ms", async (t) => {
  const { baseUrl, store } = await startTempServer(t, { accessMode: "lan" });
  const nowIso = new Date().toISOString();
  const sampleBody = "Progress report line. ".repeat(100); // ~2.2KB

  store.db.exec("BEGIN IMMEDIATE");
  try {
    const insertEntity = store.db.prepare("INSERT INTO entities(id,kind,work_key,document) VALUES(?,?,?,?)");
    const insertComment = store.db.prepare("INSERT INTO comments(id,card_id,document) VALUES(?,?,?)");
    for (let i = 0; i < 11000; i += 1) {
      const id = `card-${i}`;
      const workKey = `bench/item-${i}`;
      const archivedAt = i >= 1000 ? nowIso : null;
      const doc = {
        id,
        kind: "work",
        work_key: workKey,
        project: i % 2 === 0 ? "Workbench" : "Hashi",
        title: `Benchmark Task ${i}`,
        body: sampleBody,
        status: i % 3 === 0 ? "in_progress" : "planned",
        next_step: "Verify latency",
        blocker: "",
        repository: "",
        branch: "main",
        instance: "A9_MAX",
        pr_url: "",
        merge_status: "not_applicable",
        asset_id: "",
        announcement: false,
        owner_id: "lan-shared",
        created_by: "lan-shared",
        revision: 1,
        layout_revision: 1,
        position: { x: 0, y: i * 10 },
        created_at: nowIso,
        updated_at: nowIso,
        updated_by: "lan-shared",
        archived_at: archivedAt,
      };
      insertEntity.run(id, "card", workKey, JSON.stringify(doc));
      if (i < 100) {
        insertComment.run(`c-${i}-1`, id, JSON.stringify({ id: `c-${i}-1`, card_id: id, actor_id: "lan-shared", body: "note", system: false, created_at: nowIso }));
      }
    }
    store.db.exec("COMMIT");
  } catch (e) {
    store.db.exec("ROLLBACK");
    throw e;
  }

  const latencies = [];
  let lastPayloadBytes = 0;
  for (let run = 0; run < 20; run += 1) {
    const start = performance.now();
    const res = await fetch(`${baseUrl}/api/cards?limit=50`);
    const text = await res.text();
    const elapsed = performance.now() - start;
    latencies.push(elapsed);
    lastPayloadBytes = Buffer.byteLength(text, "utf8");
    const parsed = JSON.parse(text);
    assert.equal(parsed.total, 1000);
    assert.equal(parsed.cards.length, 50);
    assert.equal(parsed.has_more, true);
  }
  latencies.sort((a, b) => a - b);
  const p95 = latencies[Math.floor(latencies.length * 0.95) - 1];
  assert.equal(lastPayloadBytes < 50 * 1024, true, `Directory payload ${lastPayloadBytes}B exceeded 50KB`);
  assert.equal(p95 < 200, true, `Directory P95 ${p95.toFixed(1)}ms exceeded 200ms`);
});

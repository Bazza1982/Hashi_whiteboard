import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { fixture } from "./helpers.mjs";

test("existing notes become global announcements without losing identity, comments or layout", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  assert.equal((await f.call("/api/announcements", { token: "" })).status, 401);
  const owner = await f.addActor("Notice author");
  const peer = await f.addActor("Notice reader");
  const note = (
    await f.call("/api/cards", {
      token: owner.token,
      method: "POST",
      body: {
        kind: "note",
        title: "Shared tool entry",
        project: "Operations",
        body: "author@test | 2026-01-01T00:00:00Z\nFor Operations members.",
      },
    })
  ).body.card;
  await f.call(`/api/cards/${note.id}/comments`, {
    method: "POST",
    body: { body: "Existing discussion stays on the same record." },
  });
  const before = (await f.call(`/api/cards/${note.id}`)).body.card;
  const request = {
    expected_revision: note.revision,
    changes: { announcement: true },
  };
  assert.equal(
    (
      await f.call(`/api/cards/${note.id}`, {
        token: peer.token,
        method: "PATCH",
        body: request,
      })
    ).status,
    403,
  );
  const key = randomUUID();
  const promoted = await f.call(`/api/cards/${note.id}`, {
    token: owner.token,
    method: "PATCH",
    key,
    body: request,
  });
  assert.equal(promoted.status, 200);
  const replay = await f.call(`/api/cards/${note.id}`, {
    token: owner.token,
    method: "PATCH",
    key,
    body: request,
  });
  assert.deepEqual(replay.body, promoted.body);
  assert.equal(
    (
      await f.call(`/api/cards/${note.id}`, {
        token: owner.token,
        method: "PATCH",
        body: request,
      })
    ).status,
    409,
  );
  const after = (await f.call(`/api/cards/${note.id}`)).body.card;
  assert.equal(after.id, before.id);
  assert.equal(after.owner_id, before.owner_id);
  assert.equal(after.body, before.body);
  assert.deepEqual(after.comments, before.comments);
  assert.deepEqual(after.position, before.position);
  assert.equal(after.layout_revision, before.layout_revision);
  const filtered = (await f.call("/api/board?project=Other")).body;
  assert.equal(filtered.cards.length, 0);
  assert.equal(filtered.announcements[0].id, note.id);
  assert.equal(
    (await f.call("/api/announcements", { token: peer.token })).body
      .announcements[0].id,
    note.id,
  );
  const archived = await f.call(`/api/cards/${note.id}/archive`, {
    token: owner.token,
    method: "POST",
    body: { expected_revision: after.revision, archived: true },
  });
  assert.equal(archived.status, 200);
  assert.deepEqual((await f.call("/api/announcements")).body.announcements, []);
  const restored = await f.call(`/api/cards/${note.id}/archive`, {
    token: owner.token,
    method: "POST",
    body: { expected_revision: archived.body.card.revision, archived: false },
  });
  assert.equal(restored.status, 200);
  assert.equal(
    (await f.call("/api/announcements")).body.announcements[0].id,
    note.id,
  );
});

test("LAN notices persist across restart, ordinary cards stay ordinary, and canvas arrangement leaves announcements alone", async (t) => {
  let f = await fixture({ accessMode: "lan" });
  const directory = f.dataDir;
  t.after(async () => {
    await f.close(false);
    rmSync(directory, { recursive: true, force: true });
  });
  const notice = (
    await f.call("/api/cards", {
      token: "",
      method: "POST",
      body: {
        kind: "note",
        announcement: true,
        project: "Operations",
        title: "Notice",
        body: "Current shared information",
      },
    })
  ).body.card;
  const task = await f.call("/api/cards", {
    method: "POST",
    body: await f.work("announcements/task"),
  });
  assert.equal(task.body.card.announcement, false);
  const snapshot = (await f.call("/api/board")).body;
  assert.equal(
    (
      await f.call("/api/layout/tidy", {
        method: "POST",
        body: { expected_revision: snapshot.revision },
      })
    ).status,
    200,
  );
  const after = (await f.call(`/api/cards/${notice.id}`)).body.card;
  assert.deepEqual(after.position, notice.position);
  assert.equal(after.layout_revision, notice.layout_revision);
  await f.close(false);
  f = await fixture({ directory, accessMode: "lan" });
  assert.equal(
    (await f.call("/api/announcements", { token: "" })).body.announcements[0]
      .id,
    notice.id,
  );
  assert.equal(
    (
      await f.call(`/api/cards/${notice.id}`, {
        token: "",
        method: "PATCH",
        body: {
          expected_revision: after.revision,
          changes: { announcement: false },
        },
      })
    ).status,
    200,
  );
  assert.deepEqual((await f.call("/api/announcements")).body.announcements, []);
  assert.equal(
    (await f.call(`/api/cards/${notice.id}`)).body.card.title,
    notice.title,
  );
});

test("announcement flag rejects invalid types and cannot relabel work or topics", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  for (const value of ["true", 1, {}]) {
    const result = await f.call("/api/cards", {
      method: "POST",
      body: {
        kind: "note",
        announcement: value,
        title: "Invalid",
        project: "tests",
      },
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "invalid_announcement");
  }
  const result = await f.call("/api/cards", {
    method: "POST",
    body: await f.work("announcements/invalid-work", { announcement: true }),
  });
  assert.equal(result.body.error.code, "invalid_announcement");
  const topic = await f.topicFor("tests");
  assert.equal(
    (
      await f.call(`/api/cards/${topic}`, {
        method: "PATCH",
        body: { expected_revision: 1, changes: { announcement: true } },
      })
    ).body.error.code,
    "invalid_announcement",
  );
});

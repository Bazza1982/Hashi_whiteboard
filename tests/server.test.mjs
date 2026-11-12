import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { request } from "node:http";
import { fixture, work, ADMIN } from "./helpers.mjs";
import { request as agentRequest } from "../agent/client.mjs";
import { networkAllowed } from "../server/settings.mjs";

test("new cards stay in their project lane and follow the existing project without moving its cards", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const a = (
    await f.call("/api/cards", {
      method: "POST",
      body: await f.work("lanes/a", { project: "Hashi" }),
    })
  ).body.card;
  const b = (
    await f.call("/api/cards", {
      method: "POST",
      body: await f.work("lanes/b", { project: "Workbench" }),
    })
  ).body.card;
  assert.notEqual(a.position.x, b.position.x);
  await f.call(`/api/cards/${b.id}/layout`, {
    method: "PATCH",
    body: {
      expected_layout_revision: 1,
      position: { x: b.position.x, y: 900 },
    },
  });
  const next = (
    await f.call("/api/cards", {
      method: "POST",
      body: await f.work("lanes/c", { project: "Workbench" }),
    })
  ).body.card;
  assert.equal(next.position.x, b.position.x);
  assert.ok(next.position.y > 1200);
  const original = (await f.call(`/api/cards/${b.id}`)).body.card;
  assert.equal(original.position.y, 900);
  assert.equal(original.revision, 1);
});

test("LAN peers edit existing cards without keys while revisions and admin boundaries remain enforced", async (t) => {
  const f = await fixture({ accessMode: "lan" });
  t.after(() => f.close());
  const me = await f.call("/api/me", { token: "" });
  assert.equal(me.status, 200);
  assert.equal(me.body.actor.id, "lan-shared");
  assert.equal(me.body.access.shared_edit, true);
  const guide = await f.call("/api/guide", { token: "" });
  assert.equal(guide.body.access.mode, "lan");
  const card = (
    await f.call("/api/cards", {
      method: "POST",
      body: await f.work("shared/existing"),
    })
  ).body.card;
  assert.equal(card.owner_id, "human-owner");
  const results = await Promise.all(
    ["peer A", "peer B"].map((body) =>
      f.call(`/api/cards/${card.id}`, {
        token: "",
        method: "PATCH",
        body: { expected_revision: 1, changes: { body } },
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const current = (await f.call(`/api/cards/${card.id}`, { token: "" })).body
    .card;
  assert.equal(current.revision, 2);
  assert.equal(current.updated_by, "lan-shared");
  assert.equal(current.owner_id, "human-owner");
  const key = randomUUID();
  const body = {
    expected_revision: 2,
    changes: { next_step: "Re-read and coordinate." },
  };
  const first = await f.call(`/api/cards/${card.id}`, {
    token: "",
    method: "PATCH",
    key,
    body,
  });
  const replay = await f.call(`/api/cards/${card.id}`, {
    token: "",
    method: "PATCH",
    key,
    body,
  });
  assert.deepEqual(replay.body, first.body);
  assert.equal(
    (
      await f.call("/api/actors", {
        token: "",
        method: "POST",
        body: { name: "unapproved admin" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.call("/api/me", { token: "revoked-or-invalid" })).status,
    401,
  );
  assert.equal(
    (await agentRequest("/api/me", { url: f.url, token: "" })).actor.id,
    "lan-shared",
  );
  const created = await agentRequest("/api/cards", {
    url: f.url,
    token: "",
    method: "POST",
    operationId: randomUUID(),
    body: await f.work("shared/agent"),
  });
  assert.equal(created.card.owner_id, "lan-shared");
  const named = await f.addActor("Optional LAN identity");
  const login = await f.call("/api/session", {
    method: "POST",
    body: { token: named.token },
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  await f.call(`/api/actors/${named.actor.id}`, { method: "DELETE", body: {} });
  assert.equal((await f.call("/api/me", { token: named.token })).status, 401);
  const browser = await f.call("/api/me", {
    token: "",
    headers: { Cookie: cookie },
  });
  assert.equal(browser.body.actor.id, "lan-shared");
});

test("LAN scope uses the actual socket address and does not trust forwarded addresses", async (t) => {
  assert.equal(networkAllowed("::ffff:192.168.0.42", ["192.168.0.0/24"]), true);
  assert.equal(networkAllowed("192.168.1.42", ["192.168.0.0/24"]), false);
  assert.equal(networkAllowed("203.0.113.9", ["192.168.0.0/24"]), false);
  const f = await fixture({
    accessMode: "lan",
    allowedSubnets: ["192.168.0.0/24"],
  });
  t.after(() => f.close());
  const response = await f.call("/api/board", {
    token: "",
    headers: { "X-Forwarded-For": "192.168.0.42" },
  });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, "network_denied");
});

test("the public guide exposes the agent contract and update procedure", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const response = await f.call("/api/guide", { token: "" });
  assert.equal(response.status, 200);
  assert.equal(response.body.contract, "hashi_whiteboard/v1");
  assert.ok(response.body.workflow.length >= 6);
  assert.match(response.body.endpoints.update, /expected_revision/);
});

test("external links can open the UI without allowing cross-site API calls or frames", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const navigate = (endpoint, headers = {}, method = "GET") =>
    new Promise((resolve, reject) => {
      const req = request(
        `${f.url}${endpoint}`,
        {
          method,
          headers: {
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
            ...headers,
          },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  const page = await navigate("/");
  assert.equal(page.status, 200);
  assert.match(page.body, /<html/i);
  assert.equal((await navigate("/", {}, "HEAD")).status, 200);
  assert.equal((await navigate("/api/board")).status, 403);
  assert.equal((await navigate("/api/session", {}, "POST")).status, 403);
  assert.equal(
    (await navigate("/", { "sec-fetch-dest": "iframe" })).status,
    403,
  );
  assert.equal((await navigate("/", { "sec-fetch-mode": "cors" })).status, 403);
  assert.equal(
    (
      await navigate("/", {
        Host: "whiteboard.example",
        Origin: "https://whiteboard.example",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "script",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await navigate("/", {
        Host: "whiteboard.example",
        Origin: "https://whiteboard.example:444",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "script",
      })
    ).status,
    403,
  );
});

test("identity, immutable work identity, ownership, explicit handoff and append-only comments", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const a = await f.addActor("A"),
    b = await f.addActor("B");
  assert.equal(
    (await f.call("/api/actors", { method: "POST", body: { name: "a" } })).body
      .error.code,
    "actor_name_exists",
  );
  assert.equal(
    (await f.call("/api/me", { token: a.token })).body.actor.id,
    a.actor.id,
  );
  assert.equal((await f.call("/api/board", { token: "" })).status, 401);
  assert.equal(
    (
      await f.call("/api/actors", {
        token: a.token,
        method: "POST",
        body: { name: "Impersonator" },
      })
    ).status,
    403,
  );
  const created = await f.call("/api/cards", {
    method: "POST",
    token: a.token,
    body: await f.work("hashi/settings"),
  });
  assert.equal(created.status, 200);
  const card = created.body.card;
  assert.equal(card.owner_id, a.actor.id);
  assert.equal(card.revision, 1);
  const duplicate = await f.call("/api/cards", {
    method: "POST",
    token: b.token,
    body: work("hashi/settings"),
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.existing_id, card.id);
  assert.equal(
    (
      await f.call(`/api/cards/${card.id}`, {
        method: "PATCH",
        token: b.token,
        body: { expected_revision: 1, changes: { title: "wrong actor" } },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(`/api/cards/${card.id}`, {
        method: "PATCH",
        token: a.token,
        body: { expected_revision: 1, changes: { owner_id: b.actor.id } },
      })
    ).body.error.code,
    "unknown_field",
  );
  assert.equal(
    (
      await f.call(`/api/cards/${card.id}/comments`, {
        method: "POST",
        token: b.token,
        body: { body: "Available for review." },
      })
    ).status,
    200,
  );
  let read = await f.call(`/api/cards/${card.id}`);
  assert.equal(read.body.card.revision, 1);
  assert.equal(read.body.card.comments.length, 1);
  const transferred = await f.call(`/api/cards/${card.id}/handoff`, {
    method: "POST",
    token: a.token,
    body: {
      expected_revision: 1,
      new_owner_id: b.actor.id,
      note: "API complete. Please test UI.",
    },
  });
  assert.equal(transferred.status, 200);
  assert.equal(transferred.body.card.owner_id, b.actor.id);
  assert.equal(
    (
      await f.call(`/api/cards/${card.id}`, {
        method: "PATCH",
        token: a.token,
        body: { expected_revision: 2, changes: { body: "old owner" } },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(`/api/cards/${card.id}`, {
        method: "PATCH",
        token: b.token,
        body: { expected_revision: 2, changes: { body: "Picked up UI." } },
      })
    ).status,
    200,
  );
  read = await f.call(`/api/cards/${card.id}`);
  assert.equal(read.body.card.comments.length, 2);
  assert.equal(
    (await f.call("/api/board", { method: "PUT", body: { cards: [] } })).status,
    404,
  );
});

test("10 independent agents update concurrently; same-card races fail without lost updates; layout is separate", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const agents = await Promise.all(
    Array.from({ length: 10 }, (_, i) => f.addActor(`agent-${i}`)),
  );
  const created = await Promise.all(
    agents.map(async (a, i) =>
      f.call("/api/cards", {
        method: "POST",
        token: a.token,
        body: await f.work(`parallel/${i}`),
      }),
    ),
  );
  assert.ok(created.every((c) => c.status === 200));
  const updated = await Promise.all(
    created.map((c, i) =>
      f.call(`/api/cards/${c.body.card.id}`, {
        method: "PATCH",
        token: agents[i].token,
        body: {
          expected_revision: 1,
          changes: { status: "in_progress", body: `Verified step ${i}` },
        },
      }),
    ),
  );
  assert.ok(updated.every((c) => c.status === 200));
  const id = created[0].body.card.id,
    token = agents[0].token;
  const race = await Promise.all(
    ["first", "second"].map((body) =>
      f.call(`/api/cards/${id}`, {
        method: "PATCH",
        token,
        body: { expected_revision: 2, changes: { body } },
      }),
    ),
  );
  assert.deepEqual(race.map((x) => x.status).sort(), [200, 409]);
  const failed = race.find((x) => x.status === 409);
  assert.equal(failed.body.error.code, "revision_conflict");
  assert.equal(failed.body.error.current.revision, 3);
  const moved = await f.call(`/api/cards/${id}/layout`, {
    method: "PATCH",
    token,
    body: { expected_layout_revision: 1, position: { x: 88, y: 155 } },
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.card.revision, 3);
  assert.equal(moved.body.card.layout_revision, 2);
  const updatedAgain = await f.call(`/api/cards/${id}`, {
    method: "PATCH",
    token,
    body: { expected_revision: 3, changes: { next_step: "Review" } },
  });
  assert.equal(updatedAgain.status, 200);
  const snapshot = (await f.call("/api/board")).body;
  assert.equal(snapshot.cards.filter((c) => c.kind === "work").length, 10);
  assert.ok(
    snapshot.cards
      .filter((c) => c.kind === "work")
      .every((c) => c.status === "in_progress"),
  );
});

test("writes are idempotent across restart; changed requests cannot reuse a key", async () => {
  const f = await fixture();
  const directory = f.dataDir;
  let reopened;
  try {
    const key = randomUUID(),
      data = await f.work("persist/checkpoint", { body: "Keep this result." });
    const first = await f.call("/api/cards", {
      method: "POST",
      body: data,
      key,
    });
    const repeat = await f.call("/api/cards", {
      method: "POST",
      body: data,
      key,
    });
    assert.deepEqual(repeat.body, first.body);
    assert.equal(
      (
        await f.call("/api/cards", {
          method: "POST",
          body: { ...data, title: "different" },
          key,
        })
      ).status,
      409,
    );
    await f.close(false);
    reopened = await fixture({ directory });
    const persisted = await reopened.call(`/api/cards/${first.body.card.id}`);
    assert.equal(persisted.body.card.body, data.body);
    const retried = await reopened.call("/api/cards", {
      method: "POST",
      body: data,
      key,
    });
    assert.deepEqual(retried.body, first.body);
    assert.equal(
      (await reopened.call("/api/board")).body.cards.filter(
        (c) => c.kind === "work",
      ).length,
      1,
    );
  } finally {
    await f.close(false);
    if (reopened) await reopened.close(false);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("status is explicit, schema rejects spoofed identities, archive restores before expiry", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  assert.equal(
    (
      await f.call("/api/cards", {
        method: "POST",
        body: work("bad/owner", { owner_id: "someone" }),
      })
    ).body.error.code,
    "unknown_field",
  );
  assert.equal(
    (
      await f.call("/api/cards", {
        method: "POST",
        body: work("bad/blocked", { status: "blocked" }),
      })
    ).body.error.code,
    "blocker_required",
  );
  assert.equal(
    (
      await f.call("/api/cards", {
        method: "POST",
        body: work("bad/done", { status: "done" }),
      })
    ).body.error.code,
    "result_required",
  );
  assert.equal(
    (
      await f.call("/api/cards", {
        method: "POST",
        body: work("bad/merged", {
          status: "done",
          body: "Done",
          merge_status: "merged",
        }),
      })
    ).body.error.code,
    "pr_required",
  );
  const made = (
    await f.call("/api/cards", {
      method: "POST",
      body: await f.work("done/not-merged", {
        status: "done",
        body: "Tests passed",
        merge_status: "open",
        pr_url: "https://github.com/example/project/pull/1",
      }),
    })
  ).body.card;
  assert.equal(made.merge_status, "open");
  let x = await f.call(`/api/cards/${made.id}/archive`, {
    method: "POST",
    body: { expected_revision: 1, archived: true },
  });
  assert.equal(x.status, 200);
  assert.equal(
    (await f.call("/api/board")).body.cards.filter((c) => c.kind === "work")
      .length,
    0,
  );
  assert.equal(
    (await f.call("/api/board?archived=true")).body.cards.filter(
      (c) => c.kind === "work",
    ).length,
    1,
  );
  x = await f.call(`/api/cards/${made.id}/archive`, {
    method: "POST",
    body: { expected_revision: 2, archived: false },
  });
  assert.equal(x.status, 200);
  await f.call(`/api/cards/${made.id}/archive`, {
    method: "POST",
    body: { expected_revision: 3, archived: true },
  });
  const active = (
    await f.call("/api/cards", {
      method: "POST",
      body: await f.work("still/active"),
    })
  ).body.card;
  f.store.prune(Date.now() + 15 * 86400000);
  assert.equal((await f.call(`/api/cards/${made.id}`)).status, 404);
  assert.equal((await f.call(`/api/cards/${active.id}`)).status, 200);
});

test("real event stream, binary image policy, origin rejection and revoked access", async (t) => {
  const f = await fixture();
  await f.topicFor();
  t.after(() => f.close());
  const a = await f.addActor("Stream agent");
  assert.equal(
    (
      await f.call("/api/board", {
        headers: { Origin: "https://unrelated.example" },
      })
    ).status,
    403,
  );
  const abort = new AbortController();
  t.after(() => abort.abort());
  const stream = await fetch(`${f.url}/api/events`, {
    headers: { Authorization: `Bearer ${a.token}` },
    signal: abort.signal,
  });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  await reader.read();
  const card = (
    await f.call("/api/cards", {
      method: "POST",
      body: await f.work("event/notification"),
    })
  ).body.card;
  const chunk = await reader.read();
  assert.match(new TextDecoder().decode(chunk.value), new RegExp(card.id));
  const svg = await fetch(`${f.url}/api/assets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN}`,
      "Content-Type": "image/png",
      "Idempotency-Key": randomUUID(),
    },
    body: Buffer.from("<svg/>"),
  });
  assert.equal(svg.status, 400);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN0cAAAAASUVORK5CYII=",
    "base64",
  );
  const upload = await fetch(`${f.url}/api/assets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN}`,
      "Content-Type": "image/png",
      "Idempotency-Key": randomUUID(),
    },
    body: png,
  });
  assert.equal(upload.status, 200);
  const asset = await upload.json();
  assert.equal(
    (
      await fetch(`${f.url}/api/assets/${asset.asset_id}`, {
        headers: { Authorization: `Bearer ${ADMIN}` },
      })
    ).headers.get("content-type"),
    "image/png",
  );
  assert.equal(
    (await f.call(`/api/actors/${a.actor.id}`, { method: "DELETE", body: {} }))
      .status,
    200,
  );
  assert.equal((await f.call("/api/board", { token: a.token })).status, 401);
  await reader.cancel();
});

test("browser sessions use HttpOnly cookies, not a URL secret; writes require request ids", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const login = await f.call("/api/session", {
    method: "POST",
    token: "",
    body: { token: ADMIN },
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(
    (
      await f.call("/api/me", {
        token: "",
        headers: { Cookie: cookie.split(";")[0] },
      })
    ).status,
    200,
  );
  const response = await fetch(`${f.url}/api/cards`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(work("missing/key")),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "idempotency_key_required");
});

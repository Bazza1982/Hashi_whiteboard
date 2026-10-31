import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fixture, root } from "./helpers.mjs";

test("actual stdio MCP client discovers and uses the shared authenticated board", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const actor = await f.addActor("MCP agent");
  const child = spawn(process.execPath, [path.join(root, "agent/mcp.mjs")], {
    env: {
      ...process.env,
      WHITEBOARD_URL: f.url,
      WHITEBOARD_API_KEY: actor.token,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    child.stdin.end();
    child.kill();
  });
  const replies = new Map();
  let id = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    replies.get(value.id)?.(value);
    replies.delete(value.id);
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(
        () => reject(new Error(`MCP timeout ${method}`)),
        10000,
      );
      replies.set(requestId, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`,
      );
    });
  assert.equal(
    (
      await call("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      })
    ).result.serverInfo.name,
    "hashi-whiteboard",
  );
  const tools = (await call("tools/list")).result.tools;
  assert.ok(tools.some((x) => x.name === "whiteboard_update_card"));
  const tool = async (name, args = {}) => {
    const response = await call("tools/call", { name, arguments: args });
    return {
      error: response.result.isError,
      data: JSON.parse(response.result.content[0].text),
    };
  };
  assert.equal((await tool("whiteboard_me")).data.actor.id, actor.actor.id);
  assert.equal(
    (await tool("whiteboard_me", { invented_identity: "other" })).data.error
      .code,
    "invalid_arguments",
  );
  const created = await tool("whiteboard_create_card", {
    operation_id: randomUUID(),
    kind: "work",
    work_key: "mcp/contract",
    title: "Protocol smoke",
    project: "tests",
    topic_id: await f.topicFor("tests"),
    body: "MCP wrote this.",
  });
  assert.ok(!created.error);
  const card = created.data.card;
  assert.equal(
    (await tool("whiteboard_get_card", { card_id: card.id })).data.card.body,
    "MCP wrote this.",
  );
  const updated = await tool("whiteboard_update_card", {
    operation_id: randomUUID(),
    card_id: card.id,
    expected_revision: 1,
    changes: { status: "done", body: "Verified through stdio MCP." },
  });
  assert.ok(!updated.error);
  const stale = await tool("whiteboard_update_card", {
    operation_id: randomUUID(),
    card_id: card.id,
    expected_revision: 1,
    changes: { body: "stale" },
  });
  assert.equal(stale.error, true);
  assert.equal(stale.data.error.code, "revision_conflict");
  assert.equal(
    (await f.call(`/api/cards/${card.id}`)).body.card.body,
    "Verified through stdio MCP.",
  );
});

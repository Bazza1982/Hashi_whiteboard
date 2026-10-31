import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { root } from "./helpers.mjs";

async function until(check) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Host recovery condition did not become true.");
}
test("persistent host retries an unavailable bind address and recovers an exited worker without losing data", async () => {
  mkdirSync(path.join(root, "artifacts"), { recursive: true });
  const directory = mkdtempSync(path.join(root, "artifacts", "host-"));
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const settings = {
    host: "192.0.2.254",
    port,
    access_mode: "lan",
    allowed_subnets: ["127.0.0.0/8"],
  };
  const settingsFile = path.join(directory, "settings.json");
  const state = () =>
    JSON.parse(readFileSync(path.join(directory, "host-status.json"), "utf8"));
  writeFileSync(settingsFile, JSON.stringify(settings));
  const env = { ...process.env, WHITEBOARD_DATA_DIR: directory };
  for (const name of [
    "WHITEBOARD_HOST",
    "WHITEBOARD_PORT",
    "WHITEBOARD_ACCESS_MODE",
    "WHITEBOARD_ALLOWED_SUBNETS",
    "WHITEBOARD_ADMIN_KEY",
  ])
    delete env[name];
  const host = spawn(process.execPath, [path.join(root, "server/host.mjs")], {
    cwd: root,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  host.stderr.on("data", (x) => (errors += x));
  const url = `http://127.0.0.1:${port}`;
  try {
    await until(() => state().restart_count >= 1);
    settings.host = "127.0.0.1";
    writeFileSync(settingsFile, JSON.stringify(settings));
    await until(async () => (await fetch(`${url}/api/health`)).ok);
    const topicResponse = await fetch(`${url}/api/cards`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({
        kind: "topic",
        work_key: "topic/host/recovery",
        title: "Host recovery",
        project: "general",
      }),
    });
    assert.equal(topicResponse.status, 200);
    const topic = (await topicResponse.json()).card;
    const response = await fetch(`${url}/api/cards`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({
        kind: "work",
        work_key: "host/recovery",
        topic_id: topic.id,
        title: "Persist through worker restart",
        body: "Verified result before restart.",
      }),
    });
    assert.equal(response.status, 200, errors);
    const { card } = await response.json();
    const old = state();
    process.kill(old.worker_pid);
    const recovered = await until(async () => {
      const current = state();
      if (!current.worker_pid || current.worker_pid === old.worker_pid)
        return false;
      const result = await fetch(`${url}/api/cards/${card.id}`);
      return result.ok ? { current, card: (await result.json()).card } : false;
    });
    assert.equal(recovered.current.host_pid, host.pid);
    assert.ok(recovered.current.restart_count > old.restart_count);
    assert.equal(recovered.card.body, card.body);
    assert.equal(recovered.card.revision, card.revision);
    assert.match(
      readFileSync(path.join(directory, "logs/service.log"), "utf8"),
      /worker exited/,
    );
  } finally {
    let worker;
    try {
      worker = state().worker_pid;
    } catch {}
    if (host.exitCode === null) {
      host.kill();
      await once(host, "exit");
    }
    if (worker) {
      try {
        process.kill(worker);
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    rmSync(directory, { recursive: true, force: true });
  }
});

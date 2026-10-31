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
import { root } from "./helpers.mjs";

test("saved LAN settings start a fixed listener and let the CLI connect without a key", async () => {
  mkdirSync(path.join(root, "artifacts"), { recursive: true });
  const directory = mkdtempSync(path.join(root, "artifacts", "lan-startup-"));
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  writeFileSync(
    path.join(directory, "settings.json"),
    JSON.stringify({
      host: "127.0.0.1",
      port,
      access_mode: "lan",
      allowed_subnets: ["127.0.0.0/8"],
    }),
  );
  const env = {
    ...process.env,
    WHITEBOARD_DATA_DIR: directory,
    WHITEBOARD_URL: `http://127.0.0.1:${port}`,
  };
  for (const name of [
    "WHITEBOARD_HOST",
    "WHITEBOARD_PORT",
    "WHITEBOARD_ACCESS_MODE",
    "WHITEBOARD_ALLOWED_SUBNETS",
    "WHITEBOARD_API_KEY",
    "WHITEBOARD_ADMIN_KEY",
  ])
    delete env[name];
  const child = spawn(process.execPath, [path.join(root, "server/index.mjs")], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (x) => (logs += x));
  child.stderr.on("data", (x) => (logs += x));
  try {
    let response;
    for (let i = 0; i < 50; i++) {
      try {
        response = await fetch(`${env.WHITEBOARD_URL}/api/me`);
      } catch {}
      if (response?.ok) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(response?.status, 200, logs);
    assert.equal((await response.json()).access.mode, "lan");
    const cli = spawn(
      process.execPath,
      [path.join(root, "agent/cli.mjs"), "me"],
      { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    cli.stdout.on("data", (x) => (output += x));
    assert.equal((await once(cli, "exit"))[0], 0);
    assert.equal(JSON.parse(output).actor.id, "lan-shared");
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("first-start entry serves the built UI, persists a private owner key and accepts the CLI", async () => {
  mkdirSync(path.join(root, "artifacts"), { recursive: true });
  const directory = mkdtempSync(path.join(root, "artifacts", "startup-"));
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const env = {
    ...process.env,
    WHITEBOARD_DATA_DIR: directory,
    WHITEBOARD_HOST: "127.0.0.1",
    WHITEBOARD_PORT: String(port),
  };
  delete env.WHITEBOARD_ADMIN_KEY;
  const child = spawn(process.execPath, [path.join(root, "server/index.mjs")], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (x) => (logs += x));
  child.stderr.on("data", (x) => (logs += x));
  try {
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try {
        ready = (await fetch(`${url}/api/health`)).ok;
      } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, logs);
    const html = await fetch(url);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /HASHI Whiteboard/);
    assert.equal((await fetch(`${url}/third-party-notices.txt`)).status, 200);
    const token = readFileSync(
      path.join(directory, "admin-key.txt"),
      "utf8",
    ).trim();
    assert.match(token, /^wb_[A-Za-z0-9_-]{43}$/);
    const cli = spawn(
      process.execPath,
      [path.join(root, "agent/cli.mjs"), "me"],
      {
        cwd: root,
        env: { ...env, WHITEBOARD_URL: url, WHITEBOARD_API_KEY: token },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    cli.stdout.on("data", (x) => (output += x));
    const [code] = await once(cli, "exit");
    assert.equal(code, 0);
    assert.equal(JSON.parse(output).actor.id, "human-owner");
    assert.ok(
      !logs.includes(token),
      "Owner key must not be printed by normal service startup.",
    );
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

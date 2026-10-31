import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.mjs";

export const root = fileURLToPath(new URL("..", import.meta.url));
export const ADMIN = "test-owner-key-with-at-least-32-characters";
export async function fixture({
  directory,
  host = "127.0.0.1",
  ...options
} = {}) {
  mkdirSync(path.join(root, "artifacts"), { recursive: true });
  const dataDir =
    directory || mkdtempSync(path.join(root, "artifacts", "test-"));
  const service = createApp({ dataDir, adminKey: ADMIN, ...options });
  const server = service.app.listen(0, host);
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async (
    endpoint,
    {
      token = ADMIN,
      method = "GET",
      body,
      key = randomUUID(),
      headers = {},
    } = {},
  ) => {
    const response = await fetch(`${url}${endpoint}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(method !== "GET" ? { "Idempotency-Key": key } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: response.status,
      body: await response.json(),
      headers: response.headers,
    };
  };
  const addActor = async (name) => {
    const x = await call("/api/actors", { method: "POST", body: { name } });
    if (x.status !== 200) throw new Error(JSON.stringify(x));
    return x.body;
  };
  const topicPromises = new Map();
  const topicFor = (project = "acceptance") => {
    if (!topicPromises.has(project))
      topicPromises.set(
        project,
        (async () => {
          const snapshot = (await call("/api/board")).body;
          const existing = snapshot.cards.find(
            (c) => c.kind === "topic" && c.project === project,
          );
          if (existing) return existing.id;
          const result = await call("/api/cards", {
            method: "POST",
            body: {
              kind: "topic",
              work_key: `topic/tests/${Buffer.from(project).toString("hex")}`,
              title: `${project} acceptance topic`,
              project,
            },
          });
          if (result.status !== 200) throw new Error(JSON.stringify(result));
          return result.body.card.id;
        })(),
      );
    return topicPromises.get(project);
  };
  let closed = false;
  return {
    ...service,
    server,
    url,
    call,
    addActor,
    topicFor,
    work: async (key, extra = {}) =>
      work(key, {
        ...extra,
        topic_id:
          extra.topic_id || (await topicFor(extra.project || "acceptance")),
      }),
    dataDir,
    async close(remove = !directory) {
      if (closed) return;
      closed = true;
      service.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      if (remove) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
export const work = (key, extra = {}) => ({
  kind: "work",
  work_key: key,
  project: "acceptance",
  title: `Work ${key}`,
  ...extra,
});

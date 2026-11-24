import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "./client.mjs";

const args = process.argv.slice(2);
const [command = "guide", idOrFile, file] = args;

function parseFlags(rest) {
  const params = new URLSearchParams();
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-/g, "_");
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      params.set(key, next);
      i += 1;
    } else {
      params.set(key, "true");
    }
  }
  return params;
}

const routes = {
  guide: ["GET", "/api/guide"],
  me: ["GET", "/api/me"],
  snapshot: ["GET", "/api/board?compact=1"],
  announcements: ["GET", "/api/announcements"],
  get: ["GET", `/api/cards/${encodeURIComponent(idOrFile || "")}`],
  create: ["POST", "/api/cards"],
  connect: ["POST", "/api/edges"],
  topic: ["POST", `/api/cards/${encodeURIComponent(idOrFile || "")}/topic`],
  update: ["PATCH", `/api/cards/${encodeURIComponent(idOrFile || "")}`],
  comment: [
    "POST",
    `/api/cards/${encodeURIComponent(idOrFile || "")}/comments`,
  ],
  handoff: ["POST", `/api/cards/${encodeURIComponent(idOrFile || "")}/handoff`],
  archive: ["POST", `/api/cards/${encodeURIComponent(idOrFile || "")}/archive`],
  register: ["POST", "/api/actors"],
};
try {
  let out;
  if (command === "topics") {
    const params = new URLSearchParams({ kind: "topic", limit: "200" });
    if (idOrFile && !idOrFile.startsWith("--")) params.set("project", idOrFile);
    out = await request(`/api/cards?${params.toString()}`);
  } else if (command === "find") {
    const params = parseFlags(args.slice(1));
    out = await request(`/api/cards?${params.toString()}`);
  } else if (command === "read") {
    if (!idOrFile) throw new Error("Usage: read CARD_ID [--tail N]");
    const flags = parseFlags(args.slice(2));
    const params = new URLSearchParams();
    if (flags.has("tail")) {
      params.set("comments_limit", flags.get("tail"));
      params.set("comments_order", "desc");
    }
    const qs = params.toString();
    out = await request(`/api/cards/${encodeURIComponent(idOrFile)}${qs ? `?${qs}` : ""}`);
  } else if (command === "patch") {
    if (!idOrFile || !file) throw new Error("Usage: patch CARD_ID JSON_FILE");
    const data = JSON.parse(readFileSync(file, "utf8"));
    const { operation_id, expected_revision, ...rest } = data;
    const changes = rest.changes || rest;
    let rev = expected_revision;
    if (!rev) {
      const current = await request(`/api/cards/${encodeURIComponent(idOrFile)}?comments_limit=1&comments_order=desc`);
      rev = current.card.revision;
    }
    out = await request(`/api/cards/${encodeURIComponent(idOrFile)}`, {
      method: "PATCH",
      operationId: operation_id || randomUUID(),
      body: { expected_revision: rev, changes },
    });
  } else if (command === "note") {
    if (!idOrFile || !file) throw new Error("Usage: note CARD_ID TEXT");
    out = await request(`/api/cards/${encodeURIComponent(idOrFile)}/comments`, {
      method: "POST",
      operationId: randomUUID(),
      body: { body: file },
    });
  } else {
    if (!routes[command])
      throw new Error(
        "Commands: guide | me | announcements | snapshot | topics [PROJECT] | find [--project P --status S --work-key K --q Q --limit N] | read CARD_ID [--tail N] | get CARD_ID | create/connect JSON_FILE | patch CARD_ID JSON_FILE | note CARD_ID TEXT | topic/update/comment/handoff/archive CARD_ID JSON_FILE | register JSON_FILE",
      );
    const [method, endpoint] = routes[command];
    const data =
      method === "GET"
        ? {}
        : JSON.parse(
            readFileSync(
              ["create", "register", "connect"].includes(command)
                ? idOrFile
                : file,
              "utf8",
            ),
          );
    const { operation_id, ...body } = data;
    out = await request(endpoint, {
      method,
      operationId: operation_id,
      ...(method !== "GET" ? { body } : {}),
    });
  }
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error(
    JSON.stringify(
      {
        error: {
          code: e.code || "request_failed",
          message: e.message,
          ...(e.details || {}),
        },
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}

import { readFileSync } from "node:fs";
import { request } from "./client.mjs";

const [command = "guide", idOrFile, file] = process.argv.slice(2);
const routes = {
  guide: ["GET", "/api/guide"],
  me: ["GET", "/api/me"],
  snapshot: ["GET", "/api/board"],
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
  if (!routes[command])
    throw new Error(
      "Commands: guide | me | announcements | snapshot | get CARD_ID | create/connect JSON_FILE | topic/update/comment/handoff/archive CARD_ID JSON_FILE | register JSON_FILE",
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
  console.log(
    JSON.stringify(
      await request(endpoint, {
        method,
        operationId: operation_id,
        ...(method !== "GET" ? { body } : {}),
      }),
      null,
      2,
    ),
  );
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

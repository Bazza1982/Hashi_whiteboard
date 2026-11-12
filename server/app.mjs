import express from "express";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { BoardStore, hash } from "./store.mjs";
import { BoardError, fail, GUIDE } from "../shared/contract.mjs";
import { networkAllowed, validateAccess } from "./settings.mjs";

export function localKey(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "admin-key.txt");
  if (!fs.existsSync(file)) {
    try {
      fs.writeFileSync(file, `wb_${randomBytes(32).toString("base64url")}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  return fs.readFileSync(file, "utf8").trim();
}
export function createApp({
  dataDir,
  adminKey = localKey(dataDir),
  staticDir = fileURLToPath(new URL("../dist", import.meta.url)),
  accessMode = "key",
  allowedSubnets = ["127.0.0.0/8"],
} = {}) {
  validateAccess(accessMode, allowedSubnets);
  const access = { mode: accessMode, shared_edit: accessMode === "lan" };
  fail(
    typeof adminKey === "string" && adminKey.length >= 32,
    "invalid_key",
    "Admin key must contain at least 32 characters.",
  );
  const store = new BoardStore(dataDir, adminKey, {
      sharedEdit: access.shared_edit,
    }),
    app = express(),
    sessions = new Map(),
    clients = new Set(),
    attempts = new Map();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (
      access.shared_edit &&
      !networkAllowed(req.socket.remoteAddress, allowedSubnets)
    )
      return res.status(403).json({
        error: {
          code: "network_denied",
          message: "This Whiteboard is available on its configured LAN only.",
        },
      });
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    if (req.path.startsWith("/api")) res.set("Cache-Control", "no-store");
    // A link from Workbench/Telegram may navigate to the public app shell.
    // Cross-site API requests, form writes and embedded frames stay blocked.
    const publicNavigation =
      ["GET", "HEAD"].includes(req.method) &&
      req.get("sec-fetch-mode") === "navigate" &&
      req.get("sec-fetch-dest") === "document" &&
      !req.path.startsWith("/api");
    const origin = req.get("origin");
    let originMatchesHost = !origin;
    if (origin) {
      try {
        // A TLS-terminating reverse proxy preserves Host while Express sees the
        // connector's HTTP hop. Compare authorities so same-origin module and
        // stylesheet requests keep working without trusting forwarded headers.
        originMatchesHost =
          new URL(origin).host.toLowerCase() ===
          String(req.get("host") || "").toLowerCase();
      } catch {
        originMatchesHost = false;
      }
    }
    if (!publicNavigation && origin && !originMatchesHost)
      return res.status(403).json({
        error: {
          code: "origin_denied",
          message: "Use the Whiteboard origin directly.",
        },
      });
    if (!publicNavigation && req.get("sec-fetch-site") === "cross-site")
      return res.status(403).json({
        error: {
          code: "origin_denied",
          message: "Cross-site requests are not accepted.",
        },
      });
    next();
  });
  app.use(express.json({ limit: "512kb" }));
  app.get("/api/health", (_req, res) =>
    res.json({ ok: true, product: "HASHI Whiteboard", version: "0.1.0" }),
  );
  app.get("/api/guide", (_req, res) => res.json({ ...GUIDE, access }));
  const actorFor = (req) => {
    const authorization = req.get("authorization");
    if (authorization)
      return store.authenticate(
        authorization.startsWith("Bearer ") ? authorization.slice(7) : "",
      );
    const raw = /(?:^|;\s*)whiteboard_session=([^;]+)/.exec(
      req.get("cookie") || "",
    )?.[1];
    const session = raw && sessions.get(hash(raw));
    if (session && session.expires > Date.now()) {
      const actor = store.actor(session.actor_id);
      if (actor && !actor.disabled) return actor;
    }
    return access.shared_edit ? store.actor("lan-shared") : null;
  };
  app.post("/api/session", (req, res) => {
    const ip = req.socket.remoteAddress,
      window = attempts.get(ip);
    const count =
      window && window.until > Date.now()
        ? window
        : { n: 0, until: Date.now() + 60000 };
    count.n += 1;
    attempts.set(ip, count);
    fail(
      count.n <= 20,
      "rate_limited",
      "Too many login attempts. Wait one minute.",
      429,
    );
    const actor = store.authenticate(
      typeof req.body?.token === "string" ? req.body.token : "",
    );
    fail(actor, "unauthorized", "Invalid or revoked access key.", 401);
    const token = randomBytes(32).toString("base64url");
    sessions.set(hash(token), {
      actor_id: actor.id,
      expires: Date.now() + 8 * 3600000,
    });
    res.cookie("whiteboard_session", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: req.secure,
      maxAge: 8 * 3600000,
      path: "/",
    });
    res.json({ actor });
  });
  app.use("/api", (req, _res, next) => {
    req.actor = actorFor(req);
    fail(
      req.actor,
      "unauthorized",
      "Sign in or send your assigned Bearer key.",
      401,
    );
    next();
  });
  app.delete("/api/session", (req, res) => {
    const raw = /(?:^|;\s*)whiteboard_session=([^;]+)/.exec(
      req.get("cookie") || "",
    )?.[1];
    if (raw) sessions.delete(hash(raw));
    res.clearCookie("whiteboard_session", { path: "/" });
    res.json({ ok: true });
  });
  app.get("/api/me", (req, res) => res.json({ actor: req.actor, access }));
  app.get("/api/connection", (req, res) => {
    const bound = req.socket.server.address();
    const port = bound.port;
    const all = ["0.0.0.0", "::"].includes(bound.address);
    const addresses = [
      ...new Set(
        Object.values(networkInterfaces())
          .flat()
          .filter((a) => a?.family === "IPv4" && !a.internal)
          .map((a) => a.address),
      ),
    ];
    addresses.sort(
      (a, b) =>
        Number(b.startsWith("192.168.")) - Number(a.startsWith("192.168.")),
    );
    const lan = all ? addresses : addresses.filter((a) => a === bound.address);
    res.json({
      local_url: `http://${all ? "127.0.0.1" : bound.address.includes(":") ? `[${bound.address}]` : bound.address}:${port}`,
      lan_urls: lan.map((a) => `http://${a}:${port}`),
    });
  });
  app.get("/api/announcements", (_req, res) =>
    res.json({ announcements: store.announcements() }),
  );
  app.get("/api/board", (req, res) =>
    res.json(
      store.snapshot({
        project: String(req.query.project || ""),
        archived: req.query.archived === "true",
      }),
    ),
  );
  app.get("/api/cards/:id", (req, res) =>
    res.json({ card: store.readCard(req.params.id) }),
  );
  const mutate = (fn) => (req, res) => {
    const body = Buffer.isBuffer(req.body)
      ? hash(req.body)
      : JSON.stringify(req.body || {});
    const result = store.write(
      req.actor,
      req.get("Idempotency-Key"),
      hash(`${req.method} ${req.path}\n${body}`),
      () => fn(req),
    );
    res.json(result);
  };
  app.post(
    "/api/cards",
    mutate((req) => store.createCard(req.actor, req.body)),
  );
  app.post(
    "/api/layout/tidy",
    mutate((req) => store.tidy(req.actor, req.body)),
  );
  app.post(
    "/api/layout/undo",
    mutate((req) => store.undoLayout(req.actor, req.body)),
  );
  app.post(
    "/api/cards/:id/topic",
    mutate((req) => store.setTopic(req.actor, req.params.id, req.body)),
  );
  app.patch(
    "/api/cards/:id",
    mutate((req) => store.updateCard(req.actor, req.params.id, req.body)),
  );
  app.patch(
    "/api/cards/:id/layout",
    mutate((req) => store.layout(req.actor, req.params.id, req.body)),
  );
  app.post(
    "/api/cards/:id/comments",
    mutate((req) => store.addComment(req.actor, req.params.id, req.body)),
  );
  app.post(
    "/api/cards/:id/archive",
    mutate((req) => store.archive(req.actor, req.params.id, req.body)),
  );
  app.post(
    "/api/cards/:id/handoff",
    mutate((req) => store.handoff(req.actor, req.params.id, req.body)),
  );
  app.post(
    "/api/actors",
    mutate((req) => store.createActor(req.actor, req.body)),
  );
  app.delete(
    "/api/actors/:id",
    mutate((req) => store.revokeActor(req.actor, req.params.id)),
  );
  app.post(
    "/api/edges",
    mutate((req) => store.addEdge(req.actor, req.body)),
  );
  app.delete(
    "/api/edges/:id",
    mutate((req) =>
      store.removeEntity(req.actor, req.params.id, "edge", req.body),
    ),
  );
  app.post(
    "/api/strokes",
    mutate((req) => store.addStroke(req.actor, req.body)),
  );
  app.delete(
    "/api/strokes/:id",
    mutate((req) =>
      store.removeEntity(req.actor, req.params.id, "stroke", req.body),
    ),
  );
  app.post(
    "/api/assets",
    express.raw({
      type: [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "application/octet-stream",
      ],
      limit: "10mb",
    }),
    mutate((req) => {
      fail(
        Buffer.isBuffer(req.body),
        "invalid_image",
        "Upload binary image bytes with an image Content-Type.",
      );
      return store.addAsset(req.body);
    }),
  );
  app.get("/api/assets/:id", (req, res) => {
    const asset = store.asset(req.params.id);
    fail(asset, "not_found", "Image not found.", 404);
    res
      .type(asset.mime)
      .set("Content-Disposition", "inline")
      .send(Buffer.from(asset.body));
  });
  const sendEvent = (client, event) => {
    const actor = store.actor(client.actor_id);
    if (!actor || actor.disabled || client.expires <= Date.now()) {
      client.res.end();
      clients.delete(client);
      return;
    }
    if (client.res.writableLength > 256 * 1024) {
      client.res.destroy();
      clients.delete(client);
      return;
    }
    client.res.write(`event: change\ndata: ${JSON.stringify(event)}\n\n`);
  };
  store.onChange = (event) => {
    for (const c of clients) sendEvent(c, event);
  };
  app.get("/api/events", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const client = {
      res,
      actor_id: req.actor.id,
      expires: Date.now() + 8 * 3600000,
    };
    clients.add(client);
    res.write(
      `event: change\ndata: ${JSON.stringify({ seq: store.revision() })}\n\n`,
    );
    req.on("close", () => clients.delete(client));
  });
  const heartbeat = setInterval(() => {
    for (const c of clients)
      sendEvent(c, { seq: store.revision(), heartbeat: true });
    for (const [key, s] of sessions)
      if (s.expires <= Date.now()) sessions.delete(key);
    for (const [key, attempt] of attempts)
      if (attempt.until < Date.now()) attempts.delete(key);
  }, 20000);
  heartbeat.unref();
  store.prune();
  const maintenance = setInterval(() => {
    try {
      store.prune();
    } catch (e) {
      console.error("Board maintenance failed:", e.message);
    }
  }, 3600000);
  maintenance.unref();
  app.use("/api", (_req, _res, next) =>
    next(new BoardError("not_found", "Unknown API endpoint.", 404)),
  );
  app.use(express.static(staticDir, { index: false }));
  app.get("*", (_req, res) => {
    const entry = path.join(staticDir, "index.html");
    if (!fs.existsSync(entry))
      return res.status(503).send("Run npm run build, then npm start.");
    res.set("Cache-Control", "no-store").sendFile(entry);
  });
  app.use((error, _req, res, _next) => {
    const status =
      error instanceof BoardError
        ? error.status
        : error.type === "entity.too.large"
          ? 413
          : error.type === "entity.parse.failed"
            ? 400
            : 500;
    if (status === 500)
      console.error("Whiteboard request failed:", error.message);
    res.status(status).json({
      error: {
        code:
          error.code ||
          (status === 413
            ? "body_too_large"
            : status === 400
              ? "invalid_json"
              : "internal_error"),
        message:
          status === 500
            ? "Storage request failed. Re-read before retrying."
            : error.message,
        ...(error.details || {}),
      },
    });
  });
  return {
    app,
    store,
    close() {
      clearInterval(heartbeat);
      clearInterval(maintenance);
      for (const c of clients) c.res.end();
      clients.clear();
      store.close();
    },
  };
}

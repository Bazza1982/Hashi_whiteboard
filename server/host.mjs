import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSettings } from "./settings.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const dataDir = path.resolve(
  process.env.WHITEBOARD_DATA_DIR || path.join(root, "data"),
);
const logDir = path.join(dataDir, "logs");
fs.mkdirSync(logDir, { recursive: true });
const stateFile = path.join(dataDir, "host-status.json");
const logFile = path.join(logDir, "service.log");
let worker,
  retry,
  checking = false,
  stopping = false,
  failures = 0,
  restarts = 0,
  startedAt = 0;
const state = {
  host_pid: process.pid,
  worker_pid: null,
  started_at: new Date().toISOString(),
  restart_count: 0,
  last_exit: null,
};
function save() {
  fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(state, null, 2));
  fs.renameSync(`${stateFile}.tmp`, stateFile);
}
function log(message) {
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) {
    fs.rmSync(`${logFile}.1`, { force: true });
    fs.renameSync(logFile, `${logFile}.1`);
  }
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
}
function launch() {
  if (stopping) return;
  startedAt = Date.now();
  worker = spawn(process.execPath, [path.join(root, "server/index.mjs")], {
    cwd: root,
    env: { ...process.env, WHITEBOARD_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const child = worker;
  state.worker_pid = child.pid || null;
  state.restart_count = restarts;
  state.worker_started_at = new Date().toISOString();
  save();
  log(`worker started pid=${child.pid}`);
  child.stdout.on("data", (chunk) =>
    log(`stdout ${chunk.toString("utf8").trimEnd()}`),
  );
  child.stderr.on("data", (chunk) =>
    log(`stderr ${chunk.toString("utf8").trimEnd()}`),
  );
  child.once("error", (error) => log(`worker launch failed: ${error.message}`));
  child.once("close", (code, signal) => {
    worker = null;
    failures = 0;
    state.worker_pid = null;
    state.last_exit = { code, signal, at: new Date().toISOString() };
    log(`worker exited code=${code} signal=${signal}`);
    if (stopping) {
      save();
      return;
    }
    restarts += 1;
    state.restart_count = restarts;
    save();
    const delay =
      Date.now() - startedAt > 60000
        ? 1000
        : Math.min(30000, 1000 * 2 ** Math.min(restarts - 1, 5));
    retry = setTimeout(launch, delay);
  });
}
const watchdog = setInterval(async () => {
  if (checking || stopping || !worker || Date.now() - startedAt < 10000) return;
  checking = true;
  const child = worker;
  try {
    const { host, port } = loadSettings(dataDir);
    const address =
      host === "0.0.0.0" || host === "::"
        ? "127.0.0.1"
        : host.includes(":")
          ? `[${host}]`
          : host;
    const response = await fetch(`http://${address}:${port}/api/health`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json();
    if (!response.ok || body.product !== "HASHI Whiteboard")
      throw new Error(`health returned ${response.status}`);
    failures = 0;
    state.last_healthy_at = new Date().toISOString();
    save();
  } catch (error) {
    if (child === worker) {
      failures += 1;
      log(`health check failed ${failures}/3: ${error.message}`);
      if (failures >= 3) {
        log("restarting unresponsive worker");
        child.kill();
      }
    }
  } finally {
    checking = false;
  }
}, 15000);
function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(watchdog);
  clearTimeout(retry);
  log("host stopping");
  if (worker) worker.kill();
  else {
    state.worker_pid = null;
    save();
  }
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
log(`host started pid=${process.pid}`);
launch();

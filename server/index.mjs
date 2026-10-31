import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { createApp } from "./app.mjs";
import { loadSettings } from "./settings.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const dataDir = path.resolve(
  process.env.WHITEBOARD_DATA_DIR || path.join(root, "data"),
);
const { port, host, accessMode, allowedSubnets } = loadSettings(dataDir);
const service = createApp({
  dataDir,
  accessMode,
  allowedSubnets,
  ...(process.env.WHITEBOARD_ADMIN_KEY
    ? { adminKey: process.env.WHITEBOARD_ADMIN_KEY }
    : {}),
});
const server = service.app.listen(port, host, () => {
  console.log(
    `HASHI Whiteboard · http://${host === "0.0.0.0" ? "localhost" : host.includes(":") ? `[${host}]` : host}:${port}`,
  );
  if (host === "0.0.0.0")
    for (const interfaces of Object.values(networkInterfaces()))
      for (const address of interfaces || [])
        if (address.family === "IPv4" && !address.internal)
          console.log(`LAN: http://${address.address}:${port}`);
  console.log(
    accessMode === "lan"
      ? `Access: LAN shared editing without a key. Allowed: ${allowedSubnets.join(", ")}`
      : "Access: run npm run access in this project.",
  );
  console.log(`Data: ${dataDir}`);
  console.log(
    "Owner administration still requires its key. No firewall/router changes are made by the server.",
  );
});
server.on("error", (error) => {
  console.error(error.message);
  service.close();
  process.exitCode = 1;
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  service.close();
  server.close();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

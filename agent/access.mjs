import path from "node:path";
import { fileURLToPath } from "node:url";
import { localKey } from "../server/app.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const key =
  process.env.WHITEBOARD_ADMIN_KEY ||
  localKey(
    path.resolve(process.env.WHITEBOARD_DATA_DIR || path.join(root, "data")),
  );
console.log(
  "Owner access key (keep private; assign separate keys to agents in the UI):",
);
console.log(key);

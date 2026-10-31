import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const git = (...args) => execFileSync("git", args, {
  cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
});
const privatePath = /(^|\/)(data|artifacts|node_modules|dist|projects|private|local|backups|exports|uploads|attachments|screenshots|secrets|credentials)\/|(^|\/)\.env(?:$|\.)|(^|\/)\.(?:envrc|npmrc)$|\.(?:sqlite[^/]*|db(?:-[^/]*)?|pem|key|pfx|p12|bak|zip|7z)$/i;
const contentChecks = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub credential", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["API credential", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ["cloud access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["Telegram bot credential", /\b\d{8,12}:[A-Za-z0-9_-]{35}\b/],
  ["host user directory", /[A-Za-z]:\\+(?:Users|home)\\+[A-Za-z0-9_.-]+\\/i],
  ["host home directory", /\/home\/[a-z][a-z0-9_-]+\//i],
];
const failures = new Set();
const current = git("ls-files", "-z").split("\0").filter(Boolean);
const history = git("log", "--all", "--format=", "--name-only").split(/\r?\n/).filter(Boolean);
for (const name of new Set([...current, ...history])) {
  if (privatePath.test(name)) failures.add("Private/generated path: " + name);
}
function scan(name, content) {
  if (content.includes("\0")) {
    failures.add("Binary material needs explicit publication review: " + name);
    return;
  }
  for (const [label, pattern] of contentChecks) {
    if (pattern.test(content)) failures.add(label + ": " + name);
  }
}
for (const name of current) scan(name, readFileSync(path.join(root, name), "utf8"));
// Inspect reachable historical file contents, not only their paths.
const seen = new Set();
for (const line of git("rev-list", "--objects", "--all").split(/\r?\n/)) {
  const split = line.indexOf(" ");
  if (split < 0) continue;
  const oid = line.slice(0, split), name = line.slice(split + 1);
  if (seen.has(oid) || git("cat-file", "-t", oid).trim() !== "blob") continue;
  seen.add(oid);
  scan("history/" + name, git("cat-file", "blob", oid));
}
const samples = [
  "data/settings.json", "data/admin-key.txt", "data/board.sqlite",
  "artifacts/screenshot.png", "projects/live.json", "private/notes.md",
  "exports/board.json", "uploads/image.png", ".env.production", "secrets/key.pem",
];
const ignored = new Set(execFileSync("git", ["check-ignore", "--stdin"], {
  cwd: root, encoding: "utf8", input: samples.join("\n") + "\n",
}).trim().split(/\r?\n/));
for (const sample of samples) {
  if (!ignored.has(sample)) failures.add("Missing ignore protection: " + sample);
}
if (failures.size) {
  console.error([...failures].join("\n")); // Paths and finding categories only.
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    ok: true, tracked_files: current.length, historical_blobs: seen.size,
    ignore_samples: samples.length,
    scope: "tracked source and reachable history; manual review still required",
  }));
}

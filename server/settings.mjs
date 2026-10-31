import fs from "node:fs";
import path from "node:path";
import { isIPv4, isIP } from "node:net";

function ipv4Number(address) {
  return (
    address
      .split(".")
      .reduce((value, octet) => value * 256 + Number(octet), 0) >>> 0
  );
}
function subnet(value) {
  if (typeof value !== "string")
    throw new Error("Each allowed subnet must be IPv4 CIDR.");
  const [address, prefix, extra] = value.split("/");
  if (
    !isIPv4(address) ||
    !/^\d{1,2}$/.test(prefix || "") ||
    Number(prefix) > 32 ||
    extra !== undefined
  )
    throw new Error(`Invalid allowed subnet: ${value}`);
  const mask =
    Number(prefix) === 0 ? 0 : (0xffffffff << (32 - Number(prefix))) >>> 0;
  return { network: (ipv4Number(address) & mask) >>> 0, mask };
}
export function networkAllowed(address, allowedSubnets) {
  const normalized = address?.startsWith("::ffff:")
    ? address.slice(7)
    : address === "::1"
      ? "127.0.0.1"
      : address;
  if (!isIPv4(normalized || "")) return false;
  const value = ipv4Number(normalized);
  return allowedSubnets.some((entry) => {
    const { network, mask } = subnet(entry);
    return (value & mask) >>> 0 === network;
  });
}
export function validateAccess(mode, allowedSubnets) {
  if (!["key", "lan"].includes(mode))
    throw new Error("access_mode must be key or lan.");
  if (!Array.isArray(allowedSubnets) || !allowedSubnets.length)
    throw new Error("allowed_subnets must be a non-empty list.");
  allowedSubnets.forEach(subnet);
}
export function loadSettings(dataDir, env = process.env) {
  const file = path.join(dataDir, "settings.json");
  const local = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : {};
  const settings = {
    host: env.WHITEBOARD_HOST || local.host || "0.0.0.0",
    port: Number(env.WHITEBOARD_PORT || local.port || 4417),
    accessMode: env.WHITEBOARD_ACCESS_MODE || local.access_mode || "key",
    allowedSubnets: env.WHITEBOARD_ALLOWED_SUBNETS?.split(",").map((x) =>
      x.trim(),
    ) ||
      local.allowed_subnets || ["127.0.0.0/8"],
  };
  if (!isIP(settings.host))
    throw new Error("WHITEBOARD_HOST / host must be an IP address.");
  if (
    !Number.isInteger(settings.port) ||
    settings.port < 1 ||
    settings.port > 65535
  )
    throw new Error("Invalid WHITEBOARD_PORT / port.");
  validateAccess(settings.accessMode, settings.allowedSubnets);
  return settings;
}

export async function request(
  path,
  {
    method = "GET",
    body,
    operationId,
    url = process.env.WHITEBOARD_URL || "http://127.0.0.1:4417",
    token = process.env.WHITEBOARD_API_KEY,
  } = {},
) {
  const base = new URL(url);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.pathname !== "/"
  )
    throw new Error(
      "WHITEBOARD_URL must be an HTTP(S) origin without credentials or a path.",
    );
  if (method !== "GET" && !operationId)
    throw new Error(
      "operation_id is required for every write. Retain it on transport retry.",
    );
  const response = await fetch(new URL(path, base), {
    method,
    signal: AbortSignal.timeout(20000),
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(operationId ? { "Idempotency-Key": operationId } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) {
    const e = new Error(result.error?.message || "Whiteboard request failed.");
    Object.assign(e, {
      code: result.error?.code,
      status: response.status,
      details: result.error,
    });
    throw e;
  }
  return result;
}

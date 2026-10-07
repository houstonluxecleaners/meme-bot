/** Classify provider failures without exposing endpoint URLs, headers or API keys. */
export function rpcFailureReason(error: unknown): string {
  if (!error || typeof error !== "object") return "REQUEST_FAILED";
  const value = error as Record<string, unknown>;
  const context =
    value.context && typeof value.context === "object"
      ? (value.context as Record<string, unknown>)
      : {};
  const status =
    context.statusCode ?? context.status ?? value.statusCode ?? value.status;
  if (status === 429 || value.code === 429) return "RATE_LIMITED";
  if (status === 401 || status === 403) return "ACCESS_DENIED";
  if (typeof status === "number" && status >= 500 && status < 600)
    return "PROVIDER_UNAVAILABLE";
  if (value.name === "TimeoutError" || value.name === "AbortError")
    return "TIMEOUT";
  if (value.code === -32601) return "METHOD_UNSUPPORTED";
  if (value.code === -32005) return "NODE_UNHEALTHY";
  const cause =
    value.cause && typeof value.cause === "object"
      ? (value.cause as Record<string, unknown>)
      : {};
  if (
    [
      "EAI_AGAIN",
      "ENOTFOUND",
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
    ].includes(String(cause.code ?? value.code))
  )
    return "NETWORK_ERROR";
  return "REQUEST_FAILED";
}
export class RpcRequestError extends Error {
  constructor(readonly reason: string) {
    super("RPC request failed");
    this.name = "RpcRequestError";
  }
}

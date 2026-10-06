// Do not log RPC URLs, request headers, environment values, or provider errors
// that may echo endpoint credentials.
export const log = (
  level: "info" | "warn" | "error",
  message: string,
  details: Record<string, unknown> = {},
): void => {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      level,
      message,
      ...details,
    }),
  );
};

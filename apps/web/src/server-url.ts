export function resolveServerBase(input: {
  configured: string | undefined;
  development: boolean;
  protocol: string;
  hostname: string;
  origin: string;
}): string {
  if (input.configured) return input.configured.replace(/\/$/, "");
  if (input.development) return `${input.protocol}//${input.hostname}:8787`;
  return input.origin;
}

/** Dev HTTP and WebSocket must use the same reachable endpoint, not a startup-time LAN IP. */
export function resolveWebSocketUrl(input: {
  serverBase: string;
  development: boolean;
  advertisedUrl: string;
}): string {
  if (!input.development) return input.advertisedUrl;
  return `${input.serverBase.replace(/\/$/, "").replace(/^http/, "ws")}/ws`;
}

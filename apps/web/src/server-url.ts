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

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * 发给别人的链接（邀请、分享）用的地址。开发时页面多半开在 localhost 上，别人打不开：
 * 换成 Server 公布的局域网主机名，端口仍用当前页面（Vite）的；正式环境直接用 Server 公布的地址。
 */
export function resolveShareBase(input: {
  development: boolean;
  location: { protocol: string; hostname: string; port: string; pathname: string; origin: string };
  advertisedUrl: string | undefined;
}): string {
  const { location } = input;
  if (!input.development) {
    return (input.advertisedUrl ?? `${location.origin}${location.pathname}`).replace(/\/$/, "");
  }
  let host = location.hostname;
  if (LOOPBACK_HOSTS.has(host) && input.advertisedUrl) {
    const advertised = new URL(input.advertisedUrl).hostname;
    if (!LOOPBACK_HOSTS.has(advertised)) host = advertised;
  }
  const port = location.port ? `:${location.port}` : "";
  return `${location.protocol}//${host}${port}${location.pathname}`.replace(/\/$/, "");
}

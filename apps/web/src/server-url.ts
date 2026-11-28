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

/**
 * WebSocket 和 HTTP 走同一个地址：页面能从 serverBase 加载出来，说明这个地址浏览器连得上。
 * Server 公布的 wsUrl 是启动时选的局域网地址，可能和浏览器打开页面用的不一样（本机用 localhost
 * 打开、公布的是 10.x）；这时连公布的地址会被 Server 的 CSP（connect-src 只放行当前 host）拦掉，
 * 房间永远连不上。只有公布地址和 serverBase 是同一个 host 时才用它（保留反向代理下自定义的路径）。
 */
export function resolveWebSocketUrl(input: {
  serverBase: string;
  development: boolean;
  advertisedUrl: string;
}): string {
  const base = input.serverBase.replace(/\/$/, "");
  const sameEndpoint = `${base.replace(/^http/, "ws")}/ws`;
  if (input.development) return sameEndpoint;
  try {
    if (new URL(input.advertisedUrl).host === new URL(base).host) return input.advertisedUrl;
  } catch {
    // 公布的地址解析不了就用同源
  }
  return sameEndpoint;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** 地址指向本机回环（别的设备拿到也打不开）；解析不了的按不是处理 */
export function isLoopbackUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

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

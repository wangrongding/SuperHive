import { networkInterfaces } from "node:os";

/**
 * 判断一个 HTTP 请求是否来自 Hive Server 所在的这台电脑本身。
 * "本机 Agent" 能在这台电脑上启动进程，只能给坐在这台电脑前的房主用：
 * - 对端地址必须是回环地址或本机网卡地址（允许用局域网 IP 访问自己）
 * - 经过反向代理的请求一律拒绝：同机代理会让所有外部访问者看起来都像本机
 * - Host 必须是 localhost 或本机 IP 字面量：DNS rebinding 时 Host 是攻击者的域名
 * - 带 Origin 时其主机也必须属于本机：拦住恶意网页从浏览器里发起的跨站请求
 */

export type LocalRequestLike = {
  socket: { remoteAddress?: string | undefined };
  headers: Record<string, string | string[] | undefined>;
};

export type LocalCheck = { local: true } | { local: false; reason: string };

const PROXY_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip"];
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** 去掉 IPv4-mapped 前缀与 IPv6 方括号，统一成小写 */
function normalizeAddress(address: string): string {
  const unbracketed = address.replace(/^\[|\]$/g, "").toLowerCase();
  return unbracketed.startsWith("::ffff:") ? unbracketed.slice(7) : unbracketed;
}

function isLoopback(address: string): boolean {
  return LOOPBACK_NAMES.has(address) || /^127\./.test(address);
}

/** 本机所有网卡地址；每次现取，网卡变化（换 Wi-Fi、开 VPN）后无需重启 */
export function localAddresses(): Set<string> {
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) addresses.add(normalizeAddress(entry.address));
  }
  return addresses;
}

function hostnameOf(value: string, withScheme: boolean): string | undefined {
  try {
    return normalizeAddress(new URL(withScheme ? value : `http://${value}`).hostname);
  } catch {
    return undefined;
  }
}

export function checkLocalRequest(
  request: LocalRequestLike,
  addresses: Set<string> = localAddresses(),
): LocalCheck {
  const isSelf = (address: string) => isLoopback(address) || addresses.has(address);

  const remote = request.socket.remoteAddress ? normalizeAddress(request.socket.remoteAddress) : "";
  if (!remote || !isSelf(remote))
    return { local: false, reason: "请求不是来自 Hive Server 所在的电脑" };
  if (PROXY_HEADERS.some((name) => request.headers[name] !== undefined)) {
    return { local: false, reason: "经过代理转发的请求不能使用本机 Agent" };
  }

  const hostHeader = request.headers.host;
  const host = typeof hostHeader === "string" ? hostnameOf(hostHeader, false) : undefined;
  if (!host || !isSelf(host)) {
    return { local: false, reason: "请用 localhost 或本机 IP 地址打开页面" };
  }

  const originHeader = request.headers.origin;
  if (originHeader !== undefined) {
    const origin = typeof originHeader === "string" ? hostnameOf(originHeader, true) : undefined;
    if (!origin || !isSelf(origin)) return { local: false, reason: "跨站请求不能使用本机 Agent" };
  }
  return { local: true };
}

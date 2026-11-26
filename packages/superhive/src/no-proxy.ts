/**
 * 设了代理时，把要连的 Hive Server 加进 NO_PROXY：带进别人房间时对方多半是局域网地址（192.168.x.x），
 * 运行时（Claude Code、agy……）连 Hive MCP 会照着 HTTPS_PROXY 走代理，局域网地址经代理通常连不上。
 * 本机 Hive Server 拉起时已经带了回环地址，这里只补上 --server 的主机名。没设代理时什么都不改。
 */
const PROXY_KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"];

export function addServerToNoProxy(env: NodeJS.ProcessEnv, serverUrl: string): boolean {
  const hasProxy = Object.keys(env).some(
    (key) => PROXY_KEYS.includes(key.toUpperCase()) && env[key],
  );
  if (!hasProxy) return false;
  let host: string;
  try {
    host = new URL(serverUrl).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (!host) return false;
  const current = env.NO_PROXY ?? env.no_proxy ?? "";
  const entries = current
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (entries.some((item) => item === "*" || item.toLowerCase() === host.toLowerCase()))
    return false;
  const value = [...entries, host].join(",");
  env.NO_PROXY = value;
  env.no_proxy = value;
  return true;
}

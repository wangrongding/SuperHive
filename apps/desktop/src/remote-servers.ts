/**
 * 别人的 Hive：客户端除了本机 Hive，还能打开别人发来的邀请链接，进入对方的房间。
 *
 * - 每个外部服务器（按 origin 区分）开一个单独的窗口，和本机的主窗口分开：不给 preload，
 *   拿不到终端、选文件这些本机能力；存储放在单独的分区里，访客凭证只在那个 origin 下。
 * - 打开过的服务器记在 remote-servers.json，本机页面的侧栏据此列出「别人的服务器」，点一下切过去。
 * - superhive:// 深链接：`superhive://join?url=<邀请链接>` 打开别人的房间；
 *   `superhive://agent-join?server=…&room=…&name=…&token=…` 让本机页面弹出「带 Agent 加入」，
 *   由人选本机 Agent 并确认后才会接入。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DEEP_LINK_SCHEME = "superhive";
/** 别人的服务器共用一个持久化分区：和本机 Hive 的存储分开，重启后访客身份还在 */
export const REMOTE_PARTITION = "persist:superhive-remote";
/** 最多记住多少个服务器；再多按最近打开的留 */
const MAX_SERVERS = 30;

export type RemoteServer = {
  origin: string;
  /** 上次打开的完整地址（带房间和邀请），重新打开时回到这里 */
  url: string;
  addedAt: string;
  lastOpenedAt: string;
};

export type AgentJoinRequest = {
  server: string;
  roomId: string;
  name: string;
  token: string;
};

export type DeepLink =
  { kind: "open"; url: string; origin: string } | ({ kind: "agent-join" } & AgentJoinRequest);

/**
 * 外部服务器地址只认 http(s)，不带用户名密码；返回规范化后的 origin 和完整地址。
 * 「完整地址」只保留路径和 hash（邀请令牌在 hash 里，不会发给服务器日志）。
 */
export function normalizeRemoteUrl(input: string): { origin: string; url: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.username || parsed.password) return undefined;
  if (!parsed.hostname) return undefined;
  return {
    origin: parsed.origin,
    url: `${parsed.origin}${parsed.pathname}${parsed.search}${parsed.hash}`,
  };
}

const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NAME = /^[\p{L}\p{N}_.-]{1,64}$/u;
const TOKEN = /^[A-Za-z0-9_-]{8,256}$/;

/** 解析 superhive:// 深链接；格式不对或参数可疑时返回 undefined（什么都不做） */
export function parseDeepLink(input: string): DeepLink | undefined {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== `${DEEP_LINK_SCHEME}:`) return undefined;
  // superhive://join?… 里 join 是 host；superhive:join?… 时在 pathname
  const action = (parsed.host || parsed.pathname).replace(/^\/+|\/+$/g, "");
  const params = parsed.searchParams;
  if (action === "join" || action === "open") {
    const target = normalizeRemoteUrl(params.get("url") ?? "");
    return target ? { kind: "open", ...target } : undefined;
  }
  if (action === "agent-join") {
    const server = normalizeRemoteUrl(params.get("server") ?? "");
    const roomId = params.get("room") ?? "";
    const name = params.get("name") ?? "";
    const token = params.get("token") ?? "";
    if (!server || !ROOM_ID.test(roomId) || !NAME.test(name) || !TOKEN.test(token))
      return undefined;
    return { kind: "agent-join", server: server.origin, roomId, name, token };
  }
  return undefined;
}

/**
 * 深链接打开别人的房间前的确认内容：真实的服务器地址、房间、会用什么身份加入。
 * 链接里的东西都不可信，这里只从规范化后的地址里取，不信链接里另写的说明文字。
 */
export function describeRoomLink(target: { origin: string; url: string }): {
  host: string;
  origin: string;
  roomId: string | undefined;
  hasInvite: boolean;
} {
  const url = new URL(target.url);
  const [room = "", query = ""] = url.hash.replace(/^#/, "").split("?", 2);
  return {
    host: url.host,
    origin: target.origin,
    roomId: ROOM_ID.test(room) ? room : undefined,
    hasInvite: Boolean(new URLSearchParams(query).get("invite")),
  };
}

/** Windows / Linux 上深链接作为命令行参数传进来（启动时或 second-instance） */
export function deepLinkFromArgv(argv: readonly string[]): string | undefined {
  return argv.find((arg) => arg.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}:`));
}

export function loadRemoteServers(file: string): RemoteServer[] {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as { servers?: unknown };
    if (!Array.isArray(value.servers)) return [];
    return value.servers.flatMap((item: unknown) => {
      const entry = item as Partial<RemoteServer>;
      const normalized = typeof entry?.url === "string" ? normalizeRemoteUrl(entry.url) : undefined;
      if (!normalized || normalized.origin !== entry.origin) return [];
      const addedAt = typeof entry.addedAt === "string" ? entry.addedAt : new Date(0).toISOString();
      return [
        {
          origin: normalized.origin,
          url: normalized.url,
          addedAt,
          lastOpenedAt: typeof entry.lastOpenedAt === "string" ? entry.lastOpenedAt : addedAt,
        },
      ];
    });
  } catch {
    return [];
  }
}

export function saveRemoteServers(file: string, servers: readonly RemoteServer[]): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ servers }, null, 2)}\n`);
    renameSync(temp, file);
  } catch {
    /* 存不下来只影响下次的列表 */
  }
}

/** 记一次打开：新服务器加到最前，已有的更新地址和时间；最近打开的排前面 */
export function upsertRemoteServer(
  servers: readonly RemoteServer[],
  target: { origin: string; url: string },
  now: Date,
): RemoteServer[] {
  const stamp = now.toISOString();
  const existing = servers.find((server) => server.origin === target.origin);
  const next: RemoteServer = {
    origin: target.origin,
    url: target.url,
    addedAt: existing?.addedAt ?? stamp,
    lastOpenedAt: stamp,
  };
  return [next, ...servers.filter((server) => server.origin !== target.origin)].slice(
    0,
    MAX_SERVERS,
  );
}

/** 窗口标题：一眼看出这是别人的服务器 */
export function remoteWindowTitle(origin: string, pageTitle?: string): string {
  const host = new URL(origin).host;
  const page = pageTitle?.trim();
  return page && page !== "SuperHive" ? `${page} — ${host}` : `SuperHive — ${host}`;
}

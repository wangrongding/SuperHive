/**
 * 「加入别人的房间」：解析别人发来的东西。可以是
 * - 邀请链接 `http://对方地址:8787/#房间?invite=hvi_…`（人加入），或者对方 Hive 的地址；
 * - `superhive://join?url=<邀请链接>`；
 * - 带 Agent 加入的接入命令 `… join --server … --room … --name … --token …`，
 *   或者 `superhive://agent-join?server=…&room=…&name=…&token=…`。
 */

export type JoinTarget =
  | { kind: "room"; url: string; origin: string; roomId?: string; hasInvite: boolean }
  | { kind: "agent"; server: string; roomId?: string; name: string; token: string };

const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NAME = /^[\p{L}\p{N}_.-]{1,64}$/u;
const TOKEN = /^[A-Za-z0-9_-]{8,256}$/;

function httpUrl(input: string): URL | undefined {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password || !url.hostname) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function roomTarget(input: string): JoinTarget | undefined {
  const url = httpUrl(input);
  if (!url) return undefined;
  const [room = "", query = ""] = url.hash.replace(/^#/, "").split("?", 2);
  const roomId = ROOM_ID.test(room) ? room : undefined;
  return {
    kind: "room",
    url: url.href,
    origin: url.origin,
    ...(roomId ? { roomId } : {}),
    hasInvite: Boolean(new URLSearchParams(query).get("invite")),
  };
}

function agentTarget(fields: {
  server?: string | null | undefined;
  room?: string | null | undefined;
  name?: string | null | undefined;
  token?: string | null | undefined;
}): JoinTarget | undefined {
  const server = httpUrl(fields.server ?? "");
  const name = fields.name ?? "";
  const token = fields.token ?? "";
  const room = fields.room ?? "";
  if (!server || !NAME.test(name) || !TOKEN.test(token)) return undefined;
  if (room && !ROOM_ID.test(room)) return undefined;
  return {
    kind: "agent",
    server: server.origin,
    ...(room ? { roomId: room } : {}),
    name,
    token,
  };
}

/** 从命令行里取 `--flag value` 或 `--flag=value`（值可以带引号） */
function commandFlags(command: string): Map<string, string> {
  const words = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const unquote = (word: string) => word.replace(/^(["'])(.*)\1$/, "$2");
  const flags = new Map<string, string>();
  for (let index = 0; index < words.length; index += 1) {
    const word = unquote(words[index]!);
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(word);
    if (!match) continue;
    if (match[2] !== undefined) flags.set(match[1]!, unquote(match[2]));
    else if (words[index + 1] && !words[index + 1]!.startsWith("--")) {
      flags.set(match[1]!, unquote(words[index + 1]!));
      index += 1;
    }
  }
  return flags;
}

export function parseJoinInput(raw: string): JoinTarget | undefined {
  const input = raw.trim();
  if (!input) return undefined;
  if (/^superhive:/i.test(input)) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return undefined;
    }
    const action = (url.host || url.pathname).replace(/^\/+|\/+$/g, "");
    if (action === "join" || action === "open")
      return roomTarget(url.searchParams.get("url") ?? "");
    if (action === "agent-join") {
      return agentTarget({
        server: url.searchParams.get("server"),
        room: url.searchParams.get("room"),
        name: url.searchParams.get("name"),
        token: url.searchParams.get("token"),
      });
    }
    return undefined;
  }
  if (/\bjoin\b/.test(input) && /--server/.test(input)) {
    const flags = commandFlags(input);
    return agentTarget({
      server: flags.get("server"),
      room: flags.get("room"),
      name: flags.get("name"),
      token: flags.get("token"),
    });
  }
  return roomTarget(input);
}

/** 带 Agent 加入的深链接：放在别人房间的「带入我的 Agent」里，点一下交给本机客户端 */
export function agentJoinLink(target: Extract<JoinTarget, { kind: "agent" }>): string {
  const params = new URLSearchParams({
    server: target.server,
    ...(target.roomId ? { room: target.roomId } : {}),
    name: target.name,
    token: target.token,
  });
  return `superhive://agent-join?${params.toString()}`;
}

/** 在客户端里打开这个邀请链接 */
export function roomJoinLink(url: string): string {
  return `superhive://join?url=${encodeURIComponent(url)}`;
}

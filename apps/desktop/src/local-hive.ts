/**
 * 主进程向本机 Hive 要 /api/local 接口的数据（选附件时查房间工作区、重启前查 Agent 忙闲）。
 * 本机凭证从 /api/local/session 取（主进程直连回环地址，不带 Origin，算本机房主），缓存起来；
 * Hive 重启换了凭证（401）就重取一次。
 */

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** GET 一个 /api/local 接口，返回 JSON；没有地址、本机会话关着、请求失败或超时都是 undefined */
export type LocalHiveGet = (pathname: string) => Promise<unknown>;

export function createLocalHiveGet(options: {
  origin: () => string | undefined;
  fetch: FetchLike;
  timeoutMs?: number;
}): LocalHiveGet {
  let cached: { origin: string; token: string } | undefined;
  const timeoutMs = options.timeoutMs ?? 2_000;

  async function request(url: string, headers?: Record<string, string>) {
    return options.fetch(url, {
      ...(headers ? { headers } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function ownerToken(origin: string, fresh: boolean): Promise<string | undefined> {
    if (!fresh && cached?.origin === origin) return cached.token;
    const response = await request(`${origin}/api/local/session`);
    if (!response.ok) return undefined;
    const body = (await response.json()) as { enabled?: unknown; ownerToken?: unknown };
    if (body?.enabled !== true || typeof body.ownerToken !== "string") return undefined;
    cached = { origin, token: body.ownerToken };
    return body.ownerToken;
  }

  return async (pathname) => {
    const origin = options.origin();
    if (!origin) return undefined;
    try {
      for (const fresh of [false, true]) {
        const token = await ownerToken(origin, fresh);
        if (!token) return undefined;
        const response = await request(`${origin}${pathname}`, { "x-hive-owner": token });
        if (response.status === 401 && !fresh) continue;
        if (!response.ok) return undefined;
        return await response.json();
      }
    } catch {
      // Hive 没起好、超时
    }
    return undefined;
  };
}

import { describe, expect, it, vi } from "vitest";
import { createLocalHiveGet, type FetchLike } from "./local-hive.js";
import { busyAgentNames } from "./restart-gate.js";

const origin = "http://127.0.0.1:8787";

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("createLocalHiveGet", () => {
  it("带本机凭证查重启前要看的 Agent 忙闲（/api/local/agents）", async () => {
    const fetch = vi.fn<FetchLike>(async (url, init) => {
      if (url === `${origin}/api/local/session`)
        return jsonResponse(200, { enabled: true, ownerToken: "tok" });
      expect(url).toBe(`${origin}/api/local/agents`);
      expect(init?.headers).toEqual({ "x-hive-owner": "tok" });
      return jsonResponse(200, {
        agents: [
          { name: "rd-claude2", busy: true },
          { name: "rd-claude3", busy: false },
        ],
      });
    });
    const get = createLocalHiveGet({ origin: () => origin, fetch });
    expect(busyAgentNames(await get("/api/local/agents"))).toEqual(["rd-claude2"]);
  });

  it("没有地址（Hive 不是桌面端起的）、本机 Agent 关着（404）、请求出错：都是 undefined", async () => {
    const never = vi.fn<FetchLike>();
    expect(await createLocalHiveGet({ origin: () => undefined, fetch: never })("/x")).toBe(
      undefined,
    );
    expect(never).not.toHaveBeenCalled();
    const disabled = createLocalHiveGet({
      origin: () => origin,
      fetch: async (url) =>
        url.endsWith("/session")
          ? jsonResponse(200, { enabled: true, ownerToken: "t" })
          : jsonResponse(404, { error: "disabled" }),
    });
    expect(await disabled("/api/local/agents")).toBeUndefined();
    const broken = createLocalHiveGet({
      origin: () => origin,
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(await broken("/api/local/agents")).toBeUndefined();
  });
});

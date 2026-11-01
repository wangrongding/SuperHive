// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessGate, deviceName } from "./access-gate";

describe("AccessGate", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps retrying while the server is unreachable and moves on once it answers", async () => {
    vi.useFakeTimers();
    let up = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (!up) throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({ role: "none", reason: "no_invite" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    render(<AccessGate />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("连接失败")).toBeTruthy();
    expect(screen.getByText("正在自动重试，服务恢复后会直接进入。")).toBeTruthy();

    up = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByText("需要邀请")).toBeTruthy();
  });

  it("redeems a login link once, keeps the device token and strips it from the address bar", async () => {
    localStorage.clear();
    window.history.replaceState(null, "", "/?login=hoi_ticket#build");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(String(url));
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
          });
        if (String(url).endsWith("/api/owner-login")) {
          expect(JSON.parse(String(init?.body))).toMatchObject({ ticket: "hoi_ticket" });
          return json({ token: "hod_device" });
        }
        if (String(url).endsWith("/api/access")) {
          const auth = new Headers(init?.headers).get("authorization");
          return json(
            auth === "Bearer hod_device"
              ? { role: "owner", joinToken: "hod_device" }
              : { role: "none", reason: "no_invite" },
          );
        }
        return json({}, 503);
      }),
    );
    render(<AccessGate />);
    await vi.waitFor(() =>
      expect(localStorage.getItem("superhive.owner-token")).toBe("hod_device"),
    );
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#build");
    expect(calls.filter((url) => url.endsWith("/api/owner-login"))).toHaveLength(1);
  });

  it("explains an expired login link instead of silently showing the invite page", async () => {
    localStorage.clear();
    window.history.replaceState(null, "", "/?login=hoi_old#build");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/api/owner-login")
          ? new Response(JSON.stringify({ error: "登录链接无效、已过期或已经用过。" }), {
              status: 401,
              headers: { "Content-Type": "application/json" },
            })
          : new Response(JSON.stringify({ role: "none", reason: "no_invite" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
      ),
    );
    render(<AccessGate />);
    await screen.findByText("登录链接无效、已过期或已经用过。");
    expect(localStorage.getItem("superhive.owner-token")).toBeNull();
  });

  it("names the device by system and app", () => {
    expect(
      deviceName(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Lark/7.30.0",
      ),
    ).toBe("iPhone · 飞书");
    expect(
      deviceName(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
      ),
    ).toBe("Windows · Chrome");
  });
});

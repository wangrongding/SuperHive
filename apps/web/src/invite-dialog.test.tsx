// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InviteDialog } from "./invite-dialog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("InviteDialog", () => {
  it("lets guests see agents' activity by default and sends the switch with the invite", async () => {
    const user = userEvent.setup();
    const posted: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          posted.push(JSON.parse(String(init.body)));
          return new Response(
            JSON.stringify({
              token: "hvi_x",
              invite: {
                id: "00000000-0000-4000-8000-000000000001",
                roomId: "general",
                createdAt: new Date().toISOString(),
                expiresAt: null,
                allowAgents: false,
                showTrace: false,
                uses: 0,
              },
            }),
            { status: 201 },
          );
        }
        return new Response(JSON.stringify({ invites: [] }), { status: 200 });
      }),
    );
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(async () => {}) } });
    render(
      <InviteDialog
        base="http://hive"
        adminToken="t"
        roomId="general"
        linkFor={(token) => `http://hive/#invite=${token}`}
        onClose={() => {}}
      />,
    );
    const trace = screen.getByRole("switch", { name: /让对方看到 Agent 的执行过程/ });
    expect(trace.getAttribute("aria-checked")).toBe("true");
    await user.click(trace);
    expect(trace.getAttribute("aria-checked")).toBe("false");
    await user.click(screen.getByRole("button", { name: /生成/ }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ allowAgents: false, showTrace: false });
  });
});

describe("InviteDialog 在局域网关着时", () => {
  it("不生成新链接、给去打开的按钮；已有的邀请照样能看、能撤销，但不给复制", async () => {
    const user = userEvent.setup();
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? "GET" });
        if (init?.method) return new Response("{}", { status: 200 });
        return new Response(
          JSON.stringify({
            invites: [
              {
                id: "00000000-0000-4000-8000-000000000002",
                roomId: "general",
                createdAt: new Date().toISOString(),
                expiresAt: null,
                allowAgents: false,
                showTrace: true,
                uses: 0,
                token: "hvi_old",
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    const openSettings = vi.fn();
    render(
      <InviteDialog
        base="http://hive"
        adminToken="t"
        roomId="general"
        linkFor={(token) => `http://127.0.0.1:8799/#general?invite=${token}`}
        lanBlocked={{ openSettings }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/局域网访问已关闭，别的设备上的人打不开邀请链接/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /生成/ })).toBeNull();
    expect(screen.queryByText(/127\.0\.0\.1/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "去打开" }));
    expect(openSettings).toHaveBeenCalledTimes(1);

    await screen.findByRole("button", { name: "撤销" });
    expect(screen.queryByRole("button", { name: "复制链接" })).toBeNull();
    expect(screen.getByRole("button", { name: "续期" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true));
  });
});

describe("InviteDialog 撤销邀请", () => {
  it("已经有人用过的链接，撤销前在确认弹窗里写明会断开几个人", async () => {
    const user = userEvent.setup();
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? "GET" });
        if (init?.method) return new Response("{}", { status: 200 });
        return new Response(
          JSON.stringify({
            invites: [
              {
                id: "00000000-0000-4000-8000-000000000003",
                roomId: "general",
                createdAt: new Date().toISOString(),
                expiresAt: null,
                allowAgents: false,
                showTrace: true,
                uses: 2,
                token: "hvi_used",
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    const onClose = vi.fn();
    render(
      <InviteDialog
        base="http://hive"
        adminToken="t"
        roomId="general"
        linkFor={(token) => `http://hive/#invite=${token}`}
        onClose={onClose}
      />,
    );
    const revoke = await screen.findByRole("button", { name: "撤销" });
    await user.click(revoke);
    let dialog = await screen.findByRole("alertdialog", { name: "撤销这个邀请链接？" });
    expect(dialog.textContent).toContain("凭它加入的 2 人会立即被断开。");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    // Esc 只关确认弹窗，邀请弹窗还在
    await user.click(revoke);
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    await user.click(revoke);
    dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "撤销" }));
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE")).toBe(true));
  });
});

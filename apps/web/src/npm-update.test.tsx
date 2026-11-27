// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NpmUpdateCheckResponse, NpmUpdateInfo, NpmUpdateJob } from "@superhive/protocol";
import { NpmUpdateEntry, npmCheckNotice, npmUpdateReason } from "./npm-update";
import { resetUpdateCenter, updateCenter } from "./update-center";
import { UpdateCorner } from "./update-corner";

const info: NpmUpdateInfo = {
  current: "0.4.8",
  latest: "0.4.9",
  notes: ["更稳的更新 / Safer updates"],
  releaseUrl: "https://github.com/wangrongding/SuperHive/releases/tag/v0.4.9",
  canUpdate: true,
  blocker: null,
  manualCommand: "hive update",
  busyAgents: [],
  canHandover: true,
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  resetUpdateCenter();
});

/** 状态栏弹层里点「检查更新」 */
async function checkNow() {
  await waitFor(() => expect(updateCenter().npmCheck).toBeTruthy());
  await act(() => updateCenter().npmCheck!());
}

function setup(
  options: {
    remote?: boolean;
    offline?: boolean;
    changed?: boolean;
    previousCompleted?: boolean;
    info?: Partial<NpmUpdateInfo>;
    /** 一开始（每小时那次）没有新版 */
    noUpdate?: boolean;
    /** 「检查更新」（?refresh=1）的回答；Error 表示连不上 */
    check?: NpmUpdateCheckResponse | Error;
    /** 刷新页面前留下的更新进度 */
    saved?: NpmUpdateJob;
  } = {},
) {
  const value = { ...info, ...options.info };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (options.offline) throw new Error("offline");
    if (url.endsWith("/api/update?refresh=1")) {
      if (options.check instanceof Error) throw options.check;
      return Response.json(options.check ?? { update: value, current: value.current });
    }
    if (url.endsWith("/api/local/update/current") && options.saved)
      return Response.json({ job: options.saved });
    if (url.endsWith("/api/local/update/session"))
      return Response.json(
        options.remote
          ? { enabled: true, mode: "device" }
          : { enabled: true, mode: "local", ownerToken: "local-only" },
      );
    if (url.endsWith("/api/local/update/current")) return Response.json({ job: null });
    if (init?.method === "POST")
      return options.changed
        ? Response.json(
            { code: "UPDATE_BUSY", info: { ...value, canHandover: false, busyAgents: ["worker"] } },
            { status: 409 },
          )
        : Response.json(
            {
              job: {
                id: "job",
                target: value.latest,
                previous: value.current,
                phase: "installing",
                startedAt: 1,
                updatedAt: 1,
              },
            },
            { status: 202 },
          );
    if (url.endsWith("/api/local/update"))
      return Response.json({
        info: value,
        job: options.previousCompleted
          ? {
              id: "previous",
              target: "0.4.8",
              previous: "0.4.7",
              phase: "completed",
              startedAt: 1,
              updatedAt: 1,
            }
          : null,
      });
    return Response.json({ update: options.noUpdate ? null : value });
  });
  vi.stubGlobal("fetch", fetcher);
  if (options.saved)
    sessionStorage.setItem(
      "superhive.npm-update:http://localhost:9999",
      JSON.stringify(options.saved),
    );
  render(
    <>
      <NpmUpdateEntry
        base="http://localhost:9999"
        token={options.remote ? "hod_device" : "owner"}
      />
      <UpdateCorner />
    </>,
  );
  return fetcher;
}

const installing: NpmUpdateJob = {
  id: "job",
  target: "0.4.9",
  previous: "0.4.8",
  phase: "installing",
  startedAt: 1,
  updatedAt: 1,
};

describe("npm web updates", () => {
  it("allows another release to be installed after a previous update completed", async () => {
    setup({ previousCompleted: true });
    fireEvent.click(await screen.findByRole("button", { name: "有新版本 0.4.9" }));
    expect(await screen.findByRole("button", { name: "更新并重启" })).toBeTruthy();
  });
  it("opens release notes and sends only the confirmed version with a local owner credential", async () => {
    const fetcher = setup();
    fireEvent.click(await screen.findByRole("button", { name: "有新版本 0.4.9" }));
    expect(await screen.findByText("本机 Agent 不下线，正在执行的任务继续。")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "更新并重启" }));
    // 确认后弹窗关掉，右下角的卡片显示到了哪一步
    const card = await screen.findByRole("region", { name: "正在更新到 0.4.9" });
    expect(card.textContent).toContain("正在安装新版本…");
    expect(within(card).getByRole("progressbar")).toBeTruthy();
    expect(within(card).getByRole("link", { name: "发布说明" }).getAttribute("href")).toBe(
      info.releaseUrl,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    const request = fetcher.mock.calls.find((call) => call[1]?.method === "POST")!;
    expect(JSON.parse(request[1]!.body as string)).toEqual({ target: "0.4.9" });
    expect(request[1]!.headers).toMatchObject({ "X-Hive-Owner": "local-only" });
  });
  it("collapses the progress card to the status bar and expands it from there", async () => {
    setup({ saved: installing });
    await screen.findByRole("region", { name: "正在更新到 0.4.9" });
    fireEvent.click(screen.getByRole("button", { name: "收起到状态栏" }));
    expect(screen.queryByRole("region")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "正在安装新版本…" }));
    expect(screen.getByRole("region", { name: "正在更新到 0.4.9" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // 已经在更新时「检查更新」只展开卡片，不再去查
    fireEvent.click(screen.getByRole("button", { name: "收起到状态栏" }));
    const fetcher = vi.mocked(fetch);
    await checkNow();
    expect(screen.getByRole("region", { name: "正在更新到 0.4.9" })).toBeTruthy();
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes("refresh=1"))).toBe(false);
  });
  it("shows a failed update in the corner and opens the details from there", async () => {
    setup({
      saved: {
        ...installing,
        phase: "failed",
        error: "Update command timed out",
        rolledBack: true,
      },
    });
    const card = await screen.findByRole("region", { name: "更新未完成" });
    expect(card.textContent).toContain("更新命令超时");
    expect(card.textContent).toContain("已恢复旧包");
    fireEvent.click(within(card).getByRole("button", { name: "查看详情" }));
    expect(await screen.findByRole("dialog", { name: "更新 SuperHive" })).toBeTruthy();
  });
  it("checks again after a failed update instead of only showing the old failure", async () => {
    const fetcher = setup({
      saved: { ...installing, phase: "failed", error: "Update command timed out" },
    });
    await screen.findByRole("region", { name: "更新未完成" });
    await checkNow();
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes("refresh=1"))).toBe(true);
    expect(await screen.findByRole("dialog", { name: "更新 SuperHive" })).toBeTruthy();
  });
  it("shows remote owners a contact-owner notice, never an update action", async () => {
    const fetcher = setup({ remote: true });
    fireEvent.click(await screen.findByRole("button", { name: "有新版本 0.4.9" }));
    await screen.findByText("有新版本，请联系房主。只有本机房主可以更新并重启服务。");
    expect(screen.queryByRole("button", { name: "更新并重启" })).toBeNull();
    expect(fetcher.mock.calls.some((call) => call[1]?.method === "POST")).toBe(false);
  });
  it("explains unsupported installs and gives the manual command", async () => {
    setup({
      info: { canUpdate: false, blocker: "source", manualCommand: "git pull && pnpm build" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "有新版本 0.4.9" }));
    await screen.findByText("git pull && pnpm build");
    expect(screen.queryByRole("button", { name: "更新并重启" })).toBeNull();
    expect(npmUpdateReason("external")).toContain("进程管理");
    expect(npmUpdateReason("permissions")).toContain("sudo");
  });
  it("requires the owner to confirm wait or interrupt when handover is unavailable", async () => {
    const fetcher = setup({ info: { canHandover: false, busyAgents: ["worker"] } });
    fireEvent.click(await screen.findByRole("button", { name: "有新版本 0.4.9" }));
    await screen.findByRole("radio", { name: "等任务完成后更新（推荐）" });
    fireEvent.click(screen.getByRole("radio", { name: "立即更新，中断正在执行的任务" }));
    fireEvent.click(screen.getByRole("button", { name: "更新并重启" }));
    await waitFor(() =>
      expect(fetcher.mock.calls.some((call) => call[1]?.method === "POST")).toBe(true),
    );
    expect(
      JSON.parse(fetcher.mock.calls.find((call) => call[1]?.method === "POST")![1]!.body as string)
        .choice,
    ).toBe("now");
  });
  it("refreshes busy confirmation without automatically retrying the update", async () => {
    const fetcher = setup({ changed: true });
    fireEvent.click(await screen.findByRole("button", { name: "有新版本 0.4.9" }));
    fireEvent.click(await screen.findByRole("button", { name: "更新并重启" }));
    await screen.findByRole("radio", { name: "等任务完成后更新（推荐）" });
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
  });
  it("check now: up to date, source runs, desktop-run servers, failures each get one line", async () => {
    expect(npmCheckNotice({ update: null, current: "0.4.9", blocker: null })).toEqual({
      tone: "ok",
      text: "已是最新版本 0.4.9",
    });
    // 源码运行：不检查更新，也不说「已是最新」
    expect(npmCheckNotice({ update: { ...info }, current: "0.4.8", blocker: "source" })?.text).toBe(
      "当前从源码运行，不检查更新。拉取代码后重新构建即可。",
    );
    expect(npmCheckNotice({ update: null, unavailable: "desktop" })?.text).toContain("桌面客户端");
    expect(npmCheckNotice({ update: null, failed: true })?.tone).toBe("danger");
    expect(npmCheckNotice({ update: { ...info }, failed: true })).toBeUndefined();
  });
  it("check now says it is up to date in the corner, bypassing the cache", async () => {
    const fetcher = setup({
      noUpdate: true,
      check: { update: null, current: "0.4.8", blocker: null },
    });
    await checkNow();
    expect(screen.getByRole("status").textContent).toBe("已是最新版本 0.4.8");
    const call = fetcher.mock.calls.find((item) => String(item[0]).includes("refresh=1"))!;
    expect(call[1]!.headers).toMatchObject({ Authorization: "Bearer owner" });
    expect(screen.queryByRole("button", { name: /有新版本/ })).toBeNull();
  });
  it("check now opens the update dialog when a new version shows up", async () => {
    setup({ noUpdate: true });
    await checkNow();
    expect(await screen.findByRole("dialog", { name: "更新 SuperHive" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "更新并重启" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "有新版本 0.4.9" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("check now shows remote owners the new version without an update action", async () => {
    setup({ remote: true, noUpdate: true });
    await checkNow();
    await screen.findByText("有新版本，请联系房主。只有本机房主可以更新并重启服务。");
    expect(screen.queryByRole("button", { name: "更新并重启" })).toBeNull();
  });
  it("check now explains when the Server cannot be reached", async () => {
    setup({ noUpdate: true, check: new Error("offline") });
    await checkNow();
    expect(screen.getByRole("status").textContent).toBe(
      "没能检查更新：连不上 Hive Server，稍后再试。",
    );
  });
  it("stays silent offline", async () => {
    setup({ offline: true });
    await waitFor(() => expect(screen.queryByRole("button", { name: /有新版本/ })).toBeNull());
  });
});

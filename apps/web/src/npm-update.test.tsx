// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NpmUpdateInfo } from "@superhive/protocol";
import { NpmUpdateEntry, npmUpdateReason } from "./npm-update";

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
});

function setup(
  options: {
    remote?: boolean;
    offline?: boolean;
    changed?: boolean;
    previousCompleted?: boolean;
    info?: Partial<NpmUpdateInfo>;
  } = {},
) {
  const value = { ...info, ...options.info };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (options.offline) throw new Error("offline");
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
    return Response.json({ update: value });
  });
  vi.stubGlobal("fetch", fetcher);
  render(
    <NpmUpdateEntry base="http://localhost:9999" token={options.remote ? "hod_device" : "owner"} />,
  );
  return fetcher;
}

describe("npm web updates", () => {
  it("allows another release to be installed after a previous update completed", async () => {
    setup({ previousCompleted: true });
    fireEvent.click(await screen.findByRole("button", { name: "有新版本 0.4.9" }));
    expect(await screen.findByRole("button", { name: "更新并重启" })).toBeTruthy();
  });
  it("opens release notes and sends only the confirmed version with a local owner credential", async () => {
    const fetcher = setup();
    fireEvent.click(await screen.findByRole("button", { name: "有新版本 0.4.9" }));
    fireEvent.click(await screen.findByRole("button", { name: "更新并重启" }));
    await screen.findAllByText("正在安装新版本…");
    const request = fetcher.mock.calls.find((call) => call[1]?.method === "POST")!;
    expect(JSON.parse(request[1]!.body as string)).toEqual({ target: "0.4.9" });
    expect(request[1]!.headers).toMatchObject({ "X-Hive-Owner": "local-only" });
    expect(screen.getByText("本机 Agent 不下线，正在执行的任务继续。")).toBeTruthy();
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
  it("stays silent offline", async () => {
    setup({ offline: true });
    await waitFor(() => expect(screen.queryByRole("button", { name: /有新版本/ })).toBeNull());
  });
});

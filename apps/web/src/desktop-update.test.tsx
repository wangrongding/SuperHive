// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopUpdateCheckResult,
  DesktopUpdateInfo,
  DesktopUpdatesApi,
} from "./desktop-bridge";
import { checkDesktopUpdatesNow, DesktopUpdateEntry, noteForLocale } from "./desktop-update";
import { resetUpdateCenter } from "./update-center";
import { UpdateCorner } from "./update-corner";

afterEach(() => {
  cleanup();
  resetUpdateCenter();
});

/** 入口 + 右下角（弹窗、进度卡片、检查更新的提示都挂在那里） */
function renderDesktop(api: DesktopUpdatesApi | undefined, platform = "darwin") {
  return render(
    <>
      <DesktopUpdateEntry api={api} />
      <UpdateCorner desktopApi={api} platform={platform} />
    </>,
  );
}

const info: DesktopUpdateInfo = {
  version: "0.4.8",
  currentVersion: "0.4.7",
  publishedAt: "2026-11-30T12:00:00Z",
  notes: ["桌面端会提示新版本 / The desktop app tells you about new versions", "只有中文"],
  assetName: "SuperHive-0.4.8-arm64.dmg",
  assetSize: 129 * 1024 * 1024,
};

function fakeApi(
  initial: DesktopUpdateInfo | null,
  withInstall = false,
  checkNow?: () => Promise<DesktopUpdateCheckResult>,
) {
  // 入口和右下角各订阅一份
  const listeners = new Set<(next: DesktopUpdateInfo | null) => void>();
  let current = initial;
  const api: DesktopUpdatesApi = {
    get: vi.fn(async () => current),
    ...(checkNow ? { checkNow: vi.fn(checkNow) } : {}),
    open: vi.fn(async () => true),
    dismiss: vi.fn(async () => true),
    ...(withInstall ? { install: vi.fn(async () => true), restart: vi.fn(async () => true) } : {}),
    onChange: vi.fn((next) => {
      listeners.add(next);
      return () => {
        listeners.delete(next);
      };
    }),
  };
  return {
    api,
    push: (next: DesktopUpdateInfo | null) => {
      current = next;
      for (const listener of listeners) listener(next);
    },
  };
}

describe("noteForLocale", () => {
  it("按界面语言取中英文的一半，没有分隔就原样", () => {
    expect(noteForLocale("新功能 / New feature", "zh-CN")).toBe("新功能");
    expect(noteForLocale("新功能 / New feature", "en")).toBe("New feature");
    expect(noteForLocale("A / B / C", "en")).toBe("B / C");
    expect(noteForLocale("只有中文", "en")).toBe("只有中文");
  });
});

describe("DesktopUpdateEntry", () => {
  it("不在桌面端或没有新版时什么都不显示", async () => {
    const { container } = render(<DesktopUpdateEntry api={undefined} />);
    expect(container.innerHTML).toBe("");
    const { api } = fakeApi(null);
    const second = render(<DesktopUpdateEntry api={api} />);
    await act(async () => undefined);
    expect(second.container.innerHTML).toBe("");
    renderDesktop(api);
    await act(async () => undefined);
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("有新版时显示入口，点开看版本和说明，下载只告诉桌面端打开哪一个", async () => {
    const { api } = fakeApi(info);
    renderDesktop(api);
    fireEvent.click(await screen.findByRole("button", { name: "有新版本 0.4.8" }));
    const dialog = screen.getByRole("dialog", { name: "有新版本 0.4.8" });
    expect(dialog.textContent).toContain("你现在用的是 0.4.7");
    expect(dialog.textContent).toContain("桌面端会提示新版本");
    expect(dialog.textContent).not.toContain("The desktop app");
    expect(dialog.textContent).toContain("拖进「应用程序」");

    fireEvent.click(screen.getByRole("button", { name: "完整发布说明" }));
    expect(api.open).toHaveBeenLastCalledWith("release");
    fireEvent.click(screen.getByRole("button", { name: /^下载/ }));
    expect(api.open).toHaveBeenLastCalledWith("download");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Windows 上提示覆盖安装", async () => {
    const { api } = fakeApi(info);
    renderDesktop(api, "win32");
    fireEvent.click(await screen.findByRole("button", { name: "有新版本 0.4.8" }));
    expect(screen.getByRole("dialog").textContent).toContain("覆盖安装");
  });

  it("忽略这个版本后入口马上收起，并告诉桌面端", async () => {
    const { api } = fakeApi(info);
    renderDesktop(api);
    fireEvent.click(await screen.findByRole("button", { name: "有新版本 0.4.8" }));
    fireEvent.click(screen.getByRole("button", { name: "忽略这个版本" }));
    expect(api.dismiss).toHaveBeenCalledWith("0.4.8");
    expect(screen.queryByRole("button", { name: "有新版本 0.4.8" })).toBeNull();
  });

  it("桌面端后来查到新版时出现，收回时消失", async () => {
    const { api, push } = fakeApi(null);
    renderDesktop(api);
    await act(async () => undefined);
    expect(screen.queryByRole("button", { name: /有新版本/ })).toBeNull();
    act(() => push({ ...info, version: "0.4.9" }));
    expect(screen.getByRole("button", { name: "有新版本 0.4.9" })).toBeTruthy();
    act(() => push(null));
    expect(screen.queryByRole("button", { name: /有新版本/ })).toBeNull();
  });

  describe("检查更新", () => {
    it("已是最新：右下角先说正在检查，再说已是最新版本，可以关掉", async () => {
      let resolve: (value: DesktopUpdateCheckResult) => void = () => undefined;
      const { api } = fakeApi(null, true, () => new Promise((done) => (resolve = done)));
      renderDesktop(api);
      let checking: Promise<void> = Promise.resolve();
      act(() => {
        checking = checkDesktopUpdatesNow(api);
      });
      expect((await screen.findByRole("status")).textContent).toContain("正在检查更新…");
      // 检查中再点一次不重复发请求
      await act(() => checkDesktopUpdatesNow(api));
      expect(api.checkNow).toHaveBeenCalledTimes(1);
      await act(async () => {
        resolve({ status: "latest", currentVersion: "0.4.9" });
        await checking;
      });
      expect(screen.getByRole("status").textContent).toContain("已是最新版本 0.4.9");
      fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("有新版本时直接打开更新弹窗，之前在这里忽略过的版本也重新提示", async () => {
      const { api, push } = fakeApi(info, true, async () => {
        push(info);
        return { status: "available", currentVersion: "0.4.7" };
      });
      renderDesktop(api);
      fireEvent.click(await screen.findByRole("button", { name: "有新版本 0.4.8" }));
      fireEvent.click(screen.getByRole("button", { name: "忽略这个版本" }));
      act(() => push(null));
      expect(screen.queryByRole("button", { name: /有新版本/ })).toBeNull();
      await act(() => checkDesktopUpdatesNow(api));
      expect(screen.getByRole("dialog", { name: "有新版本 0.4.8" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "有新版本 0.4.8" })).toBeTruthy();
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("已经在下载：直接展开进度卡片，不再去查", async () => {
      const { api } = fakeApi(
        {
          ...info,
          install: {
            available: true,
            size: 200,
            state: { phase: "downloading", received: 20, total: 200 },
          },
        },
        true,
        async () => ({ status: "latest", currentVersion: "0.4.7" }),
      );
      renderDesktop(api);
      await screen.findByRole("region", { name: "正在下载 0.4.8" });
      fireEvent.click(screen.getByRole("button", { name: "收起到状态栏" }));
      await act(() => checkDesktopUpdatesNow(api));
      expect(screen.getByRole("region", { name: "正在下载 0.4.8" })).toBeTruthy();
      expect(api.checkNow).not.toHaveBeenCalled();
    });

    it("没查成、开发版、桌面端出错时各说一句原因，不误报最新", async () => {
      const results: Array<DesktopUpdateCheckResult | Error> = [
        { status: "failed", currentVersion: "0.4.7" },
        { status: "disabled", currentVersion: "0.0.0" },
        new Error("ipc"),
      ];
      const { api } = fakeApi(null, true, async () => {
        const next = results.shift()!;
        if (next instanceof Error) throw next;
        return next;
      });
      renderDesktop(api);
      await act(() => checkDesktopUpdatesNow(api));
      expect(screen.getByRole("status").textContent).toBe(
        "没能检查更新，可能是网络问题，稍后再试。",
      );
      await act(() => checkDesktopUpdatesNow(api));
      expect(screen.getByRole("status").textContent).toBe("这是开发版，不检查更新。");
      await act(() => checkDesktopUpdatesNow(api));
      expect(screen.getByRole("status").textContent).toContain("没能检查更新");
    });
  });

  describe("应用内更新", () => {
    const withInstall = (
      install: NonNullable<DesktopUpdateInfo["install"]>,
    ): DesktopUpdateInfo => ({
      ...info,
      install,
    });
    const idle = { phase: "idle" } as const;

    it("能直接更新时主按钮是「下载并更新」，只告诉桌面端版本号，确认后改在右下角看进度", async () => {
      const { api, push } = fakeApi(
        withInstall({ available: true, size: 120_000_000, state: idle }),
        true,
      );
      renderDesktop(api);
      fireEvent.click(await screen.findByRole("button", { name: "有新版本 0.4.8" }));
      const dialog = screen.getByRole("dialog");
      expect(dialog.textContent).toContain("下次退出时再换");
      expect(within(dialog).getByRole("button", { name: /下载并更新.*120 MB/ })).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: /^下载并更新/ }));
      expect(api.install).toHaveBeenCalledWith("0.4.8");
      // 确认后弹窗关掉，进度改在右下角的卡片里看
      expect(screen.queryByRole("dialog")).toBeNull();
      act(() =>
        push(
          withInstall({
            available: true,
            size: 120_000_000,
            state: { phase: "downloading", received: 30_000_000, total: 120_000_000 },
          }),
        ),
      );
      const card = screen.getByRole("region", { name: "正在下载 0.4.8" });
      expect(within(card).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
    });

    it("下载中显示进度，入口也显示百分比；不知道大小时（Windows）只说在下载", async () => {
      const { api, push } = fakeApi(
        withInstall({
          available: true,
          size: 200,
          state: { phase: "downloading", received: 50, total: 200 },
        }),
        true,
      );
      renderDesktop(api);
      const card = await screen.findByRole("region", { name: "正在下载 0.4.8" });
      expect(within(card).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
      expect(card.textContent).toContain("下载中 25%");
      expect(screen.getByRole("button", { name: "正在下载新版本 25%" })).toBeTruthy();
      act(() =>
        push(
          withInstall({
            available: true,
            size: 200,
            state: { phase: "downloading", received: 0, total: 0 },
          }),
        ),
      );
      expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
      expect(screen.getByRole("region").textContent).toContain("下载中…");
      act(() => push(withInstall({ available: true, size: 200, state: { phase: "verifying" } })));
      expect(screen.getByRole("region").textContent).toContain("正在校验…");
      fireEvent.click(screen.getByRole("button", { name: "发布说明" }));
      expect(api.open).toHaveBeenLastCalledWith("release");
    });

    it("进度卡片可以收起到状态栏，点状态栏里的进度再展开；下完自己再展开一次", async () => {
      const downloading = withInstall({
        available: true,
        size: 200,
        state: { phase: "downloading", received: 100, total: 200 },
      });
      const { api, push } = fakeApi(downloading, true);
      renderDesktop(api);
      await screen.findByRole("region", { name: "正在下载 0.4.8" });
      fireEvent.click(screen.getByRole("button", { name: "收起到状态栏" }));
      expect(screen.queryByRole("region")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "正在下载新版本 50%" }));
      expect(screen.getByRole("region", { name: "正在下载 0.4.8" })).toBeTruthy();
      // 点入口展开卡片，不弹窗
      expect(screen.queryByRole("dialog")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "收起到状态栏" }));
      act(() => push(withInstall({ available: true, size: 200, state: { phase: "ready" } })));
      expect(screen.getByRole("region", { name: "新版本 0.4.8 已下载好" })).toBeTruthy();
    });

    it("下好后右下角「重启以更新」，并说明不重启也会在下次退出时生效", async () => {
      const { api } = fakeApi(
        withInstall({ available: true, size: 200, state: { phase: "ready" } }),
        true,
      );
      renderDesktop(api);
      fireEvent.click(await screen.findByRole("button", { name: "重启以更新到 0.4.8" }));
      const card = screen.getByRole("region", { name: "新版本 0.4.8 已下载好" });
      expect(card.textContent).toContain("下次退出时换上新版本");
      fireEvent.click(within(card).getByRole("button", { name: "重启以更新" }));
      expect(api.restart).toHaveBeenCalled();
    });

    it("失败时说明原因，主按钮退回下载安装包，可以重试", async () => {
      const { api } = fakeApi(
        withInstall({ available: true, size: 200, state: { phase: "failed", reason: "checksum" } }),
        true,
      );
      renderDesktop(api);
      // 右下角卡片：原因 + 重试 / 下载安装包
      const card = await screen.findByRole("region", { name: "没能直接更新" });
      expect(card.textContent).toContain("校验不通过");
      fireEvent.click(within(card).getByRole("button", { name: "重试" }));
      expect(api.install).toHaveBeenCalledTimes(1);
      // 入口打开弹窗看完整说明
      fireEvent.click(screen.getByRole("button", { name: "有新版本 0.4.8" }));
      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByRole("status").textContent).toContain("校验不通过");
      expect(within(dialog).getByRole("status").textContent).toContain("当前版本不受影响");
      fireEvent.click(within(dialog).getByRole("button", { name: "重试" }));
      expect(api.install).toHaveBeenLastCalledWith("0.4.8");
      expect(screen.queryByRole("dialog")).toBeNull();
      fireEvent.click(within(card).getByRole("button", { name: "下载安装包" }));
      expect(api.open).toHaveBeenLastCalledWith("download");
    });

    it("位置不能写时只给「下载」，并写明原因；Release 没传更新包时不多说", async () => {
      const { api, push } = fakeApi(
        withInstall({ available: false, reason: "translocated", size: 200, state: idle }),
        true,
      );
      renderDesktop(api);
      fireEvent.click(await screen.findByRole("button", { name: "有新版本 0.4.8" }));
      expect(screen.getByRole("status").textContent).toContain("拖进「应用程序」再打开");
      expect(screen.queryByRole("button", { name: /下载并更新/ })).toBeNull();
      expect(screen.getByRole("button", { name: /^下载/ })).toBeTruthy();
      act(() =>
        push(withInstall({ available: false, reason: "no-package", size: 0, state: idle })),
      );
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("老版本桌面端没有 install / restart 时照旧只给「下载」", async () => {
      const { api } = fakeApi(withInstall({ available: true, size: 200, state: idle }));
      renderDesktop(api);
      fireEvent.click(await screen.findByRole("button", { name: "有新版本 0.4.8" }));
      expect(screen.queryByRole("button", { name: /下载并更新/ })).toBeNull();
    });
  });
});

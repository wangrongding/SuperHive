// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerDevicesPanel, lanBlocksSharing } from "./host-settings";
import type { LocalAgentsState } from "./local-agents";
import type { DesktopFirewallStatus, DesktopLanState } from "./desktop-bridge";

/** 桌面端设置「设备」页的「允许局域网设备访问」 */

const fn = () => () => undefined;
const terminal = {
  create: fn,
  write: fn,
  resize: fn,
  kill: fn,
  onData: fn,
  onExit: fn,
  onNewRequest: fn,
};

function installBridge(options: {
  state: DesktopLanState;
  firewall?: DesktopFirewallStatus | null;
  platform?: string;
}) {
  let current = options.state;
  let listener: ((state: DesktopLanState) => void) | undefined;
  let finish: (() => void) | undefined;
  const lan = {
    get: vi.fn(async () => current),
    set: vi.fn(
      (enabled: boolean) =>
        new Promise<DesktopLanState>((resolve) => {
          finish = () => {
            current = { ...current, enabled, restarting: false };
            resolve(current);
          };
        }),
    ),
    firewall: vi.fn(async () => options.firewall ?? null),
    onChange: vi.fn((next: (state: DesktopLanState) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    }),
  };
  window.superhiveDesktop = { version: 1, platform: options.platform ?? "win32", terminal, lan };
  return {
    lan,
    finish: () => finish?.(),
    push: (state: DesktopLanState) => listener?.(state),
  };
}

const local = {
  enabled: true,
  mode: "local",
  canManage: true,
  ownerDevices: async () => [],
  hostApprovers: async () => [],
  pairOwnerDevice: vi.fn(async () => ({
    url: "http://192.168.1.5:8787/#pair",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    qrDataUrl: "data:image/png;base64,",
  })),
} as unknown as LocalAgentsState;

afterEach(() => {
  cleanup();
  delete window.superhiveDesktop;
});

describe("允许局域网设备访问", () => {
  it("关着时不给二维码，说明要先打开；打开后重启 Server，期间开关不能点", async () => {
    const user = userEvent.setup();
    const bridge = installBridge({
      state: { enabled: false, managed: true, restarting: false },
    });
    render(<OwnerDevicesPanel local={local} />);
    const toggle = await screen.findByRole("switch", { name: /允许局域网设备访问/ });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("button", { name: "显示登录二维码" })).toBeNull();
    expect(screen.getByText(/先打开「允许局域网设备访问」/)).toBeTruthy();
    // 关着时不查防火墙
    expect(bridge.lan.firewall).not.toHaveBeenCalled();

    await user.click(toggle);
    expect(bridge.lan.set).toHaveBeenCalledWith(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("正在重启 Server，Agent 不会断开…")).toBeTruthy();
    await act(async () => bridge.finish());
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole("button", { name: "显示登录二维码" })).toBeTruthy();
    expect(bridge.lan.firewall).toHaveBeenCalledTimes(1);
  });

  it("Windows 防火墙拦着、还没放行时提示去放行，附上程序路径，说明只在本机用可以不管；放行了就不提示", async () => {
    const program = "C:\\Users\\rd\\AppData\\Local\\SuperHive\\app-0.5.0\\SuperHive.exe";
    installBridge({
      state: { enabled: true, managed: true, restarting: false },
      firewall: { status: "blocked", program },
    });
    const { unmount } = render(<OwnerDevicesPanel local={local} />);
    expect(await screen.findByText(/弹窗时可能点了取消.*只在这台电脑上用可以不管/)).toBeTruthy();
    expect(screen.getByText(program)).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制路径" })).toBeTruthy();
    unmount();

    installBridge({
      state: { enabled: true, managed: true, restarting: false },
      firewall: { status: "missing", program },
    });
    const second = render(<OwnerDevicesPanel local={local} />);
    expect(
      await screen.findByText(
        /Windows 防火墙还没放行 SuperHive，手机和其他电脑可能连不上；只在这台电脑上用可以不管/,
      ),
    ).toBeTruthy();
    second.unmount();

    const ok = installBridge({
      state: { enabled: true, managed: true, restarting: false },
      firewall: { status: "ok", program },
    });
    render(<OwnerDevicesPanel local={local} />);
    await waitFor(() => expect(ok.lan.firewall).toHaveBeenCalled());
    expect(screen.queryByText(/Windows 防火墙/)).toBeNull();
  });

  it("连的是别人起的 Server、或不在桌面端：没有开关，二维码照旧", async () => {
    installBridge({ state: { enabled: false, managed: false, restarting: false } });
    const { unmount } = render(<OwnerDevicesPanel local={local} />);
    expect(await screen.findByRole("button", { name: "显示登录二维码" })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: /允许局域网设备访问/ })).toBeNull();
    unmount();
    delete window.superhiveDesktop;
    render(<OwnerDevicesPanel local={local} />);
    expect(await screen.findByRole("button", { name: "显示登录二维码" })).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("系统菜单或另一个窗口改了开关：跟着桌面端推来的状态变", async () => {
    const bridge = installBridge({ state: { enabled: true, managed: true, restarting: false } });
    render(<OwnerDevicesPanel local={local} />);
    const toggle = await screen.findByRole("switch", { name: /允许局域网设备访问/ });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    act(() => bridge.push({ enabled: false, managed: true, restarting: false }));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});

describe("局域网关着时发给别的设备的链接和命令", () => {
  const off = { state: { enabled: false, managed: true, restarting: false } };
  const on = { state: { enabled: true, managed: true, restarting: false } };

  it("桌面端自管 Server、关着局域网、公布地址是本机时拦下", () => {
    for (const advertisedUrl of [
      "http://127.0.0.1:8799",
      "http://localhost:8799",
      "http://[::1]:8799",
    ]) {
      expect(lanBlocksSharing({ localMode: "local", lan: off, advertisedUrl })).toBe(true);
    }
  });

  it("正在切换时以公布地址为准：打开中、地址还没换过来也拦下", () => {
    const opening = { state: { enabled: true, managed: true, restarting: true } };
    expect(
      lanBlocksSharing({ localMode: "local", lan: opening, advertisedUrl: "http://127.0.0.1:1" }),
    ).toBe(true);
    expect(
      lanBlocksSharing({ localMode: "local", lan: opening, advertisedUrl: "http://10.0.0.2:1" }),
    ).toBe(false);
  });

  it("开着局域网、设了 HIVE_PUBLIC_URL、网页版或连别人起的 Server 都不拦", () => {
    const loopback = "http://127.0.0.1:8799";
    expect(lanBlocksSharing({ localMode: "local", lan: on, advertisedUrl: loopback })).toBe(false);
    expect(
      lanBlocksSharing({
        localMode: "local",
        lan: off,
        advertisedUrl: "https://hive.example.com",
      }),
    ).toBe(false);
    // 网页版没有桌面桥；hive start 起的 Server 时 useDesktopLan 返回 undefined
    expect(lanBlocksSharing({ localMode: "local", lan: undefined, advertisedUrl: loopback })).toBe(
      false,
    );
    expect(lanBlocksSharing({ localMode: "device", lan: off, advertisedUrl: loopback })).toBe(
      false,
    );
    expect(lanBlocksSharing({ localMode: "local", lan: off, advertisedUrl: undefined })).toBe(
      false,
    );
  });
});

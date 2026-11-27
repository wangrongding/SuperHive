// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerDevicesPanel } from "./host-settings";
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

  it("Windows 防火墙拦着时提示去允许，附上程序路径；放行了就不提示", async () => {
    const program = "C:\\Users\\rd\\AppData\\Local\\SuperHive\\app-0.5.0\\SuperHive.exe";
    installBridge({
      state: { enabled: true, managed: true, restarting: false },
      firewall: { status: "blocked", program },
    });
    const { unmount } = render(<OwnerDevicesPanel local={local} />);
    expect(await screen.findByText(/Windows 防火墙拦着 SuperHive/)).toBeTruthy();
    expect(screen.getByText(program)).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制路径" })).toBeTruthy();
    unmount();

    installBridge({
      state: { enabled: true, managed: true, restarting: false },
      firewall: { status: "missing", program },
    });
    const second = render(<OwnerDevicesPanel local={local} />);
    expect(await screen.findByText(/Windows 防火墙里还没有放行 SuperHive/)).toBeTruthy();
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

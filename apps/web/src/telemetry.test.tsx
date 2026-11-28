// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelemetryStatus } from "@superhive/protocol";
import type { LocalAgentsState } from "./local-agents";
import {
  TelemetryNotice,
  TelemetrySettingsGroup,
  configureTelemetryReporter,
  reportDesktopUpdate,
  reportTelemetryFeature,
  resetTelemetryReporter,
} from "./telemetry";

afterEach(() => {
  cleanup();
  resetTelemetryReporter();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const status = (patch: Partial<TelemetryStatus> = {}): TelemetryStatus => ({
  active: true,
  enabled: true,
  installId: "8d0f3c1e-2a4b-4c6d-8e9f-0a1b2c3d4e5f",
  endpoint: true,
  queued: 2,
  noticePending: true,
  ...patch,
});

function api(initial: TelemetryStatus, mode: "local" | "device" = "local") {
  let current = initial;
  return {
    enabled: true,
    mode,
    telemetry: vi.fn(async () => current),
    updateTelemetry: vi.fn(async (enabled: boolean) => {
      current = { ...current, enabled, active: enabled, queued: enabled ? current.queued : 0 };
      return current;
    }),
    resetTelemetryId: vi.fn(async () => (current = { ...current, installId: "new", queued: 0 })),
    telemetryNoticeShown: vi.fn(async () => (current = { ...current, noticePending: false })),
    telemetryPreview: vi.fn(async () =>
      current.active
        ? current.queued
          ? [{ type: "event", payload: { name: "heartbeat", id: current.installId } }]
          : []
        : null,
    ),
  };
}

describe("TelemetryNotice", () => {
  const title = "帮我们把 SuperHive 做得更好";
  const card = () => screen.queryByRole("region", { name: title });
  /** 让假时钟往前走，并等 Server 的回应落地 */
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  it("pops up once for the local owner, with just 「知道了」 and a docs link", async () => {
    const local = api(status());
    render(<TelemetryNotice local={local} delayMs={0} />);
    expect(await screen.findByRole("region", { name: title })).toBeTruthy();
    expect(screen.getByText(/每天有多少人在用、用的什么版本和系统/)).toBeTruthy();
    expect(screen.getByText(/不收消息内容和 key，可以在设置里关/)).toBeTruthy();
    // npm、桌面版有上报地址：不说「只记在这台电脑上」
    expect(screen.queryByText(/这台电脑上/)).toBeNull();
    // 只告知、不引导关：没有关统计的按钮，也没有 ×
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["知道了"]);
    expect(screen.getByRole("link", { name: /了解详情/ }).getAttribute("href")).toContain(
      "reference/telemetry/",
    );
    await waitFor(() => expect(local.telemetryNoticeShown).toHaveBeenCalledTimes(1));
    expect(local.updateTelemetry).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(card()).toBeNull();

    // 刷新页面（重新挂载）后不再弹
    cleanup();
    render(<TelemetryNotice local={local} delayMs={0} />);
    await waitFor(() => expect(local.telemetry).toHaveBeenCalledTimes(2));
    expect(card()).toBeNull();
  });

  it("says the data stays local when running from source", async () => {
    render(<TelemetryNotice local={api(status({ endpoint: false }))} delayMs={0} />);
    expect(
      await screen.findByText("从源码运行时不上报，统计只记在这台电脑上，可以在设置里关。"),
    ).toBeTruthy();
  });

  it("closes with Esc", async () => {
    render(<TelemetryNotice local={api(status())} delayMs={0} />);
    fireEvent.keyDown(await screen.findByRole("region", { name: title }), { key: "Escape" });
    expect(card()).toBeNull();
  });

  it("waits until the first message is sent, or the page has been open a while", async () => {
    vi.useFakeTimers();
    const local = api(status());
    const view = render(<TelemetryNotice local={local} delayMs={60_000} afterSendMs={2_000} />);
    await advance(30_000);
    expect(local.telemetry).not.toHaveBeenCalled();
    // 发完第一条消息：过两秒出，不再等满一分钟
    view.rerender(<TelemetryNotice local={local} sent delayMs={60_000} afterSendMs={2_000} />);
    await advance(1_000);
    expect(card()).toBeNull();
    await advance(1_000);
    expect(card()).toBeTruthy();

    // 一直不发消息：页面开满一分钟才出
    cleanup();
    const idle = api(status());
    render(<TelemetryNotice local={idle} delayMs={60_000} afterSendMs={2_000} />);
    await advance(59_000);
    expect(idle.telemetry).not.toHaveBeenCalled();
    await advance(1_000);
    expect(card()).toBeTruthy();
    expect(idle.telemetryNoticeShown).toHaveBeenCalledTimes(1);
  });

  it("holds back while a dialog is open or the page is in the background", async () => {
    vi.useFakeTimers();
    const local = api(status());
    const guide = document.createElement("dialog");
    guide.setAttribute("open", "");
    document.body.append(guide);
    render(<TelemetryNotice local={local} delayMs={0} />);
    await advance(10_000);
    // 新用户引导开着：没弹、也不算看过
    expect(local.telemetry).not.toHaveBeenCalled();
    expect(local.telemetryNoticeShown).not.toHaveBeenCalled();
    guide.remove();

    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await advance(10_000);
    expect(local.telemetry).not.toHaveBeenCalled();
    // 切回这个页面：马上出
    hidden.mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(card()).toBeTruthy();
    expect(local.telemetryNoticeShown).toHaveBeenCalledTimes(1);
    hidden.mockRestore();
  });

  it("hides while settings are open and comes back after", async () => {
    const local = api(status());
    const view = render(<TelemetryNotice local={local} delayMs={0} />);
    expect(await screen.findByRole("region", { name: title })).toBeTruthy();
    view.rerender(<TelemetryNotice local={local} paused delayMs={0} />);
    expect(card()).toBeNull();
    view.rerender(<TelemetryNotice local={local} delayMs={0} />);
    expect(card()).toBeTruthy();
    expect(local.telemetryNoticeShown).toHaveBeenCalledTimes(1);
  });

  it("stays away from other devices, when turned off or blocked", async () => {
    for (const [value, mode] of [
      [status(), "device"],
      [status({ noticePending: false, active: false, enabled: false }), "local"],
      [status({ noticePending: false, active: false, blocker: "do_not_track" }), "local"],
    ] as const) {
      const local = api(value, mode);
      render(<TelemetryNotice local={local} delayMs={0} />);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(card()).toBeNull();
      expect(local.telemetryNoticeShown).not.toHaveBeenCalled();
      cleanup();
    }
  });
});

describe("TelemetrySettingsGroup", () => {
  const renderGroup = (local: ReturnType<typeof api>) =>
    render(<TelemetrySettingsGroup local={local as unknown as LocalAgentsState} />);

  it("shows the switch on by default and turns it off", async () => {
    const local = api(status());
    renderGroup(local);
    const toggle = await screen.findByRole("switch", { name: /匿名使用统计/ });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/每天最多上报一次/)).toBeTruthy();
    expect(screen.queryByText(/源码运行默认不上报/)).toBeNull();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(local.updateTelemetry).toHaveBeenCalledWith(false);
    // 关了就没有要发的数据：不再给「查看」按钮
    expect(screen.queryByRole("button", { name: /查看要发送的数据/ })).toBeNull();
  });

  it("says nothing is sent when running from source", async () => {
    renderGroup(api(status({ endpoint: false })));
    expect(
      await screen.findByText("源码运行默认不上报：数据只记在这台电脑上，不会发出去。"),
    ).toBeTruthy();
  });

  it("shows the raw JSON that would be sent, and hides it again", async () => {
    const local = api(status());
    renderGroup(local);
    fireEvent.click(await screen.findByRole("button", { name: "查看要发送的数据（2 条）" }));
    const preview = await screen.findByLabelText("要发送的数据");
    expect(JSON.parse(preview.textContent ?? "")).toMatchObject([
      { type: "event", payload: { name: "heartbeat" } },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(screen.queryByLabelText("要发送的数据")).toBeNull();
  });

  it("says there is nothing to send when the queue is empty", async () => {
    const local = api(status({ queued: 0 }));
    renderGroup(local);
    fireEvent.click(await screen.findByRole("button", { name: "查看要发送的数据（0 条）" }));
    expect(await screen.findByText("没有要发送的数据。")).toBeTruthy();
    expect(screen.queryByLabelText("要发送的数据")).toBeNull();
  });

  it("resets the install ID", async () => {
    const local = api(status());
    renderGroup(local);
    fireEvent.click(await screen.findByRole("button", { name: "重置安装 ID" }));
    await waitFor(() => expect(local.resetTelemetryId).toHaveBeenCalled());
  });

  it("explains why it is off and cannot be switched when blocked", async () => {
    renderGroup(api(status({ active: false, blocker: "ci", noticePending: false })));
    const toggle = await screen.findByRole("switch", { name: /匿名使用统计/ });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("在 CI 环境里运行，一律不记。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /查看要发送的数据/ })).toBeNull();
  });

  it("is read-only on the owner's other devices", async () => {
    renderGroup(api(status(), "device"));
    const toggle = await screen.findByRole("switch", { name: /匿名使用统计/ });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("只能在运行 Hive Server 的那台电脑上改。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重置安装 ID" })).toBeNull();
  });
});

describe("web reports", () => {
  it("sends nothing until the Server says it is recording, then each feature once", () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    reportTelemetryFeature("code_panel");
    reportDesktopUpdate("success");
    expect(fetch).not.toHaveBeenCalled();

    configureTelemetryReporter({ base: "http://hive", token: "join-token" });
    reportTelemetryFeature("code_panel");
    reportTelemetryFeature("code_panel");
    reportDesktopUpdate("failure", "not-writable");
    expect(fetch).toHaveBeenCalledTimes(2);
    const bodies = fetch.mock.calls.map((call) =>
      JSON.parse(String((call as unknown as [string, RequestInit])[1].body)),
    );
    expect(bodies).toEqual([
      { events: [{ event: "feature_first_used", props: { feature: "code_panel" } }] },
      {
        events: [
          {
            event: "update_result",
            props: { kind: "desktop", outcome: "failure", reason: "not_writable" },
          },
        ],
      },
    ]);
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe(
      "http://hive/api/telemetry/events",
    );
  });
});

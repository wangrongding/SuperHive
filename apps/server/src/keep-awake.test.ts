import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeepAwakeSettings } from "@ai-hive/protocol";
import { KeepAwake, type KeepAwakeDemand } from "./keep-awake.js";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  kill() {
    this.killed = true;
    this.exitCode = 0;
    this.emit("exit", 0, "SIGTERM");
    return true;
  }
}

function setup(options: { platform?: NodeJS.Platform; power?: "ac" | "battery" } = {}) {
  const children: FakeChild[] = [];
  let saved: KeepAwakeSettings | undefined;
  const demand: KeepAwakeDemand = { imConnections: 0, runningTasks: 0 };
  let power: "ac" | "battery" | "unknown" = options.power ?? "ac";
  const keepAwake = new KeepAwake({
    platform: options.platform ?? "darwin",
    loadSettings: () => saved,
    saveSettings: (settings) => {
      saved = settings;
    },
    demand: () => demand,
    readPower: async () => power,
    spawnAssertion: () => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
    tickMs: 10,
  });
  return {
    keepAwake,
    children,
    demand,
    setPower: (value: typeof power) => {
      power = value;
    },
    saved: () => saved,
  };
}

let current: KeepAwake | undefined;
afterEach(() => {
  current?.close();
  current = undefined;
  vi.useRealTimers();
});

describe("熄屏后保持在线", () => {
  it("有 IM 连接时起一个断言进程，没有了就释放；不重复起", async () => {
    const { keepAwake, children, demand } = setup();
    current = keepAwake;
    await keepAwake.start();
    expect(keepAwake.state()).toMatchObject({ status: "idle", whenIm: true, power: "ac" });
    demand.imConnections = 1;
    keepAwake.evaluate();
    keepAwake.evaluate();
    expect(children).toHaveLength(1);
    expect(keepAwake.state()).toMatchObject({
      status: "active",
      reasons: ["有 1 个 IM 连接在线"],
    });
    demand.imConnections = 0;
    keepAwake.evaluate();
    expect(children[0]!.killed).toBe(true);
    expect(keepAwake.state().status).toBe("idle");
  });

  it("用电池时默认暂停，打开「用电池时也保持」后生效；设置保存在服务端", async () => {
    const { keepAwake, children, demand, saved } = setup({ power: "battery" });
    current = keepAwake;
    demand.imConnections = 1;
    await keepAwake.start();
    expect(keepAwake.state().status).toBe("battery");
    expect(children).toHaveLength(0);
    keepAwake.update({ onBattery: true });
    expect(keepAwake.state().status).toBe("active");
    expect(saved()).toEqual({ whenIm: true, whenTasks: false, onBattery: true });
  });

  it("任务在跑默认不算，打开后才算；全部关掉显示已关闭", async () => {
    const { keepAwake, demand } = setup();
    current = keepAwake;
    demand.runningTasks = 2;
    await keepAwake.start();
    expect(keepAwake.state().status).toBe("idle");
    keepAwake.update({ whenTasks: true });
    expect(keepAwake.state()).toMatchObject({
      status: "active",
      reasons: ["有 2 个 Agent 任务在跑"],
    });
    keepAwake.update({ whenIm: false, whenTasks: false });
    expect(keepAwake.state().status).toBe("disabled");
  });

  it("断言进程意外退出时如实显示失败，并退避后重新申请", async () => {
    vi.useFakeTimers();
    const { keepAwake, children, demand } = setup();
    current = keepAwake;
    demand.imConnections = 1;
    await keepAwake.start();
    children[0]!.emit("exit", 1, null);
    expect(keepAwake.state()).toMatchObject({ status: "failed", detail: "caffeinate 退出（1）" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(children).toHaveLength(2);
    expect(keepAwake.state().status).toBe("active");
  });

  it("Windows 也支持：有 IM 时起断言进程", async () => {
    const { keepAwake, children, demand } = setup({ platform: "win32" });
    current = keepAwake;
    demand.imConnections = 1;
    await keepAwake.start();
    keepAwake.evaluate();
    expect(children).toHaveLength(1);
    expect(keepAwake.state()).toMatchObject({ supported: true, status: "active" });
  });

  it("macOS、Windows 以外如实显示不支持，不起进程", async () => {
    const { keepAwake, children, demand } = setup({ platform: "linux" });
    current = keepAwake;
    demand.imConnections = 1;
    await keepAwake.start();
    keepAwake.evaluate();
    expect(children).toHaveLength(0);
    expect(keepAwake.state()).toMatchObject({ supported: false, status: "unsupported" });
  });
});

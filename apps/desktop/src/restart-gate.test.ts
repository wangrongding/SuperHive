import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  busyAgentNames,
  RESTART_WAIT_INTERVAL_MS,
  RESTART_WAIT_TIMEOUT_MS,
  RestartGate,
} from "./restart-gate.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** 可控的忙闲：busy 改了下一次查就是新的；设成 undefined 表示查不到 */
function setup(initial: string[] | undefined = []) {
  const state = { busy: initial as string[] | undefined, ready: true, throws: false };
  const restart = vi.fn(() => state.ready);
  const busyAgents = vi.fn(async () => {
    if (state.throws) throw new Error("ECONNREFUSED");
    return state.busy ? [...state.busy] : undefined;
  });
  const onChange = vi.fn();
  const gate = new RestartGate({ ready: () => state.ready, restart, busyAgents, onChange });
  return { state, restart, busyAgents, onChange, gate };
}

describe("busyAgentNames", () => {
  it("只挑 busy 为 true 的本机 Agent 名字；形状不对就是不知道", () => {
    expect(
      busyAgentNames({
        agents: [
          { name: "rd-claude2", busy: true },
          { name: "rd-claude3", busy: false },
          { name: "rd-codex" },
          { busy: true },
          null,
        ],
      }),
    ).toEqual(["rd-claude2"]);
    expect(busyAgentNames({ agents: [] })).toEqual([]);
    expect(busyAgentNames(undefined)).toBeUndefined();
    expect(busyAgentNames({ error: "disabled" })).toBeUndefined();
  });
});

describe("RestartGate", () => {
  it("没有 Agent 在忙：照旧直接重启", async () => {
    const { gate, restart } = setup([]);
    expect(await gate.request("check")).toEqual({ status: "restarting" });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(gate.view()).toBeUndefined();
  });

  it("查不到忙闲（本机 Hive 没回话、出错）：也照旧直接重启", async () => {
    const unknown = setup(undefined);
    expect(await unknown.gate.request("check")).toEqual({ status: "restarting" });
    expect(unknown.restart).toHaveBeenCalledTimes(1);
    const broken = setup(["rd-claude2"]);
    broken.state.throws = true;
    expect(await broken.gate.request("check")).toEqual({ status: "restarting" });
  });

  it("有 Agent 在忙：不重启，交回名单等人选", async () => {
    const { gate, restart, onChange } = setup(["rd-claude2", "rd-claude3"]);
    expect(await gate.request("check")).toEqual({
      status: "busy",
      agents: ["rd-claude2", "rd-claude3"],
    });
    expect(restart).not.toHaveBeenCalled();
    expect(gate.view()).toBeUndefined();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("选「立即重启」：有 Agent 在忙也马上重启", async () => {
    const { gate, restart, busyAgents } = setup(["rd-claude2"]);
    expect(await gate.request("now")).toEqual({ status: "restarting" });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(busyAgents).not.toHaveBeenCalled();
  });

  it("选「等任务做完」：每 2 秒查一次，名单变了推给网页，全部空闲后自动重启", async () => {
    const { gate, state, restart, onChange, busyAgents } = setup(["rd-claude2", "rd-claude3"]);
    expect(await gate.request("wait")).toEqual({
      status: "waiting",
      agents: ["rd-claude2", "rd-claude3"],
    });
    expect(gate.view()).toEqual({ phase: "waiting", agents: ["rd-claude2", "rd-claude3"] });
    expect(onChange).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(RESTART_WAIT_INTERVAL_MS);
    expect(busyAgents).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledTimes(1);

    state.busy = ["rd-claude3"];
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_INTERVAL_MS);
    expect(gate.view()).toEqual({ phase: "waiting", agents: ["rd-claude3"] });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(restart).not.toHaveBeenCalled();

    // 等待中再点一次：接着等，不重复查、不重启
    expect(await gate.request("check")).toEqual({ status: "waiting", agents: ["rd-claude3"] });

    state.busy = [];
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_INTERVAL_MS);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(gate.view()).toBeUndefined();
    expect(onChange).toHaveBeenCalledTimes(3);

    // 重启后不再查
    const calls = busyAgents.mock.calls.length;
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_INTERVAL_MS * 5);
    expect(busyAgents).toHaveBeenCalledTimes(calls);
  });

  it("选等待时已经都做完了：马上重启", async () => {
    const { gate, restart } = setup([]);
    expect(await gate.request("wait")).toEqual({ status: "restarting" });
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("等待中查不到忙闲当作还在忙，不会因此重启", async () => {
    const { gate, state, restart } = setup(["rd-claude2"]);
    await gate.request("wait");
    state.busy = undefined;
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_INTERVAL_MS * 3);
    state.throws = true;
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_INTERVAL_MS * 3);
    expect(restart).not.toHaveBeenCalled();
    expect(gate.view()).toEqual({ phase: "waiting", agents: ["rd-claude2"] });
  });

  it("取消等待：回到已下载好，之后都做完了也不重启", async () => {
    const { gate, state, restart, onChange } = setup(["rd-claude2"]);
    await gate.request("wait");
    expect(gate.cancel()).toBe(true);
    expect(gate.view()).toBeUndefined();
    expect(onChange).toHaveBeenCalledTimes(2);
    state.busy = [];
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_INTERVAL_MS * 3);
    expect(restart).not.toHaveBeenCalled();
    expect(gate.cancel()).toBe(false);
  });

  it("等到 30 分钟上限还没做完：停下来等人决定，不硬重启；可以再等一轮或立即重启", async () => {
    const { gate, state, restart, busyAgents } = setup(["rd-claude2"]);
    await gate.request("wait");
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_TIMEOUT_MS + RESTART_WAIT_INTERVAL_MS);
    expect(gate.view()).toEqual({ phase: "timeout", agents: ["rd-claude2"] });
    expect(restart).not.toHaveBeenCalled();
    // 超时后不再查
    const calls = busyAgents.mock.calls.length;
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_INTERVAL_MS * 10);
    expect(busyAgents).toHaveBeenCalledTimes(calls);

    // 再等一轮：重新计时
    expect(await gate.request("wait")).toEqual({ status: "waiting", agents: ["rd-claude2"] });
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_TIMEOUT_MS - RESTART_WAIT_INTERVAL_MS * 2);
    expect(gate.view()?.phase).toBe("waiting");
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_INTERVAL_MS * 3);
    expect(gate.view()?.phase).toBe("timeout");

    // 以后再说：清掉超时提示
    expect(gate.cancel()).toBe(true);
    expect(gate.view()).toBeUndefined();

    // 再来一轮超时后选立即重启
    await gate.request("wait");
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_TIMEOUT_MS + RESTART_WAIT_INTERVAL_MS);
    expect(await gate.request("now")).toEqual({ status: "restarting" });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(gate.view()).toBeUndefined();
    state.busy = [];
  });

  it("等待中选立即重启：马上重启，不再查", async () => {
    const { gate, restart, busyAgents } = setup(["rd-claude2"]);
    await gate.request("wait");
    expect(await gate.request("now")).toEqual({ status: "restarting" });
    expect(restart).toHaveBeenCalledTimes(1);
    const calls = busyAgents.mock.calls.length;
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_INTERVAL_MS * 3);
    expect(busyAgents).toHaveBeenCalledTimes(calls);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("新版本还没准备好或中途作废：不重启、不等", async () => {
    const { gate, state, restart, busyAgents } = setup(["rd-claude2"]);
    state.ready = false;
    expect(await gate.request("check")).toEqual({ status: "unavailable" });
    expect(busyAgents).not.toHaveBeenCalled();

    state.ready = true;
    await gate.request("wait");
    state.ready = false;
    expect(gate.view()).toBeUndefined();
    state.busy = [];
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_INTERVAL_MS);
    expect(restart).not.toHaveBeenCalled();
    state.ready = true;
    expect(gate.view()).toBeUndefined();
  });

  it("查忙闲的路上被取消：以取消为准，不进入等待", async () => {
    let release: (value: string[]) => void = () => undefined;
    const restart = vi.fn(() => true);
    const gate = new RestartGate({
      ready: () => true,
      restart,
      busyAgents: () =>
        new Promise<string[]>((resolve) => {
          release = resolve;
        }),
      onChange: vi.fn(),
    });
    const pending = gate.request("wait");
    // 查的时候人点了立即重启
    expect(await gate.request("now")).toEqual({ status: "restarting" });
    release(["rd-claude2"]);
    expect(await pending).toEqual({ status: "unavailable" });
    expect(gate.view()).toBeUndefined();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("应用退出时停掉定时查询", async () => {
    const { gate, busyAgents, restart, state } = setup(["rd-claude2"]);
    await gate.request("wait");
    gate.dispose();
    state.busy = [];
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_INTERVAL_MS * 3);
    expect(busyAgents).toHaveBeenCalledTimes(1);
    expect(restart).not.toHaveBeenCalled();
  });
});

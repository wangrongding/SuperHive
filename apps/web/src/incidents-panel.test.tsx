// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INCIDENT_SETTINGS,
  type Incident,
  type IncidentsResponse,
  type RuleProposal,
} from "@superhive/protocol";
import {
  IncidentsPanel,
  groupIncidents,
  incidentsAvailable,
  useIncidents,
  type IncidentsState,
  type RoomAgent,
} from "./incidents-panel";
import { IncidentsDialog } from "./incidents-dialog";
import { AttentionRoomGroup } from "./attention-alerts";
import type { SlowOpsState } from "./slow-ops";
import type { LocalAgentsState } from "./local-agents";
import { installErrorReporter, ignorableError } from "./error-report";

afterEach(cleanup);

let sequence = 0;
function incident(patch: Partial<Incident> = {}): Incident {
  sequence++;
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    fingerprint: `server:TypeError:f${sequence}`,
    origin: "internal",
    source: "server",
    title: `TypeError: boom ${sequence}`,
    status: "open",
    count: 3,
    recentCount: 3,
    firstSeenAt: "2026-11-22T01:00:00.000Z",
    lastSeenAt: `2026-11-22T01:${String(sequence).padStart(2, "0")}:00.000Z`,
    samples: [
      {
        at: "2026-11-22T01:00:00.000Z",
        route: "GET /api/rooms",
        stack: "TypeError: boom\n    at f (apps/server/src/app.ts)",
      },
    ],
    failedAttempts: 0,
    dispatches: [],
    reopenedCount: 0,
    updatedAt: "2026-11-22T01:00:00.000Z",
    ...patch,
  };
}

function proposal(patch: Partial<RuleProposal> = {}): RuleProposal {
  return {
    id: "p1",
    roomId: "build",
    agentName: "rd-claude2",
    text: "合入前先跑全量测试",
    reason: "漏跑了 docs 的测试",
    status: "pending",
    createdAt: "2026-11-22T01:00:00.000Z",
    ...patch,
  };
}

function response(patch: Partial<IncidentsResponse> = {}): IncidentsResponse {
  return {
    incidents: [],
    lessons: [],
    proposals: [],
    settings: { ...DEFAULT_INCIDENT_SETTINGS },
    dispatchedToday: 0,
    protectedPaths: ["apps/server/src/agent-instructions.ts"],
    runningCommit: "a".repeat(40),
    ...patch,
  };
}

describe("groupIncidents", () => {
  it("puts incidents that need a person first and keeps external and unclear ones apart", () => {
    const older = incident({ lastSeenAt: "2026-11-22T00:00:00.000Z" });
    const escalated = incident({ status: "escalated", lastSeenAt: "2026-11-21T00:00:00.000Z" });
    const newer = incident({ lastSeenAt: "2026-11-22T02:00:00.000Z" });
    const resolved = incident({ status: "resolved" });
    const external = incident({ origin: "external" });
    const unknown = incident({ origin: "unknown" });
    const groups = groupIncidents([older, escalated, newer, resolved, external, unknown]);
    expect(groups.active.map((item) => item.id)).toEqual([escalated.id, newer.id, older.id]);
    expect(groups.closed).toEqual([resolved]);
    expect(groups.external).toEqual([external]);
    expect(groups.unknown).toEqual([unknown]);
  });
});

describe("IncidentsPanel", () => {
  const handlers = () => ({ onAction: vi.fn(), onDecide: vi.fn() });

  it("lists our incidents with actions but no dispatch settings", () => {
    const calls = handlers();
    const open = incident({ title: "TypeError: x is undefined" });
    render(
      <IncidentsPanel
        data={response({ incidents: [open, incident({ origin: "external" })] })}
        {...calls}
      />,
    );
    expect(screen.getByText("TypeError: x is undefined")).toBeTruthy();
    expect(screen.getByText("外部原因（1）")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "派修" })[0]!);
    expect(calls.onAction).toHaveBeenCalledWith(open.id, "dispatch");
    // 设置在「设置 → 这台电脑」里，不在列表里
    expect(screen.queryByRole("switch", { name: /自动派修/ })).toBeNull();
    expect(screen.queryByLabelText("修的 Agent")).toBeNull();
  });

  it("hands the chosen incident to feedback or contribution without dispatching a repair", () => {
    const item = incident();
    const onFeedback = vi.fn();
    const calls = handlers();
    render(
      <IncidentsPanel data={response({ incidents: [item] })} {...calls} onFeedback={onFeedback} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "反馈给 SuperHive" }));
    expect(onFeedback).toHaveBeenCalledWith(item);
    fireEvent.click(screen.getByRole("button", { name: "让我的 Agent 来修" }));
    expect(onFeedback).toHaveBeenCalledWith(item, true);
    expect(calls.onAction).not.toHaveBeenCalled();
  });

  it("lets the owner approve or reject rule proposals", () => {
    const calls = handlers();
    render(<IncidentsPanel data={response({ proposals: [proposal()] })} {...calls} />);
    expect(screen.getByText("合入前先跑全量测试")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "批准" }));
    expect(calls.onDecide).toHaveBeenCalledWith("p1", "approve");
  });

  it("highlights the incident opened from 「需要你处理」 and expands its details", () => {
    const target = incident({ status: "escalated", title: "TypeError: escalated" });
    const { container } = render(
      <IncidentsPanel
        data={response({ incidents: [incident(), target] })}
        focusId={target.id}
        {...handlers()}
      />,
    );
    const row = container.querySelector(`[data-incident-id="${target.id}"]`)!;
    expect(row.className).toContain("focused");
    expect(row.querySelector("details")!.open).toBe(true);
    expect(container.querySelectorAll(".focused")).toHaveLength(1);
  });
});

function state(patch: Partial<IncidentsState> = {}): IncidentsState {
  const data = patch.data ?? response();
  return {
    enabled: true,
    data,
    error: undefined,
    unhandled: 0,
    attentionItems: [],
    refresh: vi.fn(),
    updateSettings: vi.fn(() => Promise.resolve(true)),
    act: vi.fn(),
    decide: vi.fn(),
    ...patch,
  };
}

describe("incident entry", () => {
  it("is only for the owner on this computer, like the worktree switcher", () => {
    expect(incidentsAvailable(true, { enabled: true, mode: "local" })).toBe(true);
    expect(incidentsAvailable(true, { enabled: true, mode: "device" })).toBe(false);
    expect(incidentsAvailable(true, { enabled: false, mode: undefined })).toBe(false);
    expect(incidentsAvailable(false, { enabled: true, mode: "local" })).toBe(false);
  });

  let latest: IncidentsState | undefined;
  function Harness({
    local,
    enabled,
    signal,
  }: {
    local: LocalAgentsState;
    enabled: boolean;
    signal?: { attention: number; version: number };
  }) {
    latest = useIncidents(local, enabled, signal);
    return null;
  }

  it("loads incidents for the local owner and counts what nobody handles yet", async () => {
    const incidents = vi.fn(async () =>
      response({
        incidents: [
          incident({ status: "escalated", title: "TypeError: escalated" }),
          incident({ status: "open" }),
          incident({ status: "fixing" }),
          incident({ status: "resolved" }),
          incident({ origin: "external" }),
        ],
        proposals: [proposal(), proposal({ id: "p2", status: "approved" })],
      }),
    );
    const local = { mode: "local", incidents } as unknown as LocalAgentsState;
    render(<Harness local={local} enabled signal={{ attention: 2, version: 1 }} />);
    // 详情还没拉到：先用 Server 推来的数字
    expect(latest!.unhandled).toBe(2);
    await waitFor(() => expect(latest!.data).toBeDefined());
    // 待处理 + 升级给人 + 待批准的规则提议；修复中、已解决、外部原因不算
    expect(latest!.unhandled).toBe(3);
    expect(latest!.attentionItems.map((item) => [item.kind, item.title])).toEqual([
      ["incident", "TypeError: escalated"],
      ["proposal", "合入前先跑全量测试"],
    ]);
  });

  it("doesn't load or count anything elsewhere", async () => {
    const incidents = vi.fn(async () => response({ proposals: [proposal()] }));
    const local = { mode: "device", incidents } as unknown as LocalAgentsState;
    render(<Harness local={local} enabled={false} signal={{ attention: 1, version: 1 }} />);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(incidents).not.toHaveBeenCalled();
    expect(latest!.unhandled).toBe(0);
    expect(latest!.attentionItems).toEqual([]);
  });

  it("puts escalated incidents and pending proposals into 「需要你处理」", () => {
    const onOpenIncident = vi.fn();
    render(
      <AttentionRoomGroup
        items={[]}
        incidents={[
          { id: "i1", kind: "incident", title: "TypeError: escalated" },
          { id: "p1", kind: "proposal", title: "合入前先跑全量测试" },
        ]}
        roomName={(id) => id}
        onOpen={vi.fn()}
        onOpenIncident={onOpenIncident}
      />,
    );
    const group = screen.getByRole("region", { name: "需要你处理" });
    expect(group.textContent).toContain("故障单");
    expect(group.textContent).toContain("规则提议");
    fireEvent.click(screen.getByRole("button", { name: /TypeError: escalated/ }));
    expect(onOpenIncident).toHaveBeenCalledWith(expect.objectContaining({ id: "i1" }));
  });
});

describe("IncidentsDialog", () => {
  const slowOps: SlowOpsState = {
    enabled: true,
    operations: [
      { id: "s1", at: new Date().toISOString(), kind: "git", name: "git fetch", durationMs: 4_000 },
    ],
    settings: {
      thresholdMs: 3000,
      requestThresholdMs: 5000,
      capacity: 200,
      alertMs: 15_000,
      lockWaitAlertMs: 10_000,
    },
    receiveSnapshot: vi.fn(),
    receive: vi.fn(),
  };

  it("switches between incidents and slow operations", () => {
    const onTab = vi.fn();
    const current = state({
      unhandled: 1,
      data: response({ incidents: [incident({ title: "TypeError: listed" })] }),
    });
    const { rerender } = render(
      <IncidentsDialog
        tab="incidents"
        incidents={current}
        slowOps={slowOps}
        rooms={[]}
        currentRoomId="build"
        username="rd"
        loadAgents={loadAgents}
        onTab={onTab}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog", { name: "故障" })).toBeTruthy();
    expect(current.refresh).toHaveBeenCalled();
    expect(screen.getByText("TypeError: listed")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "故障单 1" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("tab", { name: "慢操作" }));
    expect(onTab).toHaveBeenCalledWith("slow-ops");
    rerender(
      <IncidentsDialog
        tab="slow-ops"
        incidents={current}
        slowOps={slowOps}
        rooms={[]}
        currentRoomId="build"
        username="rd"
        loadAgents={loadAgents}
        onTab={onTab}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText("TypeError: listed")).toBeNull();
    expect(screen.getByRole("list", { name: "最近慢操作" }).textContent).toContain("git fetch");
    expect(screen.getByText(/记录超过 3 秒（请求 5 秒）的操作/)).toBeTruthy();
  });

  it("60 条慢操作全放在弹窗内容区里，列表和说明都在唯一的滚动区内", () => {
    const many: SlowOpsState = {
      ...slowOps,
      operations: Array.from({ length: 60 }, (_, index) => ({
        id: `s${index}`,
        at: new Date(Date.now() - index * 120_000).toISOString(),
        kind: index % 2 ? ("git" as const) : ("request" as const),
        name: `op-${index}`,
        durationMs: 4_000,
      })),
    };
    render(
      <IncidentsDialog
        tab="slow-ops"
        incidents={state({ data: response({}) })}
        slowOps={many}
        rooms={[]}
        currentRoomId="build"
        username="rd"
        loadAgents={loadAgents}
        onTab={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "故障" });
    const body = screen.getByRole("tabpanel");
    expect(body.classList.contains("app-dialog-body")).toBe(true);
    const list = screen.getByRole("list", { name: "最近慢操作" });
    expect(list.querySelectorAll("li")).toHaveLength(60);
    expect(body.contains(list)).toBe(true);
    expect(body.contains(screen.getByText(/记录超过 3 秒/))).toBe(true);
    // 标签切换和关闭按钮在标题栏里，不在滚动区内
    const header = dialog.querySelector(".app-dialog-header")!;
    expect(header.contains(screen.getByRole("tab", { name: "慢操作" }))).toBe(true);
    expect(header.querySelector(".app-dialog-close")).toBeTruthy();
    expect(body.contains(header)).toBe(false);
  });

  const agentsByRoom: Record<string, RoomAgent[]> = {
    build: [
      { username: "rd-claude", status: "offline", provider: "claude" },
      { username: "rd-claude2", status: "online", provider: "claude" },
      { username: "rd-codex", status: "busy", provider: "codex" },
    ],
    ops: [{ username: "ops-bot", status: "online", provider: "codex" }],
  };
  const loadAgents = (roomId: string) => Promise.resolve(agentsByRoom[roomId] ?? []);
  const rooms = [
    { id: "build", name: "build" },
    { id: "ops", name: "运维" },
  ];

  function openSettings(current: IncidentsState, onClose = vi.fn()) {
    render(
      <IncidentsDialog
        tab="incidents"
        incidents={current}
        slowOps={{ ...slowOps, operations: [] }}
        rooms={rooms}
        currentRoomId="build"
        username="rd"
        loadAgents={loadAgents}
        onTab={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "派修设置" }));
  }

  const pick = async (field: string, option: string | RegExp) => {
    fireEvent.click(screen.getByRole("combobox", { name: field }));
    fireEvent.click(await screen.findByRole("option", { name: option }));
  };

  it("unfolds the dispatch settings in place and closes on Escape", async () => {
    const onClose = vi.fn();
    const current = state({ data: response() });
    render(
      <IncidentsDialog
        tab="incidents"
        incidents={current}
        slowOps={{ ...slowOps, operations: [] }}
        rooms={rooms}
        currentRoomId="build"
        username="rd"
        loadAgents={loadAgents}
        onTab={vi.fn()}
        onClose={onClose}
      />,
    );
    expect(screen.getByText(/自动派修没打开/)).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "派修设置" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("combobox", { name: "修的 Agent" })).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const settings = screen.getByRole("region", { name: "派修设置" });
    // 以房主的名义派活，不用填；也没有「保存」按钮，改了就存
    expect(screen.queryByText("以谁的名义派活")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    expect(settings.querySelector(".incident-settings.muted")).toBeTruthy();

    await pick("修的 Agent", /rd-claude2/);
    expect(current.updateSettings).toHaveBeenLastCalledWith({
      roomId: "build",
      requester: "rd",
      fixer: "rd-claude2",
    });
    expect((await screen.findByRole("status")).textContent).toContain("已保存");
    fireEvent.click(screen.getByRole("switch", { name: /自动派修/ }));
    expect(current.updateSettings).toHaveBeenLastCalledWith({
      roomId: "build",
      requester: "rd",
      autoDispatch: true,
    });
    expect(settings.textContent).toContain("自动修复不许改的代码");

    fireEvent.click(toggle);
    expect(screen.queryByRole("region", { name: "派修设置" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("lists the chosen room's agents, online first and offline marked", async () => {
    const current = state({ data: response() });
    openSettings(current);
    fireEvent.click(screen.getByRole("combobox", { name: "修的 Agent" }));
    await screen.findByRole("option", { name: /rd-claude2/ });
    const names = screen.getAllByRole("option").map((option) => option.textContent);
    expect(names[0]).toContain("rd-claude2");
    expect(names[1]).toContain("rd-codex");
    expect(names[1]).toContain("忙碌中");
    expect(names[2]).toContain("rd-claude");
    const headings = [...document.querySelectorAll(".select-group")].map(
      (item) => item.textContent,
    );
    expect(headings).toEqual(["在线", "离线"]);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "修的 Agent" }), { key: "Escape" });

    await pick("在哪个房间派活", "# 运维");
    expect(current.updateSettings).toHaveBeenLastCalledWith({ roomId: "ops", requester: "rd" });
    fireEvent.click(screen.getByRole("combobox", { name: "修的 Agent" }));
    await screen.findByRole("option", { name: /ops-bot/ });
    expect(screen.queryByRole("option", { name: /rd-claude2/ })).toBeNull();
  });

  it("won't let the reviewer be the fixer", async () => {
    const current = state({
      data: response({
        settings: {
          ...DEFAULT_INCIDENT_SETTINGS,
          roomId: "build",
          requester: "rd",
          fixer: "rd-claude2",
          reviewer: "rd-codex",
        },
      }),
    });
    openSettings(current);
    fireEvent.click(screen.getByRole("combobox", { name: "review 的 Agent" }));
    const same = await screen.findByRole("option", { name: /rd-claude2/ });
    expect(same.getAttribute("aria-disabled")).toBe("true");
    expect(same.textContent).toContain("已选为修的 Agent");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "review 的 Agent" }), {
      key: "Escape",
    });

    // 把修的换成原来 review 的那个：review 的清空，提示重新选
    await pick("修的 Agent", /rd-codex/);
    expect(current.updateSettings).toHaveBeenLastCalledWith({
      roomId: "build",
      requester: "rd",
      fixer: "rd-codex",
      reviewer: "",
    });
    expect(screen.getByRole("alert").textContent).toContain("不能和修的是同一个");
  });

  it("warns when a saved agent is no longer in the room", async () => {
    const current = state({
      data: response({
        settings: { ...DEFAULT_INCIDENT_SETTINGS, roomId: "build", fixer: "gone-agent" },
      }),
    });
    openSettings(current);
    expect((await screen.findByRole("alert")).textContent).toContain("gone-agent 不在 #build");
    expect(screen.getByRole("combobox", { name: "修的 Agent" }).textContent).toContain(
      "gone-agent",
    );
  });

  it("keeps the counts within range and saves them once the clicking stops", async () => {
    const current = state({ data: response() });
    openSettings(current);
    const threshold = screen.getByRole("spinbutton", { name: "出现几次派修" });
    const daily = screen.getByRole("spinbutton", { name: "每天最多派" });
    const attempts = screen.getByRole("spinbutton", { name: "修失败几次找你" });
    expect([threshold, daily, attempts].map((item) => item.getAttribute("aria-valuemax"))).toEqual([
      "20",
      "20",
      "5",
    ]);
    expect(daily.getAttribute("aria-valuemin")).toBe("1");
    fireEvent.keyDown(threshold, { key: "End" });
    fireEvent.keyDown(threshold, { key: "ArrowUp" });
    fireEvent.keyDown(attempts, { key: "End" });
    fireEvent.keyDown(daily, { key: "Home" });
    fireEvent.keyDown(daily, { key: "ArrowDown" });
    expect(threshold.getAttribute("aria-valuenow")).toBe("20");
    expect(attempts.getAttribute("aria-valuenow")).toBe("5");
    expect(daily.getAttribute("aria-valuenow")).toBe("1");
    expect(current.updateSettings).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(current.updateSettings).toHaveBeenCalledWith({
        roomId: "build",
        requester: "rd",
        threshold: 20,
        maxAttempts: 5,
        dailyLimit: 1,
      }),
    );
    expect(current.updateSettings).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("次")).toHaveLength(3);
  });

  it("can't switch on automatic fixing when the server doesn't run from a checkout", () => {
    const data = response();
    delete data.runningCommit;
    render(
      <IncidentsDialog
        tab="incidents"
        incidents={state({ data })}
        slowOps={{ ...slowOps, operations: [] }}
        rooms={[]}
        currentRoomId="build"
        username="rd"
        loadAgents={loadAgents}
        onTab={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "派修设置" }));
    expect((screen.getByRole("switch", { name: /自动派修/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe("installErrorReporter", () => {
  it("reports uncaught errors and rejections once per minute, skipping extension noise", () => {
    const sent: Array<{ message: string; kind: string; roomId: string | undefined }> = [];
    const uninstall = installErrorReporter({
      base: "",
      token: "t",
      roomId: () => "build",
      send: (report, roomId) => sent.push({ message: report.message, kind: report.kind, roomId }),
    });
    const error = new TypeError("x is undefined");
    window.dispatchEvent(new ErrorEvent("error", { error, message: error.message }));
    window.dispatchEvent(new ErrorEvent("error", { error, message: error.message }));
    const rejection = new Event("unhandledrejection") as Event & { reason: unknown };
    rejection.reason = new Error("fetch failed");
    window.dispatchEvent(rejection);
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));
    uninstall();
    window.dispatchEvent(new ErrorEvent("error", { message: "later" }));
    expect(sent).toEqual([
      { message: "x is undefined", kind: "error", roomId: "build" },
      { message: "fetch failed", kind: "unhandledrejection", roomId: "build" },
    ]);
    expect(ignorableError("x", "at chrome-extension://abc/content.js:1:1")).toBe(true);
  });
});

describe("故障弹窗只有一个滚动区（样式）", () => {
  const stylesDir = path.join(import.meta.dirname, "styles");
  const rules = (name: string) =>
    [
      ...readFileSync(path.join(stylesDir, name), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/@media[^{]*\{/g, "")
        .matchAll(/([^{}]+)\{([^{}]*)\}/g),
    ].map((match) => ({ selector: match[1]!.replace(/\s+/g, " ").trim(), body: match[2]! }));

  it("故障单、慢操作的样式里不给列表、调用栈等内容限高或单独滚动", () => {
    const nested = ["incidents.css", "slow-ops.css"].flatMap((name) =>
      rules(name)
        .filter(
          (rule) =>
            /(^|[;\s])max-height\s*:/.test(rule.body) ||
            /(^|[;\s])overflow(-y)?\s*:\s*(auto|scroll)/.test(rule.body),
        )
        .map((rule) => `${name}: ${rule.selector}`),
    );
    expect(nested).toEqual([]);
  });

  it("宽屏下弹窗高度贴合内容（不沿用 xl 的固定高度），顶边按撑满时的位置固定", () => {
    const dialog = rules("incidents.css").find(
      (rule) => rule.selector === ".app-dialog.xl.incidents-dialog",
    );
    expect(dialog?.body).toMatch(/height:\s*auto/);
    expect(dialog?.body).toMatch(/align-self:\s*start/);
    expect(dialog?.body).toMatch(/margin-top:.*100cqh/);
  });
});

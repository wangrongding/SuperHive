// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Invocation } from "@superhive/protocol";
import { InvocationChips } from "./invocations";
import { FILTER_PANEL_MAX_HEIGHT, ModelPicker, RetryModelDialog } from "./model-picker";

afterEach(cleanup);

const at = "2026-11-14T13:00:00.000Z";
const failed: Invocation = {
  id: "00000000-0000-4000-8000-000000000001",
  roomId: "general",
  messageId: "m",
  agentId: "a",
  agentName: "rd-codex",
  requesterName: "rd",
  requesterType: "human",
  status: "failed",
  attempts: 1,
  createdAt: at,
  updatedAt: at,
};
const chipProps = {
  participants: [],
  canJumpTo: () => true,
  onJump: vi.fn(),
  onRetry: vi.fn(),
  onCancel: vi.fn(),
  onExtend: vi.fn(),
};

describe("换个模型重试", () => {
  it("shows the button only on failed tasks, and only to the owner", () => {
    const onRetryWithModel = vi.fn();
    const { rerender } = render(
      <InvocationChips {...chipProps} invocations={[failed]} onRetryWithModel={onRetryWithModel} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "换个模型重试 @rd-codex" }));
    expect(onRetryWithModel).toHaveBeenCalledWith(failed);
    // 普通「重试」还在
    expect(screen.getByRole("button", { name: /^重试 @rd-codex/ })).toBeTruthy();

    rerender(
      <InvocationChips
        {...chipProps}
        invocations={[failed]}
        isOwner={false}
        onRetryWithModel={onRetryWithModel}
      />,
    );
    expect(screen.queryByRole("button", { name: /换个模型重试/ })).toBeNull();
    rerender(
      <InvocationChips
        {...chipProps}
        invocations={[{ ...failed, status: "completed" }]}
        onRetryWithModel={onRetryWithModel}
      />,
    );
    expect(screen.queryByRole("button", { name: /换个模型重试/ })).toBeNull();
  });

  it("says under the buttons what retrying will do", () => {
    render(
      <InvocationChips
        {...chipProps}
        invocations={[{ ...failed, detail: "x", detailText: { key: "bridge.transientFailed" } }]}
        onRetryWithModel={vi.fn()}
      />,
    );
    const note = screen.getByText("还没开始执行，重试安全");
    expect(note.className).toBe("invocation-consequence");
    // 读屏读按钮时一并读出后果
    expect(
      screen.getByRole("button", { name: /^重试 @rd-codex/ }).getAttribute("aria-describedby"),
    ).toBe(note.id);
    // 悬停提示的说明接在后果后面
    expect(
      screen
        .getByRole("button", { name: "换个模型重试 @rd-codex" })
        .getAttribute("aria-describedby")
        ?.split(" ")[0],
    ).toBe(note.id);
  });

  it("retries once with a model picked from the runtime's list", async () => {
    const onRetry = vi.fn();
    const load = vi.fn(async () => ({
      source: "runtime" as const,
      models: [{ id: "gpt-a", isDefault: true }, { id: "gpt-b" }],
      efforts: [],
    }));
    render(
      <RetryModelDialog
        agentName="rd-codex"
        currentModel="gpt-a"
        load={load}
        onRetry={onRetry}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText("只对这一次重试生效，之后还是用它设置里的模型 gpt-a。")).toBeTruthy();
    const submit = screen.getByRole("button", { name: "重试" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const picker = screen.getByRole("combobox", { name: "模型" });
    await waitFor(() => expect((picker as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(picker);
    // 换模型重试没有「运行时默认」这一项
    expect(screen.queryByRole("option", { name: /运行时默认/ })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /^gpt-b/ }));
    fireEvent.click(screen.getByRole("button", { name: "用 gpt-b 重试" }));
    expect(onRetry).toHaveBeenCalledWith("gpt-b", "");
  });

  it("retries once with only a different reasoning effort", async () => {
    const onRetry = vi.fn();
    const load = vi.fn(async () => ({
      source: "preset" as const,
      models: [{ id: "opus" }],
      efforts: ["low", "medium", "high", "xhigh", "max"],
    }));
    render(
      <RetryModelDialog
        agentName="rd-claude"
        currentModel="opus"
        load={load}
        onRetry={onRetry}
        onClose={() => undefined}
      />,
    );
    const effort = await screen.findByRole("combobox", { name: "思考强度" });
    expect(effort.textContent).toContain("不换");
    fireEvent.click(effort);
    fireEvent.click(screen.getByRole("option", { name: /^最高 · max/ }));
    fireEvent.click(screen.getByRole("button", { name: "用 最高 · max 思考强度重试" }));
    expect(onRetry).toHaveBeenCalledWith("", "max");
  });

  it("asks for a typed model name when the agent is not on this computer", () => {
    const onRetry = vi.fn();
    render(<RetryModelDialog agentName="remote" onRetry={onRetry} onClose={() => undefined} />);
    expect(
      screen.getByText("这个 Agent 不在这台电脑上，拿不到它的模型列表，请手动输入模型名。"),
    ).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "模型名" }), {
      target: { value: "claude-opus-5-5" },
    });
    fireEvent.submit(screen.getByRole("dialog"));
    expect(onRetry).toHaveBeenCalledWith("claude-opus-5-5", "");
  });
});

describe("可能需要配置代理", () => {
  it("links network failures of local agents to the proxy settings", () => {
    const open = vi.fn();
    const onOpenProxySettings = vi.fn((invocation: Invocation) =>
      invocation.agentName === "rd-codex" ? open : undefined,
    );
    const { rerender } = render(
      <InvocationChips
        {...chipProps}
        invocations={[{ ...failed, failure: "network" }]}
        onOpenProxySettings={onOpenProxySettings}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "@rd-codex 连不上模型服务，打开网络代理设置" }),
    );
    expect(open).toHaveBeenCalled();
    // 自动重试等网络恢复时也给
    rerender(
      <InvocationChips
        {...chipProps}
        invocations={[{ ...failed, status: "running", failure: "network" }]}
        onOpenProxySettings={onOpenProxySettings}
      />,
    );
    expect(screen.getByRole("button", { name: /打开网络代理设置/ })).toBeTruthy();
    // 别的失败原因、远程 Agent（拿不到处理函数）都不给
    rerender(
      <InvocationChips
        {...chipProps}
        invocations={[{ ...failed, failure: "auth" }]}
        onOpenProxySettings={onOpenProxySettings}
      />,
    );
    expect(screen.queryByRole("button", { name: /打开网络代理设置/ })).toBeNull();
    rerender(
      <InvocationChips
        {...chipProps}
        invocations={[{ ...failed, agentName: "remote", failure: "network" }]}
        onOpenProxySettings={onOpenProxySettings}
      />,
    );
    expect(screen.queryByRole("button", { name: /打开网络代理设置/ })).toBeNull();
  });
});

describe("ModelPicker hint", () => {
  const aliases = [{ id: "opus" }, { id: "sonnet" }];
  const efforts = ["low", "high"];
  const hint = (data: Parameters<typeof ModelPicker>[0]["data"]) => {
    cleanup();
    const { container } = render(
      <ModelPicker data={data} value="" onChange={() => undefined} allowDefault />,
    );
    return container.querySelector(".agent-mcp-hint")?.textContent ?? null;
  };

  it("says nothing for a full list from the runtime", () => {
    expect(hint({ source: "runtime", models: aliases, efforts })).toBeNull();
  });

  it("explains why only common choices are shown", () => {
    expect(hint({ source: "preset", models: aliases, efforts, presetReason: "oauth" })).toBe(
      "Claude 用账号登录、没有 API key，拉不到完整列表，下面是常用选项，也可以手动输入。",
    );
    expect(hint({ source: "preset", models: aliases, efforts, presetReason: "cloud" })).toContain(
      "Bedrock / Vertex",
    );
    expect(
      hint({ source: "preset", models: aliases, efforts, error: "api.example.com 返回 401" }),
    ).toBe("没能拉到完整的模型列表（api.example.com 返回 401），下面是常用选项，也可以手动输入。");
    expect(hint({ source: "preset", models: [], efforts, error: "spawn ENOENT" })).toBe(
      "没能从运行时拉到模型列表（spawn ENOENT），可以手动输入。",
    );
    expect(hint({ source: "preset", models: [{ id: "auto" }], efforts })).toBe(
      "这个运行时没有列模型的命令，下面是常用选项，也可以手动输入。",
    );
  });
});

describe("ModelPicker with many models", () => {
  const many = {
    source: "runtime" as const,
    efforts: [],
    models: [
      { id: "opus", label: "Opus" },
      { id: "sonnet", label: "Sonnet" },
      { id: "haiku", label: "Haiku" },
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", isDefault: true },
      ...Array.from({ length: 56 }, (_, index) => ({ id: `gw-model-${index + 1}` })),
    ],
  };
  const open = (props: Partial<Parameters<typeof ModelPicker>[0]> = {}) => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <ModelPicker
        aria-label="模型"
        data={many}
        value=""
        allowDefault
        onChange={onChange}
        onCommit={onCommit}
        {...props}
      />,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "模型" }));
    const filter = screen.getByRole("combobox", { name: "过滤模型" });
    return { onChange, onCommit, filter };
  };
  const optionNames = () =>
    screen
      .getAllByRole("option")
      .map((option) => option.querySelector(".select-option-text > span")!.textContent);

  it("puts focus in the filter box and keeps the runtime default and aliases on top", () => {
    const { filter } = open();
    expect(document.activeElement).toBe(filter);
    expect(optionNames().slice(0, 4)).toEqual(["运行时默认", "Opus", "Sonnet", "Haiku"]);
    expect(screen.getAllByRole("option")).toHaveLength(61);
    // 不再有单独的「手动输入…」
    expect(screen.queryByRole("option", { name: /手动输入/ })).toBeNull();
  });

  it("gives the filter panel more room than a plain select and says how many models there are", () => {
    const innerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1000 });
    try {
      const { filter } = open();
      const panel = filter.closest<HTMLElement>(".model-filter-panel")!;
      // jsdom 里触发框在 (0,0)：下方可用约 988px，面板按 520 封顶（普通下拉是 300）
      expect(panel.style.maxHeight).toBe(`${FILTER_PANEL_MAX_HEIGHT}px`);
      expect(filter.getAttribute("placeholder")).toBe("过滤 60 个模型，或输入模型名");
    } finally {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: innerHeight });
    }
  });

  it("filters by id or display name ignoring case, and picks with the arrow keys and Enter", () => {
    const { filter, onChange, onCommit } = open();
    fireEvent.change(filter, { target: { value: "OPUS 5" } });
    expect(optionNames()).toEqual(["Claude Opus 5.5", "使用「OPUS 5」"]);
    fireEvent.change(filter, { target: { value: "GW-MODEL-5" } });
    expect(optionNames()).toEqual([
      "gw-model-5",
      "gw-model-50",
      "gw-model-51",
      "gw-model-52",
      "gw-model-53",
      "gw-model-54",
      "gw-model-55",
      "gw-model-56",
      "使用「GW-MODEL-5」",
    ]);
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    fireEvent.keyDown(filter, { key: "ArrowUp" });
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("gw-model-50");
    expect(onCommit).toHaveBeenCalledWith("gw-model-50");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "模型" }));
  });

  it("offers the typed text as a model name when nothing matches", () => {
    const { filter, onCommit } = open();
    fireEvent.change(filter, { target: { value: "my-private-model" } });
    expect(optionNames()).toEqual(["使用「my-private-model」"]);
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("my-private-model");
  });

  it("does not offer 「使用」 for an exact model name", () => {
    const { filter } = open();
    fireEvent.change(filter, { target: { value: "gw-model-56" } });
    expect(optionNames()).toEqual(["gw-model-56"]);
  });

  it("shows a typed model name on the trigger without a separate input box", () => {
    render(
      <ModelPicker
        aria-label="模型"
        data={many}
        value="my-private-model"
        onChange={() => undefined}
      />,
    );
    expect(screen.getByRole("combobox", { name: "模型" }).textContent).toContain(
      "my-private-model",
    );
    expect(screen.queryByRole("textbox", { name: "模型名" })).toBeNull();
  });

  it("closes with Esc and a click outside without closing the retry dialog", () => {
    const onClose = vi.fn();
    render(
      <RetryModelDialog
        agentName="rd-claude"
        load={async () => many}
        onRetry={() => undefined}
        onClose={onClose}
      />,
    );
    return waitFor(() =>
      expect((screen.getByRole("combobox", { name: "模型" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    ).then(() => {
      fireEvent.click(screen.getByRole("combobox", { name: "模型" }));
      const filter = screen.getByRole("combobox", { name: "过滤模型" });
      fireEvent.keyDown(filter, { key: "Escape" });
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("combobox", { name: "模型" }));
      fireEvent.pointerDown(document.body);
      expect(screen.queryByRole("listbox")).toBeNull();
      // 选一个再重试：只对这一次生效
      fireEvent.click(screen.getByRole("combobox", { name: "模型" }));
      fireEvent.change(screen.getByRole("combobox", { name: "过滤模型" }), {
        target: { value: "gw-model-7" },
      });
      fireEvent.click(screen.getByRole("option", { name: /^gw-model-7$/ }));
      expect(screen.getByRole("button", { name: "用 gw-model-7 重试" })).toBeTruthy();
    });
  });

  it("keeps the plain list without a filter box for 8 options or fewer", () => {
    render(
      <ModelPicker
        aria-label="模型"
        data={{ source: "preset", efforts: [], models: many.models.slice(0, 4) }}
        value=""
        allowDefault
        onChange={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "模型" }));
    expect(screen.queryByRole("combobox", { name: "过滤模型" })).toBeNull();
    expect(screen.getByRole("option", { name: /手动输入/ })).toBeTruthy();
  });
});

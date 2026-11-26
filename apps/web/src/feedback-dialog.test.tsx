// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { LocalAgentsState } from "./local-agents";
import { FeedbackDialog } from "./feedback-dialog";
import { copyTextToClipboard } from "./clipboard";
import { setLocalePreference } from "./i18n";

vi.mock("./clipboard", () => ({ copyTextToClipboard: vi.fn(async () => undefined) }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  setLocalePreference("zh-CN");
});

function props(
  patch: Partial<ComponentProps<typeof FeedbackDialog>> = {},
): ComponentProps<typeof FeedbackDialog> {
  return {
    local: {
      enabled: true,
      mode: "local",
      hostPlatform: "darwin",
      agents: [{ name: "local-agent", access: "workspace", status: "running" }],
      agentClis: vi.fn(async () => ({
        tools: [{ tool: "codex", status: "ok", version: "0.100.0" }],
      })),
      refreshAgents: vi.fn(async () => undefined),
    } as unknown as LocalAgentsState,
    meta: undefined,
    participants: [
      {
        type: "agent",
        username: "local-agent",
        status: "online",
        id: crypto.randomUUID(),
        roomId: "test",
        joinedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      },
    ],
    canContribute: true,
    onContribute: vi.fn(async () => true),
    onClose: vi.fn(),
    ...patch,
  };
}

function fill() {
  fireEvent.change(screen.getByLabelText("标题"), { target: { value: "Settings fail" } });
  fireEvent.change(screen.getByLabelText("描述"), {
    target: { value: "token=secret /Users/alice/app Settings do not open" },
  });
}

describe("feedback dialog", () => {
  it("keeps generic feedback blank but explicitly prefills an incident entry without private error text", async () => {
    const recentIncident = {
      source: "web",
      status: "open",
      title: "TypeError: private-room",
      count: 3,
      samples: [],
    } as unknown as ComponentProps<typeof FeedbackDialog>["recentIncident"];
    const view = render(<FeedbackDialog {...props({ recentIncident })} />);
    expect((screen.getByLabelText("标题") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("描述") as HTMLTextAreaElement).value).toBe("");
    view.unmount();
    render(<FeedbackDialog {...props({ recentIncident, prefillIncident: true })} />);
    expect((screen.getByLabelText("标题") as HTMLInputElement).value).toBe("web: TypeError");
    expect((screen.getByLabelText("描述") as HTMLTextAreaElement).value).toContain("web");
    expect((screen.getByLabelText("描述") as HTMLTextAreaElement).value).not.toContain(
      "private-room",
    );
    await screen.findByText(/仅附上运行时种类/);
  });
  it("freezes the preview so late runtime diagnostics cannot silently change the submitted report", async () => {
    const initial = props();
    let resolveTools: (tools: unknown) => void = () => undefined;
    initial.local.agentClis = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveTools = resolve;
        }),
    ) as LocalAgentsState["agentClis"];
    render(<FeedbackDialog {...initial} />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "预览最终正文" }));
    const before = screen.getByRole("region", { name: "最终正文预览" }).textContent;
    await act(async () =>
      resolveTools({ tools: [{ tool: "codex", status: "ok", version: "0.100.0" }] }),
    );
    expect(screen.getByRole("region", { name: "最终正文预览" }).textContent).toBe(before);
    fireEvent.click(screen.getByRole("button", { name: "复制正文" }));
    await waitFor(() => expect(copyTextToClipboard).toHaveBeenCalled());
    expect(vi.mocked(copyTextToClipboard).mock.calls[0]![0]).not.toContain("codex 0.100.0");
  });
  it("previews redacted text, allows removing diagnostics and opens only a generated GitHub URL", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<FeedbackDialog {...props()} />);
    expect(screen.getByRole("button", { name: "预览最终正文" }).hasAttribute("disabled")).toBe(
      true,
    );
    fill();
    fireEvent.click(screen.getByLabelText("附上诊断信息"));
    fireEvent.click(screen.getByRole("button", { name: "预览最终正文" }));
    const preview = screen.getByRole("region", { name: "最终正文预览" });
    expect(preview.textContent).not.toContain("secret");
    expect(preview.textContent).not.toContain("alice");
    expect(preview.textContent).not.toContain("SuperHive:");
    fireEvent.click(screen.getByRole("button", { name: "去 GitHub 确认提交" }));
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining("https://github.com/wangrongding/SuperHive/issues/new?"),
      "_blank",
      "noopener,noreferrer",
    );
    expect(new URL(open.mock.calls[0]![0] as string).searchParams.get("description")).not.toContain(
      "secret",
    );
    await screen.findByRole("status");
    fireEvent.click(screen.getByRole("button", { name: "返回编辑" }));
    expect((screen.getByLabelText("描述") as HTMLTextAreaElement).value).toContain("token=secret");
  });

  it("does not open a long URL and surfaces clipboard failures without losing the preview", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<FeedbackDialog {...props()} />);
    fill();
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "长正文 ".repeat(1_000) } });
    fireEvent.click(screen.getByRole("button", { name: "预览最终正文" }));
    vi.mocked(copyTextToClipboard).mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "去 GitHub 确认提交" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "去 GitHub 确认提交" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("正文较长"));
    expect(open).not.toHaveBeenCalled();
    const link = screen.getByRole("link", { name: "打开生成的 GitHub 链接" }) as HTMLAnchorElement;
    expect(link.href.length).toBeLessThan(2_000);
    expect(vi.mocked(copyTextToClipboard).mock.calls.at(-1)?.[0]).toContain("长正文");
  });

  it("offers feature feedback without hidden bug fields and renders English", async () => {
    setLocalePreference("en");
    render(<FeedbackDialog {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Suggest a feature" }));
    expect(screen.queryByLabelText("Steps to reproduce")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Feedback and contributing" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Only runtime types/)).toBeTruthy());
  });

  it("requires an explicit local Agent and directory and avoids double dispatch or uncertain retries", async () => {
    let finish: (confirmed: boolean) => void = () => undefined;
    const onContribute = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    render(<FeedbackDialog {...props({ onContribute, startContributing: true })} />);
    fill();
    fireEvent.click(screen.getByRole("combobox", { name: "本机 Agent" }));
    fireEvent.click(screen.getByRole("option", { name: "local-agent" }));
    fireEvent.change(screen.getByLabelText("贡献目录"), {
      target: { value: "/tmp/superhive-contribution" },
    });
    const send = screen.getByRole("button", { name: "确认交给 Agent" });
    fireEvent.click(send);
    fireEvent.click(send);
    expect(onContribute).toHaveBeenCalledTimes(1);
    expect(onContribute).toHaveBeenCalledWith(
      "local-agent",
      expect.stringContaining("hive_ask_human"),
    );
    await act(async () => finish(false));
    expect(screen.getByRole("status").textContent).toContain("未收到回执");
    expect(screen.getByRole("button", { name: "任务已发送" }).hasAttribute("disabled")).toBe(true);
  });

  it("does not offer local dispatch to visitors or remote users", async () => {
    const onContribute = vi.fn();
    render(
      <FeedbackDialog
        {...props({ canContribute: false, onContribute, startContributing: true })}
      />,
    );
    fill();
    expect(screen.queryByRole("option", { name: "local-agent" })).toBeNull();
    expect(screen.getByRole("button", { name: "确认交给 Agent" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(onContribute).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/仅附上运行时种类/)).toBeTruthy());
  });
});

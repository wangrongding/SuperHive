// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Invocation, TraceStep } from "@superhive/protocol";
import {
  ThinkingCard,
  TraceRecap,
  cardAttention,
  groupLiveCards,
  narrativeMarkdownReady,
  narrativeSteps,
  showsCard,
  showsLiveCard,
  sortCards,
  withoutFinalReply,
} from "./thinking-card";

const now = new Date().toISOString();
const invocation = (extra: Partial<Invocation> = {}) =>
  ({
    id: "00000000-0000-4000-8000-0000000000c1",
    roomId: "general",
    messageId: "00000000-0000-4000-8000-0000000000c2",
    agentId: "00000000-0000-4000-8000-0000000000c3",
    agentName: "helper",
    requesterName: "rd",
    requesterType: "human",
    status: "running",
    attempts: 1,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    ...extra,
  }) as Invocation;
const step = (id: string, extra: Partial<TraceStep>): TraceStep => ({
  id,
  kind: "tool",
  startedAt: now,
  ...extra,
});

// Markdown 渲染器是单独加载的 chunk：首次加载（转译 react-markdown、remark 一整套）在机器繁忙时
// 会超过 waitFor 默认的 1 秒。先在钩子里等它加载完，下面的卡片第一次渲染就是 Markdown
beforeAll(() => narrativeMarkdownReady);
afterEach(cleanup);

describe("thinking card", () => {
  it("只把中途说的话和有正文的思考当叙述", () => {
    expect(
      narrativeSteps([
        step("a", { kind: "text", text: "先看看" }),
        step("b", { kind: "thinking" }),
        step("c", { kind: "thinking", text: "Checking" }),
        step("d", { tool: "command", summary: "ls" }),
        step("e", { kind: "text", text: "  " }),
      ]).map((item) => item.id),
    ).toEqual(["a", "c"]);
  });

  it("执行中、停止中、这一轮还没结束的等人回答才有卡片", () => {
    expect(showsLiveCard(invocation())).toBe(true);
    expect(showsLiveCard(invocation({ status: "cancelling" }))).toBe(true);
    expect(showsLiveCard(invocation({ status: "waiting_human" }))).toBe(true);
    expect(showsLiveCard(invocation({ status: "waiting_human", finishedAt: now }))).toBe(false);
    expect(showsLiveCard(invocation({ status: "queued" }))).toBe(false);
    expect(showsLiveCard(invocation({ status: "completed", finishedAt: now }))).toBe(false);
  });

  it("没有执行过程可看时只显示在做、做了多久；能看但第一步还没到时是「启动中」", () => {
    const { rerender } = render(
      <ThinkingCard invocation={invocation()} steps={undefined} avatar="AI" />,
    );
    const card = screen.getByRole("article", { name: "helper 正在处理" });
    expect(within(card).getByText("启动中")).toBeTruthy();
    rerender(
      <ThinkingCard invocation={invocation()} steps={undefined} avatar="AI" traceAllowed={false} />,
    );
    expect(within(card).getByText("看不到具体步骤")).toBeTruthy();
    rerender(
      <ThinkingCard
        invocation={invocation({
          runtime: {
            observability: "heartbeat",
            lastHeartbeatAt: now,
            history: [],
          },
        })}
        steps={undefined}
        avatar="AI"
      />,
    );
    expect(within(card).getByText("看不到具体步骤")).toBeTruthy();
    // 没有过程可看时不给「一行 / 最近 / 全部」的切换
    expect(within(card).queryByRole("group", { name: "显示多少" })).toBeNull();
  });

  it("多出来的卡片只留一行，用户选过以后以用户为准；等你回答时默认一行、不计时", () => {
    const steps = [step("a", { kind: "text", text: "先看看" })];
    const { rerender } = render(
      <ThinkingCard invocation={invocation()} steps={steps} avatar="AI" />,
    );
    expect(screen.getByText("先看看")).toBeTruthy();
    expect(screen.getByRole("button", { name: "最近" }).getAttribute("aria-pressed")).toBe("true");
    rerender(<ThinkingCard invocation={invocation()} steps={steps} avatar="AI" defaultCollapsed />);
    expect(screen.queryByText("先看看")).toBeNull();
    expect(screen.getByRole("article").className).toContain("line");
    fireEvent.click(screen.getByRole("button", { name: "最近" }));
    rerender(<ThinkingCard invocation={invocation()} steps={steps} avatar="AI" defaultCollapsed />);
    expect(screen.getByText("先看看")).toBeTruthy();
    cleanup();
    render(
      <ThinkingCard
        invocation={invocation({ status: "waiting_human" })}
        steps={steps}
        avatar="AI"
      />,
    );
    const card = screen.getByRole("article", { name: "helper 在等你回答" });
    expect(card.className).toContain("attention question");
    expect(within(card).getByText("等你回答")).toBeTruthy();
    expect(within(card).queryByText("先看看")).toBeNull();
    expect(card.querySelector(".thinking-card-elapsed")).toBeNull();
  });

  it("三档：一行状态、最近两段话加步骤汇总、按顺序的完整时间线", () => {
    const steps = [
      step("t1", { kind: "text", text: "第一段" }),
      step("c1", { tool: "command", summary: "pnpm test", status: "ok", endedAt: now }),
      step("t2", { kind: "text", text: "第二段" }),
      step("t3", { kind: "text", text: "第三段" }),
      step("c2", { tool: "command", summary: "git status", status: "running" }),
    ];
    const { container } = render(
      <ThinkingCard invocation={invocation()} steps={steps} avatar="AI" />,
    );
    // 最近：只露最后两段话，步骤收成一行汇总
    expect(screen.queryByText("第一段")).toBeNull();
    expect(screen.getByText("第二段")).toBeTruthy();
    expect(screen.getByText("第三段")).toBeTruthy();
    expect(container.textContent).not.toContain("pnpm test");
    const summary = screen.getByRole("button", { name: /前面还有 1 段话.*看完整时间线/ });
    // 一行：只剩头部，当前在跑的步骤写在头部
    fireEvent.click(screen.getByRole("button", { name: "一行" }));
    expect(screen.queryByText("第三段")).toBeNull();
    expect(container.querySelector(".thinking-card-current")?.textContent).toContain("git status");
    fireEvent.click(screen.getByRole("button", { name: "最近" }));
    fireEvent.click(screen.getByRole("button", { name: /看完整时间线/ }));
    expect(summary.isConnected).toBe(false);
    expect(screen.getByRole("button", { name: "全部" }).getAttribute("aria-pressed")).toBe("true");
    // 全部：说的话和步骤按发生顺序排在一起
    const timeline = container.querySelector(".thinking-card-narrative.full")!;
    const text = timeline.textContent ?? "";
    expect(text.indexOf("第一段")).toBeLessThan(text.indexOf("pnpm test"));
    expect(text.indexOf("pnpm test")).toBeLessThan(text.indexOf("第二段"));
    expect(text.indexOf("第三段")).toBeLessThan(text.indexOf("git status"));
  });

  it("等你回答、等你决定的卡片置顶；等你决定写明原因，点「去处理」跳到失败卡片", () => {
    const running = invocation({ id: "00000000-0000-4000-8000-0000000000e1" });
    const question = invocation({
      id: "00000000-0000-4000-8000-0000000000e2",
      status: "waiting_human",
      startedAt: new Date(Date.now() + 1000).toISOString(),
    });
    const decide = invocation({
      id: "00000000-0000-4000-8000-0000000000e3",
      status: "failed",
      finishedAt: now,
      detail: "上游模型服务出错：overloaded",
    });
    const done = invocation({
      id: "00000000-0000-4000-8000-0000000000e4",
      status: "completed",
      finishedAt: now,
    });
    expect([running, question, decide, done].map(cardAttention)).toEqual([
      undefined,
      "question",
      "decide",
      undefined,
    ]);
    expect([running, question, decide, done].map(showsCard)).toEqual([true, true, true, false]);
    // 忽略过的不再算
    expect(showsCard({ ...decide, resolution: { by: "rd", at: now } } as Invocation)).toBe(false);
    expect(sortCards([running, decide, question]).map((item) => item.id)).toEqual([
      question.id,
      decide.id,
      running.id,
    ]);

    const jumps: number[] = [];
    render(
      <ThinkingCard
        invocation={decide}
        steps={[step("a", { kind: "text", text: "做到一半" })]}
        avatar="AI"
        trigger={{ seq: 42, preview: "修一下登录页" }}
        onJumpToTrigger={() => jumps.push(42)}
      />,
    );
    const card = screen.getByRole("article", { name: "helper 的任务等你决定" });
    expect(card.className).toContain("attention decide");
    expect(within(card).getByText("等你决定")).toBeTruthy();
    expect(within(card).getByText("上游模型服务出错：overloaded")).toBeTruthy();
    expect(within(card).queryByText("做到一半")).toBeNull();
    expect(card.querySelector(".thinking-card-elapsed")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "去处理" }));
    fireEvent.click(within(card).getByRole("button", { name: /^跳到原消息 #42：/ }));
    expect(jumps).toEqual([42, 42]);
  });

  it("执行中的卡片上能停这一轮：一行时也在，停止中点不了，等人处理和没权限时没有", () => {
    const stops: string[] = [];
    const { rerender } = render(
      <ThinkingCard
        invocation={invocation()}
        steps={[step("a", { kind: "text", text: "先看看" })]}
        avatar="AI"
        defaultCollapsed
        onStop={() => stops.push("stop")}
      />,
    );
    const stop = screen.getByRole("button", { name: "停止 @helper 这一轮" });
    expect(stop.textContent).toBe("停止");
    fireEvent.click(stop);
    expect(stops).toEqual(["stop"]);

    rerender(
      <ThinkingCard
        invocation={invocation({ status: "cancelling" })}
        steps={[step("a", { kind: "text", text: "先看看" })]}
        avatar="AI"
        onStop={() => stops.push("stop")}
      />,
    );
    const stopping = screen.getByRole("button", { name: "停止 @helper 这一轮" });
    expect(stopping.textContent).toBe("停止中…");
    expect((stopping as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText("停止中").length).toBeGreaterThan(0);

    rerender(
      <ThinkingCard
        invocation={invocation({ status: "waiting_human" })}
        steps={undefined}
        avatar="AI"
        onStop={() => stops.push("stop")}
      />,
    );
    expect(screen.queryByRole("button", { name: "停止 @helper 这一轮" })).toBeNull();

    rerender(<ThinkingCard invocation={invocation()} steps={undefined} avatar="AI" />);
    expect(screen.queryByRole("button", { name: "停止 @helper 这一轮" })).toBeNull();
    expect(stops).toEqual(["stop"]);
  });

  it("回顾去掉和回复重复的最后一段，并标出没正常完成的结果", () => {
    const steps = [
      step("a", { kind: "text", text: "先看看" }),
      step("b", { tool: "command", summary: "ls", status: "ok", endedAt: now }),
      step("c", { kind: "text", text: "提交好了" }),
    ];
    expect(withoutFinalReply(steps, "提交好了\n\n细节如下").map((item) => item.id)).toEqual([
      "a",
      "b",
    ]);
    expect(withoutFinalReply(steps, "别的内容").map((item) => item.id)).toEqual(["a", "b", "c"]);
    render(
      <TraceRecap
        invocation={invocation({ status: "cancelled", finishedAt: now })}
        steps={steps}
      />,
    );
    expect(screen.getByRole("button", { name: /^helper 的过程/ }).textContent).toContain("已停止");
  });

  it("较早的卡片默认只留一行，点「最近」再看", () => {
    render(
      <ThinkingCard
        invocation={invocation()}
        steps={[step("a", { kind: "text", text: "先看看" })]}
        avatar="AI"
        defaultCollapsed
      />,
    );
    expect(screen.queryByText("先看看")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "最近" }));
    expect(screen.getByText("先看看")).toBeTruthy();
  });

  it("思考和中途的话按 Markdown 渲染：列表、代码块、加粗照常；链接不可点、图片不加载、HTML 不渲染", () => {
    const text = [
      "**先确认**两点：",
      "",
      "- 服务端在哪里停任务",
      "- 前端确认框",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
      "看 [文档](https://evil.example) ![图](https://evil.example/x.png) <img src=x onerror=alert(1)>",
    ].join("\n");
    const { container } = render(
      <ThinkingCard
        invocation={invocation()}
        steps={[
          step("th", { kind: "thinking", text }),
          step("x", { kind: "text", text: "接着写一半的代码：\n\n```ts\nconst b" }),
        ]}
        avatar="AI"
      />,
    );
    expect(container.querySelector(".thinking-card-md strong")?.textContent).toBe("先确认");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("pre code")?.textContent).toContain("const a = 1;");
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".md-inert-link")?.textContent).toBe("文档");
    expect(container.querySelector(".md-inert-image")?.textContent).toBe("[图]");
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    // 思考段带标记（更淡、左侧细线），没闭合的代码块照样按代码显示
    expect(container.querySelector(".thinking-card-line.thinking")).toBeTruthy();
    expect(container.querySelectorAll("pre code")[1]?.textContent).toContain("const b");
  });

  it("回顾收起时露出最后一段话的开头，点一下展开", () => {
    render(
      <TraceRecap
        invocation={invocation({ status: "completed", finishedAt: now })}
        steps={[step("a", { kind: "text", text: "改好了 **两处**" })]}
      />,
    );
    const preview = screen.getByRole("button", { name: "展开 helper 的过程" });
    expect(preview.querySelector("strong")?.textContent).toBe("两处");
    fireEvent.click(preview);
    expect(screen.queryByRole("button", { name: "展开 helper 的过程" })).toBeNull();
    expect(
      screen.getByRole("button", { name: /^helper 的过程/ }).getAttribute("aria-expanded"),
    ).toBe("true");
  });
});

describe("groupLiveCards", () => {
  it("merges the messages one agent handles in the same turn into one card", () => {
    const a = invocation({ id: "00000000-0000-4000-8000-0000000000d1" });
    const b = invocation({ id: "00000000-0000-4000-8000-0000000000d2" });
    const other = invocation({
      id: "00000000-0000-4000-8000-0000000000d3",
      agentId: "00000000-0000-4000-8000-0000000000d9",
    });
    const waiting = invocation({
      id: "00000000-0000-4000-8000-0000000000d4",
      status: "waiting_human",
    });
    const cards = groupLiveCards([a, b, other, waiting]);
    expect(cards.map((card) => card.batch.map((item) => item.id))).toEqual([
      [a.id, b.id],
      [other.id],
      [waiting.id],
    ]);
  });

  it("names the messages a merged turn is handling", () => {
    render(
      <ThinkingCard
        invocation={invocation()}
        steps={[]}
        avatar={null}
        batchSeqs={[1825, 1828, 1830]}
      />,
    );
    expect(screen.getByText("一起处理 #1825、#1828、#1830")).toBeTruthy();
  });

  it("写明在处理哪条消息，点了跳过去；只留一行时缩成序号，照样能跳", () => {
    const jumps: number[] = [];
    render(
      <ThinkingCard
        invocation={invocation()}
        steps={[step("a", { kind: "text", text: "先看看" })]}
        avatar="AI"
        defaultCollapsed
        trigger={{ seq: 1899, preview: "为什么不能每 5 分钟定时一次" }}
        onJumpToTrigger={() => jumps.push(1899)}
      />,
    );
    const chip = screen.getByRole("button", {
      name: "跳到原消息 #1899：为什么不能每 5 分钟定时一次",
      description: "回应 #1899：为什么不能每 5 分钟定时一次",
    });
    fireEvent.click(chip);
    expect(screen.queryByText("先看看")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "最近" }));
    fireEvent.click(
      screen.getByRole("button", { name: /回应 #1899.*为什么不能每 5 分钟定时一次/ }),
    );
    expect(jumps).toEqual([1899, 1899]);
    expect(screen.getByText("先看看")).toBeTruthy();
  });
});

import { type Invocation, type InvocationState, type TraceStep } from "@superhive/protocol";
import { t } from "./i18n";

const toolLabels: Record<string, string> = {
  read: "读文件",
  write: "改文件",
  search: "搜索",
  command: "跑命令",
  collaboration: "协作工具",
  other: "调用工具",
};
const phaseLabels: Record<string, string> = {
  starting: "启动中",
  working: "处理中",
  thinking: "思考中",
  tool_running: "工具执行中",
  tool_completed: "工具刚结束",
};

function duration(value: number): string {
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return t("{0} 秒", { 0: seconds });
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? t("{0} 分钟", { 0: minutes })
    : t("{0} 小时 {1} 分钟", { 0: Math.floor(minutes / 60), 1: minutes % 60 });
}

/** 最后一步：优先用执行过程里的摘要（命令、文件），没有时用 Runtime 上报的工具和阶段 */
export function lastStepText(
  invocation: Invocation,
  steps?: readonly TraceStep[],
): string | undefined {
  const step = steps?.at(-1);
  if (step) {
    if (step.kind === "tool") {
      const name =
        step.name ?? (step.tool ? t(toolLabels[step.tool] ?? "调用工具") : t("调用工具"));
      return step.summary ? `${name} ${step.summary}` : name;
    }
    if (step.kind === "thinking") return t("思考中");
    if (step.text) return step.text.length > 60 ? `${step.text.slice(0, 60)}…` : step.text;
  }
  const runtime = invocation.runtime;
  const parts = [
    runtime?.tool ? t(toolLabels[runtime.tool] ?? "调用工具") : undefined,
    runtime?.phase ? t(phaseLabels[runtime.phase] ?? "处理中") : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

/**
 * 调用详情里「为什么是这个状态」的一句话；tone=warning 表示需要人留意（离线、迟迟没开始、长时间没进展）。
 * 已结束的调用不解释（状态本身就是结论），返回 undefined。
 */
export function stateExplanation(
  state: InvocationState,
  invocation: Invocation,
  steps?: readonly TraceStep[],
): { text: string; tone: "info" | "warning" } | undefined {
  const agent = `@${invocation.agentName}`;
  const step = lastStepText(invocation, steps);
  const lastStep = step ? t("，最后一步是「{0}」", { 0: step }) : "";
  switch (state.code) {
    case "queued_offline":
      return {
        tone: "warning",
        text: t("{0} 离线，消息留在服务端，等它上线后才会开始（已等 {1}）。", {
          0: agent,
          1: duration(state.waitedMs),
        }),
      };
    case "queued_behind": {
      const current = state.current
        ? t("，它正在做 {0} 派的任务", { 0: state.current.requesterName })
        : "";
      return {
        tone: state.stalled ? "warning" : "info",
        text: t("{0} 手上还有 {1} 个任务排在前面{2}；轮到后自动开始（已等 {3}）。", {
          0: agent,
          1: state.ahead,
          2: current,
          3: duration(state.waitedMs),
        }),
      };
    }
    case "queued_undelivered":
      return state.stalled
        ? {
            tone: "warning",
            text: t("已派出 {0}，{1} 在线但还没确认收到，可能连接异常。", {
              0: duration(state.waitedMs),
              1: agent,
            }),
          }
        : { tone: "info", text: t("已派出，等 {0} 确认收到。", { 0: agent }) };
    case "queued_received":
      return state.stalled
        ? {
            tone: "warning",
            text: t("{0} 已收到，但 {1} 了还没开始。", { 0: agent, 1: duration(state.waitedMs) }),
          }
        : { tone: "info", text: t("{0} 已收到，马上开始。", { 0: agent }) };
    case "running_active":
      return {
        tone: "info",
        text: t("正在执行：最近一次进展在 {0} 前{1}。", {
          0: duration(state.quietMs),
          1: lastStep,
        }),
      };
    case "running_quiet":
      return {
        tone: "warning",
        text: t(
          "已经 {0}没有新的执行事件{1}；可能在跑耗时的命令，也可能卡住了，不会自动停止或重试。",
          {
            0: duration(state.quietMs),
            1: lastStep,
          },
        ),
      };
    case "running_heartbeat":
      return {
        tone: "info",
        text: t("这种 Runtime 不上报执行过程，只能确认 Bridge {0} 前还在。", {
          0: duration(state.quietMs),
        }),
      };
    case "running_offline":
      return {
        tone: "warning",
        text: t("{0} 执行到一半断线了；重连后会继续上报，没重连回来会按结果未知处理。", {
          0: agent,
        }),
      };
    case "waiting_human":
      return {
        tone: "info",
        text: t("{0} 提了问题，在等人回答；回答后它会接着做。", { 0: agent }),
      };
    case "blocked":
      return {
        tone: "warning",
        text:
          state.reason === "guest_approval"
            ? t("访客发起的任务，在等房主批准。")
            : state.reason === "ping_pong"
              ? t("两个 Agent 没人插话地互相 @ 来回太多轮，像在绕圈子，需要人点「继续」才会执行。")
              : t("Agent 之间连续对话超过预算被拦下，需要人点「继续」才会执行。"),
      };
    case "cancelling":
      return {
        tone: state.waitedMs >= 30_000 ? "warning" : "info",
        text: t("已请求停止 {0}，等 {1} 确认真的停下。", {
          0: duration(state.waitedMs),
          1: agent,
        }),
      };
    default:
      return undefined;
  }
}

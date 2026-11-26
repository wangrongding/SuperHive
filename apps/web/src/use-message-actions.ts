import { useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { ChatMessage, Invocation, WhiteboardEntry } from "@superhive/protocol";
import { createClientMessageId } from "./client-id";
import { BUDGET_EXTEND_TURNS } from "./invocations";
import { copyTextToClipboard } from "./clipboard";
import { t } from "./i18n";

/**
 * 对话里的操作：回答提问、复制、撤回、重试 / 停止 / 引导任务、继续 Agent 对话、开新话题等，
 * 大多经当前房间的 WebSocket 发出
 */
export function useMessageActions({
  socketRef,
  setError,
  authToken,
  base,
  username,
}: {
  socketRef: RefObject<WebSocket | undefined>;
  setError: Dispatch<SetStateAction<string | undefined>>;
  authToken: string | undefined;
  base: string;
  username: string;
}) {
  // 已点选提交、等服务端确认的提问 ID → 幂等键（重发沿用同一个键，只续接一次）
  const [pendingAnswers, setPendingAnswers] = useState<ReadonlyMap<string, string>>(new Map());
  const [copiedMessageId, setCopiedMessageId] = useState<string>();
  const [recallCandidateId, setRecallCandidateId] = useState<string>();

  function submitChoice(question: ChatMessage, selected: string[], other?: string) {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN || pendingAnswers.has(question.id)) return;
    const clientMessageId = createClientMessageId();
    setPendingAnswers((current) => new Map(current).set(question.id, clientMessageId));
    socket.send(
      JSON.stringify({
        type: "question.answer",
        clientMessageId,
        questionMessageId: question.id,
        selected,
        ...(other ? { other } : {}),
      }),
    );
  }

  async function copyMessageContent(message: ChatMessage) {
    try {
      await copyTextToClipboard(message.content);
      setCopiedMessageId(message.id);
      window.setTimeout(
        () => setCopiedMessageId((current) => (current === message.id ? undefined : current)),
        1500,
      );
    } catch {
      setError(t("浏览器未允许自动复制，请选中消息文本后手动复制。"));
    }
  }

  async function copySeqReference(message: ChatMessage) {
    const key = `seq:${message.id}`;
    try {
      await copyTextToClipboard(`#${message.seq}`);
      setCopiedMessageId(key);
      window.setTimeout(
        () => setCopiedMessageId((current) => (current === key ? undefined : current)),
        1500,
      );
    } catch {
      setError(t("浏览器未允许自动复制，请手动输入序号。"));
    }
  }

  /** 右键菜单里的复制（选中内容、代码、链接、消息链接）：复制失败时提示手动复制 */
  async function copyPlainText(text: string) {
    try {
      await copyTextToClipboard(text);
    } catch {
      setError(t("浏览器未允许自动复制，请选中文本后手动复制。"));
    }
  }

  /** stop：一起停掉这条消息派出、还没结束的任务（服务端处理，只停直接派出的，不连带下游） */
  function recallMessage(messageId: string, stop = false) {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) {
      setError(t("当前未连接到 Hive Server，无法撤回。"));
      return;
    }
    socket.send(JSON.stringify({ type: "message.delete", messageId, ...(stop ? { stop } : {}) }));
    setRecallCandidateId(undefined);
  }

  function sendClientEvent(payload: Record<string, unknown>, failure: string): void {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) {
      setError(t("当前未连接到 Hive Server，{0}", { 0: failure }));
      return;
    }
    socket.send(JSON.stringify(payload));
  }

  function retryInvocation(invocation: Invocation, model?: string, effort?: string) {
    sendClientEvent(
      {
        type: "invocation.retry",
        invocationId: invocation.id,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      },
      t("无法重试。"),
    );
  }

  // 走 HTTP：「Agent 任务」面板里的调用可能属于其它房间，WebSocket 只作用于当前房间
  function dismissInvocations(list: Invocation[]) {
    if (!authToken || list.length === 0) return;
    void fetch(`${base}/api/invocations/dismiss`, {
      method: "POST",
      headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ invocationIds: list.map((item) => item.id), by: username }),
    })
      .then((response) => {
        if (!response.ok) throw new Error(`(${response.status})`);
      })
      .catch((reason: unknown) =>
        setError(
          t("无法忽略：{0}", { 0: reason instanceof Error ? reason.message : String(reason) }),
        ),
      );
  }

  function cancelInvocation(invocation: Invocation) {
    sendClientEvent({ type: "invocation.cancel", invocationId: invocation.id }, t("无法停止。"));
  }

  function steerInvocation(invocation: Invocation) {
    sendClientEvent({ type: "invocation.steer", invocationId: invocation.id }, t("无法插入。"));
  }

  function preemptInvocation(invocation: Invocation) {
    const confirmed = window.confirm(
      t(
        "停下 @{0} 正在执行的任务，改做这条？\n\n正在执行的那一轮会被中断，结果可能是「已停止」或「结果未知」，做到一半的改动不会自动撤回、也不会自动重跑。",
        { 0: invocation.agentName },
      ),
    );
    if (!confirmed) return;
    sendClientEvent({ type: "invocation.preempt", invocationId: invocation.id }, t("无法停下。"));
  }

  function extendAgentBudget() {
    sendClientEvent(
      { type: "budget.extend", turns: BUDGET_EXTEND_TURNS },
      t("无法继续 Agent 对话。"),
    );
  }

  function removeWhiteboardEntry(entry: WhiteboardEntry) {
    if (!window.confirm(t("永久删除这条历史事项？此操作无法恢复。"))) return;
    sendClientEvent(
      { type: "whiteboard.remove", entryId: entry.id, updatedAt: entry.updatedAt },
      t("无法移除白板条目。"),
    );
  }

  function startNewTopic() {
    sendClientEvent({ type: "topic.start" }, t("无法开启新话题。"));
  }

  return {
    pendingAnswers,
    setPendingAnswers,
    copiedMessageId,
    recallCandidateId,
    setRecallCandidateId,
    submitChoice,
    copyMessageContent,
    copySeqReference,
    copyPlainText,
    recallMessage,
    retryInvocation,
    dismissInvocations,
    cancelInvocation,
    steerInvocation,
    preemptInvocation,
    extendAgentBudget,
    removeWhiteboardEntry,
    startNewTopic,
  };
}

export type MessageActions = ReturnType<typeof useMessageActions>;

import type { ChatMessage } from "@ai-hive/protocol";
import { t } from "./i18n";

export function formatShareTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function buildShareMarkdown(messages: ChatMessage[], roomName: string): string {
  const sorted = [...messages].sort((a, b) => a.seq - b.seq);
  const lines: string[] = [
    t("# AI Hive · #{0} 对话分享", { 0: roomName }),
    "",
    t("> 共 {0} 条消息 · 导出于 {1}", {
      0: sorted.length,
      1: formatShareTimestamp(new Date().toISOString()),
    }),
  ];
  for (const message of sorted) {
    const badge = message.senderType === "agent" ? " `AGENT`" : "";
    lines.push(
      "",
      "---",
      "",
      `**${message.senderName}**${badge} · ${formatShareTimestamp(message.createdAt)} · #${message.seq}`,
      "",
      message.content,
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function shareFilename(roomId: string, extension: string): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `ai-hive-${roomId}-${stamp}.${extension}`;
}

export function downloadFile(filename: string, content: Blob | string): void {
  const blob = typeof content === "string" ? new Blob([content], { type: "text/plain" }) : content;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

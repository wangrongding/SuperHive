import { AgentNonRetryableError } from "./responder.js";

/** Only allowlisted diagnostics enter room-visible errors; never arbitrary stderr/credentials. */
export function codexStartupFailure(
  stage: string,
  error: unknown,
  stderr = "",
): AgentNonRetryableError {
  if (error instanceof AgentNonRetryableError) return error;
  const code = (error as { code?: unknown } | undefined)?.code;
  const text = `${error instanceof Error ? error.message : ""}\n${stderr}`;
  const reason =
    code === "ENOENT"
      ? "找不到 Codex 命令，请检查安装与 PATH"
      : error instanceof Error && error.name === "CodexRequestTimeoutError"
        ? "握手或会话准备超时；超时不代表不支持该协议"
        : /stdin is not a terminal|not a TTY|interactive TUI|TERM.*dumb/i.test(text)
          ? "CLI 进入了交互终端模式，无法通过 stdio 握手；请使用支持 app-server 的 Codex CLI"
          : /error loading configuration|invalid configuration|unknown variant/i.test(text)
            ? "Codex 配置不兼容，请检查 CLI 配置"
            : typeof code === "number"
              ? `协议请求失败（错误码 ${code}）`
              : "连接关闭或启动失败，请检查 CLI 与本机日志";
  return new AgentNonRetryableError(
    `Codex ${stage}：${reason}。未发送执行请求；不会自动降级或重试。`,
    error instanceof Error ? { cause: error } : undefined,
  );
}

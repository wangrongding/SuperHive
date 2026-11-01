import { AcpResponder, type AcpResponderDependencies } from "./acp-responder.js";
import type { HiveMcpConnection } from "./hive-mcp-config.js";
import type { AgentAccessMode } from "./responder.js";

/**
 * omp 在 ACP 下只为 bash 与删除/移动类编辑发起权限请求，write 与普通 edit 不经审批，
 * 因此档位主要靠 --tools 白名单实现：
 * - read-only：只给读取类工具；omp 会自动保留一个仅能调用 xd:// MCP 设备、写会话草稿的 write，
 *   无法写磁盘（已对 18.12 实测）
 * - workspace：加上 edit / write / bash；写入不限于 cwd，与 full 的区别只在工具范围
 * - full：不限制工具
 * ACP 模式下 omp 不读取 ~/.omp 等处的 MCP 配置，MCP 只有随会话注入的 Hive。
 */
export function ompToolArgs(access: AgentAccessMode): string[] {
  if (access === "full") return [];
  if (access === "workspace") return ["--tools", "read,grep,glob,edit,write,bash"];
  return ["--tools", "read,grep,glob"];
}

export function createOmpResponder(
  options: {
    command: string;
    cwd: string;
    hive: HiveMcpConnection;
    access?: AgentAccessMode;
    /** omp 的模型选择，如 zhipu-coding-plan/glm-5.3 或模糊匹配的 "glm" */
    model?: string;
    log?: (message: string) => void;
  },
  dependencies?: AcpResponderDependencies,
): AcpResponder {
  const access = options.access ?? "read-only";
  return new AcpResponder(
    {
      label: "omp",
      command: options.command,
      args: [
        "--mode",
        "acp",
        "--cwd",
        options.cwd,
        // 会话标题需要额外一次模型调用，房间里用不到
        "--no-title",
        ...ompToolArgs(access),
        ...(options.model ? ["--model", options.model] : []),
      ],
      cwd: options.cwd,
      hive: options.hive,
      access,
      ...(options.log ? { log: options.log } : {}),
    },
    dependencies,
  );
}

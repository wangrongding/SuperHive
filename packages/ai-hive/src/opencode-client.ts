import { AcpResponder, type AcpResponderDependencies } from "./acp-responder.js";
import type { HiveMcpConnection } from "./hive-mcp-config.js";
import type { AgentAccessMode } from "./responder.js";

type PermissionAction = "allow" | "deny";

/**
 * opencode 的权限基线：被 deny 的工具会直接从工具集里移除，模型根本看不到；
 * 剩下需要询问的操作经 ACP session/request_permission 交给 AcpResponder 按档位裁决。
 * external_directory 管所有文件工具能否触及 cwd 以外的路径。
 */
export function openCodePermission(
  access: AgentAccessMode,
): PermissionAction | Record<string, PermissionAction> {
  if (access === "full") return "allow";
  if (access === "workspace") {
    return {
      edit: "allow",
      bash: "allow",
      webfetch: "allow",
      websearch: "allow",
      external_directory: "deny",
      // 无人值守时反复执行同一调用多半是死循环，直接终止
      doom_loop: "deny",
    };
  }
  return {
    edit: "deny",
    bash: "deny",
    webfetch: "deny",
    websearch: "deny",
    task: "deny",
    external_directory: "deny",
    doom_loop: "deny",
  };
}

/**
 * 通过 OPENCODE_CONFIG_CONTENT 注入的配置，会叠加在用户与项目的 opencode 配置之上，
 * 仅作用于这一个 Agent 进程；模型与 provider 仍沿用用户自己的配置。
 */
export function openCodeConfigContent(
  access: AgentAccessMode,
  model?: string,
  inherited?: string,
): string {
  let base: Record<string, unknown> = {};
  if (inherited) {
    try {
      const parsed: unknown = JSON.parse(inherited);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      // 环境里已有的内容不是合法 JSON 时不再继承，避免整段配置失效
    }
  }
  return JSON.stringify({
    ...base,
    permission: openCodePermission(access),
    ...(model ? { model } : {}),
  });
}

export function createOpenCodeResponder(
  options: {
    command: string;
    cwd: string;
    hive: HiveMcpConnection;
    access?: AgentAccessMode;
    /** provider/model，如 zhipu-coding/glm-5.3 */
    model?: string;
    log?: (message: string) => void;
  },
  dependencies?: AcpResponderDependencies,
): AcpResponder {
  const access = options.access ?? "read-only";
  return new AcpResponder(
    {
      label: "OpenCode",
      command: options.command,
      args: ["acp", "--cwd", options.cwd],
      env: {
        OPENCODE_CONFIG_CONTENT: openCodeConfigContent(
          access,
          options.model,
          process.env.OPENCODE_CONFIG_CONTENT,
        ),
      },
      cwd: options.cwd,
      hive: options.hive,
      access,
      ...(options.log ? { log: options.log } : {}),
    },
    dependencies,
  );
}

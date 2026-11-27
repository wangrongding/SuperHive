import type { McpHealth, RuntimeOverview } from "@superhive/protocol";

/**
 * MCP「能不能用」的共用部分：安装抽屉、「已安装」表和状态栏角标都用。
 * 只有出了问题才显示；正常的不标。
 */
/** 测出来的问题怎么叫：一个词的状态 + 一句该怎么办 */
export const MCP_PROBLEM_LABELS: Record<
  Exclude<McpHealth, { ok: true }>["problem"],
  { label: string; hint: string }
> = {
  auth: {
    label: "需要登录",
    hint: "检查密钥填得对不对、有没有过期；要在浏览器里登录的服务，先在 CLI 里登录一次。",
  },
  unreachable: { label: "连不上", hint: "检查网址和网络，用了代理的看看代理设置。" },
  failed: { label: "起不来", hint: "看看它需要的软件装好没有，再测一次。" },
};

/** 状态前的小标记：对勾 / 感叹号，不只靠颜色区分 */
export function McpHealthMark({ ok }: { ok: boolean }) {
  return (
    <svg
      className={`runtime-check-mark ${ok ? "ok" : "problem"}`}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="7" />
      {ok ? <path d="m5 8.2 2 2 4-4.4" /> : <path d="M8 4.5v4.2M8 11.2v.3" />}
    </svg>
  );
}

/** 有问题的 MCP（测过、配置没变、没通过）；状态栏角标数的就是这些 */
export function mcpProblems(overview: RuntimeOverview | undefined) {
  return (overview?.mcp ?? []).filter(
    (row): row is typeof row & { health: Exclude<McpHealth, { ok: true }> } =>
      row.health !== undefined && !row.health.ok,
  );
}

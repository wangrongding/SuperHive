import { useRef, useState } from "react";
import {
  CLAUDE_COMPACT_WINDOW_DEFAULT,
  CLAUDE_COMPACT_WINDOW_MAX,
  CLAUDE_COMPACT_WINDOW_MIN,
  CLAUDE_COMPACT_WINDOW_PRESETS,
  type ClaudeCacheTtl,
  type ClaudeCompactWindow,
  type LocalAgent,
} from "@superhive/protocol";
import { getLocale, t } from "./i18n";
import { Select, type SelectOption } from "./select";
import { SaveStatus, useAutoSave } from "./auto-save";

/** 20 万 token / 200k tokens：按界面语言写 token 数 */
export function compactWindowLabel(tokens: number): string {
  return getLocale() === "en"
    ? `${(tokens / 1000).toLocaleString("en")}k tokens`
    : `${(tokens / 10_000).toLocaleString("zh-CN")} 万 token`;
}

const CUSTOM = "custom";

/** 压缩阈值在选择框里的值：档位直接用数字，"auto" 照旧，别的数字算自定义 */
function windowChoice(value: ClaudeCompactWindow): string {
  if (value === "auto") return "auto";
  return (CLAUDE_COMPACT_WINDOW_PRESETS as readonly number[]).includes(value)
    ? String(value)
    : CUSTOM;
}

/**
 * Claude Agent 的上下文设置：自动压缩阈值（默认 40 万 token）和缓存时长（默认跟随 Claude Code）。
 * 写进设置文件，下一轮生效；改了以后常驻的 Claude 进程会换新进程。
 * 选了就存；自定义阈值在按回车或离开输入框时存。
 */
export function ClaudeContextSettings({
  agent,
  lead = false,
  disabled,
  onSave,
}: {
  agent: Pick<LocalAgent, "compactWindow" | "cacheTtl">;
  /** 它是当前房间的主 Agent：跟随 Claude Code 时 Bridge 实际按 1 小时发 */
  lead?: boolean;
  disabled: boolean;
  /** 只带改了的那一项 */
  onSave: (settings: {
    compactWindow?: ClaudeCompactWindow | null;
    cacheTtl?: ClaudeCacheTtl | null;
  }) => Promise<Pick<LocalAgent, "compactWindow" | "cacheTtl">>;
}) {
  const initialWindow = agent.compactWindow ?? CLAUDE_COMPACT_WINDOW_DEFAULT;
  // 服务端已确认的值；排队中的保存拿它比较，决定发不发、发哪一项
  const confirmed = useRef({ window: initialWindow, ttl: agent.cacheTtl ?? "" });
  const [choice, setChoice] = useState(windowChoice(initialWindow));
  const [custom, setCustom] = useState(
    typeof initialWindow === "number" ? String(initialWindow) : "",
  );
  const [ttl, setTtl] = useState<string>(agent.cacheTtl ?? "");
  const { state, save } = useAutoSave((ok) => {
    // 成功时界面就是人最后选的；自定义框里正填着的数字也别动
    if (ok) return;
    const { window: savedWindow, ttl: savedTtl } = confirmed.current;
    setTtl(savedTtl);
    setChoice(windowChoice(savedWindow));
    if (typeof savedWindow === "number") setCustom(String(savedWindow));
  });

  function parseCustom(text: string): number | undefined {
    const tokens = Number(text.trim());
    return Number.isInteger(tokens) &&
      tokens >= CLAUDE_COMPACT_WINDOW_MIN &&
      tokens <= CLAUDE_COMPACT_WINDOW_MAX
      ? tokens
      : undefined;
  }
  const customValid = parseCustom(custom) !== undefined;

  /** 存这一组值：阈值是 undefined（自定义还没填对）时只存缓存时长 */
  function commit(window: ClaudeCompactWindow | undefined, nextTtl: string) {
    if (disabled) return;
    save(async () => {
      const current = confirmed.current;
      const patch: {
        compactWindow?: ClaudeCompactWindow | null;
        cacheTtl?: ClaudeCacheTtl | null;
      } = {};
      // 默认值存成「没设过」：以后默认值改了，没动过的 Agent 跟着变
      if (window !== undefined && window !== current.window)
        patch.compactWindow = window === CLAUDE_COMPACT_WINDOW_DEFAULT ? null : window;
      if (nextTtl !== current.ttl)
        patch.cacheTtl = nextTtl === "5m" || nextTtl === "1h" ? nextTtl : null;
      if (Object.keys(patch).length === 0) return false;
      const updated = await onSave(patch);
      confirmed.current = {
        window: updated.compactWindow ?? CLAUDE_COMPACT_WINDOW_DEFAULT,
        ttl: updated.cacheTtl ?? "",
      };
    });
  }

  const windowOptions: SelectOption[] = [
    ...CLAUDE_COMPACT_WINDOW_PRESETS.map((tokens) => ({
      value: String(tokens),
      label:
        tokens === CLAUDE_COMPACT_WINDOW_DEFAULT
          ? t("{0}（默认）", { 0: compactWindowLabel(tokens) })
          : compactWindowLabel(tokens),
    })),
    { value: CUSTOM, label: t("自定义…") },
    {
      value: "auto",
      label: t("不限制，交给 Claude Code"),
      description: t("接近模型上下文上限才压缩；会话可能长到几十万 token，越来越慢、越来越贵"),
    },
  ];
  const ttlOptions: SelectOption[] = [
    {
      value: "",
      label: t("跟随 Claude Code（默认）"),
      description: t(
        "主 Agent 默认 1 小时；其它由 Claude Code 自动选：订阅额度内一般 1 小时，超出额度或用 API key 时 5 分钟",
      ),
    },
    { value: "5m", label: t("5 分钟") },
    { value: "1h", label: t("1 小时"), description: t("写缓存更贵") },
  ];

  return (
    <section className="agent-model agent-context" aria-labelledby="agent-context-title">
      <h3 id="agent-context-title">{t("上下文与缓存")}</h3>
      <div className="agent-settings-fields">
        <div className="agent-settings-field">
          <h4>{t("自动压缩")}</h4>
          <Select
            aria-label={t("自动压缩")}
            value={choice}
            options={windowOptions}
            disabled={disabled}
            onChange={(next) => {
              setChoice(next);
              // 选「自定义…」先等人填数字，填好了（回车或离开输入框）再存
              if (next === CUSTOM) return;
              commit(next === "auto" ? "auto" : Number(next), ttl);
            }}
          />
          {choice === CUSTOM && (
            <label className="agent-context-custom">
              <input
                className="model-picker-input"
                type="number"
                inputMode="numeric"
                min={CLAUDE_COMPACT_WINDOW_MIN}
                max={CLAUDE_COMPACT_WINDOW_MAX}
                step={10_000}
                value={custom}
                disabled={disabled}
                aria-label={t("自定义压缩阈值（token）")}
                aria-invalid={!customValid}
                onChange={(event) => setCustom(event.target.value)}
                onBlur={() => {
                  const tokens = parseCustom(custom);
                  if (tokens !== undefined) commit(tokens, ttl);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  const tokens = parseCustom(custom);
                  if (tokens !== undefined) commit(tokens, ttl);
                }}
              />
              <span>token</span>
            </label>
          )}
          <p
            className={
              choice === CUSTOM && !customValid ? "agent-mcp-hint warning" : "agent-mcp-hint"
            }
          >
            {choice === CUSTOM && !customValid
              ? t("填 {0}～{1} 之间的整数。", {
                  0: CLAUDE_COMPACT_WINDOW_MIN.toLocaleString(),
                  1: CLAUDE_COMPACT_WINDOW_MAX.toLocaleString(),
                })
              : t(
                  "对话超过这个大小时，Claude 会把前面的内容压成摘要：每轮的速度和费用更稳定，但很早以前的细节只剩摘要。所选模型的上下文比这个小时，按模型上限，接近上限时压缩。",
                )}
          </p>
        </div>
        <div className="agent-settings-field">
          <h4>{t("缓存时长")}</h4>
          <Select
            aria-label={t("缓存时长")}
            value={ttl}
            options={ttlOptions}
            disabled={disabled}
            onChange={(next) => {
              setTtl(next);
              // 自定义阈值还没填对：这次只存缓存时长
              commit(choice === CUSTOM ? parseCustom(custom) : undefined, next);
            }}
          />
          {ttl === "" && lead && (
            <p className="agent-mcp-hint" role="note">
              {t(
                "它是本房间的主 Agent，两轮之间常隔 5 分钟以上（等子任务回执、等人回复），所以默认按 1 小时缓存，进程也常驻 55 分钟。不再是主 Agent 后，下一轮起交回 Claude Code 自己选。",
              )}
            </p>
          )}
          {ttl === "1h" && (
            <p className="agent-mcp-hint warning" role="note">
              {t(
                "写缓存的费用从输入单价的 1.25 倍变成 2 倍。两轮之间常隔 5 分钟以上时通常更省、更快；偶尔才聊一句的房间反而更贵。",
              )}
            </p>
          )}
        </div>
      </div>
      <SaveStatus
        state={state}
        hint={t("选了就保存，从下一次回复开始生效，不用重启。")}
        savedHint={t("从下一次回复开始生效，不用重启。")}
      />
    </section>
  );
}

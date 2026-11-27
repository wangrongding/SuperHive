import { useCallback, useEffect, useState } from "react";
import { sortReasoningEfforts, type LocalAgentModelsResponse } from "@superhive/protocol";
import { t } from "./i18n";
import { Select, type SelectOption } from "./select";
import { Button, IconButton } from "./button";

const CUSTOM = "\u0000custom";

/**
 * 选模型：列表从运行时拉（Server 的 /models），拉不到或列表里没有的可以手填。
 * value 为空串表示用运行时自己的默认模型（allowDefault 时才有这一项）。
 * 完全受控：选列表里的、手填时每次输入都通过 onChange 交出去，什么时候保存由外面决定。
 */
export function ModelPicker({
  data,
  value,
  onChange,
  onRefresh,
  onCommit,
  allowDefault = false,
  disabled = false,
  id,
  "aria-label": ariaLabel,
}: {
  data: LocalAgentModelsResponse | undefined;
  value: string;
  onChange: (value: string) => void;
  /** 选定了一个模型：从列表里选中时，或手填的模型名按回车、离开输入框时调用，由外面决定存不存 */
  onCommit?: (value: string) => void;
  /** 让 Server 重新拉一次列表 */
  onRefresh?: () => void;
  allowDefault?: boolean;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
}) {
  const models = data?.models ?? [];
  const listed = value === "" || models.some((model) => model.id === value);
  // 人点了「手动输入」；列表到了以后当前值不在列表里也按手填显示
  const [custom, setCustom] = useState(false);
  const runtimeDefault = models.find((model) => model.isDefault);
  const options: SelectOption[] = [
    ...(allowDefault
      ? [
          {
            value: "",
            label: t("运行时默认"),
            description: runtimeDefault
              ? t("现在是 {0}", { 0: runtimeDefault.label ?? runtimeDefault.id })
              : t("用这个 Agent CLI 自己配置的模型"),
          },
        ]
      : []),
    ...models.map((model) => ({
      value: model.id,
      label: model.label ?? model.id,
      ...(model.label ? { description: model.id } : {}),
    })),
    { value: CUSTOM, label: t("手动输入…"), description: t("列表里没有的模型名") },
  ];
  // 没有可选的（拉不到、不是本机 Agent）又不能选默认：直接给手填框
  const editing =
    custom ||
    (data !== undefined && !listed) ||
    (data !== undefined && models.length === 0 && !allowDefault);

  return (
    <div className="model-picker">
      <div className="model-picker-row">
        <Select
          {...(id ? { id } : {})}
          {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
          value={editing ? CUSTOM : value}
          options={options}
          disabled={disabled || !data}
          placeholder={data ? t("选择模型") : t("正在读取模型列表…")}
          onChange={(next) => {
            if (next === CUSTOM) {
              setCustom(true);
              return;
            }
            setCustom(false);
            onChange(next);
            onCommit?.(next);
          }}
        />
        {onRefresh && (
          <Button disabled={disabled || !data} onClick={onRefresh}>
            {t("刷新")}
          </Button>
        )}
      </div>
      {editing && (
        <input
          className="model-picker-input"
          type="text"
          value={value}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          placeholder={t("模型名，例如 {0}", { 0: models[0]?.id ?? "gpt-5" })}
          aria-label={t("模型名")}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => onCommit?.(value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onCommit?.(value);
            }
          }}
        />
      )}
      {data && <ModelListHint data={data} />}
    </div>
  );
}

/** 列表从哪来：拉取失败的原因，或者为什么只有常用选项；从运行时拉到的完整列表不提示 */
function ModelListHint({ data }: { data: LocalAgentModelsResponse }) {
  let text: string | undefined;
  if (data.error)
    text =
      data.models.length > 0
        ? t("没能拉到完整的模型列表（{0}），下面是常用选项，也可以手动输入。", { 0: data.error })
        : t("没能从运行时拉到模型列表（{0}），可以手动输入。", { 0: data.error });
  else if (data.presetReason === "oauth")
    text = t("Claude 用账号登录、没有 API key，拉不到完整列表，下面是常用选项，也可以手动输入。");
  else if (data.presetReason === "cloud")
    text = t(
      "Claude 走 Bedrock / Vertex 等云平台，拉不到完整列表，下面是常用选项，也可以手动输入。",
    );
  else if (data.source === "preset")
    text = t("这个运行时没有列模型的命令，下面是常用选项，也可以手动输入。");
  return text ? <p className="agent-mcp-hint">{text}</p> : null;
}

/** 档位的显示名；运行时报出不认识的档位就原样显示 */
export function effortLabel(effort: string): string {
  const names: Record<string, string> = {
    off: t("关闭思考"),
    none: t("不思考"),
    minimal: t("极低"),
    low: t("低"),
    medium: t("中"),
    high: t("高"),
    xhigh: t("很高"),
    max: t("最高"),
    auto: t("自动"),
  };
  const name = names[effort];
  return name ? `${name} · ${effort}` : effort;
}

/**
 * 这个模型能选的思考强度：运行时按模型列出的（Codex、omp）优先；没列出就用运行时接受的全部档位。
 * model 为空串表示运行时默认模型。
 */
export function effortChoices(
  data: LocalAgentModelsResponse | undefined,
  model: string,
): { efforts: string[]; defaultEffort?: string; perModel: boolean } {
  if (!data || data.efforts.length === 0) return { efforts: [], perModel: false };
  const entry = model
    ? data.models.find((item) => item.id === model)
    : data.models.find((item) => item.isDefault);
  if (entry?.efforts?.length)
    return {
      efforts: sortReasoningEfforts(entry.efforts),
      ...(entry.defaultEffort ? { defaultEffort: entry.defaultEffort } : {}),
      perModel: true,
    };
  return { efforts: [...data.efforts], perModel: false };
}

/**
 * 选思考强度：空串表示不传参数、沿用 CLI 自己的配置。运行时不支持（data.efforts 为空）时什么都不显示。
 * 档位跟着所选模型变；已选的档位当前模型不支持时仍列出并标明，让人自己决定改不改。
 */
export function EffortPicker({
  data,
  model,
  value,
  onChange,
  defaultLabel,
  disabled = false,
  id,
}: {
  data: LocalAgentModelsResponse | undefined;
  /** 当前选的模型（空串为运行时默认），决定能选哪几档 */
  model: string;
  value: string;
  onChange: (value: string) => void;
  /** 「不指定」那一项的名字 */
  defaultLabel?: string;
  disabled?: boolean;
  id?: string;
}) {
  const { efforts, defaultEffort, perModel } = effortChoices(data, model.trim());
  if (!data || efforts.length === 0) return null;
  const unsupported = value !== "" && !efforts.includes(value);
  const options: SelectOption[] = [
    {
      value: "",
      label: defaultLabel ?? t("跟随 CLI 配置"),
      description: defaultEffort
        ? t("这个模型默认是 {0}", { 0: effortLabel(defaultEffort) })
        : t("不传参数，用这个 Agent CLI 自己配置的强度"),
    },
    ...efforts.map((effort) => ({
      value: effort,
      label: effortLabel(effort),
      ...(effort === defaultEffort ? { description: t("这个模型的默认档") } : {}),
    })),
    ...(unsupported
      ? [{ value, label: effortLabel(value), description: t("当前模型不支持这一档") }]
      : []),
  ];
  return (
    <div className="effort-picker">
      <Select
        {...(id ? { id } : {})}
        aria-label={t("思考强度")}
        value={value}
        options={options}
        disabled={disabled}
        onChange={onChange}
      />
      {unsupported && (
        <p className="agent-mcp-hint" role="status">
          {t("当前模型不支持 {0}，运行时会按 CLI 配置的强度跑；建议换一档。", { 0: value })}
        </p>
      )}
      {!unsupported && !perModel && (
        <p className="agent-mcp-hint">{t("能用哪几档取决于模型，以 CLI 实际接受的为准。")}</p>
      )}
    </div>
  );
}

function CloseGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 「换个模型重试」：选一个模型，只对这一次重试生效，之后还是用 Agent 设置里的模型。
 * 本机 Agent 能拉到运行时的模型列表；其他 Agent 只能手填。
 */
export function RetryModelDialog({
  agentName,
  currentModel,
  load,
  onRetry,
  onClose,
}: {
  agentName: string;
  /** Agent 设置里的模型（不知道或用默认时为 undefined） */
  currentModel?: string | null | undefined;
  /** 拉模型列表；不是本机 Agent 时不给，只能手填 */
  load?: ((refresh: boolean) => Promise<LocalAgentModelsResponse>) | undefined;
  /** model、effort 至少给一个；空串表示不换 */
  onRetry: (model: string, effort: string) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<LocalAgentModelsResponse | undefined>(
    load ? undefined : { source: "preset", models: [], efforts: [] },
  );
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");

  const fetchModels = useCallback(
    async (refresh: boolean) => {
      if (!load) return;
      if (refresh) setData(undefined);
      try {
        setData(await load(refresh));
      } catch (cause) {
        setData({
          source: "preset",
          models: [],
          efforts: [],
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },
    [load],
  );

  useEffect(() => {
    void fetchModels(false);
  }, [fetchModels]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const picked = model.trim();
  // 能只换思考强度：模型不选时按它设置里的模型列档位
  const effortModel = picked || currentModel || "";
  const ready = Boolean(picked || effort);
  const submitLabel =
    picked && effort
      ? t("用 {0}（{1}）重试", { 0: picked, 1: effortLabel(effort) })
      : picked
        ? t("用 {0} 重试", { 0: picked })
        : effort
          ? t("用 {0} 思考强度重试", { 0: effortLabel(effort) })
          : t("重试");
  return (
    <div className="room-dialog-layer">
      <button
        className="room-dialog-scrim"
        type="button"
        aria-label={t("关闭")}
        onClick={onClose}
      />
      <form
        className="invite-dialog retry-model-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="retry-model-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) onRetry(picked, effort);
        }}
      >
        <header className="invite-dialog-header">
          <div>
            <h2 id="retry-model-title">{t("换个模型重试 @{0}", { 0: agentName })}</h2>
            <p>
              {currentModel
                ? t("只对这一次重试生效，之后还是用它设置里的模型 {0}。", { 0: currentModel })
                : t("只对这一次重试生效，之后还是用它设置里的模型。")}
            </p>
          </div>
          <IconButton label={t("关闭")} onClick={onClose}>
            <CloseGlyph />
          </IconButton>
        </header>
        <div className="invite-dialog-body">
          <ModelPicker
            aria-label={t("模型")}
            data={data}
            value={model}
            onChange={setModel}
            {...(load ? { onRefresh: () => void fetchModels(true) } : {})}
          />
          {!load && (
            <p className="agent-mcp-hint">
              {t("这个 Agent 不在这台电脑上，拿不到它的模型列表，请手动输入模型名。")}
            </p>
          )}
          {data && data.efforts.length > 0 && (
            <div className="retry-effort">
              <span className="retry-effort-label">{t("思考强度")}</span>
              <EffortPicker
                data={data}
                model={effortModel}
                value={effort}
                onChange={setEffort}
                defaultLabel={t("不换")}
              />
            </div>
          )}
          <div className="dialog-actions">
            <Button onClick={onClose}>{t("取消")}</Button>
            <Button type="submit" variant="primary" disabled={!ready}>
              {submitLabel}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

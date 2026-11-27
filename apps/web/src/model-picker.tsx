import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { sortReasoningEfforts, type LocalAgentModelsResponse } from "@superhive/protocol";
import { t } from "./i18n";
import { Check, Chevron, Select, place, type Placement, type SelectOption } from "./select";
import { Button, IconButton } from "./button";
import { modelDisplayName } from "./agent-models";

const CUSTOM = "\u0000custom";
/** 选项超过这么多就在面板顶上给过滤框（和状态栏「切换主 Agent」一致） */
export const MODEL_FILTER_THRESHOLD = 8;
/** 过滤面板最高多少：比普通下拉（300）高，模型多时一眼看得出能往下滚；屏幕放不下时按可用空间缩 */
export const FILTER_PANEL_MAX_HEIGHT = 520;

/** Claude Code 的模型别名：拉到完整列表时不再列出，但旧设置里可能还存着 */
const CLAUDE_ALIAS = /^(opus|sonnet|haiku|fable)(\[1m\])?$/i;

/** 拉到完整列表、列表里没有、又是 Claude 别名：这是以前选下的旧设置（照常能用） */
export function isLegacyAlias(data: LocalAgentModelsResponse | undefined, value: string): boolean {
  return (
    data?.source === "runtime" &&
    CLAUDE_ALIAS.test(value) &&
    !data.models.some((model) => model.id === value)
  );
}

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
  const legacy = isLegacyAlias(data, value);
  const listed = value === "" || legacy || models.some((model) => model.id === value);
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
              ? t("现在是 {0}", { 0: currentDefaultName(runtimeDefault.id, data) })
              : t("用这个 Agent CLI 自己配置的模型"),
          },
        ]
      : []),
    // 旧设置里的别名：排在具体模型前面，选中时按钮上就能看出是旧设置
    ...(legacy
      ? [
          {
            value,
            label: t("{0}（旧设置）", { 0: value }),
            description: t("别名，指向哪个模型由 Claude Code 决定；建议改选具体模型"),
          },
        ]
      : []),
    ...models.map((model) => {
      const description = model.description
        ? `${model.id} · ${model.description}`
        : model.label
          ? model.id
          : undefined;
      return {
        value: model.id,
        label: model.label ?? model.id,
        ...(description ? { description } : {}),
      };
    }),
  ];
  const legacyHint = legacy ? (
    <p className="agent-mcp-hint" role="status">
      {t("{0} 是 Claude Code 的别名，照常能用；建议改选具体模型。", {
        0: value,
      })}
    </p>
  ) : null;
  // 选项多：用带过滤框的面板，手填也在过滤框里（过滤不到时「使用『xxx』」），不再另给输入框
  if (data && options.length > MODEL_FILTER_THRESHOLD) {
    return (
      <div className="model-picker">
        <div className="model-picker-row">
          <FilterCombobox
            {...(id ? { id } : {})}
            {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
            value={value}
            options={options}
            count={models.length}
            disabled={disabled}
            onChoose={(next) => {
              onChange(next);
              onCommit?.(next);
            }}
          />
          {onRefresh && (
            <Button disabled={disabled} onClick={onRefresh}>
              {t("刷新")}
            </Button>
          )}
        </div>
        {legacyHint}
        <ModelListHint data={data} />
      </div>
    );
  }
  options.push({ value: CUSTOM, label: t("手动输入…"), description: t("列表里没有的模型名") });
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
      {legacyHint}
      {data && <ModelListHint data={data} />}
    </div>
  );
}

/** 「运行时默认」说明里的模型：有显示名时写「Opus 5.5 (1M) · claude-opus-5-5[1M]」，一眼知道是哪个具体模型 */
function currentDefaultName(id: string, data: LocalAgentModelsResponse | undefined): string {
  const name = modelDisplayName(id, data);
  return name === id ? id : `${name} · ${id}`;
}

/** 过滤：模型名（id）或显示名里含有输入的字（不分大小写）；「运行时默认」的说明不算，免得总被带出来 */
export function filterModelOptions(options: SelectOption[], query: string): SelectOption[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return options;
  return options.filter((option) =>
    [option.value, option.label].some((text) => text.toLocaleLowerCase().includes(needle)),
  );
}

/**
 * 选项多时的模型下拉：触发框长得和 Select 一样；打开后顶上是过滤框（焦点在框里），下面是限高、
 * 只在自己里面滚动的列表。↑↓ 移动高亮、回车选中、Esc 收起（不关外面的弹窗）、Tab 收起。
 * 输入的字不是列表里的某个模型名时，最后一项是「使用『xxx』」，回车或点它就把输入当模型名用。
 */
function FilterCombobox({
  value,
  options,
  count,
  onChoose,
  disabled,
  id,
  "aria-label": ariaLabel,
}: {
  value: string;
  options: SelectOption[];
  /** 列表里有几个模型（不算「运行时默认」和旧设置），写在过滤框的占位里 */
  count: number;
  onChoose: (value: string) => void;
  disabled: boolean;
  id?: string;
  "aria-label"?: string;
}) {
  const generated = useId();
  const base = id ?? generated;
  const listId = `${base}-listbox`;
  const optionId = (index: number) => `${base}-option-${index}`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [placement, setPlacement] = useState<Placement>();

  const typed = query.trim();
  const matches = filterModelOptions(options, typed);
  const exact = typed !== "" && options.some((option) => option.value === typed);
  // 最后一项：把输入的字当模型名用
  const items: Array<SelectOption & { custom?: boolean }> = [
    ...matches,
    ...(typed && !exact
      ? [
          {
            value: typed,
            label: t("使用「{0}」", { 0: typed }),
            description: t("列表里没有的模型名"),
            custom: true,
          },
        ]
      : []),
  ];
  const selected = options.find((option) => option.value === value);
  const shown = selected?.label ?? (value || t("选择模型"));

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setActive(-1);
    setQuery("");
    if (refocus) triggerRef.current?.focus();
  }, []);
  const show = () => {
    if (disabled || !triggerRef.current) return;
    setPlacement(place(triggerRef.current, 320, FILTER_PANEL_MAX_HEIGHT));
    setQuery("");
    setActive(
      Math.max(
        0,
        options.findIndex((option) => option.value === value),
      ),
    );
    setOpen(true);
  };
  const choose = (index: number) => {
    const item = items[index];
    if (!item) return;
    onChoose(item.value);
    close(true);
  };

  // 打开后焦点放进过滤框；不滚动外面的弹窗
  useLayoutEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  // 高亮项始终在列表可见范围内（只滚列表自己）
  useLayoutEffect(() => {
    if (!open || active < 0) return;
    const list = listRef.current;
    const element = list?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!list || !element) return;
    if (element.offsetTop < list.scrollTop) list.scrollTop = element.offsetTop;
    else if (element.offsetTop + element.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = element.offsetTop + element.offsetHeight - list.clientHeight;
  }, [active, open]);

  // 点外面收起；窗口缩放、外层滚动时重新定位（列表自己滚动不算）
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (triggerRef.current?.contains(target) || panelRef.current?.contains(target)))
        return;
      close(false);
    };
    const reposition = (event: Event) => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      if (triggerRef.current) setPlacement(place(triggerRef.current, 320, FILTER_PANEL_MAX_HEIGHT));
    };
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [close, open]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive((current) => Math.min(items.length - 1, current + 1));
        return;
      case "ArrowUp":
        event.preventDefault();
        setActive((current) => Math.max(0, current - 1));
        return;
      case "Enter":
        event.preventDefault();
        choose(active >= 0 && active < items.length ? active : 0);
        return;
      case "Escape":
        event.preventDefault();
        // 外面的弹窗也用 Esc 关闭：这里先吃掉，只收起下拉
        event.stopPropagation();
        event.nativeEvent.stopImmediatePropagation();
        close(true);
        return;
      case "Tab":
        close(false);
        return;
    }
  };

  const portalTarget =
    (triggerRef.current?.closest("dialog[open]") as HTMLElement | null) ?? document.body;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        className={`select-trigger${open ? " open" : ""}`}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
        disabled={disabled}
        onClick={() => (open ? close(true) : show())}
        onKeyDown={(event) => {
          if (open || disabled) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            show();
          }
        }}
      >
        <span className={`select-value${selected || value ? "" : " placeholder"}`} title={shown}>
          {shown}
        </span>
        <span className="select-chevron">
          <Chevron />
        </span>
      </button>
      {open &&
        placement &&
        createPortal(
          <div
            ref={panelRef}
            className={`select-panel model-filter-panel${placement.above ? " above" : ""}`}
            style={{
              left: placement.left,
              width: placement.width,
              maxHeight: placement.maxHeight,
              ...(placement.above
                ? { bottom: window.innerHeight - placement.top }
                : { top: placement.top }),
            }}
          >
            <input
              ref={inputRef}
              className="model-filter-input"
              type="text"
              role="combobox"
              aria-label={t("过滤模型")}
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={listId}
              {...(active >= 0 && active < items.length
                ? { "aria-activedescendant": optionId(active) }
                : {})}
              value={query}
              placeholder={t("过滤 {0} 个模型，或输入模型名", {
                0: count,
              })}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
            />
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              className="model-filter-list"
              {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
            >
              {items.map((item, index) => (
                <li
                  key={`${item.custom ? "custom" : "option"}:${item.value}`}
                  id={optionId(index)}
                  data-index={index}
                  role="option"
                  aria-selected={!item.custom && item.value === value}
                  className={`select-option${index === active ? " active" : ""}${
                    item.custom ? " model-filter-custom" : ""
                  }`}
                  // 焦点留在过滤框里
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => {
                    if (index !== active) setActive(index);
                  }}
                  onClick={() => choose(index)}
                >
                  <span className="select-option-text">
                    <span title={item.label}>{item.label}</span>
                    {item.description && <small>{item.description}</small>}
                  </span>
                  <span className="select-check">
                    {!item.custom && item.value === value && <Check />}
                  </span>
                </li>
              ))}
            </ul>
          </div>,
          portalTarget,
        )}
    </>
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
  else if (data.presetReason === "login")
    text = t(
      "Copilot 还没登录 GitHub（在终端运行 copilot login），拉不到完整列表，下面是常用选项，也可以手动输入。",
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

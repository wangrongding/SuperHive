import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import "./styles/select.css";

/**
 * 统一的下拉选择：不用原生 select，自己画面板，按 WAI-ARIA「只选不输的 combobox」写法
 * （https://www.w3.org/WAI/ARIA/apg/patterns/combobox/examples/combobox-select-only/）：
 * 焦点一直留在触发框上，用 aria-activedescendant 指向当前高亮的选项。
 *
 * 键盘：↓ / ↑ / Enter / Space / Alt+↓ 打开；打开后 ↑↓ 移动、Home / End 到首尾、Enter / Space 选中、
 * Esc 关闭不改值、Tab 关闭并离开；打字按首字母跳到对应选项（关着时直接改值，和原生 select 一样）。
 */
export type SelectOption<T extends string = string> = {
  value: T;
  label: string;
  /** 选项下面一行小字 */
  description?: string;
  /** 选项左边的图标，比如 Agent 头像、运行时图标 */
  icon?: ReactNode;
  disabled?: boolean;
  /** 分组标题：相邻同名的选项归到一组 */
  group?: string;
};

export type SelectProps<T extends string = string> = {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  /** 没有可见标签时的读屏名称；外面套了 <label> 时可以不给 */
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  id?: string;
  disabled?: boolean;
  /** 当前值不在选项里时显示的文字 */
  placeholder?: string;
  className?: string;
  /** 下拉面板的最小宽度：选项文字较长、触发按钮又不宽时用，免得选项被截断 */
  menuMinWidth?: number;
};

export type Placement = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  above: boolean;
};

const PANEL_MAX_HEIGHT = 300;
const GAP = 4;
const EDGE = 8;

/** 面板贴着触发框放：下面放不下就向上弹（模型下拉的过滤面板也用它） */
export function place(trigger: HTMLElement, menuMinWidth = 0): Placement {
  const rect = trigger.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(Math.max(rect.width, 180, menuMinWidth), viewportWidth - EDGE * 2);
  const left = Math.max(EDGE, Math.min(rect.left, viewportWidth - width - EDGE));
  const below = viewportHeight - rect.bottom - GAP - EDGE;
  const above = rect.top - GAP - EDGE;
  // 下面放不下而上面空间更大时改成向上弹
  const up = below < Math.min(PANEL_MAX_HEIGHT, 160) && above > below;
  const maxHeight = Math.max(96, Math.min(PANEL_MAX_HEIGHT, up ? above : below));
  return {
    left,
    top: up ? rect.top - GAP : rect.bottom + GAP,
    width,
    maxHeight,
    above: up,
  };
}

export function Chevron() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="m4 6 4 4 4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Check() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="m3.5 8.5 3 3 6-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Select<T extends string = string>({
  value,
  options,
  onChange,
  id,
  disabled = false,
  menuMinWidth,
  placeholder,
  className,
  ...aria
}: SelectProps<T>) {
  const generated = useId();
  const listId = `${id ?? generated}-listbox`;
  const optionId = (index: number) => `${id ?? generated}-option-${index}`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [placement, setPlacement] = useState<Placement>();
  const typeahead = useRef({ text: "", at: 0 });

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex];
  const enabled = (index: number) => index >= 0 && !options[index]?.disabled;

  const move = useCallback(
    (from: number, step: 1 | -1) => {
      for (let index = from + step; index >= 0 && index < options.length; index += step) {
        if (!options[index]!.disabled) return index;
      }
      return from;
    },
    [options],
  );
  const first = () => move(-1, 1);
  const last = () => move(options.length, -1);

  const show = (index = enabled(selectedIndex) ? selectedIndex : first()) => {
    if (disabled || !triggerRef.current) return;
    setPlacement(place(triggerRef.current, menuMinWidth));
    setActive(index);
    setOpen(true);
  };
  const close = useCallback(() => {
    setOpen(false);
    setActive(-1);
    typeahead.current = { text: "", at: 0 };
  }, []);
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    if (option.value !== value) onChange(option.value);
    close();
    triggerRef.current?.focus();
  };

  // 打字跳转：在 0.6 秒内连着打的字拼起来匹配；同一个字反复按就在同首字母的选项间轮转
  const findByTyping = (key: string): number => {
    const now = Date.now();
    const state = typeahead.current;
    state.text = now - state.at > 600 ? key : state.text + key;
    state.at = now;
    const query = state.text.toLocaleLowerCase();
    const repeated = query.length > 1 && [...query].every((char) => char === query[0]);
    const needle = repeated ? query[0]! : query;
    const start = (open ? active : selectedIndex) + (repeated || query.length === 1 ? 1 : 0);
    for (let offset = 0; offset < options.length; offset += 1) {
      const index = (Math.max(start, 0) + offset) % options.length;
      const option = options[index]!;
      if (!option.disabled && option.label.toLocaleLowerCase().startsWith(needle)) return index;
    }
    return -1;
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const { key } = event;
    if (!open) {
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
        event.preventDefault();
        show(
          key === "ArrowUp" && !enabled(selectedIndex)
            ? last()
            : enabled(selectedIndex)
              ? selectedIndex
              : first(),
        );
        return;
      }
      if (key === "Home" || key === "End") {
        event.preventDefault();
        show(key === "Home" ? first() : last());
        return;
      }
      if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const index = findByTyping(key);
        if (index >= 0 && options[index]!.value !== value) onChange(options[index]!.value);
      }
      return;
    }
    switch (key) {
      case "ArrowDown":
        event.preventDefault();
        if (event.altKey) return;
        setActive((current) => move(current, 1));
        return;
      case "ArrowUp":
        event.preventDefault();
        if (event.altKey) {
          choose(active);
          return;
        }
        setActive((current) => move(current, -1));
        return;
      case "Home":
        event.preventDefault();
        setActive(first());
        return;
      case "End":
        event.preventDefault();
        setActive(last());
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        choose(active);
        return;
      case "Escape":
        event.preventDefault();
        // 弹窗也用 Esc 关闭：这里先把 Esc 吃掉，只收起下拉
        event.stopPropagation();
        event.nativeEvent.stopImmediatePropagation();
        close();
        return;
      case "Tab":
        close();
        return;
      default:
        if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          const index = findByTyping(key);
          if (index >= 0) setActive(index);
        }
    }
  };

  // 打开时：点外面关闭；窗口缩放、外层滚动时跟着重新定位
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (triggerRef.current?.contains(target) || listRef.current?.contains(target))) {
        return;
      }
      close();
    };
    const reposition = (event: Event) => {
      if (event.target instanceof Node && listRef.current?.contains(event.target)) return;
      if (triggerRef.current) setPlacement(place(triggerRef.current, menuMinWidth));
    };
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [close, menuMinWidth, open]);

  // 高亮的选项始终在面板可见范围内
  useLayoutEffect(() => {
    if (!open || active < 0) return;
    const element = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    element?.scrollIntoView?.({ block: "nearest" });
  }, [active, open]);

  // 弹窗是 <dialog> 时面板要放进同一个顶层里，否则会被它盖住、变得不可点
  const portalTarget =
    (triggerRef.current?.closest("dialog[open]") as HTMLElement | null) ?? document.body;

  let lastGroup: string | undefined;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        className={`select-trigger${open ? " open" : ""}${className ? ` ${className}` : ""}`}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        {...(open && active >= 0 ? { "aria-activedescendant": optionId(active) } : {})}
        {...aria}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={onKeyDown}
      >
        {selected?.icon && <span className="select-icon">{selected.icon}</span>}
        <span
          className={`select-value${selected ? "" : " placeholder"}`}
          title={typeof selected?.label === "string" ? selected.label : undefined}
        >
          {selected?.label ?? placeholder ?? ""}
        </span>
        <span className="select-chevron">
          <Chevron />
        </span>
      </button>
      {open &&
        placement &&
        createPortal(
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            className={`select-panel${placement.above ? " above" : ""}`}
            aria-label={aria["aria-label"]}
            aria-labelledby={aria["aria-labelledby"]}
            style={{
              left: placement.left,
              width: placement.width,
              maxHeight: placement.maxHeight,
              ...(placement.above
                ? { bottom: window.innerHeight - placement.top }
                : { top: placement.top }),
            }}
          >
            {options.map((option, index) => {
              const heading =
                option.group && option.group !== lastGroup ? (
                  <li role="presentation" className="select-group" key={`group-${option.group}`}>
                    {option.group}
                  </li>
                ) : null;
              lastGroup = option.group;
              return [
                heading,
                <li
                  key={option.value}
                  id={optionId(index)}
                  data-index={index}
                  role="option"
                  aria-selected={option.value === value}
                  aria-disabled={option.disabled || undefined}
                  className={`select-option${index === active ? " active" : ""}${
                    option.disabled ? " disabled" : ""
                  }`}
                  // 不让面板抢走焦点：焦点一直留在触发框上
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => {
                    if (!option.disabled && index !== active) setActive(index);
                  }}
                  onClick={() => choose(index)}
                >
                  {option.icon && <span className="select-icon">{option.icon}</span>}
                  <span className="select-option-text">
                    <span title={typeof option.label === "string" ? option.label : undefined}>
                      {option.label}
                    </span>
                    {option.description && <small>{option.description}</small>}
                  </span>
                  <span className="select-check">{option.value === value && <Check />}</span>
                </li>,
              ];
            })}
          </ul>,
          portalTarget,
        )}
    </>
  );
}

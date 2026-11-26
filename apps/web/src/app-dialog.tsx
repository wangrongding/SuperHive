/*
 * 统一的居中弹窗外壳：遮罩、标题栏、关闭按钮、Esc / 点遮罩关闭、焦点进出、内容区内边距、底部操作区都在这里。
 *
 * - 尺寸五档（sm / md / lg / xl / full），由面板按内容选；高度跟窗口走，内容超出在内容区里滚动。
 * - 内容区的左右内边距只由外壳给（--dialog-inset，见 styles/app-dialog.css），面板不能改，
 *   app-dialog.test.ts 会扫描全部样式表拦住覆盖，避免某个面板内容贴边、和别的面板不一样。
 * - 桌面端整体让到窗口按钮那一行下面（--titlebar-safe-top）；窄屏接近全屏。
 */
import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { t } from "./i18n";
import { IconButton } from "./button";

export type AppDialogSize = "sm" | "md" | "lg" | "xl" | "full";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function AppDialog({
  size,
  title,
  header,
  tools,
  toolbar,
  footer,
  children,
  className,
  bodyClassName,
  bodyId,
  bodyRole,
  bodyRef,
  dialogRef: outerDialogRef,
  placement = "center",
  initialFocus,
  onKeyDown,
  onClose,
}: {
  size: AppDialogSize;
  /** 弹窗名称：显示成标题，同时作为无障碍名称；给了 header 时只作无障碍名称 */
  title: string;
  /** 替换标题的头部内容，比如搜索框 */
  header?: ReactNode;
  /** 标题右边、关闭按钮左边的筛选、操作 */
  tools?: ReactNode;
  /** 标题栏下面、内容区上面的一行（不随内容滚动），比如范围筛选 */
  toolbar?: ReactNode;
  /** 底部操作区（不随内容滚动） */
  footer?: ReactNode;
  children: ReactNode;
  /** 面板自己的类名，加在弹窗上；只能用来改内容的样式，内容区内边距归外壳管 */
  className?: string;
  bodyClassName?: string;
  bodyId?: string;
  bodyRole?: string;
  bodyRef?: Ref<HTMLDivElement>;
  /** 拿到弹窗本身，比如切换视图后把焦点放回弹窗 */
  dialogRef?: RefObject<HTMLDivElement | null>;
  /** top：命令面板式，靠上居中、高度随内容 */
  placement?: "center" | "top";
  /** 打开时先聚焦的元素（比如搜索框）；不给就聚焦弹窗本身，方向键、Esc 照常可用 */
  initialFocus?: RefObject<HTMLElement | null>;
  /** 面板自己的键盘操作（方向键选择、Enter 打开等），先于外壳的 Esc 处理；preventDefault 后外壳不再处理 */
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    // 关掉后焦点回到打开前的位置（侧栏入口、快捷键前的输入框）
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (initialFocus?.current ?? dialogRef.current)?.focus();
    return () => {
      // 面板里的操作已经把焦点交给别处（比如打开了调用详情）就不抢回来
      const active = document.activeElement;
      const lost = !active || active === document.body || dialogRef.current?.contains(active);
      if (lost && previous?.isConnected) previous.focus({ preventScroll: true });
    };
    // 只在打开时取一次焦点
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    // 输入法选字时按 Esc / Tab 是给输入法的
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Tab") trapTab(event, dialogRef.current);
  };

  return (
    <div className={`app-dialog-layer ${placement}`}>
      <button type="button" className="app-dialog-scrim" aria-label={t("关闭")} onClick={onClose} />
      <div
        ref={(node) => {
          dialogRef.current = node;
          if (outerDialogRef) outerDialogRef.current = node;
        }}
        className={["app-dialog", size, className].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        {...(header ? { "aria-label": title } : { "aria-labelledby": titleId })}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="app-dialog-header">
          {header ?? <h2 id={titleId}>{title}</h2>}
          {tools}
          <IconButton className="app-dialog-close" label={t("关闭")} onClick={onClose}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </IconButton>
        </header>
        {toolbar && <div className="app-dialog-toolbar">{toolbar}</div>}
        <div
          ref={bodyRef}
          className={["app-dialog-body", bodyClassName].filter(Boolean).join(" ")}
          {...(bodyId ? { id: bodyId } : {})}
          {...(bodyRole ? { role: bodyRole } : {})}
        >
          {children}
        </div>
        {footer && <footer className="app-dialog-footer">{footer}</footer>}
      </div>
    </div>
  );
}

/** Tab / Shift+Tab 在弹窗里循环，不跑到被遮住的页面上；焦点在弹出菜单（portal）里时不管 */
function trapTab(event: KeyboardEvent<HTMLDivElement>, dialog: HTMLDivElement | null) {
  if (!dialog || !(event.target instanceof Node) || !dialog.contains(event.target)) return;
  const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !element.closest("[inert], [hidden]"),
  );
  if (items.length === 0) return;
  const first = items[0]!;
  const last = items.at(-1)!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === dialog)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

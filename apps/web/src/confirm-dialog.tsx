/*
 * 统一的确认弹窗，替代浏览器原生的 window.confirm（灰框不跟主题、桌面端标题栏还显示网址）。
 *
 *   if (!(await confirmAction({ title: t("删除这条事项？"), message: t("删除后无法恢复。"),
 *     confirmLabel: t("删除"), danger: true }))) return;
 *
 * - 标题一句话说要做什么，message 一两行说后果；按钮写具体动作，不写「确定」。
 * - danger：确认按钮用危险色，打开时焦点落在「取消」上，免得顺手一按回车就执行了；
 *   其它确认焦点落在确认按钮上。
 * - Esc、点遮罩、点「取消」都算取消；Esc 在捕获阶段先接住，不会把外层的设置、邀请弹窗一起关掉。
 * - Tab 只在弹窗里转；关上后焦点回到打开前的按钮。读屏按 alertdialog 念标题和说明。
 * - 自己挂一个 React 根，调用方不用在页面里放任何东西；有打开着的原生 <dialog> 时放进它的顶层，免得被盖住。
 */
import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { trapTab } from "./app-dialog";
import { Button } from "./button";
import { returnFocus } from "./focus-return";
import { t } from "./i18n";

export interface ConfirmOptions {
  /** 一句话：要做什么，读屏也念它 */
  title: string;
  /** 一两行后果说明；可以用 \n 换行 */
  message?: ReactNode;
  /** 写具体动作，比如「删除」「停下并改做」 */
  confirmLabel: string;
  cancelLabel?: string;
  /** 删除、撤销、断开这类收不回的操作 */
  danger?: boolean;
}

/** 打开着的确认弹窗，最后一个在最上面，只有它响应 Esc */
const stack: symbol[] = [];

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  if (typeof document === "undefined") return Promise.resolve(false);
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const host = document.querySelector<HTMLDialogElement>("dialog[open]") ?? document.body;
  const container = document.createElement("div");
  host.append(container);
  const root = createRoot(container);
  const id = Symbol("confirm");
  stack.push(id);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (result: boolean) => {
      if (settled) return;
      settled = true;
      stack.splice(stack.indexOf(id), 1);
      // 先还焦点再通知调用方：调用方接着要把焦点挪到别处（比如打开新面板）时不会被抢回来
      if (previous?.isConnected) returnFocus(previous);
      resolve(result);
      // 不在自己的事件处理里同步卸载
      setTimeout(() => {
        root.unmount();
        container.remove();
      });
    };
    root.render(
      <ConfirmDialog
        {...options}
        isTop={() => stack.at(-1) === id}
        onConfirm={() => settle(true)}
        onCancel={() => settle(false)}
      />,
    );
  });
}

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  isTop,
  onConfirm,
  onCancel,
}: ConfirmOptions & { isTop: () => boolean; onConfirm: () => void; onCancel: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();

  useEffect(() => {
    (danger ? cancelRef : confirmRef).current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || !isTop()) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    // 捕获阶段：比外层弹窗挂在 window 上的 Esc 先收到
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // 只在打开时取一次焦点
  }, []);

  return (
    <div className="confirm-dialog-layer">
      <div className="confirm-dialog-scrim" aria-hidden="true" onClick={onCancel} />
      <div
        ref={dialogRef}
        className={`confirm-dialog${danger ? " danger" : ""}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(message ? { "aria-describedby": messageId } : {})}
        onKeyDown={(event) => {
          if (event.key === "Tab") trapTab(event, dialogRef.current);
        }}
      >
        <h2 id={titleId}>{title}</h2>
        {message ? <p id={messageId}>{message}</p> : null}
        <div className="dialog-actions">
          <Button ref={cancelRef} onClick={onCancel}>
            {cancelLabel ?? t("取消")}
          </Button>
          <Button ref={confirmRef} variant={danger ? "danger" : "primary"} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

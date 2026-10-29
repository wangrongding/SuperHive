import { useRef, useState, type ReactNode } from "react";

/**
 * 与 protocol 的 LIMITS.maxMessageLength 保持一致（由 collapsible-message.test.ts 校验）。
 * 前端只做类型导入，直接引用会把 zod 打进页面包。
 */
export const MAX_MESSAGE_LENGTH = 100_000;
/** 输入超过上限的这个比例时才显示字数，平时不打扰 */
export const MESSAGE_LENGTH_WARNING_RATIO = 0.9;

const COLLAPSE_LINE_THRESHOLD = 15;
const COLLAPSE_CHAR_THRESHOLD = 1500;

/** 按内容判断而不是测量高度：首帧即可确定，避免渲染后再折叠造成跳动 */
export function isLongMessage(content: string): boolean {
  if (content.length > COLLAPSE_CHAR_THRESHOLD) return true;
  let lines = 1;
  for (let index = content.indexOf("\n"); index !== -1; index = content.indexOf("\n", index + 1)) {
    lines += 1;
    if (lines > COLLAPSE_LINE_THRESHOLD) return true;
  }
  return false;
}

/** 长消息默认折叠，只影响显示；存储、复制和分享导出仍使用全文 */
export function CollapsibleMessage({
  content,
  forceExpanded = false,
  children,
}: {
  content: string;
  forceExpanded?: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  if (!isLongMessage(content)) return <>{children}</>;
  const collapsed = !expanded && !forceExpanded;

  function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (!next) {
      // 收起后消息顶部可能已在视口上方，滚回来以免读者丢失位置
      window.requestAnimationFrame(() => {
        const node = containerRef.current;
        if (node && node.getBoundingClientRect().top < 0) {
          node.scrollIntoView({ block: "start" });
        }
      });
    }
  }

  return (
    <div ref={containerRef} className={`message-collapsible ${collapsed ? "collapsed" : ""}`}>
      <div className="message-collapsible-content">{children}</div>
      {!forceExpanded && (
        <button
          type="button"
          className="message-expand"
          aria-expanded={expanded}
          onClick={(event) => {
            event.stopPropagation();
            toggle();
          }}
        >
          {expanded ? "收起" : `展开全文 · 共 ${content.length.toLocaleString()} 字`}
        </button>
      )}
    </div>
  );
}

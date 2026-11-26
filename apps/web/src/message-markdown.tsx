import { memo, useEffect, useRef, useState, type ComponentProps } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { copyTextToClipboard } from "./clipboard";
import { t } from "./i18n";
import { RefLink, remarkWorkspaceRefs } from "./workspace-refs";

// @ 前紧贴 ASCII 字母数字时是邮箱，不高亮；中文后直接 @ 与服务端一样算提及
const mentionPattern = /(?<![A-Za-z0-9_.])(@[\p{L}\p{N}_.-]+)/gu;

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  data?: { hName?: string };
}

function splitMentionNodes(text: string): MdNode[] | null {
  const matches = [...text.matchAll(mentionPattern)];
  if (matches.length === 0) {
    return null;
  }
  const nodes: MdNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index > cursor) {
      nodes.push({ type: "text", value: text.slice(cursor, match.index) });
    }
    nodes.push({
      type: "mention",
      data: { hName: "mark" },
      children: [{ type: "text", value: match[0] }],
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    nodes.push({ type: "text", value: text.slice(cursor) });
  }
  return nodes;
}

function visitMentions(node: MdNode): void {
  if (!node.children || node.type === "link" || node.type === "linkReference") {
    return;
  }
  const nextChildren: MdNode[] = [];
  let changed = false;
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      const replaced = splitMentionNodes(child.value);
      if (replaced) {
        nextChildren.push(...replaced);
        changed = true;
        continue;
      }
    }
    visitMentions(child);
    nextChildren.push(child);
  }
  if (changed) {
    node.children = nextChildren;
  }
}

// 裸链接遇到中文就收住：GFM 的裸链接只在空白处结束，「见 https://a.com/cn）页脚……」会把后面的
// 中文、全角括号和标点一起吞进链接，点开地址就错了。中文里网址后面通常紧跟中文，没有空格，
// 和飞书、微信一样在第一个汉字或全角标点处截断；[文字](网址) 这类显式链接不受影响
const cjkBoundary = /[\u2018-\u201f\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/u;

function trimCjkAutolinks(node: MdNode): void {
  if (!node.children) {
    return;
  }
  const nextChildren: MdNode[] = [];
  for (const child of node.children) {
    trimCjkAutolinks(child);
    const label = child.children?.length === 1 ? child.children[0] : undefined;
    const text = label?.type === "text" ? label.value : undefined;
    const url = child.url;
    const isAutolink =
      child.type === "link" &&
      text !== undefined &&
      url !== undefined &&
      [text, `http://${text}`, `mailto:${text}`].includes(url);
    const cut = isAutolink ? text.search(cjkBoundary) : -1;
    if (!isAutolink || cut <= 0) {
      nextChildren.push(child);
      continue;
    }
    const kept = text.slice(0, cut);
    nextChildren.push(
      {
        ...child,
        url: url.slice(0, url.length - (text.length - cut)),
        children: [{ type: "text", value: kept }],
      },
      { type: "text", value: text.slice(cut) },
    );
  }
  node.children = nextChildren;
}

function remarkCjkAutolinks() {
  return (tree: MdNode) => trimCjkAutolinks(tree);
}

// 将文本节点中的 @提及 渲染为 <mark>，跳过代码与链接内部
function remarkMentionHighlights() {
  return (tree: MdNode) => visitMentions(tree);
}

type HastNode = NonNullable<ExtraProps["node"]>;

interface HastLike {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastLike[];
}

function collectNodeText(node: HastLike): string {
  if (node.type === "text") {
    return node.value ?? "";
  }
  return (node.children ?? []).map(collectNodeText).join("");
}

function extractCodeMeta(node: HastNode | undefined): { language: string | null; text: string } {
  const code = (node as HastLike | undefined)?.children?.find(
    (child) => child.type === "element" && child.tagName === "code",
  );
  if (!code) {
    return { language: null, text: "" };
  }
  const classNames = code.properties?.className;
  const classList = Array.isArray(classNames)
    ? classNames.map(String)
    : typeof classNames === "string"
      ? classNames.split(" ")
      : [];
  const languageClass = classList.find((name) => name.startsWith("language-"));
  return {
    language: languageClass ? languageClass.slice("language-".length) : null,
    text: collectNodeText(code).replace(/\n$/, ""),
  };
}

export function CodeBlock({ node, children, ...rest }: ComponentProps<"pre"> & ExtraProps) {
  const { language, text } = extractCodeMeta(node);
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const handleCopy = async () => {
    try {
      await copyTextToClipboard(text);
      setCopied(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // 剪贴板不可用时静默失败，保持按钮原状
    }
  };

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-language">{language ?? "text"}</span>
        <button
          type="button"
          className="code-block-copy"
          aria-label={t("复制代码")}
          onClick={() => void handleCopy()}
        >
          {copied ? t("已复制 ✓") : t("复制")}
        </button>
      </div>
      <pre {...rest}>{children}</pre>
    </div>
  );
}

export const markdownComponents: Components = {
  a(props) {
    const { node, ...rest } = props;
    void node;
    return <a {...rest} target="_blank" rel="noreferrer noopener" />;
  },
  // 任务列表的 checkbox 只作展示，避免误触
  input(props) {
    const { node, ...rest } = props;
    void node;
    return <input {...rest} readOnly disabled />;
  },
  pre: CodeBlock,
  // 提交号、任务分支名：能在「代码」面板里打开的变成按钮（见 workspace-refs）
  span(props) {
    const { node, ...rest } = props;
    void node;
    const token = (rest as Record<string, unknown>)["data-ref"];
    if (typeof token === "string") return <RefLink token={token}>{rest.children}</RefLink>;
    return <span {...rest} />;
  },
};

/**
 * 不可交互的渲染：Agent 的思考和中途的话可能转述了网页、文件里的内容（包括提示词注入），
 * 链接只显示文字不可点，图片不加载外链只显示替代文字。原始 HTML 本来就不渲染（没开 rehype-raw）。
 */
const inertComponents: Components = {
  ...markdownComponents,
  a(props) {
    const { node, href, children } = props;
    void node;
    return (
      <span className="md-inert-link" title={typeof href === "string" ? href : undefined}>
        {children}
      </span>
    );
  },
  img(props) {
    const { node, alt } = props;
    void node;
    return <span className="md-inert-image">{alt ? `[${alt}]` : t("[图片]")}</span>;
  },
  span(props) {
    const { node, ...rest } = props;
    void node;
    return <span {...rest} />;
  },
};

export const MessageMarkdown = memo(function MessageMarkdown({
  content,
  inert = false,
  onLocateMessage,
}: {
  content: string;
  /** 链接不可点、图片不加载：用于展示 Agent 的思考和执行中说的话 */
  inert?: boolean;
  onLocateMessage?: (target: { messageId: string; messageSeq: number }) => void;
}) {
  return (
    <ReactMarkdown
      // 只认 ~~ 为删除线：「~100~200 元」这种写法很常见，和输入框保持一致
      remarkPlugins={[
        [remarkGfm, { singleTilde: false }],
        remarkCjkAutolinks,
        remarkBreaks,
        remarkMentionHighlights,
        remarkWorkspaceRefs,
      ]}
      // 不开语言自动检测：未标记语言的代码块要用全部语法逐一试探打分，遇到长文本是
      // 主线程热点（实测单块可达数百毫秒）；标记了语言的代码块仍正常高亮
      rehypePlugins={[rehypeHighlight]}
      components={
        inert
          ? inertComponents
          : {
              ...markdownComponents,
              a(props) {
                const target =
                  /^#message\/([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\/([1-9]\d*)$/i.exec(
                    props.href ?? "",
                  );
                if (target && onLocateMessage && Number.isSafeInteger(Number(target[2]))) {
                  return (
                    <button
                      type="button"
                      className="message-receipt-link"
                      onClick={(event) => {
                        event.stopPropagation();
                        onLocateMessage({ messageId: target[1], messageSeq: Number(target[2]) });
                      }}
                    >
                      {props.children}
                    </button>
                  );
                }
                const { node, ...rest } = props;
                void node;
                return <a {...rest} target="_blank" rel="noreferrer noopener" />;
              },
            }
      }
    >
      {content}
    </ReactMarkdown>
  );
});

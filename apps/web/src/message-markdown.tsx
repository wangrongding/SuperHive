import { memo, useEffect, useRef, useState, type ComponentProps } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { copyTextToClipboard } from "./clipboard";

const mentionPattern = /(?<![\p{L}\p{N}_])(@[\p{L}\p{N}_.-]+)/gu;

interface MdNode {
  type: string;
  value?: string;
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

function CodeBlock({ node, children, ...rest }: ComponentProps<"pre"> & ExtraProps) {
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
          aria-label="复制代码"
          onClick={() => void handleCopy()}
        >
          {copied ? "已复制 ✓" : "复制"}
        </button>
      </div>
      <pre {...rest}>{children}</pre>
    </div>
  );
}

const markdownComponents: Components = {
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
};

export const MessageMarkdown = memo(function MessageMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks, remarkMentionHighlights]}
      // 不开语言自动检测：未标记语言的代码块要用全部语法逐一试探打分，遇到长文本是
      // 主线程热点（实测单块可达数百毫秒）；标记了语言的代码块仍正常高亮
      rehypePlugins={[rehypeHighlight]}
      components={markdownComponents}
    >
      {content}
    </ReactMarkdown>
  );
});

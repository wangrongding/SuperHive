import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { t } from "./i18n";
import { markdownComponents } from "./message-markdown";

/**
 * 读文档用的 Markdown 排版：附件、产物、代码面板里打开 .md 时用。
 * 和聊天消息（MessageMarkdown）分开：不把单个换行当换行（按标准 Markdown）、不高亮 @提及，
 * 标题带锚点、能生成目录，开头的 YAML frontmatter 显示成一块元信息。原始 HTML 照旧不渲染。
 */

export interface FrontmatterEntry {
  key: string;
  value: string;
}

export interface Frontmatter {
  entries: FrontmatterEntry[];
  /** 认不出 key: value 时原样显示 */
  raw: string;
}

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const META_KEY = /^([\p{L}\p{N}_][\p{L}\p{N}_ .-]*?)\s*:(?:\s+(.*))?$/u;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  )
    return trimmed.slice(1, -1);
  return trimmed;
}

/** 只认开头的 --- … --- 块，并且里面至少有一行 key: value；否则当普通正文（--- 也可能是分隔线） */
export function splitFrontmatter(source: string): { meta?: Frontmatter; body: string } {
  const match = FRONTMATTER.exec(source);
  if (!match) return { body: source };
  const raw = match[1];
  const entries: FrontmatterEntry[] = [];
  const parts: string[][] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const key = /^\S/.test(line) ? META_KEY.exec(line) : null;
    if (key) {
      entries.push({ key: key[1], value: "" });
      const value = key[2]?.trim() ?? "";
      // 块标量（| 或 >）的内容在下面几行
      parts.push(value && !/^[|>][+-]?$/.test(value) ? [unquote(value)] : []);
      continue;
    }
    if (parts.length === 0) return { body: source };
    const item = line.trim().replace(/^-\s+/, "");
    parts[parts.length - 1].push(unquote(item));
  }
  if (entries.length === 0) return { body: source };
  entries.forEach((entry, index) => {
    const list = parts[index];
    // [a, b] 这种行内列表去掉方括号
    entry.value =
      list.length === 1 && /^\[.*\]$/.test(list[0])
        ? list[0].slice(1, -1).split(",").map(unquote).filter(Boolean).join(", ")
        : list.join(", ");
  });
  return { meta: { entries, raw }, body: source.slice(match[0].length) };
}

/** 和 GitHub 差不多的标题锚点：小写、去标点、空格换成 -，重名加 -1、-2 */
export function headingSlug(text: string, used: Map<string, number>): string {
  const base =
    text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-") || "section";
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

interface MdNode {
  type: string;
  depth?: number;
  value?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
}

function nodeText(node: MdNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(nodeText).join("");
}

/** 给每个标题挂 data-heading（不用 id，免得和页面其它元素撞名） */
function remarkHeadingAnchors() {
  return (tree: MdNode) => {
    const used = new Map<string, number>();
    const visit = (node: MdNode) => {
      if (node.type === "heading") {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            "data-heading": headingSlug(nodeText(node), used),
          },
        };
        return;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

interface TocItem {
  slug: string;
  text: string;
  level: number;
}

/** 标题少于这么多时不显示目录 */
const TOC_MIN_HEADINGS = 3;

function FrontmatterBlock({ meta }: { meta: Frontmatter }) {
  return (
    <details className="doc-meta" open>
      <summary>
        {t("文档信息")}
        <span className="doc-meta-count">{meta.entries.length}</span>
      </summary>
      <dl>
        {meta.entries.map((entry, index) => (
          <div className="doc-meta-row" key={`${entry.key}-${index}`}>
            <dt>{entry.key}</dt>
            <dd>{entry.value || "—"}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export const DocMarkdown = memo(function DocMarkdown({
  content,
  footer,
}: {
  content: string;
  /** 放在正文后面、一起滚动，例如「文件较长只显示前 N 字」 */
  footer?: ReactNode;
}) {
  const { meta, body } = useMemo(() => splitFrontmatter(content), [content]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [active, setActive] = useState<string>();

  const headingElements = useCallback(
    () => [...(articleRef.current?.querySelectorAll<HTMLElement>("[data-heading]") ?? [])],
    [],
  );

  const scrollToHeading = useCallback(
    (slug: string) => {
      const scroller = scrollRef.current;
      const target = headingElements().find((element) => element.dataset.heading === slug);
      if (!scroller || !target) return false;
      const offset = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
      scroller.scrollTop += offset;
      setActive(slug);
      return true;
    },
    [headingElements],
  );

  // ReactMarkdown 同步渲染，挂载后从 DOM 里收标题（h1–h3）
  useLayoutEffect(() => {
    const items = headingElements()
      .filter((element) => /^H[1-3]$/.test(element.tagName))
      .map((element) => ({
        slug: element.dataset.heading ?? "",
        text: element.textContent?.trim() ?? "",
        level: Number(element.tagName.slice(1)),
      }))
      .filter((item) => item.text);
    setToc(items.length >= TOC_MIN_HEADINGS ? items : []);
    setActive(undefined);
  }, [body, headingElements]);

  // 滚动时高亮当前读到的标题
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || toc.length === 0) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = scroller.getBoundingClientRect().top + 24;
      let current: string | undefined;
      for (const element of headingElements()) {
        if (!/^H[1-3]$/.test(element.tagName)) continue;
        if (element.getBoundingClientRect().top <= top) current = element.dataset.heading;
        else break;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [headingElements, toc]);

  const components = useMemo<Components>(
    () => ({
      ...markdownComponents,
      a(props) {
        const { node, href, ...rest } = props;
        void node;
        // 文档内锚点：在预览里滚过去，不改地址栏（网页自己用 # 路由）
        if (href?.startsWith("#")) {
          return (
            <a
              {...rest}
              href={href}
              onClick={(event) => {
                let slug = href.slice(1);
                try {
                  slug = decodeURIComponent(slug);
                } catch {
                  // 保持原样
                }
                if (scrollToHeading(slug.toLowerCase())) event.preventDefault();
              }}
            />
          );
        }
        return <a {...rest} href={href} target="_blank" rel="noreferrer noopener" />;
      },
      // 表格包一层，宽了在自己框里横向滚动，不撑破正文
      table(props) {
        const { node, ...rest } = props;
        void node;
        return (
          <div className="doc-table">
            <table {...rest} />
          </div>
        );
      },
      img(props) {
        const { node, ...rest } = props;
        void node;
        return <img {...rest} loading="lazy" />;
      },
    }),
    [scrollToHeading],
  );

  const minLevel = toc.length > 0 ? Math.min(...toc.map((item) => item.level)) : 1;

  return (
    <div className={`doc-view${toc.length > 0 ? " has-toc" : ""}`}>
      <div className="doc-view-scroll" ref={scrollRef}>
        <article className="doc-markdown" ref={articleRef}>
          {meta && <FrontmatterBlock meta={meta} />}
          <ReactMarkdown
            remarkPlugins={[[remarkGfm, { singleTilde: false }], remarkHeadingAnchors]}
            rehypePlugins={[rehypeHighlight]}
            components={components}
          >
            {body}
          </ReactMarkdown>
        </article>
        {footer}
      </div>
      {toc.length > 0 && (
        <nav className="doc-toc" aria-label={t("目录")}>
          <p className="doc-toc-title">{t("目录")}</p>
          <ol>
            {toc.map((item) => (
              <li key={item.slug} className={`level-${item.level - minLevel + 1}`}>
                <button
                  type="button"
                  className="doc-toc-item"
                  aria-current={active === item.slug ? "location" : undefined}
                  onClick={() => scrollToHeading(item.slug)}
                >
                  {item.text}
                </button>
              </li>
            ))}
          </ol>
        </nav>
      )}
    </div>
  );
});

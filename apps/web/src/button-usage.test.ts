import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * 按钮规范的防回归检查（规范见 button.tsx 与 styles/button.css）：
 *
 * 1. 操作按钮一律用 <Button> / <IconButton>。还能写裸 <button> 的只有不算「按钮」的复合控件：
 *    - 带 role（tab、radio、menuitem、option、switch、checkbox）或 aria-pressed 的分段、开关、菜单项；
 *    - className 第一个词在 RAW_BUTTON_CLASSES 里的：列表行、卡片、遮罩、输入框里的小控件这类
 *      本身就是一块可点区域、外观由所在组件决定的东西。新增要写进下面的表并说明为什么不是按钮。
 * 2. 除 button.css 外，样式表不许给 .btn 改颜色、尺寸、圆角、边框（只能改位置：margin、flex、宽度、对齐）；
 *    也不许再出现 button.primary、.ghost 这类自定义按钮种类。
 */

/** 允许写裸 <button> 的 className（第一个词）：不是操作按钮，而是可点的区域或复合控件的一部分 */
const RAW_BUTTON_CLASSES = new Set([
  // 遮罩：点空白处关闭
  "room-dialog-scrim",
  "activity-scrim",
  "panel-scrim",
  "settings-dialog-scrim",
  "agent-dialog-scrim",
  "app-dialog-scrim",
  // 列表行、卡片、条目：整块可点
  "room-item-main",
  "room-item-manage",
  "worktree-switcher-row",
  "workspace-tree-row",
  "workspace-commit",
  "workspace-change",
  "activity-result",
  "attention-row",
  "progress-row",
  "artifact-tile",
  "agent-runtime-row",
  // 侧栏「别人的服务器」里的一行：点了在单独的窗口打开
  "remote-server-open",
  // Agent 任务侧栏里「另有 N 个空闲…」的展开行
  "agent-runtime-more",
  // 定时任务卡片元信息里的「# 房间」：和旁边的文字同一行的小标签
  "schedule-room",
  // 跳转面板筛选条里的「下一个要处理的」：和左边的筛选片同一组
  "goto-next",
  "message-machine-card",
  "message-file",
  "message-image",
  "workspace-media-image",
  "artifact-detail-preview",
  "invocation-summary",
  "thinking-card-trigger",
  "thinking-card-trigger-chip",
  "trace-recap-preview",
  "typing-agent",
  "question-option",
  "question-answer",
  "mention-option",
  "context-menu-item",
  "select-trigger",
  "settings-switch-row",
  "invite-switch",
  "sidebar-user-chip",
  "sidebar-action",
  "member-invite-action",
  "guest-actions-trigger",
  "terminal-tab-label",
  "chat-title-branch",
  "keep-awake-badge",
  "directory-picker-entry",
  "office-pptx-thumb",
  "worktree-switcher-manage",
  "attention-toast-open",
  "question-other-toggle",
  "thinking-card-expand",
  // 步进控件「− 数字 +」的加减键、接入步骤条里回到已完成的一步：外观跟着整组控件走
  "stepper-step",
  "duration-stepper-step",
  "agent-step-back",
  // 底部状态栏的一项、弹出面板底部的「去设置」链接行：一套单独的低调小控件，和状态栏一起设计
  "status-item",
  "status-popover-link",
  // 顶栏、输入框工具条：一套单独的图标工具按钮，和顶栏、输入框一起设计
  "header-button",
  "composer-tool",
  "composer-send",
  "composer-steer",
  "composer-attach",
  "jump-to-bottom",
  "jump-pill",
  // 消息正文里的行内控件：序号、展开、引用链接
  "message-seq",
  "message-expand",
  "message-receipt-link",
  "message-machine-collapse",
  "md-ref-link",
  "code-block-copy",
  "trace-text-toggle",
  "trace-recap-toggle",
  // 看图：大图上的半透明浮层控件
  "attachment-lightbox-nav",
  "attachment-lightbox-zoom",
  "attachment-lightbox-close",
  "attachment-lightbox-text",
  "attachment-lightbox-step",
  "office-pptx-fullscreen",
  // 卡片角落的小叉：上传中的附件、白板条目
  "composer-attachment-remove",
  "terminal-tab-close",
]);

/** 这些 role 是复合控件的一部分（分段、标签页、菜单），不是独立的操作按钮 */
const COMPOSITE_ROLES = new Set([
  "tab",
  "radio",
  "menuitem",
  "menuitemradio",
  "menuitemcheckbox",
  "option",
  "switch",
  "checkbox",
]);

const srcDir = path.resolve(import.meta.dirname);

function files(dir: string, test: (name: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full, test);
    return test(name) ? [full] : [];
  });
}

/** className 里写死的第一个词：字符串、模板字符串开头、条件表达式两边都试 */
function leadingClass(init: ts.JsxAttributeValue | undefined): string | undefined {
  if (!init) return undefined;
  const fromText = (text: string) => text.trim().split(/\s+/)[0] || undefined;
  if (ts.isStringLiteral(init)) return fromText(init.text);
  if (!ts.isJsxExpression(init) || !init.expression) return undefined;
  const expression = init.expression;
  if (ts.isNoSubstitutionTemplateLiteral(expression)) return fromText(expression.text);
  if (ts.isTemplateExpression(expression)) return fromText(expression.head.text);
  if (ts.isStringLiteral(expression)) return fromText(expression.text);
  // 条件表达式：两边都得是允许的类，才算允许
  if (ts.isConditionalExpression(expression)) {
    const sides = [expression.whenTrue, expression.whenFalse].map((side) =>
      ts.isStringLiteral(side) || ts.isNoSubstitutionTemplateLiteral(side)
        ? fromText(side.text)
        : undefined,
    );
    return sides.every((side) => side && RAW_BUTTON_CLASSES.has(side)) ? sides[0] : undefined;
  }
  return undefined;
}

function attribute(node: ts.JsxOpeningLikeElement, name: string) {
  return node.attributes.properties.find(
    (item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText() === name,
  );
}

function rawButtons(): string[] {
  const problems: string[] = [];
  for (const file of files(srcDir, (name) => /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name))) {
    if (path.basename(file) === "button.tsx") continue;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node: ts.Node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.tagName.getText() === "button"
      ) {
        const role = attribute(node, "role")?.initializer;
        const roleText = role && ts.isStringLiteral(role) ? role.text : undefined;
        const allowed =
          (roleText !== undefined && COMPOSITE_ROLES.has(roleText)) ||
          attribute(node, "aria-pressed") !== undefined ||
          RAW_BUTTON_CLASSES.has(leadingClass(attribute(node, "className")?.initializer) ?? "");
        if (!allowed) {
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          const cls = attribute(node, "className")?.initializer?.getText() ?? "（没有 className）";
          problems.push(`${path.relative(srcDir, file)}:${line} ${cls}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return problems;
}

/** 只允许改位置的属性：别的样式表里出现 .btn 时只能写这些 */
const LAYOUT_PROPS = new Set([
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "margin-inline",
  "margin-inline-start",
  "margin-inline-end",
  "margin-block",
  "flex",
  "flex-shrink",
  "flex-grow",
  "flex-basis",
  "align-self",
  "justify-self",
  "order",
  "width",
  "min-width",
  "max-width",
  "grid-column",
  "grid-row",
  "grid-area",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "inset",
  "z-index",
  "display",
  "visibility",
  "opacity",
]);

/** 旧的自定义按钮种类写法：button.primary、.ghost、.invite-submit 这类 */
const LEGACY_SELECTORS = [
  /button\.(primary|secondary|ghost|danger)\b/,
  /(^|[\s,>+~])\.(primary|secondary|ghost)\b/,
  /\.invite-submit\b/,
  /\.settings-action\b/,
];

function cssProblems(): string[] {
  const problems: string[] = [];
  for (const file of files(path.join(srcDir, "styles"), (name) => name.endsWith(".css"))) {
    if (path.basename(file) === "button.css") continue;
    const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1]!.trim();
      if (selector.startsWith("@")) continue;
      const where = `${path.relative(srcDir, file)}: ${selector.replace(/\s+/g, " ")}`;
      for (const legacy of LEGACY_SELECTORS)
        if (legacy.test(selector)) problems.push(`${where}（旧的按钮种类写法）`);
      // :has(.btn) 只是拿按钮当条件，改的是外层元素
      if (!/\.btn\b|\.btn-/.test(selector.replace(/:has\([^)]*\)/g, ""))) continue;
      for (const declaration of match[2]!.split(";")) {
        const prop = declaration.split(":")[0]!.trim();
        if (prop && !prop.startsWith("--") && !LAYOUT_PROPS.has(prop))
          problems.push(`${where}（改了按钮外观：${prop}）`);
      }
    }
  }
  return problems;
}

describe("按钮规范", () => {
  it("操作按钮都用 <Button> / <IconButton>，不写裸 <button>", () => {
    expect(rawButtons()).toEqual([]);
  });

  it("样式表不另写按钮外观", () => {
    expect(cssProblems()).toEqual([]);
  });
});

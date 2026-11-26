import type { ContextMenuItem } from "./context-menu";
import type { MenuTarget } from "./message-selection";
import { t } from "./i18n";

/** 一条消息右键菜单里可做的事；不适用的不传，对应的项就不出现 */
export type MessageMenuOptions = {
  seq: number;
  senderName: string;
  /** 右键时选中的、落在这条消息里的文字 */
  selection?: string | undefined;
  /** 右键点中的链接、代码、图片 */
  target?: MenuTarget;
  quote: (selection?: string) => void;
  copyText: () => void;
  copySelection: (text: string) => void;
  copySeq: () => void;
  copyLink: () => void;
  copyValue: (value: string) => void;
  /** @ 发送者：自己的消息、访客 @ 不了的 Agent 不传 */
  mention?: (() => void) | undefined;
  showProcess?: (() => void) | undefined;
  viewChanges?: (() => void) | undefined;
  recordTodo?: (() => void) | undefined;
  /** 能重试的任务（按现有权限算好） */
  retries?: { label: string; run: () => void }[];
  /** 能停的任务 */
  stops?: { label: string; run: () => void }[];
  recall?: (() => void) | undefined;
};

/** 消息右键菜单：点中的东西 → 引用 → 复制 → 跟这条消息相关的去处 → 改变状态的操作（放最后，危险的标红） */
export function messageMenuItems(options: MessageMenuOptions): ContextMenuItem[] {
  const { selection, target = {} } = options;
  const groups: ContextMenuItem[][] = [];
  const targeted: ContextMenuItem[] = [];
  if (target.link) {
    const link = target.link;
    targeted.push({ label: t("复制链接"), onSelect: () => options.copyValue(link) });
  }
  if (target.code !== undefined) {
    const code = target.code;
    targeted.push({ label: t("复制代码"), onSelect: () => options.copyValue(code) });
  }
  if (target.image) targeted.push({ label: t("打开图片"), onSelect: target.image.open });
  groups.push(targeted);
  groups.push([
    selection
      ? { label: t("引用选中内容"), onSelect: () => options.quote(selection) }
      : { label: t("引用回复"), onSelect: () => options.quote() },
  ]);
  groups.push([
    ...(selection
      ? [{ label: t("复制选中内容"), onSelect: () => options.copySelection(selection) }]
      : []),
    { label: t("复制文本"), hint: "Markdown", onSelect: options.copyText },
    { label: t("复制序号 #{0}", { 0: options.seq }), onSelect: options.copySeq },
    // 复制的是聊天里可点的 [#序号](#message/…) 链接
    { label: t("复制消息链接"), onSelect: options.copyLink },
  ]);
  groups.push([
    ...(options.mention
      ? [{ label: t("@ {0}", { 0: options.senderName }), onSelect: options.mention }]
      : []),
    ...(options.showProcess ? [{ label: t("看这一轮过程"), onSelect: options.showProcess }] : []),
    ...(options.viewChanges ? [{ label: t("看它的改动"), onSelect: options.viewChanges }] : []),
    ...(options.recordTodo ? [{ label: t("记为待办"), onSelect: options.recordTodo }] : []),
  ]);
  groups.push([
    ...(options.retries ?? []).map((item) => ({ label: item.label, onSelect: item.run })),
    ...(options.stops ?? []).map((item) => ({
      label: item.label,
      danger: true,
      onSelect: item.run,
    })),
    ...(options.recall ? [{ label: t("撤回"), danger: true, onSelect: options.recall }] : []),
  ]);
  return groups
    .filter((group) => group.length > 0)
    .flatMap((group, index) => (index === 0 ? group : ["separator" as const, ...group]));
}

/** 执行中卡片的右键菜单：跳回在处理的消息、@ 它、停下这一轮、复制选中的过程文字 */
export function thinkingCardMenuItems(options: {
  agentName: string;
  selection?: string | undefined;
  triggerSeq?: number | undefined;
  jumpToTrigger?: (() => void) | undefined;
  mention?: (() => void) | undefined;
  copySelection: (text: string) => void;
  stop?: (() => void) | undefined;
}): ContextMenuItem[] {
  const { selection } = options;
  const groups: ContextMenuItem[][] = [
    selection
      ? [{ label: t("复制选中内容"), onSelect: () => options.copySelection(selection) }]
      : [],
    [
      ...(options.jumpToTrigger && options.triggerSeq !== undefined
        ? [
            {
              label: t("跳到在处理的 #{0}", { 0: options.triggerSeq }),
              onSelect: options.jumpToTrigger,
            },
          ]
        : []),
      ...(options.mention
        ? [{ label: t("@ {0}", { 0: options.agentName }), onSelect: options.mention }]
        : []),
    ],
    options.stop ? [{ label: t("停止这一轮"), danger: true, onSelect: options.stop }] : [],
  ];
  return groups
    .filter((group) => group.length > 0)
    .flatMap((group, index) => (index === 0 ? group : ["separator" as const, ...group]));
}

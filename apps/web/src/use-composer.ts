import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { ChatMessage, Invocation, Participant } from "@superhive/protocol";
import {
  applyMention,
  draftMentions,
  filterMentionParticipants,
  recentMentionOrder,
  findMentionContext,
  type MentionContext,
} from "./mention-autocomplete";
import { createClientMessageId } from "./client-id";
import { composerHistory, stepComposerHistory } from "./composer-history";
import type { ComposerHandle, ComposerKeyInfo } from "./rich-composer";
import { MAX_MESSAGE_LENGTH } from "./collapsible-message";
import { useAttachmentQueue } from "./attachments";
import { desktopBridge } from "./desktop-bridge";
import { pickedToFiles } from "./desktop-files";
import { t } from "./i18n";
import {
  storedUsernameKey,
  storedAutoSaveDraftKey,
  storedBoolean,
  draftStorageKey,
  type SendShortcut,
} from "./app-storage";
import { initialRoomId } from "./rooms";
import { resizeComposer, highlightOffsetX } from "./composer-size";
import { buildQuoteBlock, draftQuotes, insertQuote } from "./message-quote";

/**
 * 输入框：草稿（按房间自动保存）、@ 成员补全、方向键翻历史、附件队列、回答提问，以及发送。
 * 界面在 Composer 组件里
 */
export function useComposer({
  username,
  currentRoomId,
  participants,
  messages,
  invocations,
  autoSaveDraft,
  sendShortcut,
  richComposer,
  currentLeadAgent,
  base,
  authToken,
  socketRef,
  interceptCommand,
}: {
  username: string;
  currentRoomId: string;
  participants: Participant[];
  messages: ChatMessage[];
  invocations: ReadonlyMap<string, Invocation>;
  autoSaveDraft: boolean;
  sendShortcut: SendShortcut;
  richComposer: boolean;
  currentLeadAgent: string | undefined;
  base: string;
  authToken: string | undefined;
  socketRef: RefObject<WebSocket | undefined>;
  /** 发送前先问一下：插件认领了这条 /命令就返回 true，清空输入框但不发出去 */
  interceptCommand?: (content: string) => boolean;
}) {
  // 正在回答的 Agent 提问；发送时作为 replyToMessageId
  const [answering, setAnswering] = useState<ChatMessage>();
  // 引用回复的原消息：草稿里还留着它的引用块时，发送带上 quotedMessageId
  const [quoting, setQuoting] = useState<{ messageId: string; seq: number; roomId: string }>();
  const [draft, setDraft] = useState(() => {
    const storedUsername = localStorage.getItem(storedUsernameKey) ?? "";
    return storedUsername && storedBoolean(storedAutoSaveDraftKey, true)
      ? (localStorage.getItem(draftStorageKey(storedUsername, initialRoomId())) ?? "")
      : "";
  });
  const [mentionContext, setMentionContext] = useState<MentionContext>();
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const composingRef = useRef(false);
  const draftContextRef = useRef(`${username}:${initialRoomId()}`);
  /** 纯文本模式下就是 textarea 本身；所见即所得模式下是编辑器给的同名方法 */
  const textareaRef = useRef<ComposerHandle | null>(null);
  /** 输入框：预览 Markdown 效果、展开成大输入框 */
  const [composerPreview, setComposerPreview] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  /** 打开或刷新页面后，输入框出现时自动聚焦一次（触屏不聚焦，免得一进来就弹出键盘） */
  const composerAutoFocused = useRef(false);
  const attachComposer = useCallback((element: ComposerHandle | null) => {
    textareaRef.current = element;
    if (!element || composerAutoFocused.current) return;
    composerAutoFocused.current = true;
    if (window.matchMedia?.("(hover: none)").matches) return;
    window.requestAnimationFrame(() => {
      // 已经有别的地方拿到焦点（弹窗、搜索框）就不抢
      const active = document.activeElement;
      if (active && active !== document.body) return;
      // 所见即所得编辑器加载完会顶替先挂上的纯文本输入框，聚焦当下的那个
      textareaRef.current?.focus({ preventScroll: true });
    });
  }, []);
  const browsingHistoryRef = useRef<string | undefined>(undefined);
  const highlightRef = useRef<HTMLDivElement>(null);
  const attachmentQueue = useAttachmentQueue({ base, token: authToken, roomId: currentRoomId });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<string>();
  const [dragActive, setDragActive] = useState(false);
  function addAttachments(files: File[], extraNotice?: string) {
    if (files.length === 0) {
      if (extraNotice) setAttachmentNotice(extraNotice);
      return;
    }
    setAttachmentNotice(attachmentQueue.add(files) ?? extraNotice);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }
  /**
   * 附件按钮：桌面端用系统选文件窗口，默认打开房间绑定的工作区；
   * 浏览器（或老版本桌面端）照旧用 <input type=file>，浏览器不能指定起始目录。
   */
  function openFilePicker() {
    const files = desktopBridge()?.files;
    if (!files) {
      fileInputRef.current?.click();
      return;
    }
    files
      .pick({ roomId: currentRoomId, multiple: true })
      .then((result) => {
        if (result.canceled) return;
        const { files: picked, notice } = pickedToFiles(result.files);
        addAttachments(picked, notice);
      })
      // 桌面端这条路走不通（比如来源校验没过）：退回网页自己的选文件
      .catch(() => fileInputRef.current?.click());
  }
  const recentMentions = useMemo(
    () => recentMentionOrder(messages, username),
    [messages, username],
  );
  const mentionSuggestions = useMemo(
    () =>
      mentionContext
        ? filterMentionParticipants(
            participants,
            mentionContext.query,
            username,
            undefined,
            recentMentions,
            mentionContext.attached,
          )
        : [],
    [mentionContext, participants, username, recentMentions],
  );
  // 候选面板贴着 @ 的位置弹出（输入框很宽时不用把视线挪回最左边）；靠右时往回收，不超出输入区
  const mentionMenuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = mentionMenuRef.current;
    const parent = menu?.offsetParent as HTMLElement | null | undefined;
    if (!menu || !parent) return;
    const anchorX = mentionContext?.anchorX;
    if (anchorX === undefined) {
      menu.style.left = "";
      return;
    }
    const room = parent.clientWidth - menu.offsetWidth;
    const left = anchorX - parent.getBoundingClientRect().left - 12;
    menu.style.left = `${Math.max(0, Math.min(left, room))}px`;
  }, [mentionContext]);
  // 点输入框和面板以外的地方就收起面板
  useEffect(() => {
    if (!mentionContext) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".mention-menu, .composer-box")) return;
      setMentionContext(undefined);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [mentionContext]);
  const activeMentionId = mentionSuggestions[activeMentionIndex]?.id;
  useEffect(() => {
    if (!activeMentionId) return;
    document
      .getElementById(`mention-option-${activeMentionId}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeMentionId]);

  useEffect(() => {
    const contextKey = `${username}:${currentRoomId}`;
    if (draftContextRef.current !== contextKey) {
      draftContextRef.current = contextKey;
      browsingHistoryRef.current = undefined;
      setDraft(
        username && autoSaveDraft
          ? (localStorage.getItem(draftStorageKey(username, currentRoomId)) ?? "")
          : "",
      );
      setMentionContext(undefined);
      setQuoting(undefined);
    }
  }, [autoSaveDraft, currentRoomId, username]);

  useEffect(() => {
    if (!username || !autoSaveDraft || draftContextRef.current !== `${username}:${currentRoomId}`) {
      return;
    }
    const key = draftStorageKey(username, currentRoomId);
    // 方向键翻到的旧消息没改过就不算草稿，刷新后不该留在输入框里
    if (draft && draft !== browsingHistoryRef.current) localStorage.setItem(key, draft);
    else localStorage.removeItem(key);
  }, [autoSaveDraft, currentRoomId, draft, username]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!(textarea instanceof HTMLTextAreaElement)) return;
    resizeComposer(textarea, composerExpanded);
    if (highlightRef.current) highlightRef.current.scrollTop = textarea.scrollTop;
  }, [draft, username, composerExpanded, composerPreview, richComposer]);
  // 窗口大小变了，输入框的最高高度跟着变
  useEffect(() => {
    const onResize = () => {
      const textarea = textareaRef.current;
      if (textarea instanceof HTMLTextAreaElement) resizeComposer(textarea, composerExpanded);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [composerExpanded]);

  const draftTooLong = draft.trim().length > MAX_MESSAGE_LENGTH;

  // 有附件在上传或上传失败时不能发：失败的要先重试或移除，避免悄悄丢掉
  const attachmentsBlocking = attachmentQueue.uploading || attachmentQueue.failed;
  // 草稿里 @ 到的、正在这个房间执行任务、支持引导的 Agent：可以直接「引导」
  const steerTargets = (() => {
    const named = new Set(
      [...draft.matchAll(/@([\p{L}\p{N}_.-]+)/gu)].map((match) => match[1]!.toLocaleLowerCase()),
    );
    if (named.size === 0) return [];
    const running = new Set(
      [...invocations.values()]
        .filter((item) => item.status === "running" && item.roomId === currentRoomId)
        .map((item) => item.agentId),
    );
    return participants
      .filter(
        (participant) =>
          participant.type === "agent" &&
          named.has(participant.username.toLocaleLowerCase()) &&
          running.has(participant.id) &&
          ["claude", "codex", "opencode", "omp"].includes(participant.provider ?? ""),
      )
      .map((participant) => participant.username);
  })();
  const canSend =
    (Boolean(draft.trim()) || attachmentQueue.readyIds.length > 0) &&
    !draftTooLong &&
    !attachmentsBlocking;

  function sendMessage(steer = false) {
    const content = draft.trim();
    const socket = socketRef.current;
    const attachmentIds = attachmentQueue.readyIds;
    if (!content && attachmentIds.length === 0) return;
    if (content.length > MAX_MESSAGE_LENGTH || attachmentsBlocking) return;
    // 带附件的不算命令；插件命令不经过 Server，断线时也能用
    if (attachmentIds.length === 0 && !steer && interceptCommand?.(content)) {
      setDraft("");
      setComposerPreview(false);
      setComposerExpanded(false);
      setMentionContext(undefined);
      return;
    }
    if (socket?.readyState !== WebSocket.OPEN) return;
    // 回答提问时带上回复关系：服务端据此把答案交回提问的 Agent，不必再 @ 它
    const replyTo = answering && answering.roomId === currentRoomId ? answering.id : undefined;
    const quoted =
      quoting && quoting.roomId === currentRoomId && draftQuotes(content, quoting.seq)
        ? quoting.messageId
        : undefined;
    socket.send(
      JSON.stringify({
        type: "message.send",
        clientMessageId: createClientMessageId(),
        content,
        ...(attachmentIds.length ? { attachmentIds } : {}),
        ...(replyTo ? { replyToMessageId: replyTo } : {}),
        ...(quoted ? { quotedMessageId: quoted } : {}),
        ...(steer ? { steer: true } : {}),
      }),
    );
    attachmentQueue.clear();
    setAttachmentNotice(undefined);
    setDraft("");
    setComposerPreview(false);
    // 发完长内容自动收回，免得输入框一直占着半屏
    setComposerExpanded(false);
    setMentionContext(undefined);
    setAnswering(undefined);
    setQuoting(undefined);
  }

  function answerQuestion(question: ChatMessage) {
    setAnswering(question);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }

  /** 紧贴文字的 @（abc@）名字开头对不上任何在线成员就不弹，打邮箱时不打扰 */
  function visibleMention(context: MentionContext | undefined) {
    if (!context?.attached) return context;
    return filterMentionParticipants(participants, context.query, username, 1, [], true).length
      ? context
      : undefined;
  }

  function updateMentionContext(value: string, cursor: number | null) {
    const nextContext = visibleMention(findMentionContext(value, cursor ?? value.length));
    // 纯文本输入框：用背后排版一致的高亮层量出 @ 所在的横坐标，候选面板跟着它
    const anchorX = nextContext
      ? highlightOffsetX(highlightRef.current, nextContext.start)
      : undefined;
    setMentionContext(
      nextContext && anchorX !== undefined ? { ...nextContext, anchorX } : nextContext,
    );
    setActiveMentionIndex(0);
  }

  function showHistoryEntry(text: string) {
    browsingHistoryRef.current = text || undefined;
    setDraft(text);
    setMentionContext(undefined);
    window.requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(text.length, text.length);
    });
  }

  /** 输入框的按键：发送、选 @ 成员、翻历史。返回 true 表示已处理，调用方阻止默认行为 */
  function handleComposerKey(event: KeyboardEvent, caret: ComposerKeyInfo): boolean {
    if (event.isComposing || event.keyCode === 229) return false;
    if (event.key === "Enter" && !event.shiftKey && (event.metaKey || event.ctrlKey)) {
      sendMessage();
      return true;
    }
    if (mentionContext && event.key === "ArrowDown") {
      setActiveMentionIndex((index) =>
        mentionSuggestions.length ? (index + 1) % mentionSuggestions.length : 0,
      );
      return true;
    }
    if (mentionContext && event.key === "ArrowUp") {
      setActiveMentionIndex((index) =>
        mentionSuggestions.length
          ? (index - 1 + mentionSuggestions.length) % mentionSuggestions.length
          : 0,
      );
      return true;
    }
    if (mentionContext && event.key === "Escape") {
      setMentionContext(undefined);
      return true;
    }
    if (
      mentionContext &&
      mentionSuggestions[activeMentionIndex] &&
      (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))
    ) {
      chooseMention(mentionSuggestions[activeMentionIndex]);
      return true;
    }
    // 代码块里 Enter 是换行，要发送用组合键
    if (sendShortcut === "enter" && event.key === "Enter" && !event.shiftKey && !caret.inCode) {
      sendMessage();
      return true;
    }
    if (event.key === "Escape" && draft && draft === browsingHistoryRef.current) {
      showHistoryEntry("");
      return true;
    }
    if (
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey
    ) {
      const next = stepComposerHistory({
        history: composerHistory(messages, username),
        draft,
        browsing: browsingHistoryRef.current,
        direction: event.key === "ArrowUp" ? "older" : "newer",
        selectionStart: caret.selectionStart,
        selectionEnd: caret.selectionEnd,
      });
      if (next !== undefined) {
        showHistoryEntry(next);
        return true;
      }
    }
    return false;
  }

  function chooseMention(participant: Participant) {
    if (!mentionContext) return;
    if (textareaRef.current?.applyMention) {
      textareaRef.current.applyMention(participant.username);
      setMentionContext(undefined);
      setActiveMentionIndex(0);
      return;
    }
    const next = applyMention(draft, mentionContext, participant.username);
    setDraft(next.value);
    setMentionContext(undefined);
    setActiveMentionIndex(0);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.cursor, next.cursor);
    });
  }

  /**
   * 引用回复：输入框开头放一块引用（换掉上次的引用块），原来写的字接在下面，光标落到末尾。
   * selection 是右键时选中的那段文字；mention 是要顺手 @ 的 Agent
   */
  function quoteMessage(
    message: ChatMessage,
    options: { selection?: string; mention?: string } = {},
  ) {
    const block = buildQuoteBlock({
      seq: message.seq,
      senderName: message.senderName,
      content: message.content,
      selection: options.selection,
    });
    const next = insertQuote(draft, block, options.mention);
    browsingHistoryRef.current = undefined;
    setDraft(next.value);
    setQuoting({ messageId: message.id, seq: message.seq, roomId: message.roomId });
    setMentionContext(undefined);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.cursor, next.cursor);
    });
  }

  function appendMention(usernameToMention: string) {
    // 已经 @ 过就不再重复追加，只把焦点放回输入框
    if (draftMentions(draft, usernameToMention)) {
      setMentionContext(undefined);
      window.requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    const separator = draft && !draft.endsWith(" ") ? " " : "";
    const nextValue = `${draft}${separator}@${usernameToMention} `;
    setDraft(nextValue);
    setMentionContext(undefined);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextValue.length, nextValue.length);
    });
  }

  const composerPlaceholder = currentLeadAgent
    ? t("发送消息，不 @ 时交给主 Agent {0}…", { 0: currentLeadAgent })
    : t("发送消息，输入 @ 选择成员…");

  return {
    answering,
    setAnswering,
    quoting,
    quoteMessage,
    draft,
    setDraft,
    mentionContext,
    setMentionContext,
    activeMentionIndex,
    setActiveMentionIndex,
    composingRef,
    textareaRef,
    composerPreview,
    setComposerPreview,
    composerExpanded,
    setComposerExpanded,
    attachComposer,
    browsingHistoryRef,
    highlightRef,
    attachmentQueue,
    fileInputRef,
    attachmentNotice,
    dragActive,
    setDragActive,
    addAttachments,
    openFilePicker,
    mentionSuggestions,
    mentionMenuRef,
    draftTooLong,
    steerTargets,
    canSend,
    sendMessage,
    answerQuestion,
    visibleMention,
    updateMentionContext,
    handleComposerKey,
    chooseMention,
    appendMention,
    composerPlaceholder,
  };
}

export type ComposerState = ReturnType<typeof useComposer>;

import {
  Fragment,
  Suspense,
  useCallback,
  useMemo,
  useState,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type SetStateAction,
} from "react";
import { RoomLoading } from "./room-loading";
import { RoomTimelineLoading } from "./room-timeline-loading";
import type { LoadingStatus } from "./loading-status";
import type {
  Attachment,
  ChatMessage,
  Invocation,
  LocalAgent,
  Participant,
  QuestionAnswer,
  TraceStep,
} from "@superhive/protocol";
import {
  InvocationChips,
  canCancelInvocation,
  canRetryInvocation,
  isExtendableBlock,
  retryLabel,
  groupInvocationsByMessage,
  guestCanStopTurn,
  waitingInvocationForQuestion,
} from "./invocations";
import { plainPreview } from "./activity";
import { attentionTarget, questionOf } from "./attention";
import {
  ThinkingCard,
  TraceRecap,
  cardAttention,
  groupLiveCards,
  showsCard,
  showsLiveCard,
  sortCards,
} from "./thinking-card";
import { isMachineMessage, machinePreview, splitMentions } from "./machine-message";
import { ShadowContent } from "./shadow-content";
import { CollapsibleMessage } from "./collapsible-message";
import { QuestionOptions } from "./question-options";
import { messageBodyContent } from "./server-text";
import type { GuestAccess } from "./access-gate";
import { MessageAttachments } from "./attachments";
import { agentActivity } from "./agent-activity";
import { IM_CHANNEL_LABELS } from "./im-api";
import { getLocale, t } from "./i18n";
import type { TimeFormat } from "./app-storage";
import { Icon, HiveLogo } from "./app-icons";
import { AvatarGlyph, avatarHueStyle } from "./avatar";
import { dateDividerLabel } from "./timeline";
import { MessageMarkdown } from "./message-markdown-lazy";
import type { MessageScroll } from "./use-message-scroll";
import type { useMessageJump, useMessageWindow } from "./use-message-timeline";
import type { ShareSelection } from "./share-bar";
import type { ComposerState } from "./use-composer";
import type { MessageActions } from "./use-message-actions";
import { Tooltip } from "./tooltip";
import { Button, IconButton } from "./button";
import { contextMenuPoint, type ContextMenuState } from "./context-menu";
import { messageMenuItems, thinkingCardMenuItems } from "./message-menu";
import { isEditableTarget, menuTargetOf, selectedTextWithin } from "./message-selection";
import { splitQuote } from "./message-quote";

type SenderMenuOpener = (
  event: ReactMouseEvent<HTMLElement>,
  sender: { id?: string; name: string },
) => void;
/** Agent 回复所回应的那条消息；没载入时没有序号和预览，点了再按 seq 往前补拉 */
type ReplyTarget = {
  messageId: string;
  seq?: number;
  preview?: string;
  /** 产生这条回复的那次调用：跳回去时原消息下它的状态条也闪一下 */
  invocationId?: string;
};

type DockPreview = (attachment: Attachment, origin: { senderId: string; seq: number }) => void;
type MenuOpener = (menu: ContextMenuState) => void;
/** 这条消息引用的原消息；excerpt / body 是从正文开头拆出来的引用块和其余正文 */
type QuoteState = {
  messageId: string;
  seq: number;
  senderName: string;
  /** 原消息已撤回或不在了 */
  gone: boolean;
  loaded: boolean;
  excerpt?: string;
  body?: string;
  /** 这是对 Agent 提问的回答：卡片标「回答」，摘录是提问本身；正文照常显示 */
  answer?: boolean;
};

/** 对话流：消息、日期与话题分隔、Agent 的「思考中」卡片和「正在处理」一行 */
export function MessageList({
  scroll,
  win,
  jump,
  share,
  composer,
  actions,
  messages,
  messagesLoaded,
  initialLoading = false,
  loadingStatus,
  currentRoomName,
  currentRoomId,
  currentRoomWorkspace,
  username,
  guest,
  isOwner,
  base,
  authToken,
  connectionState,
  participants,
  invocations,
  traces,
  pendingApprovals,
  agentProviderByName,
  timeFormat,
  openMachineIds,
  setOpenMachineIds,
  openSenderMenu,
  openContextMenu,
  locateMessageFromMarkdown,
  onRecordTodo,
  dockPreview,
  setRetryModelFor,
  localAgentFor,
  openAgentTerminal,
  openProxySettings,
  canViewWorkspace,
  openWorkspaceFor,
}: {
  scroll: MessageScroll;
  win: ReturnType<typeof useMessageWindow>;
  jump: ReturnType<typeof useMessageJump>;
  share: ShareSelection;
  composer: ComposerState;
  actions: MessageActions;
  messages: ChatMessage[];
  messagesLoaded: boolean;
  initialLoading?: boolean;
  loadingStatus?: LoadingStatus;
  currentRoomName: string;
  currentRoomId: string;
  currentRoomWorkspace: string | undefined;
  username: string;
  guest: GuestAccess | undefined;
  isOwner: boolean;
  base: string;
  authToken: string | undefined;
  connectionState: "connecting" | "online" | "offline";
  participants: Participant[];
  invocations: ReadonlyMap<string, Invocation>;
  traces: ReadonlyMap<string, TraceStep[]>;
  pendingApprovals: ReadonlySet<string>;
  agentProviderByName: ReadonlyMap<string, string | undefined>;
  timeFormat: TimeFormat;
  openMachineIds: ReadonlySet<string>;
  setOpenMachineIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  openSenderMenu: SenderMenuOpener;
  /** 消息、执行中卡片的右键菜单：和成员右键用同一个菜单组件 */
  openContextMenu: MenuOpener;
  locateMessageFromMarkdown: (target: { messageId: string; messageSeq: number }) => void;
  onRecordTodo?: ((message: ChatMessage) => Promise<void>) | undefined;
  dockPreview: DockPreview;
  setRetryModelFor: Dispatch<SetStateAction<Invocation | undefined>>;
  localAgentFor: (name: string) => LocalAgent | undefined;
  openAgentTerminal: (agent: LocalAgent) => Promise<void>;
  /** 设置 → 这台电脑 → 网络代理：本机 Agent 连不上模型服务时的入口 */
  openProxySettings?: (() => void) | undefined;
  canViewWorkspace: boolean;
  openWorkspaceFor: (agent: string) => void;
}) {
  const {
    messageListRef,
    setShadowHost,
    shadowHost,
    handleMessageListScroll,
    messageScrollContentRef,
    setScrollContentElement,
    captureScrollAnchor,
    messagesEndRef,
  } = scroll;
  const {
    hiddenCount,
    setVisibleLimit,
    earlierTopicCount,
    currentTopic,
    setExpandedTopicId,
    timeline,
  } = win;
  const { jumpToMessage } = jump;
  const { textareaRef } = composer;
  const agentNames = useMemo(
    () =>
      new Set(
        participants
          .filter((participant) => participant.type === "agent")
          .map((participant) => participant.username.toLocaleLowerCase()),
      ),
    [participants],
  );
  const isMachine = (message: ChatMessage) =>
    isMachineMessage(message, (name) => agentNames.has(name.toLocaleLowerCase()));
  const invocationsByMessage = useMemo(() => groupInvocationsByMessage(invocations), [invocations]);
  const recalledMessageIds = useMemo(
    () => new Set(messages.filter((message) => message.deletedAt).map((message) => message.id)),
    [messages],
  );
  /** 回复消息 → 产生它的那次调用：回复上方显示这一轮过程的回顾 */
  const invocationByReply = useMemo(() => {
    const byReply = new Map<string, Invocation>();
    for (const invocation of invocations.values()) {
      if (
        invocation.replyMessageId &&
        !invocation.messageRecalled &&
        !recalledMessageIds.has(invocation.messageId)
      )
        byReply.set(invocation.replyMessageId, invocation);
    }
    return byReply;
  }, [invocations, recalledMessageIds]);
  // 对话流底部的「思考中」过程卡：执行中的每人一张（合批的几条算一张），等你回答、等你决定的各一张
  const liveCards = useMemo(
    () =>
      groupLiveCards(
        sortCards(
          [...invocations.values()].filter(
            (invocation) =>
              invocation.roomId === currentRoomId &&
              !invocation.messageRecalled &&
              !recalledMessageIds.has(invocation.messageId) &&
              (showsLiveCard(invocation) ||
                (cardAttention(invocation) === "decide" ? isOwner : showsCard(invocation))),
          ),
        ),
      ),
    [invocations, currentRoomId, recalledMessageIds, isOwner],
  );
  /**
   * 调用 → 对话流里展示它过程的那张卡：合批的几条指向同一张；排队中的还没开工，
   * 指向同一个 Agent 正在做的那张，看看它在忙什么
   */
  const processCardOf = useMemo(() => {
    const cardOf = new Map<string, string>();
    const liveByAgent = new Map<string, string>();
    for (const { invocation, batch } of liveCards) {
      for (const item of batch) cardOf.set(item.id, invocation.id);
      if (!cardAttention(invocation) && !liveByAgent.has(invocation.agentId))
        liveByAgent.set(invocation.agentId, invocation.id);
    }
    for (const invocation of invocations.values()) {
      if (invocation.status !== "queued" || cardOf.has(invocation.id)) continue;
      const card = liveByAgent.get(invocation.agentId);
      if (card) cardOf.set(invocation.id, card);
    }
    return cardOf;
  }, [liveCards, invocations]);
  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  // 展开着的「这一轮过程」回顾：回复的右键「看这一轮过程」从这里打开
  const [openRecapIds, setOpenRecapIds] = useState<ReadonlySet<string>>(() => new Set());
  const setRecapOpen = useCallback((invocationId: string, open: boolean) => {
    setOpenRecapIds((current) => {
      if (current.has(invocationId) === open) return current;
      const next = new Set(current);
      if (open) next.add(invocationId);
      else next.delete(invocationId);
      return next;
    });
  }, []);
  /** 展开回复上方的过程回顾并滚到它 */
  const revealRecap = useCallback(
    (invocationId: string) => {
      setRecapOpen(invocationId, true);
      window.requestAnimationFrame(() => {
        const list = messageListRef.current;
        const root = list?.shadowRoot ?? list;
        root
          ?.querySelector<HTMLElement>(`.trace-recap[data-invocation-id="${invocationId}"]`)
          ?.scrollIntoView({ block: "nearest" });
      });
    },
    [setRecapOpen, messageListRef],
  );
  const traceAllowed = !guest || guest.showTrace !== false;
  // 访客邀请没开「可以 @ Agent」时，菜单里不给 @ Agent、引用 Agent 也不自动补 @
  const canMentionAgents = !guest || guest.allowAgents !== false;
  /**
   * Agent 的回复在回应哪条消息：产生它的那次调用的触发消息，没有调用记录（刷新后）时按 parentMessageId。
   * 进度、提问、委派、回执这些中间消息不算；原消息撤回了不给入口
   */
  const replyTargetOf = useCallback(
    (message: ChatMessage): ReplyTarget | undefined => {
      if (message.deletedAt || message.senderType !== "agent" || message.kind) return undefined;
      const source = invocationByReply.get(message.id);
      const messageId = source?.messageId ?? message.parentMessageId;
      if (!messageId || recalledMessageIds.has(messageId)) return undefined;
      const trigger = messageById.get(messageId);
      return {
        messageId,
        ...(trigger
          ? { seq: trigger.seq, preview: plainPreview(trigger.content).slice(0, 120) }
          : {}),
        ...(source ? { invocationId: source.id } : {}),
      };
    },
    [invocationByReply, recalledMessageIds, messageById],
  );
  // 点选提交的答案按提问归档，用来在提问上高亮所选；先到的一条生效
  const choiceAnswers = useMemo(() => {
    const answers = new Map<string, QuestionAnswer>();
    for (const message of messages) {
      if (message.answer && !message.deletedAt && !answers.has(message.answer.questionMessageId)) {
        answers.set(message.answer.questionMessageId, message.answer);
      }
    }
    return answers;
  }, [messages]);
  const loadedMessageIds = useMemo(
    () => new Set(messages.filter((message) => !message.deletedAt).map((message) => message.id)),
    [messages],
  );
  /**
   * 回答 Agent 提问的消息（点选回答，或手打回复了一条提问）：顶上画一张「回答 #N」卡片，
   * 隔了很久才回答时也看得出答的是哪一问；点了跳回提问。
   */
  const answerStateOf = useCallback(
    (message: ChatMessage): QuoteState | undefined => {
      if (message.senderType !== "human") return undefined;
      const questionId = message.answer?.questionMessageId ?? message.replyToMessageId;
      if (!questionId) return undefined;
      const question = messageById.get(questionId);
      if (question ? question.kind !== "question" : !message.answer) return undefined;
      const seq = question?.seq ?? message.answer?.questionSeq;
      if (!seq) return undefined;
      const excerpt = question?.content
        ? plainPreview(question.content)
            .replace(/^(?:@\S+\s+)*❓\s*/u, "")
            .slice(0, 120)
        : undefined;
      return {
        messageId: questionId,
        seq,
        senderName: question?.senderName ?? "",
        gone: recalledMessageIds.has(questionId) || Boolean(question?.deletedAt),
        loaded: loadedMessageIds.has(questionId),
        answer: true,
        ...(excerpt ? { excerpt } : {}),
      };
    },
    [messageById, recalledMessageIds, loadedMessageIds],
  );
  /** 引用了别的消息：正文开头的引用块拆出来画成卡片；原消息撤回了只说「不可见」 */
  const quoteStateOf = useCallback(
    (message: ChatMessage): QuoteState | undefined => {
      if (message.deletedAt) return undefined;
      if (!message.quote) return answerStateOf(message);
      const { messageId, seq, senderName } = message.quote;
      const split = splitQuote(messageBodyContent(message), seq);
      const original = messageById.get(messageId);
      return {
        messageId,
        seq,
        senderName,
        gone: recalledMessageIds.has(messageId) || Boolean(original?.deletedAt),
        loaded: loadedMessageIds.has(messageId),
        ...(split ? { excerpt: split.excerpt, body: split.body } : {}),
      };
    },
    [messageById, recalledMessageIds, loadedMessageIds, answerStateOf],
  );
  const formatMessageTime = useCallback(
    (iso: string) =>
      new Date(iso).toLocaleTimeString(getLocale(), {
        hour: "2-digit",
        minute: "2-digit",
        ...(timeFormat === "system" ? {} : { hour12: timeFormat === "12h" }),
      }),
    [timeFormat],
  );
  return (
    <div
      ref={(element) => {
        messageListRef.current = element;
        setShadowHost((current) => (current === element ? current : element));
      }}
      className="message-list"
      role="log"
      aria-label={t("聊天室消息")}
      aria-live="polite"
      onScroll={handleMessageListScroll}
    >
      <ShadowContent host={shadowHost}>
        <div className="message-shadow-inner">
          {!messagesLoaded &&
            (initialLoading ? (
              <RoomLoading key={currentRoomId} {...(loadingStatus ?? { phase: "messages" })} />
            ) : (
              <RoomTimelineLoading key={currentRoomId} {...loadingStatus} />
            ))}
          {messagesLoaded && messages.length === 0 && (
            <div className="empty-state">
              <HiveLogo />
              <h2>{t("今天在 #{0} 协作什么？", { 0: currentRoomName })}</h2>
              <p>
                {t("发出第一条消息，或输入")} <code>@agent-name</code> {t("邀请一个 Agent 参与。")}
              </p>
              <Button onClick={() => textareaRef.current?.focus()}>
                <span>{t("开始一条消息")}</span>
                <Icon name="arrow-right" size={16} />
              </Button>
            </div>
          )}
          <div
            className="message-scroll-content"
            ref={(element) => {
              messageScrollContentRef.current = element;
              setScrollContentElement((current) => (current === element ? current : element));
            }}
          >
            {hiddenCount > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                className="load-earlier"
                onClick={() => {
                  captureScrollAnchor();
                  setVisibleLimit((current) => current + 100);
                }}
              >
                {t("显示更早的 {0} 条消息（共隐藏 {1} 条）", {
                  0: Math.min(hiddenCount, 100),
                  1: hiddenCount,
                })}
              </Button>
            ) : (
              earlierTopicCount > 0 &&
              currentTopic && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="load-earlier"
                  onClick={() => {
                    captureScrollAnchor();
                    setExpandedTopicId(currentTopic.id);
                  }}
                >
                  {t("显示更早的话题（{0} 条消息）", { 0: earlierTopicCount })}
                </Button>
              )
            )}
            {timeline.map(({ message, newDay, grouped }) => (
              <Fragment key={message.id}>
                {newDay && (
                  <div className="date-divider" role="separator">
                    <span>{dateDividerLabel(message.createdAt)}</span>
                  </div>
                )}
                {(() => {
                  // 这条是某次调用的回复：上方收着这一轮的过程（只在内存里，刷新后没有）
                  const source = message.deletedAt ? undefined : invocationByReply.get(message.id);
                  const steps = source ? traces.get(source.id) : undefined;
                  return source && steps?.length ? (
                    <TraceRecap
                      invocation={source}
                      steps={steps}
                      replyText={message.content}
                      open={openRecapIds.has(source.id)}
                      onOpenChange={(open) => setRecapOpen(source.id, open)}
                    />
                  ) : null;
                })()}
                {message.kind === "topic" ? (
                  <div className="topic-divider" role="separator" data-message-id={message.id}>
                    <span>
                      {message.content} · {formatMessageTime(message.createdAt)}
                    </span>
                    <small>{t("之前的消息不再作为 Agent 的上下文")}</small>
                  </div>
                ) : message.kind === "notice" ? (
                  // 服务端的房间提示（例如自动设了主 Agent）：一行居中的系统提示，不当成谁的发言
                  <div className="room-notice" role="note" data-message-id={message.id}>
                    <Icon name="users" size={13} />
                    <span>{message.content}</span>
                    <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time>
                  </div>
                ) : (
                  <MessageItem
                    message={message}
                    grouped={grouped}
                    isMachine={isMachine}
                    formatMessageTime={formatMessageTime}
                    invocationsByMessage={invocationsByMessage}
                    choiceAnswers={choiceAnswers}
                    loadedMessageIds={loadedMessageIds}
                    processCardOf={processCardOf}
                    replyTarget={replyTargetOf(message)}
                    replySource={message.deletedAt ? undefined : invocationByReply.get(message.id)}
                    quoteState={quoteStateOf(message)}
                    jump={jump}
                    share={share}
                    composer={composer}
                    actions={actions}
                    currentRoomWorkspace={currentRoomWorkspace}
                    username={username}
                    isOwner={isOwner}
                    base={base}
                    authToken={authToken}
                    connectionState={connectionState}
                    participants={participants}
                    invocations={invocations}
                    traces={traces}
                    pendingApprovals={pendingApprovals}
                    agentProviderByName={agentProviderByName}
                    openMachineIds={openMachineIds}
                    setOpenMachineIds={setOpenMachineIds}
                    openSenderMenu={openSenderMenu}
                    openContextMenu={openContextMenu}
                    traceAllowed={traceAllowed}
                    canMentionAgents={canMentionAgents}
                    guestName={guest ? username : undefined}
                    revealRecap={revealRecap}
                    releaseBottomPin={scroll.releaseBottomPin}
                    locateMessageFromMarkdown={locateMessageFromMarkdown}
                    onRecordTodo={onRecordTodo}
                    dockPreview={dockPreview}
                    setRetryModelFor={setRetryModelFor}
                    localAgentFor={localAgentFor}
                    openAgentTerminal={openAgentTerminal}
                    openProxySettings={openProxySettings}
                    canViewWorkspace={canViewWorkspace}
                    openWorkspaceFor={openWorkspaceFor}
                  />
                )}
              </Fragment>
            ))}
            {(() => {
              // 正在干活的 Agent：每人一张「思考中」卡片，出现在回复将来出现的位置；同时超过 3 张时只展开最新的。
              // 等你回答、等你决定（只给房主，按钮在房主这边）的也各一张，置顶并标醒目
              const cards = liveCards;
              const working = cards.filter((card) => !cardAttention(card.invocation));
              const latestWorking = working.at(-1);
              const seqOf = new Map(messages.map((message) => [message.id, message.seq]));
              return cards.map(({ invocation, batch }) => (
                <ThinkingCard
                  key={`card-${invocation.id}`}
                  invocation={invocation}
                  steps={
                    traces.get(invocation.id) ??
                    batch.map((item) => traces.get(item.id)).find(Boolean)
                  }
                  batchSeqs={batch
                    .map((item) => seqOf.get(item.messageId))
                    .filter((seq): seq is number => seq !== undefined)
                    .sort((a, b) => a - b)}
                  traceAllowed={!guest || guest.showTrace !== false}
                  // 只停这一轮：和触发消息下面的「停止」同一个操作，服务端收到任意一条就停整轮。
                  // 访客只能停全是自己发起的一轮（服务端同样这么判），停不了的不给按钮
                  {...(() => {
                    const live = batch.filter(
                      (item) => canCancelInvocation(item) || item.status === "cancelling",
                    );
                    if (!live.length) return {};
                    if (guest && !guestCanStopTurn(invocation, batch, username)) return {};
                    const target = live.find(canCancelInvocation);
                    return {
                      onStop: () => {
                        if (target) actions.cancelInvocation(target);
                      },
                    };
                  })()}
                  onAvatarContextMenu={(event) =>
                    openSenderMenu(event, {
                      id: invocation.agentId,
                      name: invocation.agentName,
                    })
                  }
                  onContextMenu={(event) => {
                    if (isEditableTarget(event.target)) return;
                    const first = [...batch]
                      .map((item) => messageById.get(item.messageId))
                      .filter((message): message is ChatMessage => Boolean(message))
                      .sort((a, b) => a.seq - b.seq)[0];
                    const live = batch.filter(canCancelInvocation);
                    const stoppable =
                      live.length > 0 && (!guest || guestCanStopTurn(invocation, batch, username));
                    event.preventDefault();
                    openContextMenu({
                      ...contextMenuPoint(event),
                      title: invocation.agentName,
                      items: thinkingCardMenuItems({
                        agentName: invocation.agentName,
                        selection: selectedTextWithin(event.currentTarget),
                        triggerSeq: first?.seq,
                        jumpToTrigger: first
                          ? () => {
                              jumpToMessage(first.id);
                              jump.flashOrigin({ invocationIds: batch.map((item) => item.id) });
                            }
                          : undefined,
                        mention:
                          canMentionAgents &&
                          invocation.agentName.toLocaleLowerCase() !== username.toLocaleLowerCase()
                            ? () => composer.appendMention(invocation.agentName)
                            : undefined,
                        copySelection: (text) => void actions.copyPlainText(text),
                        stop: stoppable ? () => actions.cancelInvocation(live[0]!) : undefined,
                      }),
                    });
                  }}
                  defaultCollapsed={
                    working.length > 3 && latestWorking?.invocation.id !== invocation.id
                  }
                  flashed={jump.flash.invocationIds.has(invocation.id)}
                  {...(() => {
                    // 卡片上写明在处理哪条消息；合批时引用最早的一条
                    const first = [...batch]
                      .map((item) => messageById.get(item.messageId))
                      .filter((message): message is ChatMessage => Boolean(message))
                      .sort((a, b) => a.seq - b.seq)[0];
                    if (!first) return {};
                    return {
                      trigger: {
                        seq: first.seq,
                        preview: plainPreview(first.content).slice(0, 120),
                      },
                      onJumpToTrigger: () => {
                        jumpToMessage(first.id);
                        // 原消息下的状态条和这张卡一起闪，看得出是哪一条对应这张卡
                        // batch 里包括这张卡自己那一条
                        jump.flashOrigin({ invocationIds: batch.map((item) => item.id) });
                      },
                    };
                  })()}
                  {...(cardAttention(invocation) === "question"
                    ? {
                        question: waitingQuestion(invocation, messages),
                        onJumpToQuestion: () => {
                          jump.locateAttention(invocation);
                          jump.flashOrigin({ invocationIds: [invocation.id] });
                        },
                      }
                    : {})}
                  avatar={
                    <AvatarGlyph
                      type="agent"
                      name={invocation.agentName}
                      provider={agentProviderByName.get(invocation.agentName.toLocaleLowerCase())}
                    />
                  }
                />
              ));
            })()}
            {(() => {
              // 谁在干活：已经有卡片的不再重复列出，只剩排队、等你回答这些没在跑的
              const all = agentActivity(participants, invocations.values(), currentRoomId).filter(
                (row) => !row.invocation || !showsLiveCard(row.invocation),
              );
              // 等你回答的单独一行：写明在问什么，给一个「看提问 #N」直接跳到那条提问
              const waiting = all.filter(
                (row): row is typeof row & { invocation: Invocation } =>
                  row.state === "waiting" && Boolean(row.invocation),
              );
              const rows = all.filter((row) => row.state !== "waiting");
              if (!rows.length && !waiting.length) return null;
              return (
                <>
                  {waiting.map((row) => {
                    const asked = waitingQuestion(row.invocation, messages);
                    return (
                      <div
                        key={row.participant.id}
                        className={`waiting-question${jump.flash.invocationIds.has(row.invocation.id) ? " jump-flash" : ""}`}
                        role="status"
                      >
                        <span className="mention-avatar agent" aria-hidden="true">
                          <AvatarGlyph
                            type="agent"
                            name={row.participant.username}
                            provider={row.participant.provider}
                          />
                        </span>
                        <span className="waiting-question-text">
                          <strong>{row.participant.username}</strong>
                          <span className="waiting-question-state">{t("在等你回答")}</span>
                          {asked.preview && (
                            <span className="waiting-question-preview" title={asked.preview}>
                              {asked.preview}
                            </span>
                          )}
                        </span>
                        <Button
                          size="sm"
                          variant="primary"
                          aria-label={
                            asked.seq
                              ? t("跳到 {0} 的提问 #{1}", {
                                  0: row.participant.username,
                                  1: asked.seq,
                                })
                              : t("跳到 {0} 的提问", { 0: row.participant.username })
                          }
                          onClick={() => {
                            jump.locateAttention(row.invocation);
                            jump.flashOrigin({ invocationIds: [row.invocation.id] });
                          }}
                        >
                          {asked.seq ? t("看提问 #{0}", { 0: asked.seq }) : t("看提问")}
                        </Button>
                      </div>
                    );
                  })}
                  {rows.length > 0 && (
                    <div className="typing" role="status" aria-live="polite">
                      <span aria-hidden="true" />
                      <span aria-hidden="true" />
                      <span aria-hidden="true" />
                      <ul className="typing-agents">
                        {rows.map((row) => {
                          const target = row.invocation?.messageId;
                          const canJump = Boolean(
                            row.invocation?.status === "waiting_human" ||
                            (target && loadedMessageIds.has(target)),
                          );
                          return (
                            <li key={row.participant.id}>
                              <Tooltip
                                content={
                                  canJump
                                    ? t("{0}，点击跳到它正在处理的消息", {
                                        0: row.participant.username,
                                      })
                                    : row.participant.username
                                }
                              >
                                <button
                                  type="button"
                                  className={`typing-agent ${row.state}`}
                                  disabled={!canJump}
                                  onClick={() => {
                                    if (row.invocation?.status === "waiting_human")
                                      jump.locateAttention(row.invocation);
                                    else if (target) jumpToMessage(target);
                                  }}
                                >
                                  <span className="mention-avatar agent" aria-hidden="true">
                                    <AvatarGlyph
                                      type="agent"
                                      name={row.participant.username}
                                      provider={row.participant.provider}
                                    />
                                  </span>
                                  <strong>{row.participant.username}</strong>
                                </button>
                              </Tooltip>
                            </li>
                          );
                        })}
                      </ul>
                      {/* 详细进展看气泡下的状态，这里只说谁在干活 */}
                      <span>{t("正在处理")}</span>
                    </div>
                  )}
                </>
              );
            })()}
            <div ref={messagesEndRef} />
          </div>
        </div>
      </ShadowContent>
    </div>
  );
}

/** 对话流里的一条消息：头像与名字、正文（Agent 之间的往来默认收成一行）、附件、提问选项、任务状态和操作按钮 */
function MessageItem({
  message,
  grouped,
  isMachine,
  formatMessageTime,
  invocationsByMessage,
  choiceAnswers,
  loadedMessageIds,
  processCardOf,
  replyTarget,
  replySource,
  quoteState,
  jump,
  share,
  composer,
  actions,
  currentRoomWorkspace,
  username,
  isOwner,
  base,
  authToken,
  connectionState,
  participants,
  invocations,
  traces,
  pendingApprovals,
  agentProviderByName,
  openMachineIds,
  setOpenMachineIds,
  openSenderMenu,
  openContextMenu,
  traceAllowed,
  canMentionAgents,
  guestName,
  revealRecap,
  releaseBottomPin,
  locateMessageFromMarkdown,
  onRecordTodo,
  dockPreview,
  setRetryModelFor,
  localAgentFor,
  openAgentTerminal,
  openProxySettings,
  canViewWorkspace,
  openWorkspaceFor,
}: {
  message: ChatMessage;
  grouped: boolean;
  isMachine: (message: ChatMessage) => boolean;
  formatMessageTime: (iso: string) => string;
  invocationsByMessage: ReadonlyMap<string, Invocation[]>;
  choiceAnswers: ReadonlyMap<string, QuestionAnswer>;
  loadedMessageIds: ReadonlySet<string>;
  processCardOf: ReadonlyMap<string, string>;
  replyTarget: ReplyTarget | undefined;
  /** 产生这条回复的那次调用（有过程记录时右键能「看这一轮过程」） */
  replySource: Invocation | undefined;
  quoteState: QuoteState | undefined;
  jump: ReturnType<typeof useMessageJump>;
  share: ShareSelection;
  composer: ComposerState;
  actions: MessageActions;
  currentRoomWorkspace: string | undefined;
  username: string;
  isOwner: boolean;
  base: string;
  authToken: string | undefined;
  connectionState: "connecting" | "online" | "offline";
  participants: Participant[];
  invocations: ReadonlyMap<string, Invocation>;
  traces: ReadonlyMap<string, TraceStep[]>;
  pendingApprovals: ReadonlySet<string>;
  agentProviderByName: ReadonlyMap<string, string | undefined>;
  openMachineIds: ReadonlySet<string>;
  setOpenMachineIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  openSenderMenu: SenderMenuOpener;
  openContextMenu: MenuOpener;
  traceAllowed: boolean;
  canMentionAgents: boolean;
  /** 访客的名字：访客只能停全是自己发起的一轮 */
  guestName: string | undefined;
  revealRecap: (invocationId: string) => void;
  releaseBottomPin: () => void;
  locateMessageFromMarkdown: (target: { messageId: string; messageSeq: number }) => void;
  onRecordTodo?: ((message: ChatMessage) => Promise<void>) | undefined;
  dockPreview: DockPreview;
  setRetryModelFor: Dispatch<SetStateAction<Invocation | undefined>>;
  localAgentFor: (name: string) => LocalAgent | undefined;
  openAgentTerminal: (agent: LocalAgent) => Promise<void>;
  /** 设置 → 这台电脑 → 网络代理：本机 Agent 连不上模型服务时的入口 */
  openProxySettings?: (() => void) | undefined;
  canViewWorkspace: boolean;
  openWorkspaceFor: (agent: string) => void;
}) {
  const {
    highlightedMessageId,
    pendingJumpId,
    jumpToMessage,
    jumpToProcess,
    locateMessage,
    flash,
    flashOrigin,
  } = jump;
  const { shareMode, selectedMessageIds, toggleMessageSelected } = share;
  const { answering, answerQuestion, appendMention } = composer;
  const {
    pendingAnswers,
    submitChoice,
    copiedMessageId,
    copySeqReference,
    copyMessageContent,
    recallCandidateId,
    setRecallCandidateId,
    recallMessage,
    retryInvocation,
    cancelInvocation,
    dismissInvocations,
    extendAgentBudget,
    steerInvocation,
    preemptInvocation,
    copyPlainText,
  } = actions;
  const bodyContent = messageBodyContent(message);
  const self = message.senderName.toLocaleLowerCase() === username.toLocaleLowerCase();
  /** 引用回复：引用 Agent 的话默认顺手 @ 它（访客不能 @ Agent 时不补） */
  const quoteThis = (selection?: string) =>
    composer.quoteMessage(
      { ...message, content: bodyContent },
      {
        ...(selection ? { selection } : {}),
        ...(message.senderType === "agent" && canMentionAgents && !self
          ? { mention: message.senderName }
          : {}),
      },
    );
  /**
   * 消息的右键菜单（也从操作条的「更多」按钮打开）：分享模式、已撤回的、点在输入框里的留给浏览器原生菜单。
   * anchor 是「更多」按钮：菜单贴着按钮弹出
   */
  const openMessageMenu = (event: ReactMouseEvent<HTMLElement>, anchor?: HTMLElement) => {
    if (shareMode || message.deletedAt || isEditableTarget(event.target)) return;
    const article = event.currentTarget.closest<HTMLElement>("article.message");
    if (!article) return;
    event.preventDefault();
    const selection = selectedTextWithin(article);
    const own = invocationsByMessage.get(message.id) ?? [];
    const online = (invocation: Invocation) =>
      participants.some((p) => p.id === invocation.agentId && p.status !== "offline");
    const cardInvocation = own.find((invocation) => processCardOf.has(invocation.id));
    const replySteps = replySource ? traces.get(replySource.id) : undefined;
    const point = anchor
      ? (() => {
          const rect = anchor.getBoundingClientRect();
          return { x: rect.right, y: rect.bottom + 4, align: "end" as const };
        })()
      : contextMenuPoint(event);
    openContextMenu({
      ...point,
      title: `#${message.seq} · ${message.senderName}`,
      items: messageMenuItems({
        seq: message.seq,
        senderName: message.senderName,
        selection,
        target: anchor ? {} : menuTargetOf(event.target, article),
        quote: quoteThis,
        copyText: () => void copyMessageContent(message),
        copySelection: (text) => void copyPlainText(text),
        copySeq: () => void copySeqReference(message),
        copyLink: () =>
          void copyPlainText(`[#${message.seq}](#message/${message.id}/${message.seq})`),
        copyValue: (value) => void copyPlainText(value),
        mention:
          !self && (message.senderType === "human" || canMentionAgents)
            ? () => appendMention(message.senderName)
            : undefined,
        showProcess: !traceAllowed
          ? undefined
          : replySource && replySteps?.length
            ? () => revealRecap(replySource.id)
            : cardInvocation
              ? () =>
                  void jumpToProcess(processCardOf.get(cardInvocation.id)!, {
                    invocationIds: [cardInvocation.id],
                  })
              : undefined,
        viewChanges:
          message.senderType === "agent" && canViewWorkspace && currentRoomWorkspace
            ? () => openWorkspaceFor(message.senderName)
            : undefined,
        recordTodo: onRecordTodo ? () => void onRecordTodo(message) : undefined,
        retries: own
          .filter(
            (invocation) =>
              !isExtendableBlock(invocation) &&
              canRetryInvocation(invocation, online(invocation)) &&
              (invocation.blockReason !== "guest_approval" || isOwner),
          )
          .map((invocation) => ({
            label: `${retryLabel(invocation)} @${invocation.agentName}`,
            run: () => retryInvocation(invocation),
          })),
        stops: own
          .filter(
            (invocation) =>
              canCancelInvocation(invocation) &&
              (!guestName || guestCanStopTurn(invocation, invocations.values(), guestName)),
          )
          .map((invocation) => ({
            label: t("停止 @{0}", { 0: invocation.agentName }),
            run: () => cancelInvocation(invocation),
          })),
        recall: self
          ? () => {
              setRecallCandidateId(message.id);
              // 确认条在操作条里：显示出来并把焦点放上去，键盘也能接着选
              window.requestAnimationFrame(() =>
                article.querySelector<HTMLButtonElement>(".message-recall-confirm button")?.focus(),
              );
            }
          : undefined,
      }),
    });
  };
  const replyLink = replyTarget && !shareMode && (
    <Tooltip
      content={
        replyTarget.seq !== undefined
          ? t("回应 #{0}：{1}", { 0: replyTarget.seq, 1: replyTarget.preview ?? "" })
          : t("跳到它回应的那条消息")
      }
    >
      <button
        type="button"
        className="message-reply-to"
        aria-label={
          replyTarget.seq !== undefined
            ? t("跳到原消息 #{0}：{1}", { 0: replyTarget.seq, 1: replyTarget.preview ?? "" })
            : t("跳到它回应的那条消息")
        }
        onClick={(event) => {
          event.stopPropagation();
          if (loadedMessageIds.has(replyTarget.messageId)) jumpToMessage(replyTarget.messageId);
          else
            // 不在已加载范围：原消息一定比回复早，从回复往前一段按 seq 补拉再定位
            void locateMessage({
              messageId: replyTarget.messageId,
              messageSeq: Math.max(1, message.seq - 5000),
            });
          flashOrigin({
            messageIds: [message.id],
            invocationIds: replyTarget.invocationId ? [replyTarget.invocationId] : [],
          });
        }}
      >
        <Icon name="arrow-up" size={11} />
        {replyTarget.seq !== undefined ? t("回应 #{0}", { 0: replyTarget.seq }) : t("回应原消息")}
      </button>
    </Tooltip>
  );
  return (
    <article
      className={`message ${message.senderType} ${
        message.senderType === "human" &&
        message.senderName.toLocaleLowerCase() === username.toLocaleLowerCase()
          ? "own"
          : ""
      } ${grouped ? "grouped" : ""} ${
        shareMode && !message.deletedAt ? "selectable" : ""
      } ${selectedMessageIds.has(message.id) ? "selected" : ""} ${
        message.deletedAt ? "deleted" : ""
      } ${highlightedMessageId === message.id || flash.messageIds.has(message.id) ? "highlighted" : ""} ${
        message.kind === "question" ? "question" : ""
      } ${message.kind === "progress" ? "progress-update" : ""} ${isMachine(message) ? "machine" : ""}`}
      data-message-id={message.id}
      style={message.senderType === "human" ? avatarHueStyle(message.senderName) : undefined}
      onClick={
        shareMode && !message.deletedAt ? () => toggleMessageSelected(message.id) : undefined
      }
      onContextMenu={openMessageMenu}
    >
      {grouped ? (
        <span className="hover-time" aria-hidden="true">
          {formatMessageTime(message.createdAt)}
        </span>
      ) : (
        <span
          className={`avatar ${message.senderType}`}
          aria-hidden="true"
          onContextMenu={(event) =>
            openSenderMenu(event, {
              id: message.senderId,
              name: message.senderName,
            })
          }
        >
          <AvatarGlyph
            type={message.senderType}
            name={message.senderName}
            provider={agentProviderByName.get(message.senderName.toLocaleLowerCase())}
          />
        </span>
      )}
      <div className="message-content">
        {message.kind === "progress" && grouped && (
          <span
            className="message-progress-tag"
            title={t("Agent 执行中途发来的进度，最终结论在它之后的回复里")}
          >
            {t("进度")}
          </span>
        )}
        {!grouped && (
          <header>
            {/* 名字也能右击，键盘聚焦后按菜单键或 Shift+F10 一样能打开 */}
            <strong
              className="message-sender"
              tabIndex={0}
              aria-haspopup="menu"
              onContextMenu={(event) =>
                openSenderMenu(event, {
                  id: message.senderId,
                  name: message.senderName,
                })
              }
            >
              {message.senderName}
            </strong>
            {message.senderType === "agent" && <b>Agent</b>}
            {message.kind === "progress" && (
              <span
                className="message-progress-tag"
                title={t("Agent 执行中途发来的进度，最终结论在它之后的回复里")}
              >
                {t("进度")}
              </span>
            )}
            {message.via && (
              <span className="message-via">
                {t("来自{0}", { 0: IM_CHANNEL_LABELS[message.via.channel] })}
              </span>
            )}
            <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time>
            <Tooltip content={t("复制序号引用（可用于在聊天中引用这条消息）")}>
              <button
                type="button"
                className="message-seq"
                aria-label={t("复制消息序号 #{0}", { 0: message.seq })}
                onClick={(event) => {
                  event.stopPropagation();
                  void copySeqReference(message);
                }}
              >
                {copiedMessageId === `seq:${message.id}` ? t("已复制") : `#${message.seq}`}
              </button>
            </Tooltip>
            {replyLink}
          </header>
        )}
        {grouped && replyLink && <div className="message-reply-to-row">{replyLink}</div>}
        {message.deletedAt ? (
          <p className="message-recalled">
            {message.senderName.toLocaleLowerCase() === username.toLocaleLowerCase()
              ? t("你撤回了一条消息")
              : t("{0} 撤回了一条消息", { 0: message.senderName })}
          </p>
        ) : isMachine(message) && !openMachineIds.has(message.id) ? (
          (() => {
            const preview = machinePreview(message);
            return (
              <Tooltip content={t("Agent 之间的往来，点开看全文")}>
                <button
                  type="button"
                  className="message-machine-card"
                  aria-expanded={false}
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenMachineIds((current) => new Set(current).add(message.id));
                  }}
                >
                  <span className="message-machine-label">
                    <span>
                      {splitMentions(preview.label).map((part, index) =>
                        part.mention ? <mark key={index}>{part.text}</mark> : part.text,
                      )}
                    </span>
                    <small>{t("展开")}</small>
                  </span>
                  {preview.text && (
                    <span className="message-machine-text">
                      {splitMentions(preview.text).map((part, index) =>
                        part.mention ? <mark key={index}>{part.text}</mark> : part.text,
                      )}
                    </span>
                  )}
                </button>
              </Tooltip>
            );
          })()
        ) : (
          message.content && (
            <div className="message-body">
              {isMachine(message) && (
                <button
                  type="button"
                  className="message-machine-collapse"
                  aria-expanded={true}
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenMachineIds((current) => {
                      const next = new Set(current);
                      next.delete(message.id);
                      return next;
                    });
                  }}
                >
                  {t("收起")}
                </button>
              )}
              {quoteState && (
                <QuoteCard
                  quote={quoteState}
                  onOpen={() => {
                    if (quoteState.loaded) jumpToMessage(quoteState.messageId);
                    else
                      void locateMessage({
                        messageId: quoteState.messageId,
                        messageSeq: quoteState.seq,
                      });
                    flashOrigin({ messageIds: [message.id] });
                  }}
                />
              )}
              {(quoteState?.body ?? bodyContent) && (
                <CollapsibleMessage
                  content={quoteState?.body ?? bodyContent}
                  enabled={message.senderType === "agent"}
                  storageKey={`superhive.message-expanded:${message.roomId}:${message.id}`}
                  expandOnLocate={
                    pendingJumpId === message.id || highlightedMessageId === message.id
                  }
                  forceExpanded={shareMode}
                  onToggle={releaseBottomPin}
                >
                  <Suspense
                    fallback={
                      <p className="message-body-fallback">{quoteState?.body ?? bodyContent}</p>
                    }
                  >
                    <MessageMarkdown
                      content={quoteState?.body ?? bodyContent}
                      onLocateMessage={locateMessageFromMarkdown}
                    />
                  </Suspense>
                </CollapsibleMessage>
              )}
            </div>
          )
        )}
        {!message.deletedAt && message.attachments?.length ? (
          <MessageAttachments
            attachments={message.attachments}
            base={base}
            token={authToken}
            onDock={(attachment) =>
              dockPreview(attachment, {
                senderId: message.senderId,
                seq: message.seq,
              })
            }
          />
        ) : null}
        {message.question && !message.deletedAt && (
          <QuestionOptions
            spec={message.question}
            waiting={
              message.approval
                ? pendingApprovals.has(message.id)
                : Boolean(waitingInvocationForQuestion(message, invocations.values()))
            }
            allowOther={!message.approval}
            pending={pendingAnswers.has(message.id) && !choiceAnswers.has(message.id)}
            {...(choiceAnswers.get(message.id) ? { answer: choiceAnswers.get(message.id)! } : {})}
            onSubmit={(selected, other) => submitChoice(message, selected, other)}
          />
        )}
        {!shareMode &&
          !message.question &&
          waitingInvocationForQuestion(message, invocations.values()) && (
            <button
              type="button"
              className="question-answer"
              aria-label={t("回答 {0} 的提问", { 0: message.senderName })}
              onClick={(event) => {
                event.stopPropagation();
                answerQuestion(message);
              }}
            >
              {answering?.id === message.id ? t("正在回答…") : t("回答")}
            </button>
          )}
        {invocationsByMessage.has(message.id) && (
          <InvocationChips
            recalled={Boolean(message.deletedAt)}
            connectionState={connectionState}
            invocations={invocationsByMessage.get(message.id) ?? []}
            allInvocations={invocations}
            participants={participants}
            canJumpTo={(messageId) => loadedMessageIds.has(messageId)}
            onJump={(messageId, origin) => {
              jumpToMessage(messageId);
              if (origin) flashOrigin({ invocationIds: [origin.id] });
            }}
            onViewProcess={(invocation) => {
              const card = processCardOf.get(invocation.id);
              return card
                ? () => jumpToProcess(card, { invocationIds: [invocation.id] })
                : undefined;
            }}
            flashedIds={flash.invocationIds}
            onRetry={(invocation) => retryInvocation(invocation)}
            onRetryWithModel={isOwner ? setRetryModelFor : undefined}
            onOpenProxySettings={
              isOwner && openProxySettings
                ? (invocation) =>
                    localAgentFor(invocation.agentName) ? openProxySettings : undefined
                : undefined
            }
            onCancel={cancelInvocation}
            onDismiss={(invocation) => dismissInvocations([invocation])}
            onExtend={extendAgentBudget}
            onSteer={steerInvocation}
            onPreempt={preemptInvocation}
            onOpenTerminal={
              isOwner
                ? (invocation) => {
                    const agent = localAgentFor(invocation.agentName);
                    return agent ? () => void openAgentTerminal(agent) : undefined;
                  }
                : undefined
            }
            onViewChanges={
              canViewWorkspace && currentRoomWorkspace
                ? (invocation) => openWorkspaceFor(invocation.agentName)
                : undefined
            }
            isOwner={isOwner}
            selfName={username}
            traces={traces}
          />
        )}
        {(invocationsByMessage.get(message.id) ?? [])
          .filter(
            (invocation) =>
              !message.deletedAt &&
              !invocation.messageRecalled &&
              !invocation.replyMessageId &&
              !showsLiveCard(invocation) &&
              invocation.status !== "queued" &&
              Boolean(traces.get(invocation.id)?.length),
          )
          .map((invocation) => (
            <TraceRecap
              key={`recap-${invocation.id}`}
              invocation={invocation}
              steps={traces.get(invocation.id)!}
            />
          ))}
      </div>
      {message.deletedAt ? null : shareMode ? (
        <span
          className={`select-indicator ${selectedMessageIds.has(message.id) ? "on" : ""}`}
          role="checkbox"
          aria-checked={selectedMessageIds.has(message.id)}
          aria-label={t("选择 {0} 的消息", { 0: message.senderName })}
        >
          {selectedMessageIds.has(message.id) && <Icon name="check" size={12} />}
        </span>
      ) : (
        <div className="message-actions">
          {onRecordTodo && (
            <IconButton
              size="sm"
              label={t("记为待办")}
              tooltip={t("记为待办")}
              onClick={() => void onRecordTodo(message)}
            >
              <Icon name="check" size={13} />
            </IconButton>
          )}
          {grouped && (
            <Tooltip content={t("复制序号引用")}>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("复制消息序号 #{0}", { 0: message.seq })}
                onClick={() => void copySeqReference(message)}
              >
                <span className="message-action-seq">
                  {copiedMessageId === `seq:${message.id}` ? "✓" : `#${message.seq}`}
                </span>
              </Button>
            </Tooltip>
          )}
          <IconButton
            size="sm"
            label={t("引用回复 #{0}", { 0: message.seq })}
            tooltip={t("引用")}
            onClick={() => quoteThis()}
          >
            <Icon name="quote" size={13} />
          </IconButton>
          <IconButton
            size="sm"
            label={t("复制消息原文")}
            tooltip={t("复制消息")}
            onClick={() => void copyMessageContent(message)}
          >
            <Icon name={copiedMessageId === message.id ? "check" : "copy"} size={13} />
          </IconButton>
          {message.senderName.toLocaleLowerCase() !== username.toLocaleLowerCase() ? (
            <IconButton
              size="sm"
              label={t("在输入框中提及 {0}", { 0: message.senderName })}
              tooltip={`@${message.senderName}`}
              onClick={() => appendMention(message.senderName)}
            >
              @
            </IconButton>
          ) : recallCandidateId === message.id ? (
            (() => {
              // 这条消息派出、还没结束的任务：撤回时默认一起停掉
              const open = (invocationsByMessage.get(message.id) ?? []).filter((invocation) =>
                ["queued", "running", "waiting_human", "blocked"].includes(invocation.status),
              );
              // 只有已经开始做的才有「只撤回、让它做完」可选；排队中的撤回后本来就不会再执行
              const started = open.some(
                (invocation) =>
                  invocation.status === "running" || invocation.status === "waiting_human",
              );
              const noteId = `recall-note-${message.id}`;
              return (
                <span
                  className={`message-recall-confirm ${open.length ? "with-tasks" : ""}`}
                  role="group"
                  aria-label={t("确认撤回")}
                  {...(open.length ? { "aria-describedby": noteId } : {})}
                >
                  <span className="message-recall-question">
                    {open.length
                      ? t("撤回并停止 {0} 的任务？", {
                          0: [
                            ...new Set(open.map((invocation) => `@${invocation.agentName}`)),
                          ].join("、"),
                        })
                      : t("撤回这条消息？")}
                  </span>
                  {open.length > 0 && (
                    <small id={noteId} className="message-recall-note">
                      {t(
                        "只停这条消息直接派出的任务，它们再派出去的子任务不受影响；已经改的文件、跑过的命令不会撤销。",
                      )}
                    </small>
                  )}
                  <span className="message-recall-actions">
                    <Button size="sm" onClick={() => setRecallCandidateId(undefined)}>
                      {t("取消")}
                    </Button>
                    {started && (
                      <Tooltip content={t("消息撤回，正在做的照常做完，只是不再回复")}>
                        <Button size="sm" onClick={() => recallMessage(message.id)}>
                          {t("只撤回")}
                        </Button>
                      </Tooltip>
                    )}
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => recallMessage(message.id, open.length > 0)}
                    >
                      {open.length ? t("撤回并停止") : t("撤回")}
                    </Button>
                  </span>
                </span>
              );
            })()
          ) : (
            <IconButton
              size="sm"
              tone="danger"
              label={t("撤回这条消息")}
              tooltip={t("撤回")}
              onClick={() => setRecallCandidateId(message.id)}
            >
              <Icon name="undo" size={13} />
            </IconButton>
          )}
          {recallCandidateId !== message.id && (
            // 右键菜单的键盘 / 触屏入口：和右键是同一份菜单
            <IconButton
              size="sm"
              label={t("更多操作")}
              tooltip={t("更多（也可以右键消息）")}
              aria-haspopup="menu"
              onClick={(event) => openMessageMenu(event, event.currentTarget)}
            >
              <Icon name="more" size={13} />
            </IconButton>
          )}
        </div>
      )}
    </article>
  );
}

/** 消息里引用的原消息：点了跳回去并闪一下；原消息撤回了就只说不可见，不再露出摘录 */
function QuoteCard({ quote, onOpen }: { quote: QuoteState; onOpen: () => void }) {
  const head = (
    <span className="message-quote-head">
      <Icon name={quote.answer ? "help" : "quote"} size={12} />
      {quote.answer && <span className="message-quote-label">{t("回答提问")}</span>}
      <span className="message-quote-seq">#{quote.seq}</span>
      {quote.senderName && <strong>{quote.senderName}</strong>}
    </span>
  );
  if (quote.gone) {
    return (
      <div className={`message-quote gone${quote.answer ? " answer" : ""}`}>
        {head}
        <span className="message-quote-excerpt">
          {quote.answer ? t("原提问已不可见") : t("原消息已不可见")}
        </span>
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`message-quote${quote.answer ? " answer" : ""}`}
      aria-label={
        quote.answer
          ? t("跳到回答的提问 #{0}", { 0: quote.seq })
          : t("跳到引用的原消息 #{0}（{1}）", { 0: quote.seq, 1: quote.senderName })
      }
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      {head}
      {quote.excerpt && <span className="message-quote-excerpt">{quote.excerpt}</span>}
    </button>
  );
}

/**
 * 等你回答的那条提问：序号（调用上记下的，或已载入时按父消息找到的）和第一句摘要。
 * 都不知道时返回空对象，入口照样在，点了由 locateAttention 按旧办法往后找
 */
function waitingQuestion(
  invocation: Invocation,
  messages: readonly ChatMessage[],
): { seq?: number; preview?: string } {
  const target = attentionTarget(invocation, messages, "question");
  const asked = questionOf(invocation, messages);
  const seq = target.messageId === invocation.messageId ? undefined : target.messageSeq;
  const preview = asked
    ? plainPreview(asked.content)
        .replace(/^(?:@\S+\s+)*❓\s*/u, "")
        .slice(0, 120)
    : invocation.detailText?.key === "invocation.waitingAnswer"
      ? String(invocation.detailText.params?.question ?? "").slice(0, 120)
      : undefined;
  return { ...(seq ? { seq } : {}), ...(preview ? { preview } : {}) };
}

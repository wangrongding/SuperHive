import { isMentioned, type ChatMessage, type RoomSummary } from "./hive-protocol.js";
import type { AgentAccessMode, AgentResponder } from "./responder.js";
import { buildDeveloperInstructions, buildMentionPrompt } from "./prompt-builder.js";
import { RoomClient, RoomClientError, type Snapshot } from "./room-client.js";
import { StateStore, type AgentState } from "./state-store.js";

export function shouldProcessMention(input: {
  message: ChatMessage;
  username: string;
  ownParticipantId: string;
  processedMessageIds: string[];
}): boolean {
  return (
    input.message.senderId !== input.ownParticipantId &&
    input.message.hopCount < 4 &&
    isMentioned(input.message.content, input.username) &&
    !input.processedMessageIds.includes(input.message.id)
  );
}

export function hasAgentMessage(messages: ChatMessage[], participantId: string): boolean {
  return messages.some((message) => message.senderId === participantId);
}

export class AgentBridge {
  private state!: AgentState;
  private stateExisted = false;
  private ownParticipantId = "";
  private instructions = "";
  private queue: Promise<void> = Promise.resolve();
  private readonly queued = new Set<string>();
  private readonly retryCounts = new Map<string, number>();
  private readonly room: RoomClient;

  constructor(
    private readonly options: {
      serverUrl: string;
      roomId: string;
      username: string;
      persona: string;
      provider: string;
      token: string;
      access?: AgentAccessMode;
      onRoomsChanged?: (room: RoomSummary) => void;
      onArchived?: () => void;
    },
    private readonly store: StateStore,
    private readonly responder: AgentResponder,
    private readonly log: (message: string) => void = console.log,
  ) {
    this.room = new RoomClient(
      {
        serverUrl: this.options.serverUrl,
        roomId: this.options.roomId,
        username: this.options.username,
        token: this.options.token,
        persona: this.options.persona,
        provider: this.options.provider,
      },
      {
        onSnapshot: (snapshot) => this.onSnapshot(snapshot),
        onMention: (message) => this.enqueue(message),
        ...(this.options.onRoomsChanged ? { onRoomsChanged: this.options.onRoomsChanged } : {}),
        onError: (error) => {
          this.log(`[hive] ${error.message}`);
          if (error instanceof RoomClientError && error.code === "ROOM_ARCHIVED") {
            this.options.onArchived?.();
          }
        },
      },
    );
  }

  async start(): Promise<void> {
    const existing = await this.store.load();
    this.stateExisted = Boolean(existing);
    this.state =
      existing ??
      ({
        serverUrl: this.options.serverUrl,
        roomId: this.options.roomId,
        username: this.options.username,
        lastProcessedSeq: 0,
        processedMessageIds: [],
      } satisfies AgentState);
    const serverRules = await this.room.fetchInstructions();
    this.instructions = buildDeveloperInstructions({
      agentName: this.options.username,
      persona: this.options.persona,
      serverRules,
      ...(this.options.access ? { access: this.options.access } : {}),
    });
    this.room.start();
    this.log(
      `[hive] ${this.options.username} 正在连接 ${this.options.serverUrl}/${this.options.roomId}`,
    );
  }

  async stop(): Promise<void> {
    this.room.stop();
    await this.queue.catch(() => undefined);
    await this.responder.close?.();
  }

  private async onSnapshot(snapshot: Snapshot): Promise<void> {
    this.ownParticipantId = snapshot.self.id;
    this.log(`[hive] 已加入 #${this.options.roomId}，公共消息最新 seq=${snapshot.latestSeq}`);
    if (!this.stateExisted) {
      this.state.lastProcessedSeq = snapshot.latestSeq;
      this.stateExisted = true;
      await this.store.save(this.state);
      return;
    }
    const missed = await this.room.fetchMessages(this.state.lastProcessedSeq);
    for (const message of missed.messages) {
      if (
        shouldProcessMention({
          message,
          username: this.options.username,
          ownParticipantId: this.ownParticipantId,
          processedMessageIds: this.state.processedMessageIds,
        })
      ) {
        this.enqueue(message);
      }
    }
  }

  private enqueue(message: ChatMessage): void {
    if (this.queued.has(message.id) || this.state.processedMessageIds.includes(message.id)) return;
    if (
      !shouldProcessMention({
        message,
        username: this.options.username,
        ownParticipantId: this.ownParticipantId,
        processedMessageIds: this.state.processedMessageIds,
      })
    ) {
      return;
    }
    this.queued.add(message.id);
    this.queue = this.queue
      .then(() => this.processMention(message))
      .catch((error: unknown) => {
        this.log(
          `[hive] 处理 @mention 失败：${error instanceof Error ? error.message : String(error)}`,
        );
        const retryCount = (this.retryCounts.get(message.id) ?? 0) + 1;
        this.retryCounts.set(message.id, retryCount);
        if (retryCount < 3) {
          const timer = setTimeout(() => this.enqueue(message), 1_000 * 2 ** (retryCount - 1));
          timer.unref();
        } else {
          this.log(`[hive] #${message.seq} 连续失败 3 次，将在下次重连时再次恢复。`);
          this.retryCounts.delete(message.id);
        }
      })
      .finally(() => this.queued.delete(message.id));
  }

  private async processMention(mention: ChatMessage): Promise<void> {
    if (this.state.processedMessageIds.includes(mention.id)) return;
    const context = await this.room.fetchMessages(this.state.lastProcessedSeq);
    this.room.setTyping(true);
    try {
      this.log(`[hive] 正在处理 #${mention.seq} 来自 ${mention.senderName} 的提及`);
      const reply = await this.responder.reply({
        instructions: this.instructions,
        prompt: buildMentionPrompt({ messages: context.messages, mention }),
        ...(this.state.threadId ? { threadId: this.state.threadId } : {}),
      });
      const content = reply.text.trim().slice(0, 4000);
      if (!content) throw new Error("Agent 回复为空。");
      const messagesAfterReply = await this.room.fetchMessages(context.latestSeq);
      const sentWithHiveTool = hasAgentMessage(messagesAfterReply.messages, this.ownParticipantId);
      if (!sentWithHiveTool) {
        await this.room.sendMessage({
          content,
          clientMessageId: `agent-reply-${mention.id}`,
          parentMessageId: mention.id,
        });
      } else {
        this.log(`[hive] #${mention.seq} 已通过 hive_message_send 发送，不再重复代发。`);
      }
      if (reply.threadId) this.state.threadId = reply.threadId;
      this.state.lastProcessedSeq = Math.max(
        this.state.lastProcessedSeq,
        context.latestSeq,
        messagesAfterReply.latestSeq,
        mention.seq,
      );
      this.state.processedMessageIds = [
        ...this.state.processedMessageIds.filter((id) => id !== mention.id),
        mention.id,
      ].slice(-1000);
      await this.store.save(this.state);
      this.retryCounts.delete(mention.id);
      this.log(`[hive] 已回复 #${mention.seq}`);
    } finally {
      this.room.setTyping(false);
    }
  }
}

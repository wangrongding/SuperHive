import type { ChatMessage } from "./hive-protocol.js";
import type { SessionStats } from "./state-store.js";

/**
 * 房间主对话自动换新（docs/research/task-scoped-sessions.md 第 2 节）：
 * 主道的会话越拉越长，每轮都贵；缓存过期后续接还要把整段重新写一遍缓存。
 * 在两件活之间、会话够长时换一段新会话，并附上按规则拼出来的交接摘要。
 */

/** 换新阈值默认 20 万 token；HIVE_LANE_RENEW_TOKENS 可调，0 表示不按长度换新 */
export const DEFAULT_RENEW_TOKENS = 200_000;
/** 缓存已过期时，会话超过这个长度就换新：接着用旧会话等于把整段重新写一次缓存 */
export const DEFAULT_IDLE_RENEW_TOKENS = 100_000;
/** 没报缓存有效期的运行时按 5 分钟算 */
const DEFAULT_CACHE_TTL_MS = 300_000;

export type RenewalSettings = {
  /** 会话达到这个长度就换新；0 = 不按长度换 */
  tokens: number;
  /** 缓存过期且会话达到这个长度就换新；0 = 不按缓存换 */
  idleTokens: number;
};

/** 读环境变量：HIVE_LANE_RENEW=0 关掉自动换新，HIVE_LANE_RENEW_TOKENS / HIVE_LANE_RENEW_IDLE_TOKENS 调阈值 */
export function renewalSettings(env: NodeJS.ProcessEnv = process.env): RenewalSettings {
  if (env.HIVE_LANE_RENEW === "0") return { tokens: 0, idleTokens: 0 };
  const read = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return value !== undefined && value.trim() !== "" && Number.isFinite(parsed) && parsed >= 0
      ? Math.floor(parsed)
      : fallback;
  };
  return {
    tokens: read(env.HIVE_LANE_RENEW_TOKENS, DEFAULT_RENEW_TOKENS),
    idleTokens: read(env.HIVE_LANE_RENEW_IDLE_TOKENS, DEFAULT_IDLE_RENEW_TOKENS),
  };
}

/** 粗估 token：CJK 一个字约 1 token，其余约 4 个字符 1 token */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (/[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/u.test(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/**
 * 记下这一轮之后会话有多长。运行时报了上下文（lastContextTokens / peakContextTokens）就用它；
 * 没报就在原来的估算上累加这一轮发出的提示和收到的回复。
 */
export function nextSessionStats(input: {
  previous: SessionStats | undefined;
  threadId: string;
  /** 运行时报的这一轮结束时的上下文大小 */
  contextTokens?: number;
  promptText: string;
  replyText: string;
}): SessionStats {
  const same = input.previous?.threadId === input.threadId ? input.previous : undefined;
  const turns = (same?.turns ?? 0) + 1;
  if (input.contextTokens !== undefined && input.contextTokens > 0)
    return { threadId: input.threadId, contextTokens: input.contextTokens, turns };
  const base = same?.contextTokens ?? 0;
  return {
    threadId: input.threadId,
    contextTokens: base + estimateTokens(input.promptText) + estimateTokens(input.replyText),
    estimated: true,
    turns,
  };
}

export type RenewalReason =
  | { kind: "size"; contextTokens: number; threshold: number; estimated?: boolean }
  | {
      kind: "idle";
      contextTokens: number;
      idleMs: number;
      cacheTtlMs: number;
      estimated?: boolean;
    };

/**
 * 这一轮开始前要不要换新会话。只看会话本身的长度和空闲时间；
 * 「是不是两件活之间」由调用方先判断（见 AgentBridge）。
 */
export function renewalReason(input: {
  stats: SessionStats | undefined;
  threadId: string | undefined;
  settings: RenewalSettings;
  /** 运行时的自动压缩阈值：换新阈值不超过它的 0.6，免得压缩先于换新 */
  compactWindow?: number;
  lastTurnEndedAt?: string;
  cacheTtlMs?: number;
  now?: number;
}): RenewalReason | undefined {
  const { stats, threadId, settings } = input;
  if (!threadId || !stats || stats.threadId !== threadId) return undefined;
  const size = stats.contextTokens;
  const estimated = stats.estimated ? { estimated: true as const } : {};
  let threshold = settings.tokens;
  if (threshold > 0 && input.compactWindow && input.compactWindow > 0)
    threshold = Math.min(threshold, Math.floor(input.compactWindow * 0.6));
  if (threshold > 0 && size >= threshold)
    return { kind: "size", contextTokens: size, threshold, ...estimated };
  const ended = Date.parse(input.lastTurnEndedAt ?? "");
  if (settings.idleTokens > 0 && size >= settings.idleTokens && Number.isFinite(ended)) {
    const cacheTtlMs = input.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    const idleMs = (input.now ?? Date.now()) - ended;
    if (idleMs > cacheTtlMs)
      return { kind: "idle", contextTokens: size, idleMs, cacheTtlMs, ...estimated };
  }
  return undefined;
}

/** 我派出去、在这段消息里还没等到回执的子任务（回执挂在委派消息下面） */
export function pendingDelegations(messages: ChatMessage[], ownId: string): ChatMessage[] {
  const receipted = new Set(
    messages
      .filter((message) => message.kind === "receipt" && message.parentMessageId)
      .map((message) => message.parentMessageId!),
  );
  return messages.filter(
    (message) =>
      message.kind === "delegation" &&
      message.senderId === ownId &&
      !message.deletedAt &&
      !receipted.has(message.id),
  );
}

function clip(text: string, max: number): string {
  const chars = [...text.replace(/\s+\n/g, "\n").trim()];
  return chars.length > max
    ? `${chars.slice(0, max).join("")}…（全文 ${chars.length} 字）`
    : chars.join("");
}

function line(message: ChatMessage, max: number): string {
  return `#${message.seq} [${message.senderName}] ${clip(message.content, max)}`;
}

/**
 * 换新时交给新会话的交接摘要：只用房间里的事实拼，不调用模型，所有运行时都一样可靠。
 * 原文不复述太多，每部分都给 #seq，需要时 hive_room_read 补读。
 */
export function buildHandoffSummary(input: {
  /** 旧会话期间（大致）的房间消息，按 seq 升序 */
  messages: ChatMessage[];
  username: string;
  ownId: string;
  reason: RenewalReason;
  /** 当前工作目录 */
  cwd?: string;
  /** 旧会话从哪条消息之后开始补读 */
  afterSeq: number;
}): string {
  const self = input.username.toLocaleLowerCase();
  const visible = input.messages.filter((message) => !message.deletedAt && message.content);
  const mentionsMe = (message: ChatMessage) =>
    message.mentions.some((mention) => mention.toLocaleLowerCase() === self);
  const asks = visible
    .filter(
      (message) =>
        message.senderType === "human" &&
        message.kind !== "progress" &&
        (mentionsMe(message) || message.kind === "schedule"),
    )
    .slice(-3);
  const askIds = new Set(asks.map((message) => message.id));
  const decisions = visible
    .filter((message) => message.senderType === "human" && !askIds.has(message.id) && !message.kind)
    .slice(-5);
  const mine = visible
    .filter(
      (message) =>
        message.senderId === input.ownId &&
        message.kind !== "progress" &&
        message.kind !== "delegation" &&
        message.kind !== "notice",
    )
    .slice(-3);
  const waiting = pendingDelegations(visible, input.ownId);
  const reason =
    input.reason.kind === "size"
      ? `上一段对话已经约 ${Math.round(input.reason.contextTokens / 1000)}k token${input.reason.estimated ? "（估算）" : ""}，超过换新阈值 ${Math.round(input.reason.threshold / 1000)}k`
      : `上一段对话约 ${Math.round(input.reason.contextTokens / 1000)}k token${input.reason.estimated ? "（估算）" : ""}，已空闲 ${Math.round(input.reason.idleMs / 60_000)} 分钟、提示缓存已过期，接着用要把整段重新写一遍缓存`;
  const sections = [
    `（系统提示）这是房间主对话的一段新会话：${reason}，所以换了新会话。下面是按房间记录拼出的交接摘要，不是完整历史；需要细节时用 hive_room_read(${JSON.stringify({ afterSeq: input.afterSeq })}) 或按 #seq 补读。`,
  ];
  if (asks.length)
    sections.push(`【最近交给你的事】\n${asks.map((message) => line(message, 1500)).join("\n")}`);
  if (decisions.length)
    sections.push(`【人最近说的】\n${decisions.map((message) => line(message, 300)).join("\n")}`);
  if (mine.length)
    sections.push(`【你最近的回复】\n${mine.map((message) => line(message, 1500)).join("\n")}`);
  if (waiting.length)
    sections.push(
      `【你派出去还没回执的子任务】\n${waiting.map((message) => line(message, 300)).join("\n")}`,
    );
  if (input.cwd) sections.push(`【工作目录】${input.cwd}`);
  return clip(sections.join("\n\n"), 24_000);
}

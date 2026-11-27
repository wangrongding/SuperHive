import type { ChatMessage } from "./hive-protocol.js";

/**
 * 触发消息是对 Agent 提问（hive_ask_human）的回答时，指向的那条提问。
 * 人可能隔了一天才回答，提问早已不在本轮上下文里：这里按 seq+id（点选回答）或 id（手打回复）补拉原文，
 * 让 Agent 看得出答的是哪一问，不再按最近的话题去猜。
 */
export type AnsweredQuestion = {
  answerId: string;
  questionId: string;
  questionSeq?: number;
  /** 校验通过的提问原文；读不到、被撤回或对不上时没有 */
  question?: ChatMessage;
  /** 提问已在本轮公共上下文里：提示词只给指引，不重复贴原文 */
  inContext: boolean;
};

const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

export async function loadAnsweredQuestions(
  triggers: ChatMessage[],
  messages: ChatMessage[],
  fetchAt: (seq: number, id: string) => Promise<ChatMessage | undefined>,
  fetchById: (id: string) => Promise<ChatMessage | undefined>,
): Promise<AnsweredQuestion[]> {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const loaded = await Promise.all(
    triggers.map(async (trigger): Promise<AnsweredQuestion | undefined> => {
      if (trigger.deletedAt || trigger.senderType !== "human") return undefined;
      // 点选回答带结构化的 answer；手打回复只有 replyToMessageId，读到后确认是提问才算
      const questionId = trigger.answer?.questionMessageId ?? trigger.replyToMessageId;
      if (!questionId || !UUID.test(questionId)) return undefined;
      const rawSeq = trigger.answer?.questionSeq;
      const questionSeq =
        typeof rawSeq === "number" &&
        Number.isSafeInteger(rawSeq) &&
        rawSeq > 0 &&
        rawSeq < trigger.seq
          ? rawSeq
          : undefined;
      const current = byId.get(questionId);
      const fetched =
        current ??
        (await (questionSeq ? fetchAt(questionSeq, questionId) : fetchById(questionId)).catch(
          () => undefined,
        ));
      const valid =
        fetched &&
        fetched.id === questionId &&
        fetched.roomId === trigger.roomId &&
        fetched.kind === "question" &&
        !fetched.deletedAt &&
        fetched.seq < trigger.seq &&
        (questionSeq === undefined || fetched.seq === questionSeq);
      // 手打回复：不是提问（或读不到）就只是普通回复，不加标注
      if (!trigger.answer && !valid) return undefined;
      const seq = valid ? fetched.seq : questionSeq;
      return {
        answerId: trigger.id,
        questionId,
        ...(seq ? { questionSeq: seq } : {}),
        ...(valid ? { question: fetched } : {}),
        inContext: Boolean(valid && current),
      };
    }),
  );
  return loaded.filter((item): item is AnsweredQuestion => item !== undefined);
}

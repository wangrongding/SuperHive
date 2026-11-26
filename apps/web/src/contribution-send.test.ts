// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendContribution } from "./contribution-send";

afterEach(() => vi.useRealTimers());

class FakeSocket extends EventTarget {
  readyState = WebSocket.OPEN;
  send = vi.fn();
  receive(clientMessageId: string) {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "message.created",
          message: {
            id: crypto.randomUUID(),
            roomId: "test",
            seq: 1,
            senderId: crypto.randomUUID(),
            senderName: "human",
            senderType: "human",
            content: "task",
            mentions: ["local-agent"],
            traceId: crypto.randomUUID(),
            hopCount: 0,
            clientMessageId,
            createdAt: new Date().toISOString(),
          },
        }),
      }),
    );
  }
}

describe("human contribution dispatch", () => {
  it("sends once as a normal human message and waits for its own saved-message receipt", async () => {
    const socket = new FakeSocket();
    const result = sendContribution(socket as unknown as WebSocket, "local-agent", "safe task");
    const event = JSON.parse(socket.send.mock.calls[0]![0] as string) as {
      content: string;
      type: string;
      clientMessageId: string;
    };
    expect(event.type).toBe("message.send");
    expect(event.content).toBe("@local-agent safe task");
    socket.receive("unrelated");
    socket.receive(event.clientMessageId);
    expect(await result).toBe(true);
    expect(socket.send).toHaveBeenCalledTimes(1);
  });

  it("marks missing receipts as uncertain and never resends automatically", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const result = sendContribution(socket as unknown as WebSocket, "local-agent", "task", 100);
    await vi.advanceTimersByTimeAsync(101);
    expect(await result).toBe(false);
    expect(socket.send).toHaveBeenCalledTimes(1);
  });

  it("does not send while offline and reports connection loss after a send as uncertain", async () => {
    await expect(sendContribution(undefined, "local-agent", "task")).rejects.toThrow("连接已中断");
    const socket = new FakeSocket();
    const result = sendContribution(socket as unknown as WebSocket, "local-agent", "task");
    socket.dispatchEvent(new Event("close"));
    expect(await result).toBe(false);
  });
});

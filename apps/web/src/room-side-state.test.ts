// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import type { Attachment, ChatMessage } from "@superhive/protocol";
import {
  MAX_ROOMS,
  loadRoomSideStates,
  previewGone,
  saveRoomSideStates,
  updateRoomSide,
  type DockedPreview,
  type RoomSideStates,
} from "./room-side-state";

const attachment: Attachment = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "page.html",
  mime: "text/html",
  size: 10,
  kind: "text",
  sha256: "a".repeat(64),
};
const preview = (roomId: string, seq = 1): DockedPreview => ({
  roomId,
  attachment,
  senderId: "agent",
  seq,
});
const KEY = "superhive.room-side.test";

describe("room-side-state", () => {
  afterEach(() => localStorage.clear());

  it("按房间各记各的：改一个房间不动别的，值没变原样返回", () => {
    let states: RoomSideStates = {};
    states = updateRoomSide(states, "a", { preview: preview("a") }, 1);
    states = updateRoomSide(states, "b", { tab: "whiteboard" }, 2);
    expect(states.a?.preview?.roomId).toBe("a");
    expect(states.a?.tab).toBeUndefined();
    expect(states.b).toEqual({ tab: "whiteboard", at: 2 });
    expect(updateRoomSide(states, "b", { tab: "whiteboard" }, 3)).toBe(states);
    // 关掉预览、标签页回到默认以外也没记：整条删掉
    const cleared = updateRoomSide(states, "a", { preview: undefined }, 4);
    expect(cleared.a).toBeUndefined();
    expect(cleared.b).toBe(states.b);
  });

  it(`最多记最近 ${MAX_ROOMS} 个房间，先丢最久没动的`, () => {
    let states: RoomSideStates = {};
    for (let index = 0; index < MAX_ROOMS + 5; index += 1)
      states = updateRoomSide(states, `room-${index}`, { tab: "whiteboard" }, index);
    expect(Object.keys(states)).toHaveLength(MAX_ROOMS);
    expect(states["room-0"]).toBeUndefined();
    expect(states[`room-${MAX_ROOMS + 4}`]).toBeTruthy();
  });

  it("存进本机只留标识，不存放大状态；读回来标成恢复的，坏数据直接丢掉", () => {
    let states: RoomSideStates = {};
    states = updateRoomSide(states, "a", { preview: { ...preview("a"), popped: true } }, 1);
    states = updateRoomSide(states, "b", { tab: "plugins" }, 2);
    saveRoomSideStates(KEY, states);
    const raw = JSON.parse(localStorage.getItem(KEY)!) as Record<string, unknown>;
    expect(raw.a).toEqual({ at: 1, preview: { attachment, senderId: "agent", seq: 1 } });
    const loaded = loadRoomSideStates(KEY);
    expect(loaded.a?.preview).toEqual({ ...preview("a"), restored: true });
    expect(loaded.b?.tab).toBe("plugins");

    localStorage.setItem(
      KEY,
      JSON.stringify({
        a: { at: 1, tab: "nope", preview: { attachment: { id: 1 }, seq: 1 } },
        b: "x",
        c: { at: 2, tab: "members" },
      }),
    );
    expect(loadRoomSideStates(KEY)).toEqual({ c: { at: 2, tab: "members" } });
    localStorage.setItem(KEY, "{not json");
    expect(loadRoomSideStates(KEY)).toEqual({});
  });

  it("来源消息已加载且被撤回或不再带这个附件，才算没了；没加载到的先当它在", () => {
    const message = (patch: Partial<ChatMessage>): ChatMessage =>
      ({ roomId: "a", seq: 1, attachments: [attachment], ...patch }) as ChatMessage;
    expect(previewGone(preview("a"), [])).toBe(false);
    expect(previewGone(preview("a"), [message({ roomId: "b" })])).toBe(false);
    expect(previewGone(preview("a"), [message({})])).toBe(false);
    expect(previewGone(preview("a"), [message({ deletedAt: "2026-11-28T00:00:00.000Z" })])).toBe(
      true,
    );
    expect(previewGone(preview("a"), [message({ attachments: [] })])).toBe(true);
  });
});

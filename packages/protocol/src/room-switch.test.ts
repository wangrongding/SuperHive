import { describe, expect, it } from "vitest";
import { clientEventSchema, roomSwitchEventSchema } from "./index.js";

describe("room.switch", () => {
  it("accepts a subscription switch without another identity or token", () => {
    expect(clientEventSchema.parse({ type: "room.switch", roomId: "project_1" })).toEqual({
      type: "room.switch",
      roomId: "project_1",
    });
  });
  it.each(["", "a/b", "../general", "a".repeat(65)])("rejects invalid room %s", (roomId) => {
    expect(roomSwitchEventSchema.safeParse({ type: "room.switch", roomId }).success).toBe(false);
  });
});

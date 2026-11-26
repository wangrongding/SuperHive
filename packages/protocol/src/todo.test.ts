import { describe, expect, it } from "vitest";
import { LIMITS, todoInputSchema, todoUpdateSchema } from "./index.js";

describe("to-do input", () => {
  it("requires a trimmed title and supplies empty optional fields", () => {
    expect(todoInputSchema.parse({ title: " later " })).toEqual({
      title: "later",
      notes: "",
      assigneeId: null,
      sourceMessageId: null,
    });
    expect(todoInputSchema.safeParse({ title: "  " }).success).toBe(false);
  });
  it("bounds titles and notes and rejects empty updates", () => {
    expect(
      todoInputSchema.safeParse({ title: "x".repeat(LIMITS.maxTodoTitleLength + 1) }).success,
    ).toBe(false);
    expect(
      todoInputSchema.safeParse({ title: "later", notes: "x".repeat(LIMITS.maxTodoNoteLength + 1) })
        .success,
    ).toBe(false);
    expect(todoUpdateSchema.safeParse({}).success).toBe(false);
    expect(todoUpdateSchema.parse({ completed: false, assigneeId: null })).toEqual({
      completed: false,
      assigneeId: null,
    });
  });
});

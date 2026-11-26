import { describe, expect, it } from "vitest";
import {
  LIMITS,
  todoInputSchema,
  todoUpdateSchema,
  todoHandoffSchema,
  messageSendEventSchema,
} from "./index.js";

describe("to-do input", () => {
  it("bounds handoff metadata and prevents ordinary messages from supplying it", () => {
    const todoHandoff = { todoId: "00000000-0000-4000-8000-000000000001", notes: "Check paths" };
    expect(todoHandoffSchema.parse(todoHandoff)).toEqual(todoHandoff);
    expect(todoHandoffSchema.safeParse({ ...todoHandoff, todoId: "not-an-id" }).success).toBe(
      false,
    );
    expect(
      todoHandoffSchema.safeParse({
        ...todoHandoff,
        notes: "x".repeat(LIMITS.maxTodoNoteLength + 1),
      }).success,
    ).toBe(false);
    expect(
      messageSendEventSchema.parse({
        type: "message.send",
        clientMessageId: "message",
        content: "@worker do this",
        todoHandoff,
      }),
    ).not.toHaveProperty("todoHandoff");
  });
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

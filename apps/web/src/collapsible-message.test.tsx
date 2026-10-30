// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LIMITS } from "@ai-hive/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollapsibleMessage, MAX_MESSAGE_LENGTH, isLongMessage } from "./collapsible-message";

afterEach(cleanup);

describe("CollapsibleMessage", () => {
  it("前端上限与协议契约一致", () => {
    expect(MAX_MESSAGE_LENGTH).toBe(LIMITS.maxMessageLength);
  });

  it("按字数或行数判断长消息", () => {
    expect(isLongMessage("短消息")).toBe(false);
    expect(isLongMessage("字".repeat(1501))).toBe(true);
    expect(isLongMessage(Array.from({ length: 16 }, (_, i) => `第 ${i} 行`).join("\n"))).toBe(true);
    expect(isLongMessage(Array.from({ length: 15 }, (_, i) => `第 ${i} 行`).join("\n"))).toBe(
      false,
    );
  });

  it("短消息不包裹也不显示按钮", () => {
    render(<CollapsibleMessage content="hi">hi</CollapsibleMessage>);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("长消息默认折叠，可展开和收起，正文始终完整渲染", () => {
    const content = "长".repeat(2000);
    const { container } = render(
      <CollapsibleMessage content={content}>{content}</CollapsibleMessage>,
    );
    expect(container.querySelector(".message-collapsible.collapsed")).not.toBeNull();
    expect(container.textContent).toContain(content);

    fireEvent.click(screen.getByRole("button", { name: /展开全文 · 共 2,000 字/ }));
    expect(container.querySelector(".message-collapsible.collapsed")).toBeNull();
    expect(screen.getByRole("button", { name: "收起" }).getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(container.querySelector(".message-collapsible.collapsed")).not.toBeNull();
  });

  it("展开、收起前先通知外层，让消息列表暂停贴底", () => {
    const onToggle = vi.fn();
    const content = "长".repeat(2000);
    render(
      <CollapsibleMessage content={content} onToggle={onToggle}>
        <p>{content}</p>
      </CollapsibleMessage>,
    );
    fireEvent.click(screen.getByRole("button", { name: /展开全文/ }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it("强制展开时不折叠也不显示按钮", () => {
    const content = "长".repeat(2000);
    const { container } = render(
      <CollapsibleMessage content={content} forceExpanded>
        {content}
      </CollapsibleMessage>,
    );
    expect(container.querySelector(".collapsed")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

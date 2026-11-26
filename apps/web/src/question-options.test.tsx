// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { QuestionSpec } from "@superhive/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionOptions } from "./question-options";
import { storedSendShortcutKey } from "./app-storage";

afterEach(cleanup);

const options = [
  { key: "A", label: "提交改动" },
  { key: "B", label: "先跑测试" },
];

function renderOptions(spec: QuestionSpec, props: Partial<Parameters<typeof QuestionOptions>[0]>) {
  const onSubmit = vi.fn();
  render(<QuestionOptions spec={spec} waiting pending={false} onSubmit={onSubmit} {...props} />);
  return onSubmit;
}

describe("QuestionOptions", () => {
  it("显示持续待答提示；提交中、回答后和停止后不再提示", () => {
    for (const props of [
      {},
      { pending: true },
      { waiting: false },
      { answer: { questionMessageId: "q", selected: ["A"] } },
    ]) {
      renderOptions({ options, multiple: false }, props);
      expect(Boolean(screen.queryByText("等你回答"))).toBe(Object.keys(props).length === 0);
      cleanup();
    }
  });
  it("单选点一下即提交；其它要填写后才能提交", () => {
    const onSubmit = renderOptions({ options, multiple: false }, {});
    fireEvent.click(screen.getByRole("button", { name: /先跑测试/ }));
    expect(onSubmit).toHaveBeenLastCalledWith(["B"]);

    // 点「其它」那一行的任意位置（包括提示文字）都能展开输入框
    fireEvent.click(screen.getByText("都不合适？点这里自己写"));
    const submit = screen.getByRole("button", { name: "提交" });
    expect(submit).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("其它回答"), { target: { value: "都不要" } });
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenLastCalledWith([], "都不要");
  });

  it("其它可以换行：Enter / Shift+Enter 换行，⌘/Ctrl+Enter 提交；设成 Enter 发送时跟着变", () => {
    const onSubmit = renderOptions({ options, multiple: false }, {});
    fireEvent.click(screen.getByText("都不合适？点这里自己写"));
    const input = screen.getByLabelText("其它回答");
    expect(input.tagName).toBe("TEXTAREA");
    fireEvent.change(input, { target: { value: "第一行\n第二行" } });
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenLastCalledWith([], "第一行\n第二行");

    localStorage.setItem(storedSendShortcutKey, "enter");
    try {
      onSubmit.mockClear();
      expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(true);
      expect(onSubmit).not.toHaveBeenCalled();
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onSubmit).toHaveBeenCalledTimes(1);
    } finally {
      localStorage.clear();
    }
  });

  it("权限申请只有允许 / 拒绝，没有「其它」", () => {
    const onSubmit = renderOptions(
      {
        options: [
          { key: "A", label: "允许" },
          { key: "B", label: "拒绝" },
        ],
        multiple: false,
      },
      { allowOther: false },
    );
    expect(screen.queryByText("其它")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /允许/ }));
    expect(onSubmit).toHaveBeenLastCalledWith(["A"]);
  });

  it("多选勾选不立即提交，统一提交选项与其它", () => {
    const onSubmit = renderOptions({ options, multiple: true }, {});
    const submit = screen.getByRole("button", { name: "提交回答" });
    expect(submit).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("checkbox", { name: /先跑测试/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /提交改动/ }));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("都不合适？点这里自己写"));
    expect(screen.getByRole("checkbox", { name: /^其它/ })).toHaveProperty("checked", true);
    fireEvent.change(screen.getByLabelText("其它回答"), { target: { value: "顺便推送" } });
    fireEvent.click(submit);
    // 按题目顺序提交，与点选顺序无关
    expect(onSubmit).toHaveBeenCalledWith(["A", "B"], "顺便推送");
  });

  it("答完锁住并高亮所选；不再等待时不能点", () => {
    renderOptions(
      { options, multiple: false },
      { waiting: false, answer: { questionMessageId: "q", selected: ["A"] } },
    );
    const picked = screen.getByRole("button", { name: /提交改动/ });
    expect(picked).toHaveProperty("disabled", true);
    expect(picked.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: /^其它/ })).toBeNull();
  });

  it("等待中但已提交时禁用，避免连点", () => {
    const onSubmit = renderOptions({ options, multiple: false }, { pending: true });
    fireEvent.click(screen.getByRole("button", { name: /提交改动/ }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("正在提交…")).toBeTruthy();
  });
});

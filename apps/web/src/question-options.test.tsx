// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { QuestionSpec } from "@ai-hive/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionOptions } from "./question-options";

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
  it("单选点一下即提交；其它要填写后才能提交", () => {
    const onSubmit = renderOptions({ options, multiple: false }, {});
    fireEvent.click(screen.getByRole("button", { name: /先跑测试/ }));
    expect(onSubmit).toHaveBeenLastCalledWith(["B"]);

    fireEvent.click(screen.getByRole("button", { name: "其它" }));
    const submit = screen.getByRole("button", { name: "提交" });
    expect(submit).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("其它回答"), { target: { value: "都不要" } });
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenLastCalledWith([], "都不要");
  });

  it("多选勾选不立即提交，统一提交选项与其它", () => {
    const onSubmit = renderOptions({ options, multiple: true }, {});
    const submit = screen.getByRole("button", { name: "提交回答" });
    expect(submit).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("checkbox", { name: /先跑测试/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /提交改动/ }));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "其它" }));
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
    expect(screen.queryByRole("button", { name: "其它" })).toBeNull();
  });

  it("等待中但已提交时禁用，避免连点", () => {
    const onSubmit = renderOptions({ options, multiple: false }, { pending: true });
    fireEvent.click(screen.getByRole("button", { name: /提交改动/ }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("正在提交…")).toBeTruthy();
  });
});

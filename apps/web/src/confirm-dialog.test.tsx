// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { confirmAction } from "./confirm-dialog";

async function open(options: Parameters<typeof confirmAction>[0]) {
  let promise!: Promise<boolean>;
  act(() => {
    promise = confirmAction(options);
  });
  const dialog = await screen.findByRole("alertdialog");
  return { promise, dialog };
}

afterEach(async () => {
  // 每个用例都已关掉弹窗；等卸载完成，下一个用例看不到残留
  await waitFor(() => expect(document.querySelector(".confirm-dialog-layer")).toBeNull());
  document.body.innerHTML = "";
});

describe("confirmAction", () => {
  it("names the dialog by its title, describes the consequence and resolves true on confirm", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const { promise, dialog } = await open({
      title: "开启新话题？",
      message: "历史消息保留。",
      confirmLabel: "开启新话题",
    });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("alertdialog", { name: "开启新话题？" })).toBe(dialog);
    expect(dialog.getAttribute("aria-describedby")).toBe(screen.getByText("历史消息保留。").id);
    // 不是危险操作：焦点在确认按钮上，回车就执行
    const confirm = within(dialog).getByRole("button", { name: "开启新话题" });
    expect(document.activeElement).toBe(confirm);
    expect(confirm.className).toContain("btn-primary");
    fireEvent.click(confirm);
    await expect(promise).resolves.toBe(true);
    // 关上后焦点回到打开前的按钮
    expect(document.activeElement).toBe(trigger);
  });

  it("puts focus on cancel and colours the button for dangerous actions", async () => {
    const { promise, dialog } = await open({
      title: "永久删除这条历史事项？",
      confirmLabel: "删除",
      danger: true,
    });
    const cancel = within(dialog).getByRole("button", { name: "取消" });
    expect(document.activeElement).toBe(cancel);
    expect(within(dialog).getByRole("button", { name: "删除" }).className).toContain("btn-danger");
    expect(dialog.hasAttribute("aria-describedby")).toBe(false);
    fireEvent.click(cancel);
    await expect(promise).resolves.toBe(false);
  });

  it("cancels on Escape before outer dialogs listening on window see it", async () => {
    let outerClosed = false;
    const outer = (event: KeyboardEvent) => {
      if (event.key === "Escape") outerClosed = true;
    };
    window.addEventListener("keydown", outer);
    const { promise, dialog } = await open({ title: "断开这个 IM？", confirmLabel: "断开" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await expect(promise).resolves.toBe(false);
    expect(outerClosed).toBe(false);
    window.removeEventListener("keydown", outer);
  });

  it("cancels when the scrim is clicked", async () => {
    const { promise } = await open({ title: "撤销这个邀请链接？", confirmLabel: "撤销" });
    fireEvent.click(document.querySelector(".confirm-dialog-scrim")!);
    await expect(promise).resolves.toBe(false);
  });

  it("keeps Tab inside the dialog", async () => {
    const { promise, dialog } = await open({ title: "归档？", confirmLabel: "归档" });
    const cancel = within(dialog).getByRole("button", { name: "取消" });
    const confirm = within(dialog).getByRole("button", { name: "归档" });
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);
    fireEvent.click(cancel);
    await expect(promise).resolves.toBe(false);
  });

  it("only the topmost dialog answers Escape", async () => {
    const first = await open({ title: "第一个？", confirmLabel: "好" });
    let second!: Promise<boolean>;
    act(() => {
      second = confirmAction({ title: "第二个？", confirmLabel: "好" });
    });
    await screen.findByRole("alertdialog", { name: "第二个？" });
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await expect(second).resolves.toBe(false);
    expect(screen.getByRole("alertdialog", { name: "第一个？" })).toBe(first.dialog);
    fireEvent.click(within(first.dialog).getByRole("button", { name: "好" }));
    await expect(first.promise).resolves.toBe(true);
  });
});

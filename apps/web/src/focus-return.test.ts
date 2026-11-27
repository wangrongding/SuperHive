// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { returnFocus } from "./focus-return";

describe("returnFocus", () => {
  it("hides the focus ring after a pointer close and keeps it after a keyboard close", () => {
    const button = document.createElement("button");
    document.body.append(button);
    const focus = vi.spyOn(button, "focus");

    window.dispatchEvent(new Event("pointerdown"));
    returnFocus(button);
    expect(focus).toHaveBeenLastCalledWith({ focusVisible: false });

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    returnFocus(button);
    expect(focus).toHaveBeenLastCalledWith({ focusVisible: true });

    expect(() => returnFocus(null)).not.toThrow();
    button.remove();
  });
});

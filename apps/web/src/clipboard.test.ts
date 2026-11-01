// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "./clipboard";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");

function setClipboard(value: Pick<Clipboard, "writeText"> | undefined) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value });
}

function setExecCommand(value: (command: string) => boolean) {
  Object.defineProperty(document, "execCommand", { configurable: true, value });
}

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");

  if (originalExecCommand) Object.defineProperty(document, "execCommand", originalExecCommand);
  else Reflect.deleteProperty(document, "execCommand");
});

describe("copyTextToClipboard", () => {
  it("uses the Clipboard API when it is available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const execCommand = vi.fn(() => true);
    setClipboard({ writeText });
    setExecCommand(execCommand);

    await copyTextToClipboard("agent command");

    expect(writeText).toHaveBeenCalledWith("agent command");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("falls back to a temporary selection when Clipboard API access is denied", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const writeText = vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    const execCommand = vi.fn(() => {
      expect(
        document.querySelector<HTMLTextAreaElement>('textarea[data-superhive-clipboard="true"]')
          ?.value,
      ).toBe("LAN command");
      return true;
    });
    setClipboard({ writeText });
    setExecCommand(execCommand);

    await copyTextToClipboard("LAN command");

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector('textarea[data-superhive-clipboard="true"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("reports failure when neither copy method is available", async () => {
    setClipboard(undefined);
    setExecCommand(() => false);

    await expect(copyTextToClipboard("agent command")).rejects.toThrow(
      "Clipboard access is unavailable",
    );
  });
});

import { describe, expect, it } from "vitest";
import { desktopBridge } from "./desktop-bridge";

const fn = () => () => undefined;
const terminal = {
  create: fn,
  write: fn,
  resize: fn,
  kill: fn,
  onData: fn,
  onExit: fn,
  onNewRequest: fn,
};

describe("desktopBridge", () => {
  it("is absent in a normal browser", () => {
    expect(desktopBridge(undefined)).toBeUndefined();
    expect(desktopBridge()).toBeUndefined();
  });

  it("accepts the shape the desktop preload exposes", () => {
    const bridge = { version: 1, platform: "darwin", terminal };
    expect(desktopBridge(bridge)).toBe(bridge);
  });

  it("rejects incompatible versions and incomplete objects", () => {
    expect(desktopBridge({ version: 2, platform: "darwin", terminal })).toBeUndefined();
    expect(desktopBridge({ version: 1, platform: "darwin" })).toBeUndefined();
    expect(
      desktopBridge({ version: 1, platform: "darwin", terminal: { ...terminal, kill: "nope" } }),
    ).toBeUndefined();
    expect(desktopBridge("superhive")).toBeUndefined();
  });

  it("keeps the terminal when the title bar API is missing or malformed", () => {
    const titlebar = { mode: "mac", setAppearance: fn };
    expect(desktopBridge({ version: 1, platform: "darwin", terminal, titlebar })?.titlebar).toBe(
      titlebar,
    );
    expect(desktopBridge({ version: 1, platform: "darwin", terminal })?.titlebar).toBeUndefined();
    const broken = desktopBridge({
      version: 1,
      platform: "darwin",
      terminal,
      titlebar: { mode: "mac" },
    });
    expect(broken?.terminal).toBe(terminal);
    expect(broken?.titlebar).toBeUndefined();
  });

  it("keeps the terminal when the newer reattach or layout hooks are malformed", () => {
    const full = { ...terminal, list: fn, attach: fn, onLayoutRequest: fn };
    expect(desktopBridge({ version: 1, platform: "darwin", terminal: full })?.terminal).toBe(full);
    const broken = desktopBridge({
      version: 1,
      platform: "darwin",
      terminal: { ...terminal, list: "nope", attach: fn, onLayoutRequest: 1 },
    });
    expect(broken?.terminal.create).toBe(fn);
    expect(broken?.terminal.list).toBeUndefined();
    expect(broken?.terminal.attach).toBe(fn);
    expect(broken?.terminal.onLayoutRequest).toBeUndefined();
  });

  it("keeps the update API only when it has every method", () => {
    const updates = { get: fn, open: fn, dismiss: fn, onChange: fn };
    expect(desktopBridge({ version: 1, platform: "darwin", terminal, updates })?.updates).toBe(
      updates,
    );
    const broken = desktopBridge({
      version: 1,
      platform: "darwin",
      terminal,
      updates: { get: fn, open: "https://evil.example" },
    });
    expect(broken?.terminal).toBe(terminal);
    expect(broken?.updates).toBeUndefined();
  });

  it("drops only malformed install / restart, keeping the rest of the update API", () => {
    const full = { get: fn, open: fn, dismiss: fn, onChange: fn, install: fn, restart: fn };
    expect(
      desktopBridge({ version: 1, platform: "darwin", terminal, updates: full })?.updates,
    ).toBe(full);
    const broken = desktopBridge({
      version: 1,
      platform: "darwin",
      terminal,
      updates: { get: fn, open: fn, dismiss: fn, onChange: fn, install: "x", restart: fn },
    })?.updates;
    expect(broken?.get).toBe(fn);
    expect(broken && "install" in broken).toBe(false);
    expect(broken && "restart" in broken).toBe(false);
  });

  it("drops only a malformed checkNow, so the check-for-updates button just stays hidden", () => {
    const full = { get: fn, open: fn, dismiss: fn, onChange: fn, checkNow: fn };
    expect(
      desktopBridge({ version: 1, platform: "darwin", terminal, updates: full })?.updates,
    ).toBe(full);
    const broken = desktopBridge({
      version: 1,
      platform: "darwin",
      terminal,
      updates: {
        get: fn,
        open: fn,
        dismiss: fn,
        onChange: fn,
        install: fn,
        restart: fn,
        checkNow: 1,
      },
    })?.updates;
    expect(broken?.install).toBe(fn);
    expect(broken && "checkNow" in broken).toBe(false);
  });

  it("drops only a malformed cancelRestart, restart itself keeps working", () => {
    const broken = desktopBridge({
      version: 1,
      platform: "darwin",
      terminal,
      updates: {
        get: fn,
        open: fn,
        dismiss: fn,
        onChange: fn,
        install: fn,
        restart: fn,
        cancelRestart: "x",
      },
    })?.updates;
    expect(broken?.restart).toBe(fn);
    expect(broken && "cancelRestart" in broken).toBe(false);
  });
});

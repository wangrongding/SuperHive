import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("房间工作区", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it("房主可设置、修改、清除；必须是存在的目录，存真实路径", async () => {
    const app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      staticDir: "/definitely-not-present",
    });
    close = () => app.close();
    const dir = mkdtempSync(path.join(tmpdir(), "room-ws-"));
    const headers = { authorization: "Bearer test-token" };
    const created = await app.inject({
      method: "POST",
      url: "/api/rooms",
      headers,
      payload: { id: "proj", workspace: dir },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().room.workspace).toBe(realpathSync(dir));

    const bad = await app.inject({
      method: "PATCH",
      url: "/api/rooms/proj",
      headers,
      payload: { workspace: path.join(dir, "missing") },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("ROOM_WORKSPACE_INVALID");
    const relative = await app.inject({
      method: "PATCH",
      url: "/api/rooms/proj",
      headers,
      payload: { workspace: "relative/dir" },
    });
    expect(relative.statusCode).toBe(400);

    const cleared = await app.inject({
      method: "PATCH",
      url: "/api/rooms/proj",
      headers,
      payload: { workspace: null },
    });
    expect(cleared.json().room.workspace).toBeUndefined();
    const anonymous = await app.inject({
      method: "PATCH",
      url: "/api/rooms/proj",
      payload: { workspace: dir },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

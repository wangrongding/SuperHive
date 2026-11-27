import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { HiveDatabase } from "./database.js";
import {
  WORKSPACE_LIMITS,
  WorkspaceView,
  hunksOf,
  isSensitivePath,
  normalizeRelative,
  parseNumstat,
} from "./workspace-files.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z" },
  });
}

function write(root: string, file: string, content: string | Buffer) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
}

/** main 上两个提交的仓库：a.txt、src/app.ts、.gitignore（忽略 dist/ 和 *.log） */
function repository(): string {
  const root = temp("ws-files-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Tester");
  git(root, "config", "commit.gpgsign", "false");
  write(root, "a.txt", "one\ntwo\nthree\n");
  write(root, ".gitignore", "dist/\n*.log\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "initial");
  write(root, "src/app.ts", "export const x = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "add app", "-m", "Longer body.");
  return root;
}

describe("路径校验", () => {
  it("拒绝绝对路径、..、反斜杠、NUL 与 .git", () => {
    for (const bad of [
      "/etc/passwd",
      "../x",
      "a/../../x",
      "a\\b",
      "a\0b",
      ".git/config",
      "x/.GIT/HEAD",
      "C:/x",
    ])
      expect(() => normalizeRelative(bad), bad).toThrow();
    expect(normalizeRelative("./src//app.ts")).toBe("src/app.ts");
    expect(normalizeRelative("")).toBe("");
  });

  it("疑似密钥文件按文件名与目录识别，样例文件不算", () => {
    for (const name of [
      ".env",
      ".env.local",
      "certs/server.pem",
      "id_rsa",
      "x/.ssh/config",
      "credentials.json",
      ".npmrc",
      "service-account-prod.json",
    ])
      expect(isSensitivePath(name), name).toBe(true);
    for (const name of [".env.example", "src/env.ts", "id_rsa.pub", "README.md", "keys.ts"])
      expect(isSensitivePath(name), name).toBe(false);
  });

  it("符号链接指到工作区外面时拒绝读取，指在里面可以", async () => {
    const root = repository();
    const outside = temp("ws-outside-");
    write(outside, "secret.txt", "top secret\n");
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "leak.txt"));
    symlinkSync(outside, path.join(root, "leakdir"));
    symlinkSync(path.join(root, "a.txt"), path.join(root, "alias.txt"));
    const view = new WorkspaceView(root);
    await expect(view.file("leak.txt", false)).rejects.toMatchObject({
      code: "WORKSPACE_PATH_OUTSIDE",
    });
    await expect(view.file("leakdir/secret.txt", false)).rejects.toMatchObject({
      code: "WORKSPACE_PATH_OUTSIDE",
    });
    await expect(view.tree("leakdir", { ignored: false })).rejects.toMatchObject({
      code: "WORKSPACE_PATH_OUTSIDE",
    });
    expect((await view.file("alias.txt", false)).content).toBe("one\ntwo\nthree\n");
    const tree = await view.tree("", { ignored: false });
    expect(tree.entries.find((item) => item.name === "leak.txt")).toMatchObject({
      outside: true,
      symlink: true,
      type: "other",
    });
    expect(tree.entries.find((item) => item.name === "alias.txt")).toMatchObject({
      type: "file",
      symlink: true,
    });
    await expect(
      view.diff({ path: "leak.txt", mode: "untracked", reveal: false }),
    ).rejects.toMatchObject({
      code: "WORKSPACE_PATH_OUTSIDE",
    });
  });
});

describe("git 状态与 diff", () => {
  it("按已暂存 / 未暂存 / 未跟踪分组并带增删行数、分支与上游", async () => {
    const root = repository();
    write(root, "a.txt", "one\n2\nthree\nfour\n");
    write(root, "staged.txt", "s\n");
    git(root, "add", "staged.txt");
    write(root, "new/file.md", "# hi\nthere\n");
    write(root, "debug.log", "ignored\n");
    write(root, "pic.bin", Buffer.from([0, 1, 2, 3]));
    const status = await new WorkspaceView(root).status();
    expect(status).toMatchObject({ git: true, branch: "main" });
    const by = (file: string, group: string) =>
      status.changes.find((item) => item.path === file && item.group === group);
    expect(by("a.txt", "unstaged")).toMatchObject({ status: "M", additions: 2, deletions: 1 });
    expect(by("staged.txt", "staged")).toMatchObject({ status: "A", additions: 1, deletions: 0 });
    expect(by("new/file.md", "untracked")).toMatchObject({ status: "?", additions: 2 });
    expect(by("pic.bin", "untracked")).toMatchObject({ binary: true });
    expect(status.changes.some((item) => item.path === "debug.log")).toBe(false);
  });

  it("领先上游的提交数与冲突文件", async () => {
    const origin = repository();
    const clone = temp("ws-clone-");
    git(clone, "clone", "-q", origin, ".");
    git(clone, "config", "user.email", "t@example.invalid");
    git(clone, "config", "user.name", "T");
    write(clone, "a.txt", "clone\n");
    git(clone, "commit", "-qam", "clone change");
    let status = await new WorkspaceView(clone).status();
    expect(status).toMatchObject({ upstream: "origin/main", ahead: 1, behind: 0 });

    git(clone, "checkout", "-q", "-b", "other", "HEAD~1");
    write(clone, "a.txt", "other\n");
    git(clone, "commit", "-qam", "other change");
    try {
      git(clone, "merge", "-q", "main");
    } catch {
      // 预期冲突
    }
    status = await new WorkspaceView(clone).status();
    expect(status.changes).toContainEqual(
      expect.objectContaining({ path: "a.txt", group: "conflict", status: "U" }),
    );
    const diff = await new WorkspaceView(clone).diff({
      path: "a.txt",
      mode: "conflict",
      reveal: false,
    });
    expect(diff.patch).toContain("<<<<<<<");
  });

  it("工作区是仓库子目录时路径相对子目录，外面的改动不算", async () => {
    const root = repository();
    write(root, "a.txt", "changed\n");
    write(root, "src/app.ts", "export const x = 2;\n");
    const view = new WorkspaceView(path.join(root, "src"));
    const status = await view.status();
    expect(status.changes.map((item) => item.path)).toEqual(["app.ts"]);
    const diff = await view.diff({ path: "app.ts", mode: "unstaged", reveal: false });
    expect(diff.patch).toMatch(/^@@ -1 \+1 @@\n-export const x = 1;\n\+export const x = 2;/);
  });

  it("未暂存、已暂存、未跟踪、二进制、超大与密钥文件的 diff", async () => {
    const root = repository();
    const view = new WorkspaceView(root);
    write(root, "a.txt", "one\nTWO\nthree\n");
    expect((await view.diff({ path: "a.txt", mode: "unstaged", reveal: false })).patch).toContain(
      "-two\n+TWO",
    );
    git(root, "add", "a.txt");
    expect((await view.diff({ path: "a.txt", mode: "staged", reveal: false })).patch).toContain(
      "+TWO",
    );
    write(
      root,
      "long.txt",
      Array.from({ length: 40 }, (_, index) => `l${index}`).join("\n") + "\n",
    );
    git(root, "add", "long.txt");
    write(
      root,
      "long.txt",
      Array.from({ length: 40 }, (_, index) => (index === 20 ? "changed" : `l${index}`)).join(
        "\n",
      ) + "\n",
    );
    const partial = await view.diff({ path: "long.txt", mode: "unstaged", reveal: false });
    expect(partial.full).toBeUndefined();
    expect(partial.patch).toMatch(/^@@ -18,7 \+18,7 @@/);
    const whole = await view.diff({
      path: "long.txt",
      mode: "unstaged",
      reveal: false,
      full: true,
    });
    expect(whole).toMatchObject({
      full: true,
      patch: expect.stringMatching(/^@@ -1,40 \+1,40 @@\n l0\n/),
    });
    write(root, "fresh.txt", "x\ny");
    expect(await view.diff({ path: "fresh.txt", mode: "untracked", reveal: false })).toEqual({
      path: "fresh.txt",
      patch: "@@ -0,0 +1,2 @@\n+x\n+y\n\\ No newline at end of file\n",
      full: true,
    });
    write(root, "blob.bin", Buffer.from([0, 0, 1]));
    git(root, "add", "blob.bin");
    expect(await view.diff({ path: "blob.bin", mode: "staged", reveal: false })).toMatchObject({
      binary: true,
    });
    write(root, "huge.txt", "line\n".repeat(WORKSPACE_LIMITS.diffBytes / 4));
    git(root, "add", "huge.txt");
    expect(await view.diff({ path: "huge.txt", mode: "staged", reveal: false })).toMatchObject({
      tooLarge: true,
    });
    write(root, ".env", "TOKEN=abc\n");
    const hidden = await view.diff({ path: ".env", mode: "untracked", reveal: false });
    expect(hidden).toEqual({ path: ".env", sensitive: true });
    expect((await view.diff({ path: ".env", mode: "untracked", reveal: true })).patch).toContain(
      "+TOKEN=abc",
    );
  });

  it("文件名里的通配符按字面处理", async () => {
    const root = repository();
    write(root, "x*.txt", "star\n");
    write(root, "xa.txt", "a\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "glob");
    write(root, "x*.txt", "star2\n");
    write(root, "xa.txt", "a2\n");
    const patch = (
      await new WorkspaceView(root).diff({ path: "x*.txt", mode: "unstaged", reveal: false })
    ).patch;
    expect(patch).toContain("+star2");
    expect(patch).not.toContain("a2");
  });

  it("最近提交、单个提交的改动与提交内文件 diff（含根提交）", async () => {
    const root = repository();
    const view = new WorkspaceView(root);
    const commits = await view.log();
    expect(commits.map((item) => item.subject)).toEqual(["add app", "initial"]);
    expect(commits[0]).toMatchObject({ author: "Tester", shortHash: expect.any(String) });
    const latest = await view.commit(commits[0]!.hash);
    expect(latest.body).toBe("Longer body.");
    expect(latest.changes).toEqual([
      expect.objectContaining({ path: "src/app.ts", status: "A", additions: 1, deletions: 0 }),
    ]);
    const first = await view.commit(commits[1]!.shortHash);
    expect(first.changes.map((item) => item.path).sort()).toEqual([".gitignore", "a.txt"]);
    const diff = await view.diff({
      path: "a.txt",
      mode: "commit",
      commit: commits[1]!.hash,
      reveal: false,
    });
    expect(diff.patch).toContain("+one");
    await expect(view.commit("--all")).rejects.toMatchObject({ code: "WORKSPACE_REF_INVALID" });
    await expect(view.commit("deadbeef")).rejects.toMatchObject({
      code: "WORKSPACE_REF_NOT_FOUND",
    });
    expect((await view.log({ skip: 1 })).map((item) => item.subject)).toEqual(["initial"]);
  });

  it("worktree 相对 base：分叉后的提交、未提交改动与新文件都算，base 上后来的改动不算", async () => {
    const root = repository();
    const tree = path.join(temp("ws-wt-"), "feature");
    git(root, "worktree", "add", "-q", "-b", "feature", tree, "main");
    write(tree, "a.txt", "one\ntwo\nthree\nmore\n");
    git(tree, "commit", "-qam", "feature work");
    write(tree, "src/app.ts", "export const x = 3;\n");
    write(tree, "notes.md", "new\n");
    write(root, "main-only.txt", "m\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "main moves on");
    const view = new WorkspaceView(realpathSync(tree));
    const compared = await view.compare("main");
    expect(compared.commits?.map((item) => item.subject)).toEqual(["feature work"]);
    expect(compared.changes.map((item) => [item.path, item.status])).toEqual([
      ["a.txt", "M"],
      ["notes.md", "A"],
      ["src/app.ts", "M"],
    ]);
    expect(compared.changes.find((item) => item.path === "notes.md")).toMatchObject({
      additions: 1,
    });
    expect(
      (await view.diff({ path: "notes.md", mode: "base", base: "main", reveal: false })).patch,
    ).toContain("+new");
    expect(
      (await view.diff({ path: "a.txt", mode: "base", base: "main", reveal: false })).patch,
    ).toContain("+more");
    await expect(view.compare("--output=/tmp/x")).rejects.toMatchObject({
      code: "WORKSPACE_REF_INVALID",
    });
  });

  it("不是 git 仓库：状态为空、日志报错，文件树与搜索照常", async () => {
    const root = temp("ws-plain-");
    write(root, "notes/todo.md", "- a\n");
    const view = new WorkspaceView(root);
    expect(await view.status()).toEqual({ git: false, changes: [] });
    await expect(view.log()).rejects.toMatchObject({ code: "WORKSPACE_NOT_GIT" });
    expect((await view.tree("", { ignored: false })).entries).toEqual([
      { name: "notes", path: "notes", type: "directory" },
    ]);
    expect((await view.search("todo")).paths).toEqual(["notes/todo.md"]);
  });

  it("解析 numstat：重命名、二进制", () => {
    const stats = parseNumstat(
      ["1\t2\ta.txt", "-\t-\timg.png", "3\t0\t", "old.ts", "new.ts", ""].join("\0"),
    );
    expect(stats.get("a.txt")).toEqual({ additions: 1, deletions: 2 });
    expect(stats.get("img.png")).toEqual({ binary: true });
    expect(stats.get("new.ts")).toEqual({ additions: 3, deletions: 0 });
    expect(hunksOf("diff --git a/x b/x\nBinary files a/x and b/x differ\n")).toEqual({
      binary: true,
    });
    expect(
      hunksOf("diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n"),
    ).toEqual({
      patch: "@@ -1 +1 @@\n-a\n+b\n",
    });
  });
});

describe("非 UTF-8 文件的预览与 diff", () => {
  const gbk = (hexText: string) => Buffer.from(hexText.replace(/\s/g, ""), "hex");
  const utf16le = (text: string) =>
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);

  it("GBK 文件：预览与已暂存、未暂存、未跟踪、提交里的 diff 都按 GB18030 解码并标 gbk", async () => {
    const root = repository();
    const view = new WorkspaceView(root);
    // 「// 中文\n」→「// 修改\n」
    write(root, "gbk.c", gbk("2f2f20 d6d0cec4 0a"));
    expect(await view.file("gbk.c", false)).toMatchObject({
      content: "// 中文\n",
      encoding: "gbk",
    });
    expect(await view.diff({ path: "gbk.c", mode: "untracked", reveal: false })).toMatchObject({
      patch: "@@ -0,0 +1,1 @@\n+// 中文\n",
      encoding: "gbk",
    });
    git(root, "add", "gbk.c");
    git(root, "commit", "-q", "-m", "gbk");
    write(root, "gbk.c", gbk("2f2f20 d0deb8c4 0a"));
    expect(await view.diff({ path: "gbk.c", mode: "unstaged", reveal: false })).toMatchObject({
      patch: expect.stringContaining("-// 中文\n+// 修改"),
      encoding: "gbk",
    });
    git(root, "add", "gbk.c");
    expect(await view.diff({ path: "gbk.c", mode: "staged", reveal: false })).toMatchObject({
      patch: expect.stringContaining("-// 中文\n+// 修改"),
      encoding: "gbk",
    });
    git(root, "commit", "-q", "-m", "change");
    const hash = git(root, "rev-parse", "HEAD").trim();
    expect(
      await view.diff({ path: "gbk.c", mode: "commit", commit: hash, reveal: false, full: true }),
    ).toMatchObject({ patch: "@@ -1 +1 @@\n-// 中文\n+// 修改\n", encoding: "gbk", full: true });
    // 普通 UTF-8 的 diff 不带 encoding
    write(root, "a.txt", "一\n");
    expect(
      (await view.diff({ path: "a.txt", mode: "unstaged", reveal: false })).encoding,
    ).toBeUndefined();
    expect((await view.file("a.txt", false)).encoding).toBeUndefined();
  });

  it("UTF-16 文件：预览不再判成二进制；git 当二进制的改动解码两侧后照常给 diff", async () => {
    const root = repository();
    const view = new WorkspaceView(root);
    write(root, "out.txt", utf16le("第一行\r\n上面\r\n"));
    expect(await view.file("out.txt", false)).toMatchObject({
      content: "第一行\r\n上面\r\n",
      encoding: "utf-16",
    });
    expect(await view.diff({ path: "out.txt", mode: "untracked", reveal: false })).toMatchObject({
      patch: "@@ -0,0 +1,2 @@\n+第一行\r\n+上面\r\n",
      encoding: "utf-16",
    });
    git(root, "add", "out.txt");
    // 新增到暂存区：HEAD 里没有，按整份新增
    expect(await view.diff({ path: "out.txt", mode: "staged", reveal: false })).toMatchObject({
      patch: "@@ -0,0 +1,2 @@\n+第一行\r\n+上面\r\n",
      encoding: "utf-16",
    });
    git(root, "commit", "-q", "-m", "utf16");
    write(root, "out.txt", utf16le("第一行\r\n下面\r\n"));
    // 改动列表里也按解码后的行数算，不标二进制
    expect((await view.status()).changes).toContainEqual(
      expect.objectContaining({ path: "out.txt", additions: 1, deletions: 1 }),
    );
    expect(
      (await view.status()).changes.find((item) => item.path === "out.txt")?.binary,
    ).toBeUndefined();
    const unstaged = await view.diff({
      path: "out.txt",
      mode: "unstaged",
      reveal: false,
      full: true,
    });
    expect(unstaged).toEqual({
      path: "out.txt",
      patch: "@@ -1,2 +1,2 @@\n 第一行\r\n-上面\r\n+下面\r\n",
      full: true,
      encoding: "utf-16",
    });
    git(root, "add", "out.txt");
    git(root, "commit", "-q", "-m", "edit");
    const hash = git(root, "rev-parse", "HEAD").trim();
    expect((await view.commit(hash)).changes).toEqual([
      expect.objectContaining({ path: "out.txt", additions: 1, deletions: 1 }),
    ]);
    expect(
      await view.diff({ path: "out.txt", mode: "commit", commit: hash, reveal: false }),
    ).toMatchObject({ patch: expect.stringContaining("-上面\r\n+下面"), encoding: "utf-16" });
    // 删掉：工作区没有了，按整份删除
    rmSync(path.join(root, "out.txt"));
    expect(await view.diff({ path: "out.txt", mode: "unstaged", reveal: false })).toMatchObject({
      patch: "@@ -1,2 +0,0 @@\n-第一行\r\n-下面\r\n",
      encoding: "utf-16",
    });
    // 真二进制照旧
    write(root, "blob.bin", Buffer.from([0, 0, 1]));
    git(root, "add", "blob.bin");
    expect(await view.diff({ path: "blob.bin", mode: "staged", reveal: false })).toEqual({
      path: "blob.bin",
      binary: true,
    });
  });
});

describe("文件树与预览", () => {
  it("懒加载一层，默认隐藏被忽略的与 .git，可切换显示；带 git 状态", async () => {
    const root = repository();
    write(root, "dist/out.js", "x");
    write(root, "src/new.ts", "y\n");
    write(root, "a.txt", "changed\n");
    const view = new WorkspaceView(root);
    const top = await view.tree("", { ignored: false });
    expect(top.entries.map((item) => item.name)).toEqual(["src", ".gitignore", "a.txt"]);
    expect(top.entries.find((item) => item.name === "src")).toMatchObject({ status: "?" });
    expect(top.entries.find((item) => item.name === "a.txt")).toMatchObject({
      status: "M",
      size: 8,
    });
    const all = await view.tree("", { ignored: true });
    expect(all.entries.find((item) => item.name === "dist")).toMatchObject({ ignored: true });
    expect(all.entries.some((item) => item.name === ".git")).toBe(false);
    const src = await view.tree("src", { ignored: false });
    expect(src.entries.map((item) => item.path)).toEqual(["src/app.ts", "src/new.ts"]);
  });

  it("预览：大文件截断、二进制不给内容、密钥文件要 reveal", async () => {
    const root = repository();
    write(root, "big.txt", "a".repeat(WORKSPACE_LIMITS.previewBytes + 10));
    write(root, "img.png", Buffer.from([137, 80, 78, 71, 0, 0]));
    write(root, "certs/server.key", "-----BEGIN PRIVATE KEY-----\n");
    const view = new WorkspaceView(root);
    const big = await view.file("big.txt", false);
    expect(big).toMatchObject({ truncated: true, size: WORKSPACE_LIMITS.previewBytes + 10 });
    expect(big.content).toHaveLength(WORKSPACE_LIMITS.previewBytes);
    expect(await view.file("img.png", false)).toEqual({ path: "img.png", size: 6, binary: true });
    expect(await view.file("certs/server.key", false)).toEqual({
      path: "certs/server.key",
      size: 28,
      sensitive: true,
    });
    expect((await view.file("certs/server.key", true)).content).toContain("PRIVATE KEY");
    await expect(view.file("src", false)).rejects.toMatchObject({ code: "WORKSPACE_NOT_FILE" });
    await expect(view.file("missing.txt", false)).rejects.toMatchObject({
      code: "WORKSPACE_PATH_NOT_FOUND",
    });
  });

  it("按文件名搜索：文件名命中排前面，忽略的不出现", async () => {
    const root = repository();
    write(root, "dist/app.js", "x");
    write(root, "docs/application-notes.md", "y");
    const result = await new WorkspaceView(root).search("app");
    expect(result.paths).toEqual(["src/app.ts", "docs/application-notes.md"]);
  });
});

describe("工作区文件接口", () => {
  const OWNER = { authorization: "Bearer test-token" };

  async function start(
    options: {
      workspace?: string;
      worktree?: { path: string; branch: string };
      now?: () => number;
    } = {},
  ) {
    const dir = temp("ws-db-");
    const filename = path.join(dir, "db.sqlite");
    const seed = new HiveDatabase(filename);
    if (options.workspace) seed.updateRoom("general", { workspace: options.workspace });
    const worktreeId = randomUUID();
    if (options.worktree && options.workspace) {
      const connection = seed.connection();
      connection.exec(`CREATE TABLE IF NOT EXISTS managed_worktrees (
        id TEXT PRIMARY KEY, repo TEXT NOT NULL, agent_name TEXT NOT NULL, slug TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE, branch TEXT NOT NULL, record TEXT NOT NULL,
        UNIQUE(repo, agent_name, slug), UNIQUE(repo, branch)
      )`);
      const record = {
        id: worktreeId,
        repo: options.workspace,
        commonDir: path.join(options.workspace, ".git"),
        path: options.worktree.path,
        branch: options.worktree.branch,
        base: "main",
        baseCommit: git(options.workspace, "rev-parse", "main").trim(),
        target: "main",
        slug: "feature",
        roomId: "general",
        agentName: "helper",
        ownerName: "rd",
        invocationIds: [],
        createdAt: new Date().toISOString(),
        phase: "ready",
      };
      connection
        .prepare(
          "INSERT INTO managed_worktrees (id, repo, agent_name, slug, path, branch, record) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          record.id,
          record.repo,
          record.agentName,
          record.slug,
          record.path,
          record.branch,
          JSON.stringify(record),
        );
    }
    seed.close();
    const logs: string[] = [];
    const app = await buildApp({
      databasePath: filename,
      token: "test-token",
      staticDir: "/definitely-not-present",
      logger: { level: "info", stream: { write: (line: string) => logs.push(line) } },
      ...(options.now ? { now: options.now } : {}),
    });
    cleanup.push(() => app.close());
    const guestToken = async () => {
      const invite = await app.inject({
        method: "POST",
        url: "/api/rooms/general/invites",
        headers: OWNER,
        payload: { expiresInMinutes: 60 },
      });
      const redeemed = await app.inject({
        method: "POST",
        url: "/api/invites/redeem",
        payload: { token: invite.json().token, username: "alice" },
      });
      return { authorization: `Bearer ${redeemed.json().token as string}` };
    };
    return { app, logs, worktreeId, guestToken };
  }

  it("房主可看且响应不缓存；没凭证 401；没设工作区给出说明", async () => {
    const { app } = await start();
    expect((await app.inject({ url: "/api/rooms/general/workspace" })).statusCode).toBe(401);
    const empty = await app.inject({ url: "/api/rooms/general/workspace", headers: OWNER });
    expect(empty.json()).toMatchObject({ configured: false, git: false, canReveal: true });
    expect(empty.headers["cache-control"]).toBe("no-store");
    const status = await app.inject({ url: "/api/rooms/general/workspace/status", headers: OWNER });
    expect(status.statusCode).toBe(404);
    expect(status.json().code).toBe("error.workspaceFiles.notConfigured");
  });

  it("访客默认不能看，房主打开后能看但不能 reveal 密钥文件；审计只记路径", async () => {
    const root = repository();
    write(root, ".env", "TOKEN=super-secret-value\n");
    write(root, "a.txt", "changed\n");
    const { app, logs, guestToken } = await start({ workspace: root });
    const guest = await guestToken();
    const denied = await app.inject({ url: "/api/rooms/general/workspace/tree", headers: guest });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe("error.workspaceFiles.guestsDisabled");
    expect(
      (await app.inject({ url: "/api/rooms/general/workspace", headers: guest })).statusCode,
    ).toBe(403);
    // 访客不能自己打开
    const selfEnable = await app.inject({
      method: "PATCH",
      url: "/api/rooms/general",
      headers: guest,
      payload: { workspaceFilesGuests: true },
    });
    expect(selfEnable.statusCode).toBe(403);

    const enabled = await app.inject({
      method: "PATCH",
      url: "/api/rooms/general",
      headers: OWNER,
      payload: { workspaceFilesGuests: true },
    });
    expect(enabled.json().room.workspaceFilesGuests).toBe(true);
    const overview = await app.inject({ url: "/api/rooms/general/workspace", headers: guest });
    expect(overview.json()).toMatchObject({
      configured: true,
      git: true,
      changeCount: 2,
      guestsAllowed: true,
      canReveal: false,
      sources: [{ id: "workspace", kind: "workspace", branch: "main" }],
    });
    expect(JSON.stringify(overview.json())).not.toContain(root);
    const file = await app.inject({
      url: "/api/rooms/general/workspace/file?path=.env",
      headers: guest,
    });
    expect(file.json()).toEqual({ path: ".env", size: 25, sensitive: true });
    const reveal = await app.inject({
      url: "/api/rooms/general/workspace/file?path=.env&reveal=1",
      headers: guest,
    });
    expect(reveal.statusCode).toBe(403);
    const ownerReveal = await app.inject({
      url: "/api/rooms/general/workspace/file?path=.env&reveal=1",
      headers: OWNER,
    });
    expect(ownerReveal.json().content).toContain("super-secret-value");
    expect(ownerReveal.headers["cache-control"]).toBe("no-store");
    const traversal = await app.inject({
      url: `/api/rooms/general/workspace/file?path=${encodeURIComponent("../etc/passwd")}`,
      headers: OWNER,
    });
    expect(traversal.statusCode).toBe(400);
    const gitConfig = await app.inject({
      url: "/api/rooms/general/workspace/file?path=.git/config",
      headers: OWNER,
    });
    expect(gitConfig.statusCode).toBe(400);
    const audited = logs.filter((line) => line.includes("workspace file viewed")).join("\n");
    expect(audited).toContain('"path":".env"');
    expect(audited).toContain('"by":"human:alice"');
    expect(audited).toContain('"revealed":true');
    expect(logs.join("\n")).not.toContain("super-secret-value");

    await app.inject({
      method: "PATCH",
      url: "/api/rooms/general",
      headers: OWNER,
      payload: { workspaceFilesGuests: false },
    });
    expect(
      (await app.inject({ url: "/api/rooms/general/workspace/status", headers: guest })).statusCode,
    ).toBe(403);
  });

  it("可以切换到这个房间登记的 worktree 看相对 base 的改动", async () => {
    const root = repository();
    const tree = path.join(temp("ws-route-wt-"), "feature");
    git(root, "worktree", "add", "-q", "-b", "feature", tree, "main");
    write(tree, "a.txt", "feature\n");
    const { app, worktreeId } = await start({
      workspace: root,
      worktree: { path: realpathSync(tree), branch: "feature" },
    });
    const overview = (
      await app.inject({ url: "/api/rooms/general/workspace", headers: OWNER })
    ).json();
    expect(overview.sources).toEqual([
      expect.objectContaining({ id: "workspace" }),
      expect.objectContaining({
        id: worktreeId,
        kind: "worktree",
        branch: "feature",
        agentName: "helper",
        base: "main",
      }),
    ]);
    const compared = await app.inject({
      url: `/api/rooms/general/workspace/compare?source=${worktreeId}`,
      headers: OWNER,
    });
    expect(compared.json()).toMatchObject({
      base: "main",
      changes: [expect.objectContaining({ path: "a.txt", status: "M" })],
    });
    const diff = await app.inject({
      url: `/api/rooms/general/workspace/diff?source=${worktreeId}&path=a.txt&mode=base`,
      headers: OWNER,
    });
    expect(diff.json().patch).toContain("+feature");
    const unknown = await app.inject({
      url: `/api/rooms/general/workspace/status?source=${randomUUID()}`,
      headers: OWNER,
    });
    expect(unknown.statusCode).toBe(404);
    const invalid = await app.inject({
      url: "/api/rooms/general/workspace/status?source=../../etc",
      headers: OWNER,
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("总览带 detail 时给出每份代码的改动数、领先提交数、最近改动时间与是否已合入", async () => {
    const root = repository();
    const tree = path.join(temp("ws-activity-"), "feature");
    git(root, "worktree", "add", "-q", "-b", "feature", tree, "main");
    write(tree, "a.txt", "feature\n");
    git(tree, "commit", "-qam", "feature work");
    write(tree, "new.txt", "draft\n");
    const { app, worktreeId } = await start({
      workspace: root,
      worktree: { path: realpathSync(tree), branch: "feature" },
    });
    const plain = (
      await app.inject({ url: "/api/rooms/general/workspace", headers: OWNER })
    ).json();
    expect(plain.sources[1].activeAt).toBeUndefined();
    const detailed = (
      await app.inject({ url: "/api/rooms/general/workspace?detail=1", headers: OWNER })
    ).json();
    expect(detailed.sources[0]).toMatchObject({ id: "workspace", changeCount: 0, ahead: 0 });
    expect(detailed.sources[0].activeAt).toBeUndefined();
    expect(detailed.sources[1]).toMatchObject({
      id: worktreeId,
      changeCount: 1,
      ahead: 1,
      activeAt: expect.any(String),
    });
    expect(detailed.sources[1].merged).toBeUndefined();
    // 改动都撤掉、分支回到 main：算已合入，不再作为默认
    git(tree, "reset", "-q", "--hard", "main");
    rmSync(path.join(tree, "new.txt"));
    const after = (
      await app.inject({ url: "/api/rooms/general/workspace?detail=1", headers: OWNER })
    ).json();
    expect(after.sources[1]).toMatchObject({ changeCount: 0, ahead: 0, merged: true });
  });

  it("批量确认消息里的提交号和分支名：只认这个仓库真实存在的提交、登记过的任务线与当前分支", async () => {
    const root = repository();
    const head = git(root, "rev-parse", "HEAD").trim();
    const tree = path.join(temp("ws-refs-"), "feature");
    git(root, "worktree", "add", "-q", "-b", "feat/x", tree, "main");
    const { app, worktreeId, guestToken } = await start({
      workspace: root,
      worktree: { path: realpathSync(tree), branch: "feat/x" },
    });
    const short = head.slice(0, 7);
    const q = [short, "deadbeef1", "1234567", head, "feat/x", "main", "feat/missing", "--all"].join(
      ",",
    );
    const response = await app.inject({
      url: `/api/rooms/general/workspace/refs?q=${encodeURIComponent(q)}`,
      headers: OWNER,
    });
    expect(response.json()).toEqual({
      commits: { [short]: head, [head]: head },
      branches: { "feat/x": worktreeId, main: "workspace" },
    });
    // 访客没被允许看工作区时，连哪些提交存在也不告诉
    const guest = await guestToken();
    expect(
      (await app.inject({ url: `/api/rooms/general/workspace/refs?q=${short}`, headers: guest }))
        .statusCode,
    ).toBe(403);
  });

  describe("原始字节与临时链接", () => {
    const bytes = Buffer.from(Array.from({ length: 1000 }, (_, index) => index % 256));

    async function rawUrl(
      app: Awaited<ReturnType<typeof start>>["app"],
      query: string,
      headers: Record<string, string> = OWNER,
    ) {
      return app.inject({ url: `/api/rooms/general/workspace/raw-url?${query}`, headers });
    }

    it("图片按白名单类型返回，带 nosniff 与沙箱，不需要请求头；支持 Range 206 / 416", async () => {
      const root = repository();
      write(root, "logo.png", bytes);
      const { app, logs } = await start({ workspace: root });
      const issued = await rawUrl(app, "path=logo.png");
      expect(issued.headers["cache-control"]).toBe("no-store");
      expect(issued.json()).toMatchObject({
        size: 1000,
        contentType: "image/png",
        inline: true,
        url: expect.stringMatching(/^\/api\/rooms\/general\/workspace\/raw\?t=/),
      });
      expect(issued.json().url).not.toContain("test-token");
      const url = issued.json().url as string;
      const full = await app.inject({ url });
      expect(full.statusCode).toBe(200);
      expect(full.headers).toMatchObject({
        "content-type": "image/png",
        "x-content-type-options": "nosniff",
        "accept-ranges": "bytes",
        "content-length": "1000",
      });
      expect(full.headers["content-security-policy"]).toContain("sandbox");
      expect(full.rawPayload.equals(bytes)).toBe(true);
      const part = await app.inject({ url, headers: { range: "bytes=10-19" } });
      expect(part.statusCode).toBe(206);
      expect(part.headers["content-range"]).toBe("bytes 10-19/1000");
      expect(part.rawPayload.equals(bytes.subarray(10, 20))).toBe(true);
      const tail = await app.inject({ url, headers: { range: "bytes=-5" } });
      expect(tail.rawPayload.equals(bytes.subarray(995))).toBe(true);
      const beyond = await app.inject({ url, headers: { range: "bytes=2000-" } });
      expect(beyond.statusCode).toBe(416);
      expect(beyond.headers["content-range"]).toBe("bytes */1000");
      expect(logs.join("\n")).toContain('"action":"raw"');
    });

    it("SVG 以 image/svg+xml 返回并加沙箱 CSP；不在白名单的一律下载", async () => {
      const root = repository();
      write(
        root,
        "icon.svg",
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      );
      write(root, "page.html", "<script>alert(1)</script>");
      const { app } = await start({ workspace: root });
      const svg = await app.inject({ url: (await rawUrl(app, "path=icon.svg")).json().url });
      expect(svg.headers["content-type"]).toBe("image/svg+xml");
      expect(svg.headers["content-security-policy"]).toBe(
        "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      );
      expect(svg.headers["content-disposition"]).toMatch(/^inline;/);
      const issued = await rawUrl(app, "path=page.html");
      expect(issued.json()).toMatchObject({
        contentType: "application/octet-stream",
        inline: false,
      });
      const html = await app.inject({ url: issued.json().url });
      expect(html.headers["content-type"]).toBe("application/octet-stream");
      expect(html.headers["content-disposition"]).toMatch(/^attachment; filename="page.html"/);
      const forced = await app.inject({
        url: (await rawUrl(app, "path=icon.svg&download=1")).json().url,
      });
      expect(forced.headers["content-type"]).toBe("application/octet-stream");
    });

    it("读 git 里的版本：HEAD、暂存区、某个提交与它的父提交，Range 同样可用", async () => {
      const root = repository();
      write(root, "logo.png", bytes.subarray(0, 100));
      git(root, "add", "logo.png");
      git(root, "commit", "-qm", "logo v1");
      const v1 = git(root, "rev-parse", "HEAD").trim();
      write(root, "logo.png", bytes.subarray(0, 200));
      git(root, "add", "logo.png");
      git(root, "commit", "-qm", "logo v2");
      const v2 = git(root, "rev-parse", "HEAD").trim();
      write(root, "logo.png", bytes.subarray(0, 300));
      git(root, "add", "logo.png");
      write(root, "logo.png", bytes);
      const { app } = await start({ workspace: root });
      const sizeOf = async (ref: string) =>
        (await rawUrl(app, `path=logo.png&ref=${ref}`)).json().size;
      expect(await sizeOf("worktree")).toBe(1000);
      expect(await sizeOf("index")).toBe(300);
      expect(await sizeOf("HEAD")).toBe(200);
      expect(await sizeOf(v1)).toBe(100);
      expect(await sizeOf(`parent:${v2}`)).toBe(100);
      expect(await sizeOf("base:main")).toBe(200);
      const url = (await rawUrl(app, `path=logo.png&ref=${v1}`)).json().url;
      const whole = await app.inject({ url });
      expect(whole.rawPayload.equals(bytes.subarray(0, 100))).toBe(true);
      const part = await app.inject({ url, headers: { range: "bytes=50-59" } });
      expect(part.statusCode).toBe(206);
      expect(part.rawPayload.equals(bytes.subarray(50, 60))).toBe(true);
      expect((await rawUrl(app, `path=logo.png&ref=parent:${v1}`)).statusCode).toBe(404);
      expect((await rawUrl(app, "path=logo.png&ref=--output%3D%2Ftmp%2Fx")).statusCode).toBe(400);
      expect((await rawUrl(app, "path=logo.png&ref=base:..%2Fx")).statusCode).toBe(400);
      expect((await rawUrl(app, "path=..%2Fx&ref=HEAD")).statusCode).toBe(400);
    });

    it("签名被改、过期、拿到别的房间用、访客被收回权限时都拒绝", async () => {
      const root = repository();
      write(root, "logo.png", bytes);
      let time = Date.now();
      const { app, guestToken } = await start({ workspace: root, now: () => time });
      const url = (await rawUrl(app, "path=logo.png")).json().url as string;
      const [, token] = url.split("?t=");
      const [payload, signature] = token!.split(".");
      const forged = Buffer.from(
        JSON.stringify({
          ...JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")),
          path: "a.txt",
        }),
      ).toString("base64url");
      const tampered = await app.inject({
        url: `/api/rooms/general/workspace/raw?t=${forged}.${signature}`,
      });
      expect(tampered.statusCode).toBe(403);
      expect(tampered.json().code).toBe("error.workspaceFiles.linkExpired");
      const other = realpathSync(mkdtempSync(path.join(tmpdir(), "ws-other-")));
      cleanup.push(() => rmSync(other, { recursive: true, force: true }));
      await app.inject({
        method: "POST",
        url: "/api/rooms",
        headers: OWNER,
        payload: { id: "other", workspace: other },
      });
      expect(
        (await app.inject({ url: url.replace("/rooms/general/", "/rooms/other/") })).statusCode,
      ).toBe(403);
      expect((await app.inject({ url: `${url}x` })).statusCode).toBe(403);
      time += 11 * 60 * 1000;
      expect((await app.inject({ url })).statusCode).toBe(403);

      await app.inject({
        method: "PATCH",
        url: "/api/rooms/general",
        headers: OWNER,
        payload: { workspaceFilesGuests: true },
      });
      const guest = await guestToken();
      const guestUrl = (await rawUrl(app, "path=logo.png", guest)).json().url as string;
      expect((await app.inject({ url: guestUrl })).statusCode).toBe(200);
      await app.inject({
        method: "PATCH",
        url: "/api/rooms/general",
        headers: OWNER,
        payload: { workspaceFilesGuests: false },
      });
      const revoked = await app.inject({ url: guestUrl });
      expect(revoked.statusCode).toBe(403);
      expect(revoked.json().code).toBe("error.workspaceFiles.guestsDisabled");
    });

    it("密钥文件不给原始字节：房主要 reveal，访客一律不行", async () => {
      const root = repository();
      write(root, "certs/server.pem", "-----BEGIN PRIVATE KEY-----\n");
      const { app, guestToken } = await start({ workspace: root });
      const hidden = await rawUrl(app, "path=certs%2Fserver.pem");
      expect(hidden.statusCode).toBe(403);
      expect(hidden.json().code).toBe("error.workspaceFiles.revealRequired");
      const revealed = await rawUrl(app, "path=certs%2Fserver.pem&reveal=1");
      expect(revealed.statusCode).toBe(200);
      expect((await app.inject({ url: revealed.json().url })).body).toContain("PRIVATE KEY");
      await app.inject({
        method: "PATCH",
        url: "/api/rooms/general",
        headers: OWNER,
        payload: { workspaceFilesGuests: true },
      });
      const guest = await guestToken();
      expect((await rawUrl(app, "path=certs%2Fserver.pem", guest)).statusCode).toBe(403);
      expect((await rawUrl(app, "path=certs%2Fserver.pem&reveal=1", guest)).statusCode).toBe(403);
    });
  });

  it("本机房主可以在访达里显示工作区文件，路径校验相同；远程设备和访客不行", async () => {
    const root = repository();
    write(root, "tool.bin", Buffer.from([0, 1, 2]));
    const revealed: string[] = [];
    const app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      staticDir: "/definitely-not-present",
      revealInFolder: vi.fn(async (file: string) => {
        revealed.push(file);
      }),
      localAgents: {
        cli: { command: "/usr/bin/node", args: ["cli.js"] },
        serverUrl: "http://127.0.0.1:8787",
        spawn: () => {
          throw new Error("no agents");
        },
        probe: async () => ({ installed: true, version: "1.0.0" }),
      },
    });
    cleanup.push(() => app.close());
    await app.inject({
      method: "PATCH",
      url: "/api/rooms/general",
      headers: OWNER,
      payload: { workspace: root },
    });
    const { ownerToken } = (await app.inject({ url: "/api/local/session" })).json();
    const reveal = (
      path: string,
      headers: Record<string, string> = { "x-hive-owner": ownerToken },
    ) =>
      app.inject({
        method: "POST",
        url: "/api/local/rooms/general/workspace/reveal",
        headers,
        payload: { source: "workspace", path },
      });
    expect((await reveal("tool.bin")).json()).toEqual({ revealed: true });
    expect(revealed).toEqual([path.join(root, "tool.bin")]);
    expect((await reveal("../etc/passwd")).statusCode).toBe(400);
    expect((await reveal(".git/config")).statusCode).toBe(400);
    expect((await reveal("missing.bin")).statusCode).toBe(404);
    // 只有总令牌（不是本机凭证）不行
    expect((await reveal("tool.bin", OWNER)).statusCode).toBe(401);
    expect(revealed).toHaveLength(1);
  });

  it("本机房主能查房间绑定的工作区（桌面端选附件的起始目录）；只有总令牌、未绑定、房间不存在各有回应", async () => {
    const root = repository();
    const app = await buildApp({
      databasePath: ":memory:",
      token: "test-token",
      staticDir: "/definitely-not-present",
      localAgents: {
        cli: { command: "/usr/bin/node", args: ["cli.js"] },
        serverUrl: "http://127.0.0.1:8787",
        spawn: () => {
          throw new Error("no agents");
        },
        probe: async () => ({ installed: true, version: "1.0.0" }),
      },
    });
    cleanup.push(() => app.close());
    const { ownerToken } = (await app.inject({ url: "/api/local/session" })).json();
    const query = (
      room: string,
      headers: Record<string, string> = { "x-hive-owner": ownerToken },
    ) => app.inject({ url: `/api/local/rooms/${room}/workspace`, headers });
    expect((await query("general")).json()).toEqual({ workspace: null });
    await app.inject({
      method: "PATCH",
      url: "/api/rooms/general",
      headers: OWNER,
      payload: { workspace: root },
    });
    expect((await query("general")).json()).toEqual({ workspace: root });
    expect((await query("no-such-room")).statusCode).toBe(404);
    expect((await query("general", OWNER)).statusCode).toBe(401);
    expect((await query("general", {})).statusCode).toBe(401);
  });
});

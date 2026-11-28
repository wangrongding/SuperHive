import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ManagedWorktree, Participant } from "@superhive/protocol";
import { HiveDatabase } from "./database.js";
import { WorktreeManager, blockingIgnored, worktreeGit, worktreeRepository } from "./worktrees.js";

/** 选中的任务目录的 id（没选中、或没沿用上次的目录时为 undefined） */
const idOf = (value: unknown) => (value as { id?: string } | undefined)?.id;

describe("managed worktrees", () => {
  let root: string;
  let repo: string;
  let database: HiveDatabase;
  let agent: Participant;
  let manager: WorktreeManager;
  let active: string[];

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const result = await worktreeGit(cwd, args);
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "hive-worktree-")));
    repo = path.join(root, "example repo");
    mkdirSync(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.email", "test@example.invalid");
    await git(repo, "config", "user.name", "Test");
    await git(repo, "config", "commit.gpgsign", "false");
    writeFileSync(path.join(repo, "first.txt"), "first\n");
    writeFileSync(path.join(repo, "second.txt"), "second\n");
    writeFileSync(path.join(repo, ".gitignore"), "ignored\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "initial");
    database = new HiveDatabase(":memory:");
    agent = database.upsertParticipant({ roomId: "general", username: "agent-a", type: "agent" });
    active = [];
    manager = new WorktreeManager({ database, activeInvocations: () => active });
  });

  afterEach(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  const create = () => manager.create(repo, agent, "Alice", [randomUUID()], { slug: "feature" });
  async function change(record: ManagedWorktree, file = "first.txt", content = "changed\n") {
    writeFileSync(path.join(record.path, file), content);
    await git(record.path, "add", file);
    await git(record.path, "commit", "-m", `change ${file}`);
  }

  it("creates from the latest default branch, reserves a claim and reuses the task line", async () => {
    const [first, second] = await Promise.all([create(), create()]);
    expect([first.reused, second.reused].sort()).toEqual([false, true]);
    expect(second.worktree.id).toBe(first.worktree.id);
    expect([first, second].find((result) => result.reused)?.worktree.invocationIds).toHaveLength(2);
    expect(first.worktree.path).toBe(path.join(root, "example repo-wt", "agent-a-feature"));
    expect(first.worktree.baseCommit).toBe(await git(repo, "rev-parse", "refs/heads/main"));
    expect(await git(first.worktree.path, "branch", "--show-current")).toBe("feat/agent-a-feature");
    expect(database.listWhiteboard("general")[0]).toMatchObject({
      slot: "in_progress",
      claim: { repo, branch: first.worktree.branch },
    });
    const other = new WorktreeManager({ database, activeInvocations: () => [] });
    expect((await other.list(repo))[0]?.worktree.id).toBe(first.worktree.id);
  });

  it("persists exact task bindings across focus changes and releases them on removal", async () => {
    const firstId = randomUUID();
    const secondId = randomUUID();
    const first = await manager.create(repo, agent, "Alice", [firstId], { slug: "one" });
    const second = await manager.create(repo, agent, "Alice", [secondId], { slug: "two" });
    const grouped = await manager.runtimeWorkspaces(repo, agent, [
      { ownerName: "Alice", invocationId: firstId },
      { ownerName: "Alice", invocationId: secondId },
    ]);
    expect(idOf(grouped.get(firstId))).toBe(first.worktree.id);
    expect(idOf(grouped.get(secondId))).toBe(second.worktree.id);
    expect(idOf(await manager.runtimeWorkspace(repo, agent, "Alice", firstId))).toBe(
      first.worktree.id,
    );
    const followupId = randomUUID();
    expect(idOf(await manager.runtimeWorkspace(repo, agent, "Alice", followupId))).toBe(
      second.worktree.id,
    );
    await expect(manager.runtimeWorkspace(repo, agent, "Guest", secondId)).rejects.toThrow();
    await manager.remove(repo, { path: second.worktree.path });
    expect(await manager.runtimeWorkspace(repo, agent, "Alice", followupId)).toMatchObject({
      removed: true,
      id: second.worktree.id,
    });
    expect(await manager.runtimeWorkspace(repo, agent, "Alice", randomUUID())).toBeUndefined();
    const recreated = new WorktreeManager({ database, activeInvocations: () => [] });
    expect(idOf(await recreated.runtimeWorkspace(repo, agent, "Alice", firstId))).toBe(
      first.worktree.id,
    );
  });

  describe("a task line whose branch was switched inside its checkout", () => {
    const focusRows = () =>
      database.connection().prepare("SELECT * FROM managed_worktree_focus").all();
    const board = (id: string) =>
      database.listWhiteboard("general").find((entry) => entry.key === `worktree:${id}`);

    it("refuses its bound tasks, tells new tasks why it was not reused, and is never auto-cleaned", async () => {
      const audit = vi.fn();
      const notify = vi.fn();
      manager = new WorktreeManager({
        database,
        activeInvocations: () => active,
        audit,
        onCleanup: notify,
      });
      const initial = randomUUID();
      const { worktree } = await manager.create(repo, agent, "Alice", [initial], {
        slug: "switched",
      });
      await git(worktree.path, "switch", "-c", "feat/agent-a-other");

      // 绑定的任务：照旧拒绝，原因写明两条分支和处理办法
      const refusal = manager.runtimeWorkspace(repo, agent, "Alice", initial);
      await expect(refusal).rejects.toMatchObject({
        code: "WORKTREE_IDENTITY",
        switched: { registered: worktree.branch, current: "feat/agent-a-other" },
      });
      await expect(refusal).rejects.toThrow(
        /登记的分支是 feat\/agent-a-switched，现在却在 feat\/agent-a-other.*hive_worktree_create/,
      );
      expect(board(worktree.id)).toMatchObject({ slot: "blocked", branch: worktree.branch });
      expect(board(worktree.id)?.summary).toContain(
        "分支已被切换：登记 feat/agent-a-switched，当前 feat/agent-a-other",
      );

      // 只是沿用「上次用的目录」的新任务：不沿用，并把原因带回去；去掉 focus、写审计，绑定不动
      const next = randomUUID();
      expect(await manager.runtimeWorkspace(repo, agent, "Alice", next)).toEqual({
        focusDropped: {
          worktreeId: worktree.id,
          path: worktree.path,
          branch: worktree.branch,
          reason: expect.stringContaining("现在却在 feat/agent-a-other"),
        },
      });
      expect(focusRows()).toEqual([]);
      expect(audit).toHaveBeenCalledWith(
        expect.stringContaining(`agent-a 上次用的任务目录 ${worktree.path} 不能再用`),
        { roomId: "general", agentName: "agent-a", worktreeId: worktree.id },
      );
      expect(
        database
          .connection()
          .prepare("SELECT worktree_id FROM managed_worktree_bindings WHERE invocation_id = ?")
          .get(next),
      ).toBeUndefined();
      // 已经告诉过一次：之后没有默认目录，也就没有说明
      expect(await manager.runtimeWorkspace(repo, agent, "Alice", randomUUID())).toBeUndefined();
      await expect(manager.runtimeWorkspace(repo, agent, "Alice", initial)).rejects.toThrow();

      // 复用 slug：拒绝，说明换 slug 或请房主处理
      const reuse = manager.create(repo, agent, "Alice", [randomUUID()], { slug: "switched" });
      await expect(reuse).rejects.toMatchObject({ code: "WORKTREE_IDENTITY" });
      await expect(reuse).rejects.toThrow(
        /slug switched 的任务目录.*已被切到分支 feat\/agent-a-other/,
      );

      // 列表标出来；登记的分支早已在 main 里（没有新提交），但清理扫描一律不碰
      const [status] = await manager.list(repo);
      expect(status).toMatchObject({
        removable: false,
        branchSwitched: { registered: worktree.branch, current: "feat/agent-a-other" },
        dirty: false,
        untracked: false,
      });
      await manager.setAutoCleanup("general", true);
      await manager.scan();
      expect(notify).not.toHaveBeenCalled();
      expect(manager.roomBatches("general")).toEqual([]);
      expect(existsSync(worktree.path)).toBe(true);
      expect(manager.allRecords()).toHaveLength(1);
    });

    it("lets the owner switch it back only when clean and no task uses it", async () => {
      const initial = randomUUID();
      const { worktree } = await manager.create(repo, agent, "Alice", [initial], {
        slug: "restore",
      });
      await git(worktree.path, "switch", "-c", "feat/agent-a-elsewhere");
      active = [initial];
      await expect(manager.repair(repo, worktree.id, "restore")).rejects.toMatchObject({
        code: "WORKTREE_BUSY",
      });
      active = [];
      writeFileSync(path.join(worktree.path, "draft.txt"), "draft\n");
      await expect(manager.repair(repo, worktree.id, "restore")).rejects.toMatchObject({
        code: "WORKTREE_DIRTY",
      });
      expect((await manager.list(repo))[0]).toMatchObject({ untracked: true });
      rmSync(path.join(worktree.path, "draft.txt"));
      const restored = await manager.repair(repo, worktree.id, "restore");
      expect(restored.branchSwitched).toBeUndefined();
      expect(restored.error).toBeUndefined();
      expect(await git(worktree.path, "branch", "--show-current")).toBe(worktree.branch);
      expect(board(worktree.id)).toMatchObject({ slot: "in_progress", branch: worktree.branch });
      expect(idOf(await manager.runtimeWorkspace(repo, agent, "Alice", initial))).toBe(worktree.id);
      await expect(manager.repair(repo, worktree.id, "restore")).rejects.toMatchObject({
        code: "WORKTREE_NOT_SWITCHED",
      });
    });

    it("refuses to switch back when the registered branch is gone", async () => {
      const { worktree } = await manager.create(repo, agent, "Alice", [randomUUID()], {
        slug: "gone-branch",
      });
      await git(worktree.path, "switch", "-c", "feat/agent-a-moved");
      await git(repo, "branch", "-D", worktree.branch);
      await expect(manager.repair(repo, worktree.id, "restore")).rejects.toMatchObject({
        code: "WORKTREE_BRANCH_GONE",
      });
    });

    it("re-registers on the current branch unless another task line has it", async () => {
      const initial = randomUUID();
      const { worktree } = await manager.create(repo, agent, "Alice", [initial], { slug: "adopt" });
      await git(worktree.path, "switch", "-c", "feat/agent-a-claimed");
      const other = database.upsertParticipant({
        roomId: "general",
        username: "agent-b",
        type: "agent",
      });
      database.upsertWhiteboardEntry(other, {
        key: "someone-else",
        slot: "in_progress",
        summary: "working on it",
        claim: { repo, branch: "feat/agent-a-claimed" },
      });
      const taken = manager.repair(repo, worktree.id, "adopt");
      await expect(taken).rejects.toMatchObject({ code: "WORKTREE_CLAIM_CONFLICT" });
      await expect(taken).rejects.toThrow(/feat\/agent-a-claimed 已被另一条任务线登记或占用/);
      await git(worktree.path, "switch", "-c", "feat/agent-a-adopted");
      active = [randomUUID()];
      await expect(manager.repair(repo, worktree.id, "adopt")).rejects.toMatchObject({
        code: "WORKTREE_BUSY",
      });
      active = [];
      // 有未提交的文件也能重新登记：分支不动，改动原样留着
      writeFileSync(path.join(worktree.path, "draft.txt"), "draft\n");
      const adopted = await manager.repair(repo, worktree.id, "adopt");
      expect(adopted.worktree.branch).toBe("feat/agent-a-adopted");
      expect(adopted).toMatchObject({ untracked: true });
      expect(adopted.branchSwitched).toBeUndefined();
      expect(manager.allRecords()[0]?.branch).toBe("feat/agent-a-adopted");
      expect(board(worktree.id)).toMatchObject({
        slot: "in_progress",
        branch: "feat/agent-a-adopted",
        claim: { repo, branch: "feat/agent-a-adopted" },
      });
      expect(idOf(await manager.runtimeWorkspace(repo, agent, "Alice", initial))).toBe(worktree.id);
      const reopened = new WorktreeManager({ database, activeInvocations: () => [] });
      expect(reopened.allRecords()[0]?.branch).toBe("feat/agent-a-adopted");
    });

    it("keeps refusing detached, deleted and replaced checkouts with the specific reason", async () => {
      const make = async (slug: string) => {
        const initial = randomUUID();
        const { worktree } = await manager.create(repo, agent, "Alice", [initial], { slug });
        return { initial, worktree };
      };
      const cases: Array<[string, (worktree: ManagedWorktree) => Promise<void>, RegExp]> = [
        [
          "detached",
          async (worktree) => {
            await git(worktree.path, "switch", "--detach");
          },
          /处于 detached HEAD/,
        ],
        [
          "deleted",
          async (worktree) => {
            rmSync(worktree.path, { recursive: true });
          },
          /不在了或已不是目录/,
        ],
        [
          "replaced",
          async (worktree) => {
            rmSync(worktree.path, { recursive: true });
            mkdirSync(worktree.path);
            await git(worktree.path, "init", "-b", "main");
          },
          /属于另一个 Git 仓库/,
        ],
        [
          "emptied",
          async (worktree) => {
            rmSync(worktree.path, { recursive: true });
            mkdirSync(worktree.path);
          },
          /被换成了链接或别的路径/,
        ],
        [
          "linked",
          async (worktree) => {
            const moved = `${worktree.path}-moved`;
            await git(repo, "worktree", "move", worktree.path, moved);
            symlinkSync(moved, worktree.path);
          },
          /被换成了链接或别的路径/,
        ],
      ];
      for (const [slug, damage, reason] of cases) {
        const { initial, worktree } = await make(slug);
        await damage(worktree);
        const refusal = manager.runtimeWorkspace(repo, agent, "Alice", initial);
        await expect(refusal, slug).rejects.toMatchObject({ code: "WORKTREE_IDENTITY" });
        await expect(refusal, slug).rejects.toThrow(reason);
        // 没有「切回」可做：列表里不标换分支，也不能修
        const status = (await manager.list(repo)).find((item) => item.worktree.id === worktree.id);
        expect(status?.branchSwitched, slug).toBeUndefined();
        expect(status?.removable, slug).toBe(false);
        expect(status?.error, slug).toMatch(reason);
        await expect(manager.repair(repo, worktree.id, "adopt"), slug).rejects.toMatchObject({
          code: "WORKTREE_NOT_SWITCHED",
        });
        // 新任务不被卡住，也不静默：带着具体原因
        const dropped = await manager.runtimeWorkspace(repo, agent, "Alice", randomUUID());
        expect(dropped, slug).toMatchObject({
          focusDropped: { worktreeId: worktree.id, reason: expect.stringMatching(reason) },
        });
      }
    }, 20_000);
  });

  /**
   * 让 git 变慢：PATH 前面放一个包装脚本，命令行里带 slow(pattern) 给的片段时先睡几秒再执行真的 git，
   * 每次调用都记下来。模拟机器负载很高时 git 半天不返回（故障单 3493d392）。
   */
  function installSlowGit(seconds: number) {
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const bin = path.join(root, "slow-git-bin");
    mkdirSync(bin);
    const log = path.join(bin, "calls.log");
    const pattern = path.join(bin, "slow");
    const started = path.join(bin, "started");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(
      path.join(bin, "git"),
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> ${quote(log)}`,
        `if [ -f ${quote(pattern)} ]; then`,
        `  pattern=$(cat ${quote(pattern)})`,
        `  case "$*" in *"$pattern"*) : > ${quote(started)}; sleep ${seconds} ;; esac`,
        "fi",
        `exec ${quote(real)} "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(path.join(bin, "git"), 0o755);
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    return {
      slow: (fragment: string) => writeFileSync(pattern, fragment),
      fast: () => rmSync(pattern, { force: true }),
      started: () => existsSync(started),
      calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
    };
  }

  it.skipIf(process.platform === "win32")(
    "answers busy before the Bridge gives up when git is slow, and stops that git so the lock is free",
    async () => {
      const id = randomUUID();
      const { worktree } = await manager.create(repo, agent, "Alice", [id], { slug: "feature" });
      const slowGit = installSlowGit(5);
      const lookups = new WorktreeManager({
        database,
        activeInvocations: () => active,
        lookupDeadlineMs: 2_000,
      });
      // 复核任务目录时核对它是不是还在原仓库：这一步的 git 卡住
      slowGit.slow(`-C ${worktree.path} rev-parse`);
      const started = performance.now();
      await expect(lookups.runtimeWorkspace(repo, agent, "Alice", id)).rejects.toMatchObject({
        code: "WORKTREE_GIT_LIMIT",
        message: expect.stringContaining("2 秒内没查完任务目录"),
      });
      // 比 Bridge 的 17 秒先放弃，也没等卡住的 git 睡完
      expect(performance.now() - started).toBeLessThan(4_000);
      expect(slowGit.started()).toBe(true);
      // 卡住的 git 到点就被结束、锁随之放开：紧接着的查询不用等它睡完
      slowGit.fast();
      const again = performance.now();
      expect(idOf(await lookups.runtimeWorkspace(repo, agent, "Alice", id))).toBe(worktree.id);
      expect(performance.now() - again).toBeLessThan(1_500);
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "answers busy while another worktree operation holds the repository, and skips the stale lookup",
    async () => {
      const id = randomUUID();
      const { worktree } = await manager.create(repo, agent, "Alice", [id], { slug: "feature" });
      const slowGit = installSlowGit(5);
      const lookups = new WorktreeManager({
        database,
        activeInvocations: () => active,
        lookupDeadlineMs: 2_000,
      });
      // 同一个仓库正在建另一条任务线，git worktree add 很慢，一直占着仓库锁
      slowGit.slow("worktree add");
      const creating = lookups.create(repo, agent, "Alice", [randomUUID()], { slug: "other" });
      await vi.waitFor(() => expect(slowGit.started()).toBe(true), { timeout: 5_000 });
      const started = performance.now();
      await expect(lookups.runtimeWorkspace(repo, agent, "Alice", id)).rejects.toMatchObject({
        code: "WORKTREE_GIT_LIMIT",
      });
      expect(performance.now() - started).toBeLessThan(4_000);
      const seen = slowGit.calls().length;
      slowGit.fast();
      await creating;
      await new Promise((resolve) => setTimeout(resolve, 200));
      // 排到锁时已经过了时限：没再去核对那个任务目录
      expect(
        slowGit
          .calls()
          .slice(seen)
          .filter((call) => call.includes(worktree.path)),
      ).toEqual([]);
    },
    15_000,
  );

  it("does not require a Git workspace when there is no managed task binding", async () => {
    expect(await manager.runtimeWorkspace(root, agent, "Alice", randomUUID())).toBeUndefined();
  });

  it("releases a fully vanished checkout on a new wakeup without dropping an unrelated task", async () => {
    const initial = randomUUID();
    const { worktree } = await manager.create(repo, agent, "Alice", [initial], { slug: "gone" });
    await git(repo, "worktree", "remove", worktree.path);
    await git(repo, "branch", "-d", worktree.branch);
    const next = randomUUID();
    active = [next];
    expect(await manager.runtimeWorkspace(repo, agent, "Alice", next)).toBeUndefined();
    expect(manager.allRecords()).toEqual([]);
    expect(database.listWhiteboard("general")[0]).toMatchObject({ slot: "milestone" });
    expect(database.listWhiteboard("general")[0]?.summary).toContain("不代表已验证合入");
    const reopened = new WorktreeManager({ database, activeInvocations: () => [] });
    const receipt = randomUUID();
    expect(
      (
        await reopened.runtimeWorkspaces(repo, agent, [
          { ownerName: "Alice", invocationId: receipt, ancestorIds: [initial] },
        ])
      ).get(receipt),
    ).toMatchObject({ removed: true, id: worktree.id });
    await expect(reopened.runtimeWorkspace(repo, agent, "Guest", initial)).rejects.toThrow();
    expect((await reopened.create(repo, agent, "Alice", [next], { slug: "gone" })).reused).toBe(
      false,
    );
    expect(idOf(await reopened.runtimeWorkspace(repo, agent, "Alice", next))).not.toBe(worktree.id);
  });

  it("allows metadata-only remove after the directory and branch are both gone", async () => {
    const { worktree } = await create();
    await git(repo, "worktree", "remove", worktree.path);
    await git(repo, "branch", "-d", worktree.branch);
    expect(await manager.status(worktree)).toMatchObject({
      missing: true,
      merged: false,
      removable: true,
    });
    active = [randomUUID()];
    await expect(manager.remove(repo, { path: worktree.path })).rejects.toThrow();
    active = [];
    await expect(
      manager.remove(repo, { path: worktree.path, expectedCommit: worktree.baseCommit }),
    ).rejects.toThrow();
    await expect(manager.remove(repo, { path: worktree.path })).resolves.toMatchObject({
      removed: true,
      branchDeleted: true,
    });
    expect(manager.allRecords()).toEqual([]);
    expect(database.connection().prepare("SELECT * FROM managed_worktree_focus").all()).toEqual([]);
    expect(database.connection().prepare("SELECT * FROM managed_worktree_bindings").all()).toEqual(
      [],
    );
  });

  it("does not release damaged directories, retained branches or unverifiable bindings", async () => {
    const initial = randomUUID();
    const { worktree } = await manager.create(repo, agent, "Alice", [initial], { slug: "damaged" });
    rmSync(worktree.path, { recursive: true });
    await expect(manager.runtimeWorkspace(repo, agent, "Alice", initial)).rejects.toThrow();
    await expect(manager.remove(repo, { path: worktree.path })).rejects.toThrow();
    await git(repo, "worktree", "prune");
    await expect(manager.runtimeWorkspace(repo, agent, "Alice", initial)).rejects.toThrow();
    await expect(manager.remove(repo, { path: worktree.path })).rejects.toThrow();
    expect(manager.allRecords()).toHaveLength(1);
    database.connection().prepare("DELETE FROM managed_worktrees WHERE id = ?").run(worktree.id);
    await expect(manager.runtimeWorkspace(repo, agent, "Alice", initial)).rejects.toThrow();
  });

  it("skips a half-removed focus directory and finishes removing it on the next scan", async () => {
    const audit = vi.fn();
    const notify = vi.fn();
    manager = new WorktreeManager({
      database,
      activeInvocations: () => active,
      audit,
      onCleanup: notify,
    });
    const initial = randomUUID();
    const { worktree } = await manager.create(repo, agent, "Alice", [initial], {
      slug: "interrupted",
    });
    // #4274：清理时 git 被中途杀掉，已跟踪的文件删了一半，记录停在 error
    rmSync(path.join(worktree.path, "first.txt"));
    database
      .connection()
      .prepare("UPDATE managed_worktrees SET record = ? WHERE id = ?")
      .run(JSON.stringify({ ...worktree, phase: "error" }), worktree.id);

    // 绑定在它上面的任务照旧失败；只是沿用上次目录的新任务跳过它，并带回原因
    await expect(manager.runtimeWorkspace(repo, agent, "Alice", initial)).rejects.toMatchObject({
      code: "WORKTREE_UNSAFE",
    });
    expect(await manager.runtimeWorkspace(repo, agent, "Alice", randomUUID())).toEqual({
      focusDropped: {
        worktreeId: worktree.id,
        path: worktree.path,
        branch: worktree.branch,
        reason: expect.stringContaining("上次建立或清理没有完成"),
      },
    });
    expect(await manager.runtimeWorkspace(repo, agent, "Alice", randomUUID())).toBeUndefined();

    // 被删掉的已跟踪文件不算改动；改了、新加的文件照旧挡住清理
    expect((await manager.list(repo))[0]).toMatchObject({ dirty: false, removable: true });
    writeFileSync(path.join(worktree.path, "second.txt"), "edited\n");
    // list 有 15 秒缓存，这里看实时状态
    expect(await manager.status(manager.allRecords()[0]!)).toMatchObject({
      dirty: true,
      removable: false,
    });
    await manager.scan();
    expect(existsSync(path.join(worktree.path, "second.txt"))).toBe(true);
    await git(worktree.path, "restore", "second.txt");
    writeFileSync(path.join(worktree.path, "new.txt"), "private\n");
    await manager.scan();
    expect(existsSync(path.join(worktree.path, "new.txt"))).toBe(true);
    rmSync(path.join(worktree.path, "new.txt"));
    active = [randomUUID()];
    await manager.scan();
    expect(existsSync(worktree.path)).toBe(true);
    active = [];

    // 下一次扫描直接接着删完，不再等房主确认（没有新的清理提醒）
    await manager.scan();
    expect(existsSync(worktree.path)).toBe(false);
    expect(manager.allRecords()).toEqual([]);
    expect(await git(repo, "branch", "--list", worktree.branch)).toBe("");
    expect(notify).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.stringContaining(`上次没清理完的任务目录 ${worktree.path} 已接着清理掉`),
      { roomId: "general", agentName: "agent-a", worktreeId: worktree.id },
    );
  });

  it("leaves a half-created directory that isn't merged alone", async () => {
    const { worktree } = await create();
    await change(worktree);
    rmSync(path.join(worktree.path, "second.txt"));
    database
      .connection()
      .prepare("UPDATE managed_worktrees SET record = ? WHERE id = ?")
      .run(JSON.stringify({ ...worktree, phase: "error" }), worktree.id);
    expect((await manager.list(repo))[0]).toMatchObject({ dirty: false, removable: false });
    await manager.scan();
    expect(existsSync(worktree.path)).toBe(true);
    await expect(manager.remove(repo, { path: worktree.path })).rejects.toMatchObject({
      code: "WORKTREE_UNSAFE",
    });
  });

  it("keeps a vanished registration while another invocation is still active", async () => {
    const { worktree } = await create();
    await git(repo, "worktree", "remove", worktree.path);
    await git(repo, "branch", "-d", worktree.branch);
    active = [randomUUID()];
    await expect(manager.runtimeWorkspace(repo, agent, "Alice", randomUUID())).rejects.toThrow();
    expect(manager.allRecords()).toHaveLength(1);
  });

  it("does not apply another agent's removal receipt to a delegated task", async () => {
    const upstream = randomUUID();
    const original = await manager.create(repo, agent, "Alice", [upstream], { slug: "upstream" });
    await manager.remove(repo, { path: original.worktree.path });
    const other = database.upsertParticipant({
      roomId: "general",
      username: "agent-b",
      type: "agent",
    });
    const own = await manager.create(repo, other, "Alice", [randomUUID()], { slug: "own" });
    const delegated = randomUUID();
    expect(
      idOf(
        (
          await manager.runtimeWorkspaces(repo, other, [
            { ownerName: "Alice", invocationId: delegated, ancestorIds: [upstream] },
          ])
        ).get(delegated),
      ),
    ).toBe(own.worktree.id);
  });

  it("prefers a new live ancestor binding over an older cleanup receipt", async () => {
    const initial = randomUUID();
    const original = await manager.create(repo, agent, "Alice", [initial], { slug: "old" });
    await manager.remove(repo, { path: original.worktree.path });
    const replacement = await manager.create(repo, agent, "Alice", [initial], { slug: "new" });
    const receipt = randomUUID();
    expect(
      idOf(
        (
          await manager.runtimeWorkspaces(repo, agent, [
            { ownerName: "Alice", invocationId: receipt, ancestorIds: [initial] },
          ])
        ).get(receipt),
      ),
    ).toBe(replacement.worktree.id);
    expect(idOf(await manager.runtimeWorkspace(repo, agent, "Alice", initial))).toBe(
      replacement.worktree.id,
    );
  });

  it("batches merged clean worktrees, reminds only once and rechecks before confirmed cleanup", async () => {
    const notify = vi.fn();
    manager = new WorktreeManager({ database, activeInvocations: () => active, onCleanup: notify });
    const first = await manager.create(repo, agent, "Alice", [randomUUID()], { slug: "one" });
    const second = await manager.create(repo, agent, "Alice", [randomUUID()], { slug: "two" });
    await change(first.worktree);
    await change(second.worktree, "second.txt");
    await git(repo, "merge", "--no-edit", first.worktree.branch);
    await git(repo, "merge", "--no-edit", second.worktree.branch);
    await manager.scan();
    expect(manager.autoCleanup("general")).toBe(false);
    expect(notify).toHaveBeenCalledOnce();
    const batch = notify.mock.calls[0]![0];
    expect(batch).toMatchObject({ state: "available", automatic: false, ownerName: "Alice" });
    expect(batch.items).toHaveLength(2);
    await manager.scan();
    expect(notify).toHaveBeenCalledOnce();
    expect(existsSync(first.worktree.path)).toBe(true);
    expect(manager.requestCleanup(batch.id, "Guest")).toBe(false);
    expect(manager.requestCleanup(batch.id, "Alice")).toBe(true);
    await manager.scan();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1]![0]).toMatchObject({
      state: "completed",
      results: [{ removed: true }, { removed: true }],
    });
    expect(existsSync(first.worktree.path)).toBe(false);
    expect(existsSync(second.worktree.path)).toBe(false);
  }, 15_000);

  it("read-only (sandbox) managers never create, remove or auto-clean real checkouts", async () => {
    const { worktree } = await create();
    await change(worktree);
    await git(repo, "merge", "--ff-only", worktree.branch);
    manager.setAutoCleanup("general", true);
    const notify = vi.fn();
    const preview = new WorktreeManager({
      database,
      activeInvocations: () => [],
      onCleanup: notify,
      readOnly: true,
    });
    expect((await preview.list(repo))[0]).toMatchObject({ removable: true });
    await preview.scan();
    expect(notify).not.toHaveBeenCalled();
    expect(existsSync(worktree.path)).toBe(true);
    await expect(preview.remove(repo, { path: worktree.path })).rejects.toMatchObject({
      code: "SANDBOX_DISABLED",
    });
    await expect(
      preview.create(repo, agent, "Alice", [randomUUID()], { slug: "other" }),
    ).rejects.toMatchObject({ code: "SANDBOX_DISABLED" });
    expect(existsSync(worktree.path)).toBe(true);
    expect(preview.allRecords()).toHaveLength(1);
    // 对照：同样的数据交给可写的管理器，自动清理会真的删掉
    await manager.scan();
    expect(existsSync(worktree.path)).toBe(false);
  }, 15_000);

  it("retains a worktree if a cleanup batch becomes stale or a task starts", async () => {
    const notify = vi.fn();
    manager = new WorktreeManager({ database, activeInvocations: () => active, onCleanup: notify });
    const { worktree } = await create();
    await manager.scan();
    const batch = notify.mock.calls[0]![0];
    await change(worktree);
    await git(repo, "merge", "--ff-only", worktree.branch);
    manager.requestCleanup(batch.id, "Alice");
    await manager.scan();
    expect(existsSync(worktree.path)).toBe(true);
    expect(manager.cleanupBatch(batch.id)?.results).toMatchObject([{ removed: false }]);
    const next = notify.mock.calls.find(
      (call) => call[0].state === "available" && call[0].id !== batch.id,
    )![0];
    active = [randomUUID()];
    manager.requestCleanup(next.id, "Alice");
    await manager.scan();
    expect(manager.cleanupBatch(next.id)?.results).toMatchObject([{ removed: false }]);
    expect(existsSync(worktree.path)).toBe(true);
  });

  it("only automatically cleans after explicit opt-in and never deletes ignored files", async () => {
    const notify = vi.fn();
    manager = new WorktreeManager({ database, activeInvocations: () => active, onCleanup: notify });
    const { worktree } = await create();
    manager.setAutoCleanup("general", true);
    writeFileSync(path.join(worktree.path, "ignored"), "private data");
    await manager.scan();
    expect(notify).not.toHaveBeenCalled();
    expect(existsSync(worktree.path)).toBe(true);
    rmSync(path.join(worktree.path, "ignored"));
    await manager.scan();
    expect(existsSync(worktree.path)).toBe(false);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![0]).toMatchObject({ automatic: true, state: "completed" });
  });

  it("expires an available cleanup notice after its checkout is removed manually", async () => {
    const notify = vi.fn();
    manager = new WorktreeManager({ database, activeInvocations: () => active, onCleanup: notify });
    const { worktree } = await create();
    await manager.scan();
    const batch = notify.mock.calls[0]![0];
    await manager.remove(repo, { path: worktree.path });
    expect(manager.cleanupBatch(batch.id)?.state).toBe("expired");
    expect(manager.roomBatches("general")).toEqual([]);
    expect(manager.requestCleanup(batch.id, "Alice")).toBe(false);
    expect(notify.mock.calls.at(-1)?.[0]).toMatchObject({
      id: batch.id,
      state: "expired",
      items: [],
    });
  });

  it("retains only live entries when part of a notified batch is cleaned manually", async () => {
    const notify = vi.fn();
    manager = new WorktreeManager({ database, activeInvocations: () => active, onCleanup: notify });
    const first = await manager.create(repo, agent, "Alice", [], { slug: "one" });
    const second = await manager.create(repo, agent, "Alice", [], { slug: "two" });
    await manager.scan();
    const batch = notify.mock.calls[0]![0];
    await manager.remove(repo, { path: first.worktree.path });
    expect(manager.roomBatches("general", await manager.list(repo))[0]?.items).toMatchObject([
      { id: second.worktree.id },
    ]);
    expect(manager.requestCleanup(batch.id, "Alice")).toBe(true);
    await manager.scan();
    expect(manager.cleanupBatch(batch.id)?.results).toMatchObject([
      { path: second.worktree.path, removed: true },
    ]);
    expect(manager.requestCleanup(batch.id, "Alice")).toBe(false);
  });

  it("expires stale commit notices and hides temporarily unsafe entries", async () => {
    const notify = vi.fn();
    manager = new WorktreeManager({ database, activeInvocations: () => active, onCleanup: notify });
    const { worktree } = await create();
    await manager.scan();
    const batch = notify.mock.calls[0]![0];
    active = [randomUUID()];
    expect(manager.roomBatches("general", await manager.list(repo))).toEqual([]);
    active = [];
    expect(manager.roomBatches("general", await manager.list(repo))).toHaveLength(1);
    await change(worktree);
    await manager.list(repo);
    expect(manager.cleanupBatch(batch.id)?.state).toBe("expired");
    expect(manager.requestCleanup(batch.id, "Alice")).toBe(false);
    await git(repo, "merge", "--ff-only", worktree.branch);
    await manager.scan();
    expect(manager.roomBatches("general")[0]?.id).not.toBe(batch.id);
  });

  describe("read/write separation (#3944)", () => {
    type Internals = {
      status: (record: ManagedWorktree, target?: string) => Promise<unknown>;
      identity: (record: ManagedWorktree) => Promise<void>;
    };
    const internals = () => manager as unknown as Internals;
    function gate() {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => (open = resolve));
      return { opened, open };
    }

    it("lets a task select its workspace while a slow status listing is still running", async () => {
      const invocationId = randomUUID();
      await manager.create(repo, agent, "Alice", [invocationId], { slug: "feature" });
      const slow = gate();
      const original = internals().status.bind(manager);
      const spy = vi.spyOn(internals(), "status").mockImplementation(async (...args) => {
        await slow.opened;
        return original(...args);
      });
      let listed = false;
      const listing = manager.list(repo).then((value) => {
        listed = true;
        return value;
      });
      const selected = (await manager.runtimeWorkspace(repo, agent, "Alice", invocationId)) as
        ManagedWorktree | undefined;
      expect(selected?.path).toBe(path.join(root, "example repo-wt", "agent-a-feature"));
      expect(listed).toBe(false);
      slow.open();
      expect((await listing)[0]?.worktree.id).toBe(selected?.id);
      spy.mockRestore();
    });

    it("still runs writes one at a time and never reports a checkout being removed as removable", async () => {
      const invocationId = randomUUID();
      const { worktree } = await manager.create(repo, agent, "Alice", [invocationId], {
        slug: "feature",
      });
      const slow = gate();
      const entered = gate();
      const original = internals().identity.bind(manager);
      let blocked = false;
      const spy = vi.spyOn(internals(), "identity").mockImplementation(async (record) => {
        if (!blocked) {
          blocked = true;
          entered.open();
          await slow.opened;
        }
        return original(record);
      });
      const removal = manager.remove(repo, { path: worktree.path });
      await entered.opened;
      let selected = false;
      const selection = manager
        .runtimeWorkspace(repo, agent, "Alice", invocationId)
        .then(() => (selected = true))
        .catch(() => (selected = true));
      const during = await manager.list(repo);
      expect(during[0]).toMatchObject({ removable: false });
      expect(selected).toBe(false);
      slow.open();
      await removal;
      await selection;
      expect(await manager.list(repo)).toEqual([]);
      spy.mockRestore();
    });

    it("serves repeated listings from a short cache that commits, merges and writes invalidate", async () => {
      const { worktree } = await create();
      const spy = vi.spyOn(internals(), "status");
      expect((await manager.list(repo))[0]).toMatchObject({ untracked: false, removable: true });
      writeFileSync(path.join(worktree.path, "untracked"), "private\n");
      // 工作区里的新文件在缓存期内看不到，但仍不会因此被删：remove() 在写锁里重新检查
      expect((await manager.list(repo))[0]).toMatchObject({ untracked: false });
      expect(spy).toHaveBeenCalledTimes(1);
      await expect(manager.remove(repo, { path: worktree.path })).rejects.toMatchObject({
        code: "WORKTREE_UNSAFE",
      });
      expect((await manager.list(repo))[0]).toMatchObject({ untracked: true, removable: false });
      rmSync(path.join(worktree.path, "untracked"));
      await change(worktree);
      expect((await manager.list(repo))[0]).toMatchObject({ merged: false, removable: false });
      await git(repo, "merge", "--ff-only", worktree.branch);
      expect((await manager.list(repo))[0]).toMatchObject({ merged: true, removable: true });
      spy.mockRestore();
    });

    it("expires the cache after its lifetime", async () => {
      manager = new WorktreeManager({
        database,
        activeInvocations: () => active,
        statusCacheMs: 30,
      });
      const { worktree } = await create();
      expect((await manager.list(repo))[0]).toMatchObject({ dirty: false });
      writeFileSync(path.join(worktree.path, "first.txt"), "dirty\n");
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect((await manager.list(repo))[0]).toMatchObject({ dirty: true, removable: false });
    });

    it("reflects task occupancy immediately even from the cache", async () => {
      const { worktree } = await create();
      expect((await manager.list(repo))[0]?.removable).toBe(true);
      active = [worktree.invocationIds[0] ?? randomUUID()];
      expect((await manager.list(repo))[0]).toMatchObject({ removable: false });
    });
  });

  it("resolves the same repository from a linked checkout or symlink", async () => {
    const { worktree } = await create();
    const link = path.join(root, "repo-link");
    symlinkSync(repo, link);
    expect(await worktreeRepository(link)).toEqual(await worktreeRepository(worktree.path));
  });

  it("supports Unicode agent names without changing the repository or task-line identity", async () => {
    const helper = database.upsertParticipant({
      roomId: "general",
      username: "开发助手",
      type: "agent",
    });
    const result = await manager.create(repo, helper, "Alice", [], { slug: "unicode" });
    expect(result.worktree.branch).toBe("feat/开发助手-unicode");
    expect((await manager.list(repo))[0]?.worktree.path).toBe(result.worktree.path);
  });

  it("does not adopt manually created worktrees or existing branches", async () => {
    await git(repo, "branch", "feat/agent-a-feature");
    await expect(create()).rejects.toMatchObject({ code: "WORKTREE_CONFLICT" });
    const manual = path.join(root, "manual");
    await git(repo, "worktree", "add", "-b", "manual", manual, "main");
    await expect(manager.remove(repo, { path: manual })).rejects.toMatchObject({
      code: "WORKTREE_UNREGISTERED",
    });
    expect(existsSync(manual)).toBe(true);
    expect(await manager.list(repo)).toEqual([]);
  });

  it("refuses dirty, untracked and ignored files independently", async () => {
    const { worktree } = await create();
    writeFileSync(path.join(worktree.path, "first.txt"), "dirty\n");
    expect((await manager.list(repo))[0]).toMatchObject({ dirty: true, removable: false });
    await expect(manager.remove(repo, { path: worktree.path })).rejects.toMatchObject({
      code: "WORKTREE_UNSAFE",
    });
    await git(worktree.path, "restore", "first.txt");
    writeFileSync(path.join(worktree.path, "untracked"), "private\n");
    expect((await manager.list(repo))[0]).toMatchObject({ untracked: true, removable: false });
    await expect(manager.remove(repo, { path: worktree.path })).rejects.toMatchObject({
      code: "WORKTREE_UNSAFE",
    });
    rmSync(path.join(worktree.path, "untracked"));
    writeFileSync(path.join(worktree.path, "ignored"), "private ignored data\n");
    expect((await manager.list(repo))[0]).toMatchObject({ ignored: true, removable: false });
    await expect(manager.remove(repo, { path: worktree.path })).rejects.toMatchObject({
      code: "WORKTREE_UNSAFE",
    });
    expect(existsSync(path.join(worktree.path, "ignored"))).toBe(true);
  });

  it("blocks active and queued task bindings even when merged and clean", async () => {
    const { worktree } = await create();
    active = [worktree.invocationIds[0]!];
    expect((await manager.list(repo))[0]).toMatchObject({
      merged: true,
      activeInvocationIds: active,
      removable: false,
    });
    await expect(manager.remove(repo, { path: worktree.path })).rejects.toMatchObject({
      code: "WORKTREE_UNSAFE",
    });
    active = [];
    expect((await manager.list(repo))[0]?.removable).toBe(true);
  });

  it("refuses clean but unmerged changes", async () => {
    const { worktree } = await create();
    await change(worktree);
    expect((await manager.list(repo))[0]).toMatchObject({
      dirty: false,
      merged: false,
      removable: false,
    });
    await expect(manager.remove(repo, { path: worktree.path })).rejects.toMatchObject({
      code: "WORKTREE_UNSAFE",
    });
  });

  it("removes an ancestor-merged worktree and safely deletes its branch by default", async () => {
    const { worktree } = await create();
    await change(worktree);
    await git(repo, "merge", "--ff-only", worktree.branch);
    expect((await manager.list(repo))[0]).toMatchObject({
      mergeMethod: "ancestor",
      removable: true,
    });
    expect(await manager.remove(repo, { path: worktree.path })).toEqual({
      removed: true,
      branchDeleted: true,
    });
    expect(existsSync(worktree.path)).toBe(false);
    expect(
      (
        await worktreeGit(repo, [
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${worktree.branch}`,
        ])
      ).code,
    ).toBe(1);
    expect(await manager.list(repo)).toEqual([]);
    expect(database.listWhiteboard("general")[0]?.slot).toBe("milestone");
  });

  it("supports explicitly retaining the branch", async () => {
    const { worktree } = await create();
    expect(await manager.remove(repo, { path: worktree.path, deleteBranch: false })).toEqual({
      removed: true,
      branchDeleted: false,
    });
    expect(await git(repo, "rev-parse", worktree.branch)).toBeTruthy();
  });

  it("recognizes a multi-commit squash and retains the non-ancestor branch without force", async () => {
    const { worktree } = await create();
    await change(worktree);
    await change(worktree, "second.txt", "also changed\n");
    await git(repo, "merge", "--squash", worktree.branch);
    await git(repo, "commit", "-m", "squashed feature");
    expect((await manager.list(repo))[0]).toMatchObject({
      mergeMethod: "squash",
      merged: true,
      removable: true,
    });
    expect(await manager.remove(repo, { path: worktree.path })).toMatchObject({
      removed: true,
      branchDeleted: false,
      branchError: expect.stringContaining("已保留"),
    });
    expect(existsSync(worktree.path)).toBe(false);
    expect(await git(repo, "rev-parse", worktree.branch)).toBeTruthy();
  });

  it("recognizes cherry-picked patches, but not a partially integrated branch", async () => {
    const { worktree } = await create();
    await change(worktree);
    const first = await git(worktree.path, "rev-parse", "HEAD");
    await change(worktree, "second.txt");
    const second = await git(worktree.path, "rev-parse", "HEAD");
    writeFileSync(path.join(repo, "other.txt"), "other\n");
    await git(repo, "add", "other.txt");
    await git(repo, "commit", "-m", "other change");
    await git(repo, "cherry-pick", first);
    expect((await manager.list(repo))[0]?.merged).toBe(false);
    await git(repo, "cherry-pick", second);
    expect((await manager.list(repo))[0]).toMatchObject({ mergeMethod: "patches", merged: true });
  });

  it("fails closed when a worktree is locked, detached or on a different branch", async () => {
    const { worktree } = await create();
    await git(repo, "worktree", "lock", worktree.path);
    expect((await manager.list(repo))[0]).toMatchObject({
      removable: false,
      error: expect.any(String),
    });
    await git(repo, "worktree", "unlock", worktree.path);
    await git(worktree.path, "checkout", "--detach");
    await expect(manager.remove(repo, { path: worktree.path })).rejects.toMatchObject({
      code: "WORKTREE_UNSAFE",
    });
    await expect(create()).rejects.toMatchObject({ code: "WORKTREE_IDENTITY" });
  });

  it("rejects path traversal, option-like refs and a substituted worktree parent", async () => {
    await expect(manager.create(repo, agent, "Alice", [], { slug: "../escape" })).rejects.toThrow();
    await expect(
      manager.create(repo, agent, "Alice", [], { slug: "safe", branch: "--orphan" }),
    ).rejects.toMatchObject({ code: "WORKTREE_INVALID_REF" });
    await expect(
      manager.create(repo, agent, "Alice", [], { slug: "safe", base: "--help" }),
    ).rejects.toMatchObject({ code: "WORKTREE_INVALID_REF" });
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, path.join(root, "example repo-wt"));
    await expect(create()).rejects.toMatchObject({ code: "WORKTREE_IDENTITY" });
  });

  it("rejects non-repositories and bare repositories", async () => {
    await expect(worktreeRepository(root)).rejects.toMatchObject({
      code: "WORKTREE_REPOSITORY_INVALID",
    });
    const bare = path.join(root, "bare");
    mkdirSync(bare);
    await git(bare, "init", "--bare");
    await expect(worktreeRepository(bare)).rejects.toMatchObject({
      code: "WORKTREE_REPOSITORY_INVALID",
    });
  });

  it("prevents branch claim conflicts across rooms and protects claimed entries from takeover or eviction", () => {
    database.createRoom({ id: "other", name: "Other" });
    const other = database.upsertParticipant({
      roomId: "other",
      username: "agent-b",
      type: "agent",
    });
    const claim = { repo, branch: "feat/shared" };
    database.upsertWhiteboardEntry(agent, {
      key: "feature",
      slot: "in_progress",
      summary: "working",
      claim,
    });
    expect(() =>
      database.upsertWhiteboardEntry(other, {
        key: "other",
        slot: "in_progress",
        summary: "working",
        claim,
      }),
    ).toThrow(/agent-a/);
    const sameRoom = database.upsertParticipant({
      roomId: "general",
      username: "agent-b",
      type: "agent",
    });
    expect(() =>
      database.upsertWhiteboardEntry(sameRoom, { key: "feature", slot: "ready", summary: "taken" }),
    ).toThrow(/agent-a/);
    database.upsertWhiteboardEntry(agent, {
      key: "feature",
      slot: "in_progress",
      summary: "updated",
    });
    expect(database.listWhiteboard("general")[0]?.claim).toEqual(claim);
    for (let count = 0; count < 60; count++)
      database.upsertWhiteboardEntry(agent, {
        key: `unclaimed-${count}`,
        slot: "in_progress",
        summary: "other",
      });
    expect(database.listWhiteboard("general").some((entry) => entry.key === "feature")).toBe(true);
    database.upsertWhiteboardEntry(agent, { key: "feature", slot: "ready", summary: "delivered" });
    expect(() =>
      database.upsertWhiteboardEntry(other, {
        key: "other",
        slot: "in_progress",
        summary: "working",
        claim,
      }),
    ).not.toThrow();
    expect(
      database.upsertWhiteboardEntry(sameRoom, {
        key: "feature",
        slot: "in_progress",
        summary: "new owner without a claim",
      }).entry.claim,
    ).toBeUndefined();
    database.upsertWhiteboardEntry(agent, {
      key: "released",
      slot: "ready",
      summary: "released claim",
      claim: { repo, branch: "feat/released" },
    });
    for (let count = 0; count < 60; count++)
      database.upsertWhiteboardEntry(agent, {
        key: `ready-${count}`,
        slot: "ready",
        summary: "ready",
      });
    const ready = database.listWhiteboard("general").filter((entry) => entry.slot === "ready");
    expect(ready).toHaveLength(61);
    expect(ready.some((entry) => entry.key === "released")).toBe(true);
  });

  describe("cleanup of regenerable ignored files", () => {
    async function project() {
      writeFileSync(
        path.join(repo, ".gitignore"),
        "ignored\nnode_modules\ndist/\n*.tsbuildinfo\n.env\n",
      );
      mkdirSync(path.join(repo, "packages", "lib"), { recursive: true });
      writeFileSync(path.join(repo, "packages", "lib", "package.json"), "{}\n");
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "workspace");
      // 主目录装好的依赖：任务目录的软链指向这里，清理后必须原样还在
      mkdirSync(path.join(repo, "node_modules", "left-pad"), { recursive: true });
      writeFileSync(path.join(repo, "node_modules", "left-pad", "index.js"), "primary\n");
    }
    const primaryDependency = () => path.join(repo, "node_modules", "left-pad", "index.js");

    it("removes a merged checkout whose node_modules links to the primary checkout, keeping the primary's dependencies", async () => {
      await project();
      const { worktree } = await create();
      // 根目录整个软链到主目录；workspace 包下是真实目录，里面的条目软链到主目录（linked 模式）
      symlinkSync(path.join(repo, "node_modules"), path.join(worktree.path, "node_modules"));
      mkdirSync(path.join(worktree.path, "packages", "lib", "node_modules"));
      symlinkSync(
        path.join(repo, "node_modules", "left-pad"),
        path.join(worktree.path, "packages", "lib", "node_modules", "left-pad"),
      );
      mkdirSync(path.join(worktree.path, "packages", "lib", "dist"));
      writeFileSync(path.join(worktree.path, "packages", "lib", "dist", "index.js"), "built\n");
      writeFileSync(path.join(worktree.path, "packages", "lib", "tsconfig.tsbuildinfo"), "{}\n");
      const listed = (await manager.list(repo))[0];
      expect(listed).toMatchObject({ ignored: false, removable: true });
      expect(listed?.ignoredFiles).toBeUndefined();
      await manager.remove(repo, { path: worktree.path });
      expect(existsSync(worktree.path)).toBe(false);
      expect(existsSync(primaryDependency())).toBe(true);
      expect(await git(repo, "status", "--porcelain")).toBe("");
    });

    it("removes real node_modules directories at any depth together with the checkout", async () => {
      await project();
      const { worktree } = await create();
      for (const directory of ["node_modules/left-pad", "packages/lib/node_modules/.bin"]) {
        mkdirSync(path.join(worktree.path, directory), { recursive: true });
        writeFileSync(path.join(worktree.path, directory, "file"), "installed\n");
      }
      expect((await manager.list(repo))[0]).toMatchObject({ ignored: false, removable: true });
      await manager.remove(repo, { path: worktree.path });
      expect(existsSync(worktree.path)).toBe(false);
      expect(existsSync(primaryDependency())).toBe(true);
    });

    it("keeps protecting .env and other ignored files and lists exactly what blocks removal", async () => {
      await project();
      const { worktree } = await create();
      symlinkSync(path.join(repo, "node_modules"), path.join(worktree.path, "node_modules"));
      mkdirSync(path.join(worktree.path, "dist"));
      writeFileSync(path.join(worktree.path, "dist", "index.js"), "built\n");
      writeFileSync(path.join(worktree.path, ".env"), "TOKEN=secret\n");
      mkdirSync(path.join(worktree.path, "packages", "lib", "ignored"));
      writeFileSync(path.join(worktree.path, "packages", "lib", "ignored", "notes"), "local\n");
      expect((await manager.list(repo))[0]).toMatchObject({
        ignored: true,
        ignoredFiles: [".env", "packages/lib/ignored/"],
        removable: false,
      });
      await expect(manager.remove(repo, { path: worktree.path })).rejects.toMatchObject({
        code: "WORKTREE_UNSAFE",
      });
      expect(existsSync(path.join(worktree.path, ".env"))).toBe(true);
      expect(existsSync(path.join(worktree.path, "node_modules"))).toBe(true);
      expect(existsSync(primaryDependency())).toBe(true);
    });
  });

  describe("dependencies", () => {
    async function nodeProject() {
      writeFileSync(path.join(repo, ".gitignore"), "ignored\nnode_modules\n");
      writeFileSync(path.join(repo, "package.json"), '{"name":"example"}\n');
      writeFileSync(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "node project");
    }

    it("installs dependencies for a new task line and lets Hive-installed ones be cleaned", async () => {
      await nodeProject();
      const prepare = vi.fn(async ({ worktree }: { worktree: string }) => {
        mkdirSync(path.join(worktree, "node_modules", "left-pad"), { recursive: true });
        return { state: "installed" as const, manager: "pnpm" as const, command: "pnpm install" };
      });
      manager = new WorktreeManager({
        database,
        activeInvocations: () => active,
        dependencies: { prepare },
      });
      const created = await create();
      expect(prepare).toHaveBeenCalledOnce();
      expect(prepare.mock.calls[0]![0]).toMatchObject({
        worktree: created.worktree.path,
        primary: repo,
        packageDirs: [""],
      });
      expect(created.dependencies).toMatchObject({ state: "installed", command: "pnpm install" });
      expect(created.dependencies?.message).toContain("依赖已装好");
      // 依赖是按锁文件装出来的，可以重建：不算要保护的忽略文件
      expect((await manager.list(repo))[0]).toMatchObject({
        ignored: false,
        removable: true,
        dependencies: { state: "installed" },
      });
      // 复用同一 slug 不再重装
      expect((await create()).dependencies?.state).toBe("installed");
      expect(prepare).toHaveBeenCalledOnce();
      // 别的忽略文件照旧保护
      writeFileSync(path.join(created.worktree.path, "ignored"), "private\n");
      expect((await manager.list(repo))[0]).toMatchObject({ ignored: true, removable: false });
      rmSync(path.join(created.worktree.path, "ignored"));
      await manager.remove(repo, { path: created.worktree.path });
      expect(existsSync(created.worktree.path)).toBe(false);
      expect(manager.dependencies(created.worktree.id)).toBeUndefined();
    });

    it("never cleans a checkout whose branch was switched, even with Hive-installed dependencies", async () => {
      await nodeProject();
      manager = new WorktreeManager({
        database,
        activeInvocations: () => active,
        // 列表有 15 秒缓存，换分支不改登记分支的提交，这里直接看最新状态
        statusCacheMs: 0,
        dependencies: {
          prepare: async ({ worktree }: { worktree: string }) => {
            mkdirSync(path.join(worktree, "node_modules", "left-pad"), { recursive: true });
            return { state: "installed" as const, manager: "pnpm" as const, command: "pnpm i" };
          },
        },
      });
      const { worktree } = await create();
      expect((await manager.list(repo))[0]).toMatchObject({ ignored: false, removable: true });
      await git(worktree.path, "checkout", "-q", "-b", "feat/other-task");
      const listed = (await manager.list(repo))[0];
      expect(listed).toMatchObject({
        removable: false,
        dependencies: { state: "installed" },
        branchSwitched: { registered: worktree.branch, current: "feat/other-task" },
      });
      await expect(manager.remove(repo, { path: worktree.path })).rejects.toThrow();
      expect(existsSync(path.join(worktree.path, "node_modules", "left-pad"))).toBe(true);
    });

    it("does not protect node_modules the agent installed itself either", async () => {
      await nodeProject();
      manager = new WorktreeManager({
        database,
        activeInvocations: () => active,
        dependencies: {
          prepare: async () => ({ state: "skipped" as const, reason: "present" }),
        },
      });
      const { worktree, dependencies } = await create();
      expect(dependencies?.message).toContain("已有 node_modules");
      mkdirSync(path.join(worktree.path, "node_modules"));
      writeFileSync(path.join(worktree.path, "node_modules", "data"), "x");
      expect((await manager.list(repo))[0]).toMatchObject({ ignored: false, removable: true });
    });

    it("returns while still installing, blocks cleanup until done and survives a restart", async () => {
      await nodeProject();
      let finish!: () => void;
      const done = new Promise<void>((resolve) => (finish = resolve));
      manager = new WorktreeManager({
        database,
        activeInvocations: () => active,
        dependencies: {
          waitMs: 20,
          prepare: async () => {
            await done;
            return { state: "installed" as const, manager: "pnpm" as const, command: "pnpm i" };
          },
        },
      });
      const { worktree, dependencies } = await create();
      expect(dependencies).toMatchObject({
        state: "preparing",
        command: "pnpm install --frozen-lockfile --prefer-offline",
      });
      expect((await manager.list(repo))[0]).toMatchObject({
        dependencies: { state: "preparing" },
        removable: false,
      });
      await expect(manager.remove(repo, { path: worktree.path })).rejects.toMatchObject({
        code: "WORKTREE_UNSAFE",
      });
      // 另一个 Server 进程接手时，上一个没装完的不能一直挂着「准备中」
      const restarted = new WorktreeManager({ database, activeInvocations: () => [] });
      expect(restarted.dependencies(worktree.id)).toMatchObject({ state: "failed" });
      expect(restarted.dependencies(worktree.id)?.message).toContain("Server 重启");
      finish();
      await vi.waitFor(() => expect(manager.dependencies(worktree.id)?.state).toBe("installed"));
      expect((await manager.list(repo))[0]?.removable).toBe(true);
    });

    it("lists every workspace package directory and is off unless configured", async () => {
      await nodeProject();
      mkdirSync(path.join(repo, "packages", "lib"), { recursive: true });
      writeFileSync(path.join(repo, "packages", "lib", "package.json"), "{}\n");
      await git(repo, "add", ".");
      await git(repo, "commit", "-m", "workspace package");
      const prepare = vi.fn<(input: { packageDirs: string[] }) => Promise<{ state: "installed" }>>(
        async () => ({ state: "installed" }),
      );
      manager = new WorktreeManager({
        database,
        activeInvocations: () => active,
        dependencies: { prepare },
      });
      await create();
      expect(prepare.mock.calls[0]![0]).toMatchObject({ packageDirs: ["", "packages/lib"] });
      const off = new WorktreeManager({
        database,
        activeInvocations: () => [],
        dependencies: false,
      });
      const other = await off.create(repo, agent, "Alice", [randomUUID()], { slug: "other" });
      expect(other.dependencies).toBeUndefined();
      expect(existsSync(path.join(other.worktree.path, "node_modules"))).toBe(false);
      // 不传就不准备：其余用例建任务线时不会真去装依赖
      const unset = new WorktreeManager({ database, activeInvocations: () => [] });
      const third = await unset.create(repo, agent, "Alice", [randomUUID()], { slug: "third" });
      expect(third.dependencies).toBeUndefined();
      expect(unset.dependencies(third.worktree.id)).toBeUndefined();
    });
  });

  it("discards an unmerged task line only after the owner confirms the exact commits", async () => {
    const audit = vi.fn();
    manager = new WorktreeManager({ database, activeInvocations: () => active, audit });
    const { worktree } = await create();
    await change(worktree, "first.txt", "feature\n");
    await change(worktree, "second.txt", "feature\n");
    // 合入前被变基、解过冲突：main 上的内容一样，但提交号和补丁都对不上
    writeFileSync(path.join(repo, "second.txt"), "conflict\n");
    await git(repo, "commit", "-am", "conflicting change on main");
    let [status] = await manager.list(repo);
    expect(status).toMatchObject({ merged: false, removable: false, discardable: true });
    const preview = await manager.discardPreview(repo, worktree.path);
    expect(preview).toMatchObject({
      headCommit: status!.headCommit,
      total: 2,
      commits: [{ subject: "change second.txt" }, { subject: "change first.txt" }],
    });
    // 有任务占用、有未跟踪文件：都不删
    active = ["task"];
    await expect(
      manager.discard(repo, { path: worktree.path, expectedCommit: preview.headCommit, by: "x" }),
    ).rejects.toMatchObject({ code: "WORKTREE_UNSAFE" });
    active = [];
    writeFileSync(path.join(worktree.path, "notes.txt"), "draft\n");
    await expect(
      manager.discard(repo, { path: worktree.path, expectedCommit: preview.headCommit, by: "x" }),
    ).rejects.toMatchObject({ code: "WORKTREE_UNSAFE" });
    rmSync(path.join(worktree.path, "notes.txt"));
    // 房主看过列表后分支又有了新提交：按看到的那个提交号拒绝
    await change(worktree, "third.txt", "late\n");
    await expect(
      manager.discard(repo, { path: worktree.path, expectedCommit: preview.headCommit, by: "x" }),
    ).rejects.toMatchObject({ code: "WORKTREE_UNSAFE" });
    expect(existsSync(worktree.path)).toBe(true);
    [status] = await manager.list(repo);
    const head = status!.headCommit!;
    const result = await manager.discard(repo, {
      path: worktree.path,
      expectedCommit: head,
      by: "本机房主",
    });
    expect(result).toMatchObject({ removed: true, branchDeleted: true });
    expect(result.discarded).toHaveLength(3);
    expect(result.discarded[0]).toBe(head);
    expect(existsSync(worktree.path)).toBe(false);
    expect(await git(repo, "branch", "--list", worktree.branch)).toBe("");
    expect(await manager.list(repo)).toEqual([]);
    expect(audit).toHaveBeenCalledWith(
      expect.stringContaining("本机房主"),
      expect.objectContaining({
        worktreeId: worktree.id,
        branch: worktree.branch,
        by: "本机房主",
        discardedCommits: result.discarded.join(","),
      }),
    );
  });

  it("does not offer discarding for merged task lines", async () => {
    const { worktree } = await create();
    await change(worktree);
    await git(repo, "merge", "--no-edit", worktree.branch);
    const [status] = await manager.list(repo);
    expect(status).toMatchObject({ merged: true, removable: true, discardable: false });
    await expect(
      manager.discard(repo, { path: worktree.path, expectedCommit: status!.headCommit!, by: "x" }),
    ).rejects.toMatchObject({ code: "WORKTREE_UNSAFE" });
  });
});

describe("blockingIgnored", () => {
  it("skips dependencies, build output and directories that only contain them", () => {
    expect(
      blockingIgnored([
        "node_modules",
        "apps/web/node_modules/",
        "apps/web/dist/",
        "apps/web/tsconfig.tsbuildinfo",
        "apps/docs/.astro/",
        "coverage/",
        "tools/",
        "tools/a/",
        "tools/a/node_modules/",
        ".env",
        "output/",
        "apps/server/.env.local",
      ]),
    ).toEqual([".env", "output/", "apps/server/.env.local"]);
  });
});

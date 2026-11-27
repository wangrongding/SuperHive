import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import {
  AgentCliManager,
  compareVersions,
  inferSource,
  inferWindowsSource,
  isConflicting,
  lastLine,
  mergePath,
  nodeRangeSatisfied,
  pathFromEnvOutput,
  pathHasDir,
  OFFICIAL_INSTALLERS,
  installerCommand,
  planInstall,
  planUpdate,
  shellQuote,
  withPath,
  type BundledNpm,
  type PlanContext,
  type SpawnUpgrade,
  type UpgradeChild,
} from "./agent-clis.js";
import type { SpawnAgent } from "./local-agents.js";

let dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const exists =
  (...files: string[]): PlanContext["isExecutable"] =>
  (file) =>
    files.includes(file);

const mac = (files: string[] = [], npm?: string): PlanContext => ({
  platform: "darwin",
  isExecutable: exists(...files),
  npm,
});

describe("inferSource", () => {
  it.each([
    [
      "/Users/a/.nvm/versions/node/v22.1.0/bin/codex",
      "/Users/a/.nvm/versions/node/v22.1.0/lib/node_modules/@openai/codex/bin/codex.js",
      "nvm",
    ],
    ["/opt/homebrew/bin/codex", "/opt/homebrew/Caskroom/codex/0.146.0/codex", "homebrew"],
    ["/usr/local/bin/gemini", "/usr/local/Cellar/gemini-cli/0.13.0/bin/gemini", "homebrew"],
    [
      "/opt/homebrew/bin/claude",
      "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js",
      "homebrew",
    ],
    ["/Users/a/.volta/bin/claude", "/Users/a/.volta/bin/volta-shim", "volta"],
    ["/Users/a/.local/state/fnm_multishells/123/bin/codex", "/x/codex.js", "fnm"],
    ["/Users/a/.local/share/mise/installs/node/22/bin/codex", "/x/codex.js", "mise"],
    ["/Users/a/.bun/bin/omp", "/Users/a/.bun/bin/omp", "bun"],
    [
      "/Users/a/Library/pnpm/codex",
      "/Users/a/Library/pnpm/global/5/node_modules/@openai/codex/bin/codex.js",
      "pnpm",
    ],
    ["/Users/a/.local/bin/claude", "/Users/a/.local/share/claude/versions/2.1.0", "native"],
    [
      "/Users/a/.local/bin/codex",
      "/Users/a/.codex/packages/standalone/releases/0.170.0-aarch64/codex",
      "native",
    ],
    [
      "/Users/a/.npm-global/bin/codex",
      "/Users/a/.npm-global/lib/node_modules/@openai/codex/bin/codex.js",
      "npm",
    ],
    ["/usr/local/bin/copilot", "/usr/local/lib/node_modules/@github/copilot/npm-loader.js", "npm"],
    ["/Users/a/.nix-profile/bin/omp", "/nix/store/abc-omp/bin/omp", "unknown"],
    ["/Users/a/bin/opencode", "/Users/a/bin/opencode", "unknown"],
    [
      "/Users/a/.npm-global/bin/gemini",
      "/Users/a/.npm-global/lib/node_modules/@google/gemini-cli/bundle/gemini.js",
      "npm",
    ],
    // agy 官方脚本装的单个原生程序；别处的同名程序认不出来源
    ["/Users/a/.local/bin/agy", "/Users/a/.local/bin/agy", "native"],
    ["/Users/a/bin/agy", "/Users/a/bin/agy", "unknown"],
    // 只认 agy：~/.local/bin 里的其他原生程序不受影响
    ["/Users/a/.local/bin/omp", "/Users/a/.local/bin/omp", "unknown"],
  ])("%s → %s", (launcher, real, source) => {
    expect(inferSource(launcher, real)).toBe(source);
  });
});

describe("inferWindowsSource", () => {
  const clis = "C:\\Users\\me\\AppData\\Roaming\\SuperHive\\agent-clis";
  it.each([
    // 桌面端用自带 npm 装进 agent-clis 的：以前一律显示「来源不明」
    [
      `${clis}\\codex.cmd`,
      `${clis}\\codex.cmd`,
      `${clis}\\node_modules\\@openai\\codex\\bin\\codex.js`,
      "npm",
    ],
    // 不分大小写、目录末尾带不带反斜杠都认
    [`${clis.toLowerCase()}\\claude.cmd`, `${clis}\\claude.cmd`, `${clis}\\claude.cmd`, "npm"],
    [
      "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd",
      "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd",
      "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
      "npm",
    ],
    [
      "C:\\Program Files\\nodejs\\codex.cmd",
      "C:\\Program Files\\nodejs\\codex.cmd",
      "C:\\Program Files\\nodejs\\node_modules\\@openai\\codex\\bin\\codex.js",
      "npm",
    ],
    // nvm-windows：PATH 上是 C:\nvm4w\nodejs 软链，解开后在 …\nvm\v22.x
    [
      "C:\\nvm4w\\nodejs\\codex.cmd",
      "C:\\Users\\me\\AppData\\Local\\nvm\\v22.22.3\\codex.cmd",
      "C:\\nvm4w\\nodejs\\node_modules\\@openai\\codex\\bin\\codex.js",
      "nvm",
    ],
    [
      "C:\\Program Files\\nodejs\\gemini.cmd",
      "C:\\Users\\me\\AppData\\Roaming\\nvm\\v20.11.0\\gemini.cmd",
      "C:\\Program Files\\nodejs\\node_modules\\@google\\gemini-cli\\dist\\index.js",
      "nvm",
    ],
    [
      "C:\\Users\\me\\AppData\\Local\\pnpm\\codex.cmd",
      "C:\\Users\\me\\AppData\\Local\\pnpm\\codex.cmd",
      "C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js",
      "pnpm",
    ],
    [
      "C:\\Users\\me\\AppData\\Local\\Volta\\bin\\claude.exe",
      "C:\\Users\\me\\AppData\\Local\\Volta\\bin\\claude.exe",
      "C:\\Users\\me\\AppData\\Local\\Volta\\bin\\claude.exe",
      "volta",
    ],
    [
      "C:\\Users\\me\\.bun\\bin\\omp.exe",
      "C:\\Users\\me\\.bun\\bin\\omp.exe",
      "C:\\Users\\me\\.bun\\bin\\omp.exe",
      "bun",
    ],
    [
      "C:\\Users\\me\\.local\\bin\\claude.exe",
      "C:\\Users\\me\\.local\\bin\\claude.exe",
      "C:\\Users\\me\\.local\\bin\\claude.exe",
      "native",
    ],
    ["C:\\tools\\opencode.exe", "C:\\tools\\opencode.exe", "C:\\tools\\opencode.exe", "unknown"],
  ])("%s → %s", (launcher, real, target, source) => {
    expect(inferWindowsSource(launcher, real, target, `${clis}\\`)).toBe(source);
  });

  it("without the desktop's agent-clis dir still tells npm installs by their node_modules target", () => {
    expect(
      inferWindowsSource(
        `${clis}\\codex.cmd`,
        `${clis}\\codex.cmd`,
        `${clis}\\node_modules\\@openai\\codex\\bin\\codex.js`,
      ),
    ).toBe("npm");
    expect(
      inferWindowsSource("C:\\tools\\codex.cmd", "C:\\tools\\codex.cmd", "C:\\tools\\codex.cmd"),
    ).toBe("unknown");
  });
});

describe("planUpdate", () => {
  const install = (tool: string, file: string, real = file) => ({
    path: file,
    realPath: real,
    source: inferSource(file, real),
  });

  it("uses the official installer's own update for native installs", () => {
    expect(
      planUpdate(
        "claude",
        install(
          "claude",
          "/Users/a/.local/bin/claude",
          "/Users/a/.local/share/claude/versions/2.1.0",
        ),
        mac(),
      ),
    ).toEqual({ kind: "anchored", command: "'/Users/a/.local/bin/claude' update" });
    const codex = planUpdate(
      "codex",
      install(
        "codex",
        "/Users/a/.local/bin/codex",
        "/Users/a/.codex/packages/standalone/releases/0.170.0/codex",
      ),
      mac(),
    );
    expect(codex.kind).toBe("anchored");
    expect(codex.kind === "anchored" && codex.command).toContain(
      "CODEX_INSTALL_DIR='/Users/a/.local/bin' CODEX_HOME='/Users/a/.codex' bash -c",
    );
  });

  it("anchors Homebrew installs to the brew next to them, and refuses when brew isn't there", () => {
    const cask = install(
      "codex",
      "/opt/homebrew/bin/codex",
      "/opt/homebrew/Caskroom/codex/0.1/codex",
    );
    expect(planUpdate("codex", cask, mac(["/opt/homebrew/bin/brew"]))).toEqual({
      kind: "anchored",
      command: "'/opt/homebrew/bin/brew' upgrade --cask codex",
    });
    const formula = install(
      "opencode",
      "/opt/homebrew/bin/opencode",
      "/opt/homebrew/Cellar/opencode/1.0/bin/opencode",
    );
    expect(planUpdate("copilot", formula, mac(["/opt/homebrew/bin/brew"]))).toEqual({
      kind: "anchored",
      command: "'/opt/homebrew/bin/brew' upgrade opencode",
    });
    const missing = planUpdate("codex", cask, mac());
    expect(missing).toMatchObject({
      kind: "manual",
      reasonText: { key: "agentCli.manual.noManager" },
    });
  });

  it("anchors npm to the node manager that owns the install", () => {
    const bin = "/Users/a/.nvm/versions/node/v22.1.0/bin";
    const plan = planUpdate(
      "codex",
      install(
        "codex",
        `${bin}/codex`,
        "/Users/a/.nvm/versions/node/v22.1.0/lib/node_modules/@openai/codex/bin/codex.js",
      ),
      mac([`${bin}/npm`]),
    );
    expect(plan).toEqual({
      kind: "anchored",
      command: `PATH='${bin}':"$PATH" '${bin}/npm' i -g @openai/codex@latest`,
    });
    // 同目录没有 npm：不猜，交给人
    expect(
      planUpdate(
        "codex",
        install("codex", `${bin}/codex`, `${bin}/../lib/node_modules/@openai/codex/x.js`),
        mac(),
      ),
    ).toMatchObject({ kind: "manual", reasonText: { params: { manager: "npm" } } });
  });

  it("writes npm installs with a custom prefix back to that prefix", () => {
    const plan = planUpdate(
      "copilot",
      install(
        "copilot",
        "/Users/a/.npm-global/bin/copilot",
        "/Users/a/.npm-global/lib/node_modules/@github/copilot/npm-loader.js",
      ),
      mac([], "/usr/local/bin/npm"),
    );
    expect(plan).toEqual({
      kind: "anchored",
      command: "'/usr/local/bin/npm' i -g --prefix '/Users/a/.npm-global' @github/copilot@latest",
    });
  });

  it("prefers the tool's own update with the anchored package manager as fallback", () => {
    const plan = planUpdate(
      "claude",
      install(
        "claude",
        "/Users/a/.npm-global/bin/claude",
        "/Users/a/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
      ),
      mac([], "/usr/local/bin/npm"),
    );
    expect(plan.kind === "anchored" && plan.command).toBe(
      "npm_config_allow_scripts=@anthropic-ai/claude-code npm_config_ignore_scripts=false npm_config_include=optional " +
        "'/Users/a/.npm-global/bin/claude' update || '/usr/local/bin/npm' i -g --prefix '/Users/a/.npm-global' " +
        "@anthropic-ai/claude-code@latest --ignore-scripts=false --include=optional --allow-scripts=@anthropic-ai/claude-code",
    );
  });

  it("refuses sources it can't recognise and Windows", () => {
    expect(planUpdate("copilot", install("copilot", "/Users/a/bin/copilot"), mac())).toMatchObject({
      kind: "manual",
      reasonText: { key: "agentCli.manual.unknownSource" },
    });
    expect(
      planUpdate("copilot", install("copilot", "C:/npm/copilot.cmd"), {
        ...mac(),
        platform: "win32",
      }),
    ).toMatchObject({ kind: "manual", reasonText: { key: "agentCli.manual.windows" } });
  });

  it("quotes paths so they can't inject shell syntax", () => {
    const evil = "/Users/a/x'; touch /tmp/pwned; echo '/.local/bin/claude";
    const plan = planUpdate(
      "claude",
      { path: evil, realPath: "/Users/a/.local/share/claude/versions/1", source: "native" },
      mac(),
    );
    expect(plan).toEqual({ kind: "anchored", command: `${shellQuote(evil)} update` });
    expect(shellQuote(evil)).toBe(
      `'/Users/a/x'\\''; touch /tmp/pwned; echo '\\''/.local/bin/claude'`,
    );
    // 换行、相对路径一律不拼
    expect(
      planUpdate("claude", { path: "/a\n/claude", realPath: "/a/claude", source: "native" }, mac()),
    ).toMatchObject({ kind: "manual" });
    expect(
      planUpdate("claude", { path: "claude", realPath: "claude", source: "native" }, mac()),
    ).toMatchObject({ kind: "manual" });
  });
});

describe("versions", () => {
  it("compares semver including prereleases", () => {
    expect(compareVersions("2.1.327", "2.1.283")).toBe(1);
    expect(compareVersions("0.170.0", "0.170.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-beta.10", "1.0.0-beta.2")).toBe(1);
    expect(compareVersions("2026.11.5", "2026.5.7")).toBe(1);
    expect(compareVersions("abc", "1.0.0")).toBeUndefined();
  });

  it.each([
    [">=22.19.0", "22.19.0", true],
    [">=22.19.0", "22.18.9", false],
    [">=18 <21 || >=22", "20.5.0", true],
    [">=18 <21 || >=22", "21.0.0", false],
    ["^18.17.0 || >=20", "18.16.0", false],
    ["^18.17.0 || >=20", "18.20.1", true],
    ["~20.1", "20.2.0", false],
    ["18.x", "18.9.1", true],
    ["18 - 20", "20.11.0", true],
    [">= 24.16", "24.16.0", true],
    [">24", "24.0.0", false],
    ["*", "16.0.0", true],
    ["latest", "22.0.0", undefined],
  ])("node %s with %s → %s", (range, version, expected) => {
    expect(nodeRangeSatisfied(range, version)).toBe(expected);
  });
});

describe("helpers", () => {
  it("reads PATH from noisy login shell output and merges", () => {
    expect(pathFromEnvOutput("Welcome!\nPATH=relative\nHOME=/x\nPATH=/a/bin:/b\n")).toBe(
      "/a/bin:/b",
    );
    expect(mergePath("/a:/b", "/b:/c::rel")).toBe("/a:/b:/c");
  });

  it("keeps the last non-empty line, strips color and caps length", () => {
    expect(lastLine("\u001b[32mfetching\u001b[0m\r50%\r100%\n\n")).toBe("100%");
    expect(lastLine("x".repeat(300))?.length).toBe(200);
    expect(lastLine("\n \n")).toBeUndefined();
  });

  it("flags conflicts only when versions differ or some can't run", () => {
    expect(isConflicting([{ version: "1.0.0", runnable: true }])).toBe(false);
    expect(
      isConflicting([
        { version: "1.0.0", runnable: true },
        { version: "1.0.0", runnable: true },
      ]),
    ).toBe(false);
    expect(
      isConflicting([
        { version: "1.0.0", runnable: true },
        { version: "1.1.0", runnable: true },
      ]),
    ).toBe(true);
    expect(
      isConflicting([
        { version: "1.0.0", runnable: true },
        { version: null, runnable: false },
      ]),
    ).toBe(true);
  });
});

/* ---------- 探测与升级：用临时目录里的假 CLI，不碰真实安装 ---------- */

function sandbox() {
  // macOS 的临时目录经 /var → /private/var 链接：按真实路径算，和探测结果一致
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "hive-clis-")));
  dirs.push(root);
  const bin = (name: string) => {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const script = (dir: string, name: string, body: string) => {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  };
  return { root, bin, script };
}

class FakeUpgrade implements UpgradeChild {
  outputs: Array<(chunk: string) => void> = [];
  exits: Array<(code: number | null, error?: Error) => void> = [];
  killed = false;
  onOutput(listener: (chunk: string) => void) {
    this.outputs.push(listener);
  }
  onExit(listener: (code: number | null, error?: Error) => void) {
    this.exits.push(listener);
  }
  kill() {
    this.killed = true;
  }
  write(text: string) {
    for (const listener of this.outputs) listener(text);
  }
  exit(code: number | null) {
    for (const listener of this.exits) listener(code);
  }
}

function manager(options: {
  loginPath: string;
  extraDirs?: string[];
  latest?: Record<string, string>;
  engines?: Record<string, string>;
  spawn?: SpawnUpgrade;
  upgradeTimeoutMs?: number;
}) {
  const fetchJson = vi.fn(async (url: string) => {
    const tags = /\/-\/package\/(.+)\/dist-tags$/.exec(url);
    if (tags) {
      const latest = options.latest?.[decodeURIComponent(tags[1]!)];
      return latest ? { latest } : undefined;
    }
    const engines = /registry\.npmjs\.org\/(.+)\/[^/]+$/.exec(url);
    const node = engines && options.engines?.[decodeURIComponent(engines[1]!)];
    return node ? { engines: { node } } : {};
  });
  const spawnUpgrade = options.spawn ?? vi.fn<SpawnUpgrade>(() => new FakeUpgrade());
  return {
    fetchJson,
    spawnUpgrade,
    clis: new AgentCliManager({
      platform: "darwin",
      home: "/nonexistent-home",
      env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent-home" },
      loginPath: async () => options.loginPath,
      extraDirs: options.extraDirs ?? [],
      fetchJson,
      spawnUpgrade,
      ...(options.upgradeTimeoutMs ? { upgradeTimeoutMs: options.upgradeTimeoutMs } : {}),
    }),
  };
}

describe("AgentCliManager detection", () => {
  it("finds installs on the login PATH and in extra dirs, dedupes symlinks and flags conflicts", async () => {
    const { bin, script, root } = sandbox();
    // 自定义前缀的 npm 全局安装：bin/codex → lib/node_modules/@openai/codex/bin/codex.js
    const prefix = path.join(root, ".npm-global");
    const pkgBin = bin(".npm-global/lib/node_modules/@openai/codex/bin");
    const real = script(pkgBin, "codex.js", 'echo "codex-cli 0.160.0"');
    const globalBin = bin(".npm-global/bin");
    symlinkSync(real, path.join(globalBin, "codex"));
    // 同一处又经另一个 PATH 目录链接过来：按真实路径去重
    const alias = bin("alias");
    symlinkSync(real, path.join(alias, "codex"));
    // 兜底目录里还有一份旧版，不在登录 PATH 上
    const extra = bin("extra");
    script(extra, "codex", 'echo "0.150.0"');
    // 装了但跑不起来
    script(globalBin, "copilot", 'echo "Error: Node 18 is too old" >&2; exit 1');
    const npm = script(bin("node/bin"), "npm", "exit 0");

    const { clis } = manager({
      loginPath: `${globalBin}:${alias}:${path.dirname(npm)}`,
      extraDirs: [extra],
      latest: { "@openai/codex": "0.170.0", "@github/copilot": "1.0.114" },
    });
    const list = await clis.list();
    expect(list.map((item) => item.tool)).toEqual([
      "claude",
      "codex",
      "copilot",
      "opencode",
      "omp",
      "openclaw",
      "gemini",
      "agy",
    ]);
    const codex = list.find((item) => item.tool === "codex")!;
    expect(codex).toMatchObject({
      status: "ok",
      version: "0.160.0",
      latest: "0.170.0",
      updateAvailable: true,
      conflict: true,
      plan: {
        kind: "anchored",
        command: `${shellQuote(npm)} i -g --prefix ${shellQuote(prefix)} @openai/codex@latest`,
      },
    });
    expect(codex.installations).toHaveLength(2);
    expect(codex.installations[0]).toMatchObject({
      path: path.join(globalBin, "codex"),
      source: "npm",
      pathDefault: true,
      runnable: true,
    });
    expect(codex.installations[1]).toMatchObject({ version: "0.150.0", pathDefault: false });

    const copilot = list.find((item) => item.tool === "copilot")!;
    expect(copilot).toMatchObject({ status: "broken", version: null, updateAvailable: true });
    expect(copilot.installations[0]!.error).toContain("Node 18 is too old");

    expect(list.find((item) => item.tool === "claude")).toMatchObject({
      status: "notInstalled",
      installations: [],
    });
  });

  it("refuses to offer an update the local Node can't run", async () => {
    const { bin, script } = sandbox();
    const nvm = bin(".nvm/versions/node/v20.1.0/bin");
    const pkg = bin(".nvm/versions/node/v20.1.0/lib/node_modules/openclaw");
    const real = script(pkg, "openclaw.mjs", 'echo "OpenClaw 2026.5.7"');
    symlinkSync(real, path.join(nvm, "openclaw"));
    script(nvm, "node", 'echo "v20.1.0"');
    script(nvm, "npm", "exit 0");
    const { clis } = manager({
      loginPath: nvm,
      latest: { openclaw: "2026.11.5" },
      engines: { openclaw: ">=24.16.0" },
    });
    const openclaw = (await clis.list()).find((item) => item.tool === "openclaw")!;
    expect(openclaw).toMatchObject({
      updateAvailable: true,
      nodeGap: { required: ">=24.16.0", current: "20.1.0" },
    });
    await expect(
      clis.upgrade("openclaw", (openclaw.plan as { command: string }).command),
    ).rejects.toMatchObject({ code: "AGENT_CLI_NODE_TOO_OLD" });
  });

  it("shows the latest version as unknown when the registry can't be reached", async () => {
    const { bin, script } = sandbox();
    const dir = bin("native");
    const claudeBin = script(dir, "claude", 'echo "2.1.0 (Claude Code)"');
    script(dir, "copilot", 'echo "1.0.88"');
    const { clis } = manager({ loginPath: dir });
    const list = await clis.list();
    const claude = list.find((item) => item.tool === "claude")!;
    expect(claude).toMatchObject({ version: "2.1.0", latest: null, updateAvailable: false });
    // 认不出来源：自带升级子命令的交给它自己（它认得自己的安装方式），没有的不给命令
    expect(claude.plan).toEqual({ kind: "anchored", command: `${shellQuote(claudeBin)} update` });
    expect(list.find((item) => item.tool === "copilot")!.plan).toMatchObject({
      kind: "manual",
      reasonText: { key: "agentCli.manual.unknownSource" },
    });
  });
});

describe("AgentCliManager without an npm package (agy)", () => {
  it("never asks the npm registry about agy, leaves latest unknown and still offers its own update", async () => {
    const { bin, script } = sandbox();
    const dir = bin("native");
    const agy = script(dir, "agy", 'echo "1.5.14"');
    script(dir, "gemini", 'echo "0.70.0"');
    const { clis, fetchJson } = manager({
      loginPath: dir,
      latest: { "@google/gemini-cli": "0.71.0" },
    });
    const list = await clis.list();
    expect(list.find((item) => item.tool === "agy")).toMatchObject({
      name: "Antigravity CLI",
      package: "",
      status: "ok",
      version: "1.5.14",
      latest: null,
      updateAvailable: false,
      plan: {
        kind: "anchored",
        command: `${shellQuote(agy)} update || ${installerCommand("agy")}`,
      },
    });
    expect(list.find((item) => item.tool === "gemini")).toMatchObject({
      name: "Gemini CLI",
      package: "@google/gemini-cli",
      version: "0.70.0",
      latest: "0.71.0",
      updateAvailable: true,
    });
    const urls = fetchJson.mock.calls.map(([url]) => url);
    expect(urls.some((url) => url.includes("gemini-cli"))).toBe(true);
    expect(urls.filter((url) => /agy|undefined|\/-\/package\/\/|org\/\//.test(url))).toEqual([]);
  });

  it("plans the official installer for a missing agy and warns when ~/.local/bin isn't on PATH", async () => {
    const { bin, script } = sandbox();
    const nodeBin = bin("node/bin");
    script(nodeBin, "npm", "exit 0");
    const { clis, fetchJson } = manager({ loginPath: nodeBin });
    const agy = (await clis.list()).find((item) => item.tool === "agy")!;
    expect(agy).toMatchObject({
      status: "notInstalled",
      latest: null,
      plan: { kind: "anchored", command: installerCommand("agy") },
      binNotOnPath: path.join("/nonexistent-home", ".local/bin"),
    });
    expect(agy.nodeGap).toBeUndefined();
    expect(fetchJson.mock.calls.filter(([url]) => /agy|undefined/.test(url))).toEqual([]);
  });
});

describe("AgentCliManager upgrade", () => {
  async function setup(options: { upgradeTimeoutMs?: number } = {}) {
    const { bin, script } = sandbox();
    const nvm = bin(".nvm/versions/node/v22.1.0/bin");
    const pkg = bin(".nvm/versions/node/v22.1.0/lib/node_modules/@openai/codex/bin");
    const real = script(pkg, "codex.js", 'echo "codex-cli 0.160.0"');
    symlinkSync(real, path.join(nvm, "codex"));
    script(nvm, "npm", "exit 0");
    const children: FakeUpgrade[] = [];
    const spawn = vi.fn<SpawnUpgrade>(() => {
      const child = new FakeUpgrade();
      children.push(child);
      return child;
    });
    const made = manager({
      loginPath: nvm,
      latest: { "@openai/codex": "0.170.0" },
      spawn,
      ...options,
    });
    const codex = (await made.clis.list()).find((item) => item.tool === "codex")!;
    const command = (codex.plan as { command: string }).command;
    const bump = () => script(pkg, "codex.js", 'echo "codex-cli 0.170.0"');
    return { ...made, spawn, children, command, bump, nvm };
  }

  it("runs only the confirmed command, one at a time, with throttled single-line progress", async () => {
    const { clis, spawn, children, command, bump, nvm } = await setup();
    expect(command).toBe(
      `PATH=${shellQuote(nvm)}:"$PATH" ${shellQuote(`${nvm}/npm`)} i -g @openai/codex@latest`,
    );
    await expect(clis.upgrade("codex", `${command}; rm -rf ~`)).rejects.toMatchObject({
      code: "AGENT_CLI_PLAN_CHANGED",
    });
    expect(spawn).not.toHaveBeenCalled();

    const job = await clis.upgrade("codex", command);
    expect(job).toMatchObject({ state: "running", command, versionBefore: "0.160.0" });
    expect(spawn).toHaveBeenCalledWith(
      command,
      expect.objectContaining({ PATH: `${nvm}:/usr/bin:/bin` }),
    );
    // 全局一次一个
    await expect(clis.upgrade("codex", command)).rejects.toMatchObject({ code: "AGENT_CLI_BUSY" });
    await expect(clis.upgrade("claude", "x")).rejects.toMatchObject({ code: "AGENT_CLI_BUSY" });

    const child = children[0]!;
    child.write("npm http fetch GET 200 https://registry.npmjs.org/@openai%2fcodex 12ms\n");
    expect(clis.job(job.id)!.progress).toContain("npm http fetch");
    child.write("\u001b[1mreify\u001b[0m: timing\rchanged 2 packages\n");
    // 150ms 内的新行先攒着
    expect(clis.job(job.id)!.progress).toContain("npm http fetch");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(clis.job(job.id)!.progress).toBe("changed 2 packages");

    bump();
    child.exit(0);
    await vi.waitFor(() => expect(clis.job(job.id)).toMatchObject({ versionAfter: "0.170.0" }));
    expect(clis.job(job.id)).toMatchObject({ state: "succeeded" });
    expect(clis.current()?.id).toBe(job.id);
    // 升完是最新版，再点就拒绝
    await expect(clis.upgrade("codex", command)).rejects.toMatchObject({
      code: "AGENT_CLI_UP_TO_DATE",
    });
  });

  it("reports the last lines of output when the command fails, then frees the lock", async () => {
    const { clis, children, command } = await setup();
    const job = await clis.upgrade("codex", command);
    const child = children[0]!;
    child.write(
      Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n") +
        "\nnpm error code EACCES\nnpm error path /usr/local/lib/node_modules\n",
    );
    child.exit(243);
    const failed = clis.job(job.id)!;
    expect(failed).toMatchObject({
      state: "failed",
      reasonText: { key: "error.agentCli.exitCode", params: { code: "243" } },
    });
    expect(failed.error!.split("\n")).toHaveLength(8);
    expect(failed.error).toContain("npm error code EACCES");
    expect(failed.error).not.toContain("line 5");
    // 失败后可以重试
    await expect(clis.upgrade("codex", command)).resolves.toMatchObject({ state: "running" });
  });

  it("doesn't report success when the version didn't change", async () => {
    const { clis, children, command } = await setup();
    const job = await clis.upgrade("codex", command);
    children[0]!.write("Update ran successfully\n");
    children[0]!.exit(0);
    // 核对版本期间仍算进行中，锁不放
    expect(clis.job(job.id)?.state).toBe("running");
    await expect(clis.upgrade("codex", command)).rejects.toMatchObject({ code: "AGENT_CLI_BUSY" });
    await vi.waitFor(() => expect(clis.job(job.id)?.state).toBe("failed"));
    expect(clis.job(job.id)).toMatchObject({
      versionAfter: "0.160.0",
      reasonText: {
        key: "error.agentCli.versionUnchanged",
        params: { tool: "Codex", version: "0.160.0" },
      },
      error: "Update ran successfully",
    });
    // 结束后可以重试
    await expect(clis.upgrade("codex", command)).resolves.toMatchObject({ state: "running" });
  });

  it("stops a command that runs too long", async () => {
    const { clis, children, command } = await setup({ upgradeTimeoutMs: 50 });
    const job = await clis.upgrade("codex", command);
    await vi.waitFor(() => expect(clis.job(job.id)?.state).toBe("failed"));
    expect(children[0]!.killed).toBe(true);
    expect(clis.job(job.id)!.reasonText).toMatchObject({ key: "error.agentCli.timeout" });
  });
});

/* ---------- 接口：只限本机房主 ---------- */

describe("agent cli routes", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function setup() {
    const { bin, script } = sandbox();
    const nvm = bin(".nvm/versions/node/v22.1.0/bin");
    const pkg = bin(".nvm/versions/node/v22.1.0/lib/node_modules/@openai/codex/bin");
    symlinkSync(script(pkg, "codex.js", 'echo "0.160.0"'), path.join(nvm, "codex"));
    script(nvm, "npm", "exit 0");
    const bump = () => script(pkg, "codex.js", 'echo "0.170.0"');
    const children: FakeUpgrade[] = [];
    const { clis, spawnUpgrade } = manager({
      loginPath: nvm,
      latest: { "@openai/codex": "0.170.0" },
      spawn: vi.fn<SpawnUpgrade>(() => {
        const child = new FakeUpgrade();
        children.push(child);
        return child;
      }),
    });
    const logs: string[] = [];
    const app = await buildApp({
      databasePath: ":memory:",
      token: "join-token",
      staticDir: "/definitely-not-present",
      logger: { level: "info", stream: { write: (line: string) => void logs.push(line) } },
      agentClis: clis,
      localAgents: {
        cli: { command: "/usr/bin/node", args: ["cli.js"] },
        serverUrl: "http://127.0.0.1:8787",
        spawn: vi.fn<SpawnAgent>(),
        probe: async () => ({ installed: true, version: "1.0.0" }),
      },
    });
    close = () => app.close();
    const session = (await app.inject({ method: "GET", url: "/api/local/session" })).json() as {
      ownerToken: string;
    };
    return {
      app,
      owner: { "x-hive-owner": session.ownerToken },
      logs,
      children,
      spawnUpgrade,
      bump,
    };
  }

  it("lists CLIs and runs a confirmed upgrade for the local owner, with an audit log", async () => {
    const { app, owner, logs, children, bump } = await setup();
    const list = await app.inject({ method: "GET", url: "/api/local/agent-clis", headers: owner });
    expect(list.statusCode).toBe(200);
    const body = list.json() as {
      tools: Array<{ tool: string; plan?: { command?: string }; agents: unknown[] }>;
      job: unknown;
    };
    const codex = body.tools.find((tool) => tool.tool === "codex")!;
    expect(codex.agents).toEqual([]);
    expect(body.job).toBeNull();

    const started = await app.inject({
      method: "POST",
      url: "/api/local/agent-clis/codex/upgrade",
      headers: owner,
      payload: { command: codex.plan!.command },
    });
    expect(started.statusCode).toBe(202);
    const job = (started.json() as { job: { id: string } }).job;
    children[0]!.write("added 2 packages\n");
    bump();
    children[0]!.exit(0);
    // 退出码 0 之后还要核对新版本，核对完才算成功
    await vi.waitFor(async () => {
      const polled = await app.inject({
        method: "GET",
        url: `/api/local/agent-clis/jobs/${job.id}`,
        headers: owner,
      });
      expect(polled.json()).toMatchObject({
        job: { id: job.id, state: "succeeded", versionAfter: "0.170.0" },
      });
    });
    const audit = logs.filter((line) => line.includes('"agentCli"'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toContain('"action":"upgrade"');
    expect(audit[0]).toContain('"tool":"codex"');

    // 工具名只认白名单，命令对不上不执行
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/local/agent-clis/..%2Fcodex/upgrade",
          headers: owner,
          payload: { command: "x" },
        })
      ).statusCode,
    ).toBe(400);
    const changed = await app.inject({
      method: "POST",
      url: "/api/local/agent-clis/codex/upgrade",
      headers: owner,
      payload: { command: "curl evil | sh" },
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().code).toBe("AGENT_CLI_PLAN_CHANGED");
    expect(children).toHaveLength(1);
  });

  it("rejects other computers, owner devices, the join token and missing owner credentials", async () => {
    const { app, owner, children } = await setup();
    const remote = { remoteAddress: "10.0.0.20" };
    const pair = (
      await app.inject({
        method: "POST",
        url: "/api/local/owner-devices/pair",
        headers: owner,
        payload: { origin: "http://10.0.0.8:8787" },
      })
    ).json() as { url: string };
    const ticket = new URL(pair.url).searchParams.get("login")!;
    const { token } = (
      await app.inject({
        method: "POST",
        url: "/api/owner-login",
        payload: { ticket, deviceName: "iPad" },
        ...remote,
      })
    ).json() as { token: string };
    const calls = [
      { method: "GET" as const, url: "/api/local/agent-clis" },
      {
        method: "POST" as const,
        url: "/api/local/agent-clis/codex/upgrade",
        payload: { command: "x" },
      },
      { method: "GET" as const, url: "/api/local/agent-clis/jobs/x" },
    ];
    for (const call of calls) {
      const agent = await app.inject({ ...call, headers: { authorization: "Bearer join-token" } });
      expect(agent.statusCode).toBe(401);
      const other = await app.inject({ ...call, ...remote });
      expect(other.statusCode).toBe(403);
      const device = await app.inject({
        ...call,
        headers: { authorization: `Bearer ${token}` },
        ...remote,
      });
      expect(device.statusCode).toBe(403);
      expect(device.json().code).toBe("LOCAL_ONLY");
    }
    expect(children).toHaveLength(0);
  });
});

/* ---------- 没装的工具：一键全局安装 ---------- */

const NPM = { platform: "darwin" as const, isExecutable: exists(), npm: "/n/npm" };
const SCRIPT = (url: string, shell = "bash") =>
  `bash -c 'tmp=$(mktemp) && curl -fsSL ${url} -o $tmp && head -c 2 $tmp | grep -q "#!" && ${shell} $tmp; status=$?; rm -f $tmp; exit $status'`;

describe("official installers", () => {
  it("keeps every script URL in a fixed https allowlist and downloads before running", () => {
    expect(
      Object.fromEntries(Object.entries(OFFICIAL_INSTALLERS).map(([k, v]) => [k, v.url])),
    ).toEqual({
      claude: "https://claude.ai/install.sh",
      opencode: "https://opencode.ai/install",
      omp: "https://omp.sh/install",
      codex: "https://chatgpt.com/codex/install.sh",
      agy: "https://antigravity.google/cli/install.sh",
    });
    for (const tool of Object.keys(OFFICIAL_INSTALLERS) as Array<
      keyof typeof OFFICIAL_INSTALLERS
    >) {
      const command = installerCommand(tool);
      expect(command).toContain("curl -fsSL https://");
      expect(command).toContain("-o $tmp &&");
      // 下载到的不是脚本（例如 HTML 页面）就不执行
      expect(command).toContain(`head -c 2 $tmp | grep -q "#!" &&`);
      expect(command).not.toMatch(/\|\s*(ba)?sh/);
    }
    expect(installerCommand("omp")).toBe(SCRIPT("https://omp.sh/install", "sh"));
    expect(installerCommand("agy")).toBe(SCRIPT("https://antigravity.google/cli/install.sh"));
  });
});

describe("planInstall", () => {
  it("runs the official script first for claude and opencode, falling back to npm", () => {
    expect(
      planInstall("claude", {
        platform: "darwin",
        isExecutable: exists("/usr/local/bin/node"),
        npm: "/usr/local/bin/npm",
      }),
    ).toEqual({
      kind: "anchored",
      command:
        `${SCRIPT("https://claude.ai/install.sh")} || ` +
        "PATH='/usr/local/bin':\"$PATH\" '/usr/local/bin/npm' i -g @anthropic-ai/claude-code@latest " +
        "--ignore-scripts=false --include=optional --allow-scripts=@anthropic-ai/claude-code",
    });
    expect(planInstall("opencode", NPM)).toEqual({
      kind: "anchored",
      command:
        `${SCRIPT("https://opencode.ai/install")} || ` +
        "'/n/npm' i -g opencode-ai@latest --ignore-scripts=false --include=optional --allow-scripts=opencode-ai",
    });
    // 没有 npm：只跑官方脚本
    expect(planInstall("claude", { platform: "darwin", isExecutable: exists() })).toEqual({
      kind: "anchored",
      command: SCRIPT("https://claude.ai/install.sh"),
    });
  });

  it("installs omp with its official script, without needing bun or npm", () => {
    for (const context of [NPM, { platform: "darwin" as const, isExecutable: exists() }]) {
      expect(planInstall("omp", context)).toEqual({
        kind: "anchored",
        command: SCRIPT("https://omp.sh/install", "sh"),
      });
    }
  });

  it("installs agy with its official script only: it isn't on npm", () => {
    for (const context of [NPM, { platform: "darwin" as const, isExecutable: exists() }]) {
      expect(planInstall("agy", context)).toEqual({
        kind: "anchored",
        command: SCRIPT("https://antigravity.google/cli/install.sh"),
      });
    }
    expect(planInstall("agy", { ...NPM, platform: "win32" })).toMatchObject({
      kind: "manual",
      reasonText: { key: "agentCli.manual.windowsInstall" },
    });
  });

  it("keeps npm for codex, copilot, openclaw and gemini, and asks for Node.js without npm", () => {
    for (const [tool, pkg] of [
      ["codex", "@openai/codex"],
      ["copilot", "@github/copilot"],
      ["openclaw", "openclaw"],
      ["gemini", "@google/gemini-cli"],
    ] as const) {
      expect(planInstall(tool, NPM)).toEqual({
        kind: "anchored",
        command: `'/n/npm' i -g ${pkg}@latest`,
      });
      expect(planInstall(tool, { platform: "darwin", isExecutable: exists() })).toMatchObject({
        kind: "manual",
        reasonText: { key: "agentCli.manual.noNode" },
      });
    }
    expect(planInstall("codex", { ...NPM, platform: "win32" })).toMatchObject({
      kind: "manual",
      reasonText: { key: "agentCli.manual.windowsInstall" },
    });
    const evil = "/opt/x'; touch /tmp/pwned; '/npm";
    expect(planInstall("codex", { ...NPM, npm: evil })).toEqual({
      kind: "anchored",
      command: `${shellQuote(evil)} i -g @openai/codex@latest`,
    });
  });
});

describe("planUpdate fallbacks", () => {
  const install = (file: string, real = file) => ({
    path: file,
    realPath: real,
    source: inferSource(file, real),
  });

  it("chains omp update to the official script and refuses Nix installs", () => {
    expect(planUpdate("omp", install("/Users/a/.local/bin/omp"), mac())).toEqual({
      kind: "anchored",
      command: `'/Users/a/.local/bin/omp' update || ${SCRIPT("https://omp.sh/install", "sh")}`,
    });
    expect(
      planUpdate("omp", install("/Users/a/.bun/bin/omp"), mac(["/Users/a/.bun/bin/bun"])),
    ).toEqual({
      kind: "anchored",
      command: `'/Users/a/.bun/bin/omp' update || ${SCRIPT("https://omp.sh/install", "sh")}`,
    });
    expect(
      planUpdate(
        "omp",
        install("/Users/a/.nix-profile/bin/omp", "/nix/store/x-omp/bin/omp"),
        mac(),
      ),
    ).toMatchObject({ kind: "manual", reasonText: { key: "agentCli.manual.nix" } });
  });

  it("chains agy update to the official script wherever it is, and refuses Nix installs", () => {
    const script = SCRIPT("https://antigravity.google/cli/install.sh");
    expect(planUpdate("agy", install("/Users/a/.local/bin/agy"), mac())).toEqual({
      kind: "anchored",
      command: `'/Users/a/.local/bin/agy' update || ${script}`,
    });
    // 认不出来源也交给它自己的 update：它不在 npm 上，没有别的包管理器可锚定
    expect(planUpdate("agy", install("/Users/a/bin/agy"), mac([], "/usr/local/bin/npm"))).toEqual({
      kind: "anchored",
      command: `'/Users/a/bin/agy' update || ${script}`,
    });
    expect(
      planUpdate(
        "agy",
        install("/Users/a/.nix-profile/bin/agy", "/nix/store/x-agy/bin/agy"),
        mac(),
      ),
    ).toMatchObject({ kind: "manual", reasonText: { key: "agentCli.manual.nix" } });
    expect(
      planUpdate("agy", install("/Users/a/.local/bin/agy"), { ...mac(), platform: "win32" }),
    ).toMatchObject({ kind: "manual", reasonText: { key: "agentCli.manual.windows" } });
  });

  it("upgrades npm-installed gemini with the anchored npm, without a self-update", () => {
    expect(
      planUpdate(
        "gemini",
        install(
          "/Users/a/.npm-global/bin/gemini",
          "/Users/a/.npm-global/lib/node_modules/@google/gemini-cli/bundle/gemini.js",
        ),
        mac([], "/usr/local/bin/npm"),
      ),
    ).toEqual({
      kind: "anchored",
      command:
        "'/usr/local/bin/npm' i -g --prefix '/Users/a/.npm-global' @google/gemini-cli@latest",
    });
    expect(
      planUpdate(
        "gemini",
        install("/usr/local/bin/gemini", "/usr/local/Cellar/gemini-cli/0.13.0/bin/gemini"),
        mac(["/usr/local/bin/brew"]),
      ),
    ).toEqual({ kind: "anchored", command: "'/usr/local/bin/brew' upgrade gemini-cli" });
    expect(planUpdate("gemini", install("/Users/a/bin/gemini"), mac())).toMatchObject({
      kind: "manual",
      reasonText: { key: "agentCli.manual.unknownSource" },
    });
  });

  it("never uses codex update: npm installs use npm, standalone installs rerun the installer", () => {
    const npm = planUpdate(
      "codex",
      install(
        "/Users/a/.npm-global/bin/codex",
        "/Users/a/.npm-global/lib/node_modules/@openai/codex/bin/codex.js",
      ),
      mac([], "/usr/local/bin/npm"),
    );
    expect(npm).toEqual({
      kind: "anchored",
      command: "'/usr/local/bin/npm' i -g --prefix '/Users/a/.npm-global' @openai/codex@latest",
    });
    const standalone = planUpdate(
      "codex",
      install(
        "/Users/a/.local/bin/codex",
        "/Users/a/.codex/packages/standalone/releases/0.170.0/codex",
      ),
      mac(),
    );
    expect(standalone).toEqual({
      kind: "anchored",
      command: `CODEX_NON_INTERACTIVE=1 CODEX_INSTALL_DIR='/Users/a/.local/bin' CODEX_HOME='/Users/a/.codex' ${SCRIPT("https://chatgpt.com/codex/install.sh", "sh")}`,
    });
    for (const plan of [npm, standalone]) {
      expect(plan.kind === "anchored" && plan.command).not.toContain("codex' update");
    }
  });

  it("chains opencode upgrade and openclaw update to the anchored npm", () => {
    expect(
      planUpdate(
        "openclaw",
        install(
          "/Users/a/.npm-global/bin/openclaw",
          "/Users/a/.npm-global/lib/node_modules/openclaw/openclaw.mjs",
        ),
        mac([], "/usr/local/bin/npm"),
      ),
    ).toEqual({
      kind: "anchored",
      command:
        "'/Users/a/.npm-global/bin/openclaw' update --yes || '/usr/local/bin/npm' i -g --prefix '/Users/a/.npm-global' openclaw@latest",
    });
  });
});

describe("AgentCliManager install", () => {
  async function setup(options: { engines?: Record<string, string>; prefix?: string } = {}) {
    const { bin, script, root } = sandbox();
    const nodeBin = bin("node/bin");
    const prefix = options.prefix ?? path.join(root, "global");
    script(nodeBin, "npm", `[ "$1" = prefix ] && echo "${prefix}"; exit 0`);
    script(nodeBin, "node", 'echo "v22.1.0"');
    const children: FakeUpgrade[] = [];
    const made = manager({
      loginPath: options.prefix === undefined ? `${nodeBin}:${prefix}/bin` : nodeBin,
      latest: { "@openai/codex": "0.170.0" },
      ...(options.engines ? { engines: options.engines } : {}),
      spawn: vi.fn<SpawnUpgrade>(() => {
        const child = new FakeUpgrade();
        children.push(child);
        return child;
      }),
    });
    const codex = (await made.clis.list()).find((item) => item.tool === "codex")!;
    return { ...made, children, codex, nodeBin, prefix, bin, script };
  }

  it("plans an install for missing tools and runs only the confirmed command", async () => {
    const { clis, codex, children, nodeBin, prefix, bin, script } = await setup();
    expect(codex).toMatchObject({
      status: "notInstalled",
      latest: "0.170.0",
      plan: {
        kind: "anchored",
        command: `PATH=${shellQuote(nodeBin)}:"$PATH" ${shellQuote(`${nodeBin}/npm`)} i -g @openai/codex@latest`,
      },
    });
    expect(codex.binNotOnPath).toBeUndefined();
    const command = (codex.plan as { command: string }).command;

    await expect(clis.start("codex", "install", `${command} && curl x | sh`)).rejects.toMatchObject(
      {
        code: "AGENT_CLI_PLAN_CHANGED",
      },
    );
    // 没装的不能走升级
    await expect(clis.start("codex", "upgrade", command)).rejects.toMatchObject({
      code: "AGENT_CLI_NOT_UPGRADABLE",
    });
    const job = await clis.start("codex", "install", command);
    expect(job).toMatchObject({ action: "install", state: "running", versionBefore: null });
    expect(clis.current()?.id).toBe(job.id);

    // 装好：命令落在全局 bin 目录，重新探测拿到版本
    const pkg = bin("global/lib/node_modules/@openai/codex/bin");
    const real = script(pkg, "codex.js", 'echo "codex-cli 0.170.0"');
    bin("global/bin");
    symlinkSync(real, path.join(prefix, "bin", "codex"));
    children[0]!.exit(0);
    await vi.waitFor(() => expect(clis.job(job.id)).toMatchObject({ versionAfter: "0.170.0" }));
    // 装过了再点安装就拒绝
    await expect(clis.start("codex", "install", command)).rejects.toMatchObject({
      code: "AGENT_CLI_ALREADY_INSTALLED",
    });
  });

  it("warns when npm's global bin isn't on PATH and refuses when Node is too old", async () => {
    const warned = await setup({ prefix: "/opt/elsewhere" });
    expect(warned.codex.binNotOnPath).toBe("/opt/elsewhere/bin");

    const old = await setup({ engines: { "@openai/codex": ">=24" } });
    expect(old.codex.nodeGap).toEqual({ required: ">=24", current: "22.1.0" });
    await expect(
      old.clis.start("codex", "install", (old.codex.plan as { command: string }).command),
    ).rejects.toMatchObject({ code: "AGENT_CLI_NODE_TOO_OLD" });
    expect(old.children).toHaveLength(0);
  });

  it("serves install and the current task over the local-owner routes", async () => {
    const { clis, codex, children } = await setup();
    const logs: string[] = [];
    const app = await buildApp({
      databasePath: ":memory:",
      token: "join-token",
      staticDir: "/definitely-not-present",
      logger: { level: "info", stream: { write: (line: string) => void logs.push(line) } },
      agentClis: clis,
      localAgents: {
        cli: { command: "/usr/bin/node", args: ["cli.js"] },
        serverUrl: "http://127.0.0.1:8787",
        spawn: vi.fn<SpawnAgent>(),
        probe: async () => ({ installed: true, version: "1.0.0" }),
      },
    });
    try {
      const session = (await app.inject({ method: "GET", url: "/api/local/session" })).json() as {
        ownerToken: string;
      };
      const owner = { "x-hive-owner": session.ownerToken };
      expect(
        (
          await app.inject({ method: "GET", url: "/api/local/agent-clis/current", headers: owner })
        ).json(),
      ).toEqual({ job: null });
      const started = await app.inject({
        method: "POST",
        url: "/api/local/agent-clis/codex/install",
        headers: owner,
        payload: { command: (codex.plan as { command: string }).command },
      });
      expect(started.statusCode).toBe(202);
      const current = await app.inject({
        method: "GET",
        url: "/api/local/agent-clis/current",
        headers: owner,
      });
      expect(current.json()).toMatchObject({ job: { action: "install", state: "running" } });
      expect(logs.filter((line) => line.includes('"agentCli"')).join()).toContain(
        '"action":"install"',
      );
      // 别的电脑、Agent 令牌都拒绝
      for (const call of [
        { method: "GET" as const, url: "/api/local/agent-clis/current" },
        {
          method: "POST" as const,
          url: "/api/local/agent-clis/codex/install",
          payload: { command: "x" },
        },
      ]) {
        expect(
          (await app.inject({ ...call, headers: { authorization: "Bearer join-token" } }))
            .statusCode,
        ).toBe(401);
        expect((await app.inject({ ...call, remoteAddress: "10.0.0.20" })).statusCode).toBe(403);
      }
      expect(children).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

describe("desktop bundled Node and npm", () => {
  function setup(options: { systemNpm?: boolean } = {}) {
    const { bin, script, root } = sandbox();
    const nodeBin = bin("SuperHive.app/Contents/Resources/node/bin");
    script(nodeBin, "node", 'echo "v24.22.3"');
    script(nodeBin, "npm", "exit 0");
    script(bin("SuperHive.app/Contents/Resources/node/lib/node_modules/npm/bin"), "npm-cli.js", "");
    const prefix = path.join(root, "Application Support/SuperHive/agent-clis");
    const system = bin("usr-local/bin");
    if (options.systemNpm) {
      script(system, "npm", `[ "$1" = prefix ] && echo "${root}/usr-local"; exit 0`);
      script(system, "node", 'echo "v22.1.0"');
    }
    const probes: Array<{ command: string; path: string | undefined }> = [];
    const spawnUpgrade = vi.fn<SpawnUpgrade>(() => new FakeUpgrade());
    const clis = new AgentCliManager({
      platform: "darwin",
      home: "/nonexistent-home",
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/nonexistent-home",
        SUPERHIVE_BUNDLED_NODE: path.join(nodeBin, "node"),
        SUPERHIVE_AGENT_CLIS_DIR: prefix,
      },
      loginPath: async () => `${system}:/usr/bin:/bin`,
      extraDirs: [],
      fetchJson: async (url: string) =>
        url.includes("dist-tags") ? { latest: "0.170.0" } : { engines: { node: ">=20" } },
      spawnUpgrade,
      runProbe: async (command, args, opts) => {
        probes.push({ command, path: opts.env.PATH });
        const { defaultRunProbe } = await import("./agent-clis.js");
        return defaultRunProbe(command, args, opts);
      },
    });
    return { clis, nodeBin, prefix, system, root, bin, script, probes, spawnUpgrade };
  }

  it("appends agent-clis and the bundled Node to the END of PATH, after the user's own", async () => {
    const { clis, nodeBin, prefix, system } = setup();
    expect(await clis.loginPath()).toBe(
      `${system}:/usr/bin:/bin:${path.join(prefix, "bin")}:${nodeBin}`,
    );
  });

  it("installs with the bundled npm into <userData>/agent-clis when there is no system npm", async () => {
    const { clis, nodeBin, prefix, bin, script, spawnUpgrade } = setup();
    const codex = (await clis.list()).find((item) => item.tool === "codex")!;
    const command = `PATH=${shellQuote(nodeBin)}:"$PATH" ${shellQuote(`${nodeBin}/npm`)} i -g --prefix ${shellQuote(prefix)} @openai/codex@latest`;
    expect(codex).toMatchObject({ status: "notInstalled", plan: { kind: "anchored", command } });
    // agent-clis/bin 已经在 PATH 里，不提示「装完不在 PATH 上」；Node 版本按自带的算
    expect(codex.binNotOnPath).toBeUndefined();
    expect(codex.nodeGap).toBeUndefined();
    await clis.start("codex", "install", command);
    expect(spawnUpgrade.mock.calls[0]![1].PATH).toMatch(new RegExp(`:${nodeBin}$`));

    // 装进 agent-clis 之后，重新探测能找到，并且升级也锚定到同一个前缀
    const pkg = bin("Application Support/SuperHive/agent-clis/lib/node_modules/@openai/codex/bin");
    const real = script(pkg, "codex.js", 'echo "codex-cli 0.169.0"');
    bin("Application Support/SuperHive/agent-clis/bin");
    symlinkSync(real, path.join(prefix, "bin", "codex"));
    const installed = (await clis.list(true)).find((item) => item.tool === "codex")!;
    expect(installed).toMatchObject({
      status: "ok",
      version: "0.169.0",
      plan: {
        kind: "anchored",
        command: `${shellQuote(`${nodeBin}/npm`)} i -g --prefix ${shellQuote(prefix)} @openai/codex@latest`,
      },
    });
  });

  it("fails an install whose CLI is found but won't run (npm silently dropped an optional package)", async () => {
    const { clis, nodeBin, prefix, bin, script, spawnUpgrade } = setup();
    const command = `PATH=${shellQuote(nodeBin)}:"$PATH" ${shellQuote(`${nodeBin}/npm`)} i -g --prefix ${shellQuote(prefix)} @openai/codex@latest`;
    await clis.list();
    const job = await clis.start("codex", "install", command);
    const pkg = bin("Application Support/SuperHive/agent-clis/lib/node_modules/@openai/codex/bin");
    const real = script(pkg, "codex.js", 'echo "native binary not installed" >&2; exit 1');
    bin("Application Support/SuperHive/agent-clis/bin");
    symlinkSync(real, path.join(prefix, "bin", "codex"));
    const child = spawnUpgrade.mock.results[0]!.value as FakeUpgrade;
    child.exit(0);
    await vi.waitFor(() =>
      expect(clis.job(job.id)).toMatchObject({
        state: "failed",
        reasonText: { key: "error.agentCli.installBroken" },
      }),
    );
  });

  it("keeps using the user's own npm (no --prefix) when one is installed", async () => {
    const { clis, system } = setup({ systemNpm: true });
    const codex = (await clis.list()).find((item) => item.tool === "codex")!;
    expect(codex.plan).toEqual({
      kind: "anchored",
      command: `PATH=${shellQuote(system)}:"$PATH" ${shellQuote(`${system}/npm`)} i -g @openai/codex@latest`,
    });
  });

  const bundled: BundledNpm = {
    node: "C:\\Users\\me\\AppData\\Local\\SuperHive\\app-0.5.0\\resources\\node\\node.exe",
    npm: "C:\\Users\\me\\AppData\\Local\\SuperHive\\app-0.5.0\\resources\\node\\npm.cmd",
    npmCli:
      "C:\\Users\\me\\AppData\\Local\\SuperHive\\app-0.5.0\\resources\\node\\node_modules\\npm\\bin\\npm-cli.js",
    prefix: "C:\\Users\\me\\AppData\\Roaming\\SuperHive\\agent-clis",
  };
  const win = { platform: "win32" as const, isExecutable: exists(), bundled };
  const winCommand = (pkg: string, args = "") =>
    `"${bundled.node}" "${bundled.npmCli}" i -g --prefix "${bundled.prefix}" ${pkg}@latest${args}`;

  it("lets Windows install npm tools with the bundled node.exe + npm-cli.js", () => {
    expect(planInstall("codex", win)).toEqual({
      kind: "anchored",
      command: winCommand("@openai/codex"),
    });
    expect(planInstall("claude", win)).toEqual({
      kind: "anchored",
      command: winCommand(
        "@anthropic-ai/claude-code",
        " --ignore-scripts=false --include=optional --allow-scripts=@anthropic-ai/claude-code",
      ),
    });
    // bun 脚本、不在 npm 上的、没有自带 npm 的（开发版、npm 版）、路径里有 cmd 会改写的字符：都不一键装
    for (const context of [
      win,
      { ...win, bundled: undefined },
      { ...win, bundled: { ...bundled, prefix: "C:\\Users\\100%\\agent-clis" } },
    ]) {
      // 还没装的说「安装」，不说「升级」
      expect(planInstall(context === win ? "omp" : "codex", context)).toMatchObject({
        kind: "manual",
        reason: "Windows 上暂不支持一键安装，请按官方说明安装",
        reasonText: { key: "agentCli.manual.windowsInstall" },
      });
    }
    expect(planInstall("agy", win)).toMatchObject({
      kind: "manual",
      reasonText: { key: "agentCli.manual.windowsInstall" },
    });
  });

  it("on Windows names agent-clis as the install dir for every npm tool and knows it is on PATH", async () => {
    const lowerWin = (file: string) => file.toLowerCase();
    const clis = new AgentCliManager({
      platform: "win32",
      home: "C:\\Users\\me",
      env: {
        Path: "C:\\Windows\\system32;C:\\Users\\me\\AppData\\Roaming\\npm",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        SUPERHIVE_BUNDLED_NODE: bundled.node,
        SUPERHIVE_AGENT_CLIS_DIR: bundled.prefix,
      },
      isExecutable: (file) => [bundled.node, bundled.npmCli].map(lowerWin).includes(lowerWin(file)),
      fetchJson: async (url: string) => (url.includes("dist-tags") ? { latest: "1.0.0" } : {}),
      runProbe: async () => ({ code: 0, stdout: "v24.22.3\n", stderr: "" }),
    });
    // 桌面端把 agent-clis 追加在 PATH 末尾，本机 Agent 直接找得到；以前按「:」切 Windows 的 PATH，
    // 每一项都误报「不在 PATH 里」，Claude Code、OpenCode 还报成官方脚本的目录（Windows 上并不跑脚本）
    const tools = await clis.list();
    for (const tool of ["codex", "claude", "opencode", "gemini"] as const) {
      const info = tools.find((item) => item.tool === tool)!;
      expect(info.plan).toMatchObject({
        kind: "anchored",
        command: expect.stringContaining(`--prefix "${bundled.prefix}"`),
      });
      expect(info.binNotOnPath).toBeUndefined();
    }
  });

  it("matches PATH entries per platform: ';' and case-insensitive on Windows, ':' elsewhere", () => {
    const prefix = "C:\\Users\\me\\AppData\\Roaming\\SuperHive\\agent-clis";
    expect(pathHasDir(`C:\\Windows;${prefix.toUpperCase()}\\`, prefix, "win32")).toBe(true);
    expect(
      pathHasDir("C:\\Windows;C:/Users/me/AppData/Roaming/SuperHive/agent-clis", prefix, "win32"),
    ).toBe(true);
    expect(pathHasDir("C:\\Windows;C:\\Users\\me\\AppData\\Roaming\\npm", prefix, "win32")).toBe(
      false,
    );
    expect(pathHasDir("/usr/bin:/opt/x/bin/", "/opt/x/bin", "darwin")).toBe(true);
    expect(pathHasDir("/usr/bin:/opt/X/bin", "/opt/x/bin", "darwin")).toBe(false);
  });

  it("upgrades on Windows only what lives in agent-clis", () => {
    const at = (file: string) => ({ path: file, realPath: file, source: inferSource(file, file) });
    expect(planUpdate("codex", at(`${bundled.prefix.toUpperCase()}\\codex.cmd`), win)).toEqual({
      kind: "anchored",
      command: winCommand("@openai/codex"),
    });
    expect(
      planUpdate("codex", at("C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd"), win),
    ).toMatchObject({ kind: "manual", reasonText: { key: "agentCli.manual.windows" } });
  });

  it("replaces every spelling of PATH on Windows", () => {
    expect(withPath({ Path: "a", path: "b", X: "1" }, "c", "win32")).toEqual({ Path: "c", X: "1" });
    expect(withPath({ PATH: "a" }, "c", "darwin")).toEqual({ PATH: "c" });
  });
});

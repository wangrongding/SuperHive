/**
 * Electron Forge 配置。scripts/stage.mjs 把它复制进 .stage/app，Forge 在那里打包
 * （`electron-forge package .stage/app`），所以这里的路径都相对 .stage/app。
 *
 * 需要证书或对外发布的部分（代码签名、公证、自动更新、发布到 GitHub Release）这次都没开，
 * 位置留在下面的 TODO 里，见 apps/desktop/README.md「发布前要准备的」。
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");
const { prune: pruneNatives } = require("./prune-natives.cjs");

// scripts/forge.mjs 传进来；Forge 加载配置时 __dirname 不一定是 .stage/app
const desktopDir = process.env.SUPERHIVE_DESKTOP_DIR ?? path.resolve(__dirname, "../..");
const { version } = require(path.join(desktopDir, "package.json"));

/**
 * 自带的 Node 运行时（scripts/stage.mjs 下载并校验好的 .stage/node），打包后在 resources/node。
 * 缺了就不打包：没有它的桌面端会让没装 Node 的用户跑不起 npm 装的 CLI。
 * 只有显式设了 SUPERHIVE_SKIP_BUNDLED_NODE=1（离线开发）才放行。
 */
const bundledNodeDir = path.join(desktopDir, ".stage", "node");
const hasBundledNode = fs.existsSync(path.join(bundledNodeDir, ".superhive-node"));
function assertBundledNode() {
  if (hasBundledNode || process.env.SUPERHIVE_SKIP_BUNDLED_NODE === "1") return;
  throw new Error(`Bundled Node runtime missing: ${bundledNodeDir}. Run scripts/stage.mjs first.`);
}

/** Windows 安装包文件名带版本和架构，和 Release 上的文件名一致，不用再手动改名 */
function setupExeName(arch) {
  return `SuperHive-${version}-win-${arch}-Setup.exe`;
}

/**
 * Mac：打包后把整个 .app 重新 ad-hoc 签一遍。fuses 插件只重签了主程序，Info.plist 和资源的封印对不上
 * （codesign --verify 报 invalid Info.plist）；这样的包从网页下载后经用户「仍要打开」能用，但应用内更新换上去的
 * 新版本不带 quarantine，系统会直接拒绝打开（LaunchServices -54）。有了 Developer ID 后换成 osxSign。
 */
function adHocSign(outputPaths) {
  for (const dir of outputPaths) {
    const app = path.join(dir, "SuperHive.app");
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
    execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  }
}

module.exports = {
  outDir: path.join(desktopDir, "out"),
  packagerConfig: {
    name: "SuperHive",
    executableName: process.platform === "linux" ? "superhive" : "SuperHive",
    appBundleId: "dev.superhive.desktop",
    appCategoryType: "public.app-category.developer-tools",
    // Mac 的 Info.plist 里声明 superhive:// 链接（打开别人的邀请、带 Agent 加入）；Windows 由主进程启动时注册
    protocols: [{ name: "SuperHive", schemes: ["superhive"] }],
    icon: path.join(desktopDir, "build/icon"),
    // 复制到 Resources/node（Mac）、resources/node（Windows），在 asar 外面、可以直接执行
    extraResource: hasBundledNode ? [bundledNodeDir] : [],
    // 原生模块和 node-pty 的 spawn-helper 必须放在 asar 外面才能加载 / 执行
    asar: {
      unpack: "**/{*.node,spawn-helper,winpty-agent.exe,winpty.dll,conpty.dll,OpenConsole.exe}",
    },
    // 运行时依赖在 stage 里已经是 npm 装好的生产依赖，不用再裁剪
    prune: false,
    ignore: [/^\/forge\.config\.cjs$/, /^\/prune-natives\.cjs$/, /^\/out($|\/)/, /\.map$/],
    // 原生模块只留目标平台的预编译，去掉调试符号和 C++ 源码
    afterCopy: [pruneNatives],
    // TODO(签名)：osxSign: {}、osxNotarize: { appleId, appleIdPassword, teamId }，需要 Apple Developer 证书
    // TODO(签名)：Windows 用 windowsSign（证书或 Azure Trusted Signing）
  },
  rebuildConfig: {
    // better-sqlite3 13 和 node-pty 都是 N-API 预编译包；只有 Linux 上的 node-pty 要按 Electron 编
    onlyModules: process.platform === "linux" ? ["node-pty"] : [],
  },
  makers: [
    { name: "@electron-forge/maker-dmg", platforms: ["darwin"], config: { format: "ULFO" } },
    { name: "@electron-forge/maker-zip", platforms: ["darwin", "linux", "win32"] },
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      // config 写成函数：Forge 按目标架构调用（maker-base 的 prepareConfig）
      config: (arch) => ({ name: "SuperHive", setupExe: setupExeName(arch) }),
    },
    {
      name: "@electron-forge/maker-deb",
      platforms: ["linux"],
      config: {
        options: { name: "superhive", productName: "SuperHive", categories: ["Development"] },
      },
    },
    {
      name: "@electron-forge/maker-rpm",
      platforms: ["linux"],
      config: {
        options: { name: "superhive", productName: "SuperHive", categories: ["Development"] },
      },
    },
  ],
  // TODO(发布)：publishers: [{ name: "@electron-forge/publisher-github", config: { repository: { owner, name }, draft: true } }]
  // 应用内更新：Windows 用 autoUpdater（Squirrel，读 Release 里的 RELEASES 和 -full.nupkg），
  // Mac 下载 Release 里 maker-zip 打的 SuperHive-darwin-arm64-<版本>.zip 自己替换 .app（src/mac-update.ts）。
  // 发版要上传的文件用 `pnpm --filter @superhive/desktop release-assets` 收集，见 docs/research/desktop-auto-update.md
  hooks: {
    prePackage: async () => assertBundledNode(),
    postPackage: async (_config, { platform, outputPaths }) => {
      if (platform === "darwin") adHocSign(outputPaths);
    },
  },
  plugins: [
    new FusesPlugin({
      version: FuseVersion.V1,
      // Electron 不能被当成任意 Node 用；本机 Agent 走 --superhive-cli，只跑包里的 CLI
      [FuseV1Options.RunAsNode]: false,
      // Windows 用 DPAPI 真加密；Mac 上主进程加了 use-mock-keychain，密钥固定、不碰钥匙串（src/keychain.ts）
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    }),
  ],
};

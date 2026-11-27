/**
 * macOS 上不让 Chromium 碰系统钥匙串。
 *
 * 打包时开了 EnableCookieEncryption fuse，Chromium 一启动就去钥匙串读「SuperHive Safe Storage」，
 * 拿它当 cookie 的加密密钥。我们的 Mac 包是 ad-hoc 签名，钥匙串按 cdhash 认程序，每次构建都不一样，
 * 所以每装一个新版本（手动覆盖或应用内更新）都会弹框要登录密码。
 *
 * 桌面端没有要靠钥匙串保护的数据：网页的登录凭据（本机房主、别人服务器的访客）都在 localStorage，
 * Server 不发 cookie，也没用 Electron safeStorage、密码自动填充。所以在 Mac 上加 Chromium 的
 * use-mock-keychain：cookie 照样按原格式加密，只是密钥固定、不读写钥匙串。
 * - localStorage、IndexedDB 本来就不加密，升级前后照常能读；
 * - 旧版用钥匙串密钥加密的 cookie 解不开，Chromium 会直接丢掉，不报错（我们没有要留的 cookie）。
 *
 * 以后要存真正的机密（safeStorage），得先有固定的签名身份（Developer ID），再去掉这个开关；
 * keychain.test.ts 会拦住在开关还在时用 safeStorage。Windows 走 DPAPI，不弹框，Linux 不变。
 */
export const MOCK_KEYCHAIN_SWITCH = "use-mock-keychain";

/** 要在 Chromium 第一次用到加密存储之前（app ready 之前）加上的命令行开关 */
export function keychainSwitches(platform: NodeJS.Platform): string[] {
  return platform === "darwin" ? [MOCK_KEYCHAIN_SWITCH] : [];
}

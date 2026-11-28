// 宣传截图的演示数据：演示仓库里的源码（两步验证改动前后）、Agent 交回的两份报告，以及两张界面设计稿的 HTML。
// 设计稿由 stills.mjs 用无头 Chrome 渲染成 PNG，不放二进制文件进仓库。

const LOGIN_BEFORE = `import { verifyPassword } from "./password";
import { createSession } from "./session";
import { limitByPhone } from "./rate-limit";
import { findUserByPhone } from "../db/users";

export type LoginResult =
  | { ok: true; token: string }
  | { ok: false; status: 401 | 429; error: string };

export async function login(phone: string, password: string): Promise<LoginResult> {
  if (await limitByPhone(phone)) return { ok: false, status: 429, error: "rate_limited" };

  const user = await findUserByPhone(phone);
  if (!user || !(await verifyPassword(user, password)))
    return { ok: false, status: 401, error: "invalid_credentials" };

  return { ok: true, token: await createSession(user) };
}
`;

const LOGIN_AFTER = `import { verifyPassword } from "./password";
import { createPendingSession, createSession, resolvePendingSession } from "./session";
import { limitByPhone } from "./rate-limit";
import { verifyTotp } from "./totp";
import { consumeBackupCode } from "./backup-codes";
import { findUserByPhone } from "../db/users";

export type LoginResult =
  | { ok: true; token: string }
  | { ok: true; step: "totp"; pendingToken: string }
  | { ok: false; status: 401 | 429; error: string };

/** 待验证令牌的有效期：输完密码后 5 分钟内要过第二步 */
const PENDING_TTL_SECONDS = 5 * 60;

export async function login(phone: string, password: string): Promise<LoginResult> {
  if (await limitByPhone(phone)) return { ok: false, status: 429, error: "rate_limited" };

  const user = await findUserByPhone(phone);
  if (!user || !(await verifyPassword(user, password)))
    return { ok: false, status: 401, error: "invalid_credentials" };

  // 开启了两步验证：先发待验证令牌，校验动态码后才换成正式会话
  if (user.totpSecret)
    return {
      ok: true,
      step: "totp",
      pendingToken: await createPendingSession(user, PENDING_TTL_SECONDS),
    };

  return { ok: true, token: await createSession(user) };
}

/** 第二步：6 位动态码，或者一次性备用码（xxxx-xxxx） */
export async function verifySecondFactor(pendingToken: string, code: string): Promise<LoginResult> {
  const user = await resolvePendingSession(pendingToken);
  if (!user?.totpSecret) return { ok: false, status: 401, error: "pending_expired" };
  // 和登录共用一套限流，动态码不能被暴力枚举
  if (await limitByPhone(user.phone)) return { ok: false, status: 429, error: "rate_limited" };

  const valid = /^\\d{6}$/.test(code)
    ? verifyTotp(user.totpSecret, code, { window: 1 })
    : await consumeBackupCode(user.id, code);
  if (!valid) return { ok: false, status: 401, error: "invalid_code" };

  return { ok: true, token: await createSession(user) };
}
`;

const SESSION_BEFORE = `import { randomBytes } from "node:crypto";
import { sessions } from "../db/sessions";
import type { User } from "../db/users";

const SESSION_TTL_SECONDS = 7 * 24 * 3600;

export async function createSession(user: User): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await sessions.insert({ token, userId: user.id, expiresIn: SESSION_TTL_SECONDS });
  return token;
}
`;

const SESSION_REFRESH = `${SESSION_BEFORE}
/** 快过期时刷新：同一个令牌并发刷新只换一次，其余请求拿到同一个新令牌 */
const refreshing = new Map<string, Promise<string>>();

export function refreshSession(token: string): Promise<string> {
  let pending = refreshing.get(token);
  if (!pending) {
    pending = sessions.rotate(token, SESSION_TTL_SECONDS).finally(() => refreshing.delete(token));
    refreshing.set(token, pending);
  }
  return pending;
}
`;

const SESSION_AFTER = `${SESSION_REFRESH}
/** 输完密码、还没过第二步时的临时令牌：只能用来提交动态码 */
export async function createPendingSession(user: User, ttlSeconds: number): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await sessions.insert({ token, userId: user.id, expiresIn: ttlSeconds, pending: true });
  return token;
}

export async function resolvePendingSession(token: string): Promise<User | undefined> {
  const row = await sessions.take(token, { pending: true });
  return row?.user;
}
`;

const TOTP = `import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { base32Decode, base32Encode } from "./base32";

/** RFC 6238 的默认参数：30 秒一个时间窗、6 位、HMAC-SHA1（主流验证器 App 都支持） */
const STEP_SECONDS = 30;
const DIGITS = 6;

/** 绑定时生成 160 位密钥，返回 base32 文本 */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** 验证器 App 扫的二维码内容 */
export function otpauthUrl(secret: string, account: string, issuer = "Web"): string {
  const label = encodeURIComponent(\`\${issuer}:\${account}\`);
  return \`otpauth://totp/\${label}?secret=\${secret}&issuer=\${encodeURIComponent(issuer)}\`;
}

/** 第 counter 个时间窗的动态码：HMAC 后动态截断，取低 6 位 */
export function totpAt(secret: string, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return code.toString().padStart(DIGITS, "0");
}

/** 允许前后各 window 个时间窗的时钟偏差；逐字节比较用 timingSafeEqual，防计时攻击 */
export function verifyTotp(
  secret: string,
  code: string,
  { window = 1, now = Date.now() }: { window?: number; now?: number } = {},
): boolean {
  if (!/^\\d{6}$/.test(code)) return false;
  const counter = Math.floor(now / 1000 / STEP_SECONDS);
  for (let drift = -window; drift <= window; drift++) {
    if (timingSafeEqual(Buffer.from(totpAt(secret, counter + drift)), Buffer.from(code)))
      return true;
  }
  return false;
}
`;

// codex-3 review 后改的：同一个时间窗的动态码只能用一次
const TOTP_REVIEWED = TOTP.replace(
  `/** 允许前后各 window 个时间窗的时钟偏差；逐字节比较用 timingSafeEqual，防计时攻击 */
export function verifyTotp(
  secret: string,
  code: string,
  { window = 1, now = Date.now() }: { window?: number; now?: number } = {},
): boolean {
  if (!/^\\d{6}$/.test(code)) return false;
  const counter = Math.floor(now / 1000 / STEP_SECONDS);
  for (let drift = -window; drift <= window; drift++) {
    if (timingSafeEqual(Buffer.from(totpAt(secret, counter + drift)), Buffer.from(code)))
      return true;
  }
  return false;
}`,
  `/**
 * 允许前后各 window 个时间窗的时钟偏差；逐字节比较用 timingSafeEqual，防计时攻击。
 * lastCounter 是上次用过的时间窗：同一个动态码不能用第二次（防重放），通过时返回这次的时间窗。
 */
export function verifyTotp(
  secret: string,
  code: string,
  {
    window = 1,
    now = Date.now(),
    lastCounter = -1,
  }: { window?: number; now?: number; lastCounter?: number } = {},
): number | false {
  if (!/^\\d{6}$/.test(code)) return false;
  const counter = Math.floor(now / 1000 / STEP_SECONDS);
  for (let drift = -window; drift <= window; drift++) {
    const candidate = counter + drift;
    if (candidate <= lastCounter) continue;
    if (timingSafeEqual(Buffer.from(totpAt(secret, candidate)), Buffer.from(code)))
      return candidate;
  }
  return false;
}`,
);

const BACKUP_CODES = `import { createHash, randomInt } from "node:crypto";
import { backupCodes } from "../db/backup-codes";

const COUNT = 10;
// 去掉容易看错的 0/O、1/I/L
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

const hash = (code: string) =>
  createHash("sha256").update(code.replace("-", "").toUpperCase()).digest("hex");

function randomCode(): string {
  const chars = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return \`\${chars.slice(0, 4).join("")}-\${chars.slice(4).join("")}\`;
}

/** 重新生成一组备用码：旧的全部作废；明文只返回这一次，库里只存哈希 */
export async function regenerateBackupCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: COUNT }, randomCode);
  await backupCodes.replaceAll(userId, codes.map(hash));
  return codes;
}

/** 用掉一个备用码：存在且没用过才通过，通过后立刻作废 */
export async function consumeBackupCode(userId: string, code: string): Promise<boolean> {
  return backupCodes.markUsed(userId, hash(code));
}

export const remainingBackupCodes = (userId: string) => backupCodes.countUnused(userId);
`;

const TOTP_TEST = `import { describe, expect, it } from "vitest";
import { generateSecret, otpauthUrl, totpAt, verifyTotp } from "./totp";

// RFC 6238 附录 B 的测试密钥（"12345678901234567890" 的 base32）
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totpAt", () => {
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])("RFC 6238 向量：%i 秒 → %s", (seconds, code) => {
    expect(totpAt(RFC_SECRET, Math.floor(seconds / 30))).toBe(code);
  });
});

describe("verifyTotp", () => {
  const now = 1_764_230_400_000;
  const code = totpAt(RFC_SECRET, Math.floor(now / 30_000));

  it("当前时间窗的动态码通过", () => {
    expect(verifyTotp(RFC_SECRET, code, { now })).toBeTruthy();
  });

  it("允许前后各差 30 秒", () => {
    expect(verifyTotp(RFC_SECRET, code, { now: now + 30_000 })).toBeTruthy();
    expect(verifyTotp(RFC_SECRET, code, { now: now - 30_000 })).toBeTruthy();
  });

  it("超过一个时间窗就拒绝", () => {
    expect(verifyTotp(RFC_SECRET, code, { now: now + 61_000 })).toBe(false);
  });

  it("不是 6 位数字直接拒绝", () => {
    for (const bad of ["", "12345", "1234567", "12a456", " 123456"])
      expect(verifyTotp(RFC_SECRET, bad, { now })).toBe(false);
  });
});

describe("generateSecret", () => {
  it("160 位、base32，每次都不一样", () => {
    const a = generateSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateSecret()).not.toBe(a);
  });

  it("二维码内容带上账号和签发方", () => {
    expect(otpauthUrl("ABC", "lin@example.com")).toBe(
      "otpauth://totp/Web%3Alin%40example.com?secret=ABC&issuer=Web",
    );
  });
});
`;

export const AUTH_FILES = {
  base: {
    "README.md": "# web\n\n控制台前后端。\n\n```sh\npnpm install\npnpm dev\n```\n",
    "package.json": `{
  "name": "web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "test": "vitest run",
    "e2e": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0",
    "vitest": "^3.1.0"
  }
}
`,
    "src/auth/login.ts": LOGIN_BEFORE,
    "src/auth/password.ts": `import { verify } from "@node-rs/argon2";
import type { User } from "../db/users";

export const verifyPassword = (user: User, password: string) => verify(user.passwordHash, password);
`,
    "src/auth/session.ts": SESSION_BEFORE,
    "src/auth/base32.ts": `const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits ? out + ALPHABET[(value << (5 - bits)) & 31] : out;
}

export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.replace(/=+$/, "")) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
`,
    "src/db/users.ts": `export type User = {
  id: string;
  phone: string;
  passwordHash: string;
  totpSecret?: string;
};

export declare function findUserByPhone(phone: string): Promise<User | undefined>;
`,
    "src/settings/SecurityPage.tsx": `export function SecurityPage() {
  return (
    <section className="settings-section">
      <h2>安全设置</h2>
      <PasswordRow />
      <DevicesRow />
    </section>
  );
}
`,
    "docs/auth.md": "# 登录\n\n手机号 + 密码。\n",
    "e2e/login.spec.ts": `import { expect, test } from "@playwright/test";

test("手机号密码登录", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("手机号").fill("13800000000");
  await page.getByLabel("密码").fill("correct horse");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("控制台")).toBeVisible();
});
`,
    "vitest.config.ts": `import { defineConfig } from "vitest/config";

export default defineConfig({ test: { environment: "node", coverage: { provider: "v8" } } });
`,
  },
  rateLimit: `import { redis } from "../db/redis";

/** 同一个手机号 1 分钟最多 5 次，超出返回 true */
export async function limitByPhone(phone: string): Promise<boolean> {
  const key = \`login:\${phone}\`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60);
  return count > 5;
}
`,
  session: SESSION_REFRESH,
  sessionAfter: SESSION_AFTER,
  docs: `# 登录

手机号 + 密码登录，成功后返回 7 天有效的会话令牌。

## 错误码

| 状态 | error | 说明 |
| --- | --- | --- |
| 401 | invalid_credentials | 手机号或密码不对 |
| 429 | rate_limited | 1 分钟内超过 5 次 |
`,
  packageJson: `{
  "name": "web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "test": "vitest run",
    "e2e": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0",
    "vitest": "^3.2.4"
  }
}
`,
  totp: TOTP,
  totpReviewed: TOTP_REVIEWED,
  backupCodes: BACKUP_CODES,
  loginAfter: LOGIN_AFTER,
  totpTest: TOTP_TEST,
};

export const REPORTS = {
  authDoc: `# 登录与会话接口说明

## POST /api/auth/login

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| phone | string | 手机号 |
| password | string | 密码 |

成功返回 \`{ token }\`，7 天有效。

## POST /api/auth/refresh

快过期时刷新；同一个令牌并发刷新只换一次，其余请求拿到同一个新令牌。

## 限流

同一个手机号 1 分钟最多 5 次，超出返回 429。

## 错误码

| 状态 | error | 说明 |
| --- | --- | --- |
| 401 | invalid_credentials | 手机号或密码不对 |
| 429 | rate_limited | 1 分钟内超过 5 次 |

## 两步验证

（待补）
`,
  research: `# TOTP 方案调研

> 结论：按 RFC 6238 自己实现（约 60 行），接口照 otplib 的设计；不引入新依赖。

## 候选

| 方案 | 维护状态 | 体积 | 时钟偏差 | 备注 |
| --- | --- | --- | --- | --- |
| 自己实现 | — | 0 | 自己控制 | 标准简单，有 RFC 测试向量可对 |
| otplib | 活跃，近 3 个月有发版 | ~9 KB | \`window\` 参数 | API 清楚，可作参考 |
| speakeasy | 6 年没更新 | ~22 KB | \`window\` 参数 | 有未修的 issue，不建议 |

## 参数

- **算法**：HMAC-SHA1，30 秒一个时间窗，6 位。Google Authenticator、1Password、Authy 都支持。
- **时间窗**：校验时允许前后各 1 个（±30 秒），覆盖手机时钟偏差；再大会降低安全性。
- **密钥**：160 位随机数，base32 编码；库里加密存储，不进日志。

## 备用码

- 10 个，\`xxxx-xxxx\`，去掉 0/O、1/I/L 这些容易看错的字符。
- 只存 SHA-256，用过即作废；重新生成时旧的全部作废。

## 风险

1. 同一个动态码在 30 秒内可能被重放 → 记下最后一次用过的时间窗。
2. 动态码只有 100 万种组合 → 必须和登录共用限流。
`,
  review: `# 两步验证安全 review

范围：\`feat/codex-1-two-factor\` 的 \`totp.ts\`、\`backup-codes.ts\`、\`login.ts\`、\`session.ts\`。

## 结果

| # | 检查项 | 结果 |
| --- | --- | --- |
| 1 | 密钥 160 位、用 \`crypto.randomBytes\` | ✅ 通过 |
| 2 | 比较动态码用 \`timingSafeEqual\` | ✅ 通过 |
| 3 | 第二步和登录共用限流 | ✅ 通过 |
| 4 | 备用码只存哈希、用过即作废 | ✅ 通过 |
| 5 | 待验证令牌 5 分钟过期、只能提交动态码 | ✅ 通过 |
| 6 | 日志里不打密钥和动态码 | ✅ 通过 |
| 7 | 同一个动态码不能用第二次 | ⚠️ 已修改 |

## 第 7 项

30 秒内同一个动态码能登录两次：被人肩窥或截屏后可以重放。

**修改**：\`verifyTotp\` 增加 \`lastCounter\`，通过时返回这次的时间窗，登录成功后存到用户上；比它早或相等的时间窗一律拒绝。

\`\`\`ts
if (candidate <= lastCounter) continue;
\`\`\`

## 建议（不阻塞合入）

- 关闭两步验证时要求再输一次动态码。
- 备用码剩 2 个以下时，在安全设置里提示重新生成。
`,
};

const FONT = `-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Segoe UI", sans-serif`;

/** 演示用的二维码：确定性的伪随机方块（不是可扫的码），三个角放定位图案 */
function fakeQr(size, modules = 29) {
  const cell = size / modules;
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const finder = (x, y) =>
    `<rect x="${x * cell}" y="${y * cell}" width="${7 * cell}" height="${7 * cell}" fill="#111"/>
     <rect x="${(x + 1) * cell}" y="${(y + 1) * cell}" width="${5 * cell}" height="${5 * cell}" fill="#fff"/>
     <rect x="${(x + 2) * cell}" y="${(y + 2) * cell}" width="${3 * cell}" height="${3 * cell}" fill="#111"/>`;
  const inFinder = (x, y) =>
    (x < 8 && y < 8) || (x >= modules - 8 && y < 8) || (x < 8 && y >= modules - 8);
  let rects = "";
  for (let y = 0; y < modules; y++)
    for (let x = 0; x < modules; x++)
      if (!inFinder(x, y) && rand() > 0.52)
        rects += `<rect x="${x * cell}" y="${y * cell}" width="${cell + 0.3}" height="${cell + 0.3}" fill="#111"/>`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="#fff"/>${rects}${finder(0, 0)}${finder(modules - 7, 0)}${finder(0, modules - 7)}</svg>`;
}

const page = (
  width,
  height,
  body,
  style,
) => `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:${width}px;height:${height}px;font-family:${FONT};color:#1d1f24;background:#eef1f5}
${style}</style></head><body>${body}</body></html>`;

/** 安全设置里的「绑定两步验证」：三步，停在第 3 步（备用码） */
export function setupHtml() {
  const codes = [
    "K7PM-3QXR",
    "9WDF-H2TN",
    "R4BZ-8MKC",
    "T6JV-Q9PE",
    "2HXN-5RWA",
    "M8CG-K3VY",
    "P5ES-7DJH",
    "X3UF-6NBQ",
    "B9KW-4TZM",
    "H2RY-8VCP",
  ];
  return page(
    1200,
    760,
    `<div class="win">
      <aside><div class="logo">◆ 控制台</div>
        <a>概览</a><a>项目</a><a>成员</a><a class="on">安全设置</a><a>账单</a></aside>
      <main>
        <h1>两步验证</h1>
        <p class="sub">登录时除了密码，还要输入验证器 App 里的 6 位动态码。</p>
        <ol class="steps"><li class="done"><b>✓</b>扫码绑定</li><li class="done"><b>✓</b>输入动态码</li><li class="on"><b>3</b>保存备用码</li></ol>
        <div class="grid">
          <div class="card qr">
            <div class="qrbox">${fakeQr(200)}</div>
            <div class="manual">扫不了码？手动输入密钥<code>GEZD GNBV GY3T QOJQ</code></div>
          </div>
          <div class="card">
            <h2>备用码</h2>
            <p class="hint">手机丢了时用来登录。每个只能用一次，请保存在安全的地方。</p>
            <div class="codes">${codes.map((code) => `<span>${code}</span>`).join("")}</div>
            <div class="row"><button class="ghost">↓ 下载 .txt</button><button class="ghost">复制</button></div>
            <label class="check"><i>✓</i>我已保存这些备用码</label>
            <button class="primary">完成</button>
          </div>
        </div>
      </main>
    </div>`,
    `.win{display:flex;height:100%}
    aside{width:200px;background:#fff;border-right:1px solid #e3e6eb;padding:22px 14px;display:flex;flex-direction:column;gap:4px}
    .logo{font-weight:700;font-size:17px;margin:0 8px 18px;color:#2b5cff}
    aside a{padding:9px 10px;border-radius:8px;color:#596070;font-size:14px}aside a.on{background:#edf2ff;color:#2b5cff;font-weight:600}
    main{flex:1;padding:34px 44px}
    h1{margin:0;font-size:26px}.sub{margin:6px 0 22px;color:#6b7280;font-size:14px}
    .steps{display:flex;gap:28px;list-style:none;padding:0;margin:0 0 24px;font-size:14px;color:#6b7280}
    .steps li{display:flex;align-items:center;gap:8px}.steps b{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:12px;background:#e5e7eb;color:#6b7280}
    .steps li.done b{background:#dcfce7;color:#15803d}.steps li.on{color:#1d1f24;font-weight:600}.steps li.on b{background:#2b5cff;color:#fff}
    .grid{display:grid;grid-template-columns:300px 1fr;gap:22px}
    .card{background:#fff;border:1px solid #e3e6eb;border-radius:14px;padding:22px 24px}
    .qr{display:flex;flex-direction:column;align-items:center;gap:16px}.qrbox{padding:12px;border:1px solid #e3e6eb;border-radius:10px}
    .manual{font-size:14px;color:#596070;text-align:center;line-height:1.7}.manual code{display:block;font:600 14px ui-monospace,Menlo,monospace;color:#1d1f24;letter-spacing:1px}
    h2{margin:0 0 6px;font-size:18px}.hint{margin:0 0 16px;color:#6b7280;font-size:13.5px}
    .codes{display:grid;grid-template-columns:repeat(2,1fr);gap:8px 14px;background:#f6f7f9;border-radius:10px;padding:16px 18px;font:600 15px ui-monospace,Menlo,monospace;letter-spacing:1px}
    .row{display:flex;gap:10px;margin:14px 0}
    button{font:600 14px ${FONT};border-radius:9px;padding:9px 16px;border:1px solid #d5d9e0;background:#fff;color:#1d1f24}
    .check{display:flex;align-items:center;gap:8px;font-size:14px;margin:4px 0 16px}.check i{width:18px;height:18px;border-radius:5px;background:#2b5cff;color:#fff;font-style:normal;font-size:12px;display:grid;place-items:center}
    .primary{background:#2b5cff;border-color:#2b5cff;color:#fff;padding:10px 28px}`,
  );
}

/** 登录第二步：输入 6 位动态码 */
export function promptHtml() {
  const digits = ["4", "8", "2", "1", "", ""];
  return page(
    1200,
    760,
    `<div class="wrap"><div class="card">
      <div class="logo">◆ 控制台</div>
      <h1>输入动态码</h1>
      <p>打开验证器 App，输入「Web」下显示的 6 位数字。</p>
      <div class="otp">${digits.map((d, i) => `<span class="${i === 4 ? "focus" : ""}">${d}</span>`).join("")}</div>
      <button>验证并登录</button>
      <div class="foot"><a>用备用码登录</a><span>·</span><a>返回</a></div>
      <div class="timer"><i style="--p:62%"></i>动态码 18 秒后刷新</div>
    </div></div>`,
    `.wrap{height:100%;display:grid;place-items:center;background:radial-gradient(circle at 30% 20%,#e3ebff,#eef1f5 60%)}
    .card{width:440px;background:#fff;border-radius:18px;box-shadow:0 12px 40px rgba(30,50,100,.12);padding:38px 40px;text-align:center}
    .logo{font-weight:700;color:#2b5cff;font-size:17px;margin-bottom:22px}
    h1{margin:0 0 8px;font-size:24px}p{margin:0 0 26px;color:#6b7280;font-size:14px}
    .otp{display:flex;gap:10px;justify-content:center;margin-bottom:24px}
    .otp span{width:50px;height:60px;border:1.5px solid #d5d9e0;border-radius:11px;display:grid;place-items:center;font:600 26px ui-monospace,Menlo,monospace}
    .otp span.focus{border-color:#2b5cff;box-shadow:0 0 0 4px rgba(43,92,255,.15)}
    button{width:100%;border:0;border-radius:11px;background:#2b5cff;color:#fff;font:600 15px ${FONT};padding:13px}
    .foot{margin-top:18px;font-size:14px;color:#9aa0aa;display:flex;gap:10px;justify-content:center}.foot a{color:#2b5cff}
    .timer{margin-top:22px;font-size:12.5px;color:#9aa0aa;display:flex;align-items:center;gap:8px;justify-content:center}
    .timer i{width:80px;height:4px;border-radius:2px;background:linear-gradient(90deg,#2b5cff var(--p),#e5e7eb var(--p))}`,
  );
}

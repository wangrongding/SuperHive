import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * IM 凭据（飞书 App Secret、微信登录令牌）的本机加密：AES-256-GCM，密钥单独存在数据目录下
 * 只有当前用户可读的文件里，数据库里只有密文。拿到数据库文件不等于拿到凭据；
 * 密钥和数据库都被拿走时防不住，这与本机其它凭据（join token）处于同一信任边界。
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("secret key must be 32 bytes");
    this.key = key;
  }

  /** 读取或生成密钥文件（0600）。内存数据库（测试）传 undefined 时用随机密钥 */
  static open(keyPath: string | undefined): SecretBox {
    if (!keyPath) return new SecretBox(randomBytes(32));
    if (existsSync(keyPath)) {
      const raw = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
      return new SecretBox(raw);
    }
    mkdirSync(path.dirname(keyPath), { recursive: true });
    const key = randomBytes(32);
    writeFileSync(keyPath, key.toString("base64"), { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    return new SecretBox(key);
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return [
      "v1",
      iv.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      data.toString("base64"),
    ].join(".");
  }

  open(sealed: string): string {
    const [version, iv, tag, data] = sealed.split(".");
    if (version !== "v1" || !iv || !tag || data === undefined)
      throw new Error("invalid sealed value");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString(
      "utf8",
    );
  }
}

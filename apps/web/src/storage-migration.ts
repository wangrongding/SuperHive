/** 改名前的本地存储前缀，只用于下面的一次性迁移 */
const LEGACY_PREFIX = "ai-hive.";
const PREFIX = "superhive.";

/** 把改名前存在浏览器里的设置、草稿、登录票搬到新前缀下；新键已有值时不覆盖 */
export function migrateLegacyStorage(storage: Storage): void {
  const legacyKeys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(LEGACY_PREFIX)) legacyKeys.push(key);
  }
  for (const key of legacyKeys) {
    const value = storage.getItem(key);
    const next = PREFIX + key.slice(LEGACY_PREFIX.length);
    if (value !== null && storage.getItem(next) === null) storage.setItem(next, value);
    storage.removeItem(key);
  }
}

try {
  migrateLegacyStorage(localStorage);
} catch {
  // 隐私模式等拿不到 localStorage 时跳过
}

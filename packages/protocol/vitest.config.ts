import { configDefaults, defineConfig } from "vitest/config";

// pnpm dev 的 supervisor 把编译好的 Server / protocol（含 *.test.js）暂存在 .superhive-dev/ 里换代用，
// 不排除的话 vitest 会把这些旧编译产物当测试再跑一遍
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, ".superhive-dev/**"] },
});

import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/.astro/**",
      ".claude/**",
      "**/.superhive-dev/**",
      "output/**",
      "packages/superhive/web/**",
      // 桌面端的组装目录、打包产物和测试报告
      "apps/desktop/.stage/**",
      "apps/desktop/out/**",
      "apps/desktop/test-results/**",
      "apps/desktop/playwright-report/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Electron Forge 配置等 CommonJS 脚本
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { ...globals.node } },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["**/*.{ts,tsx,mjs}"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);

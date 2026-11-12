// eslint.config.mjs —— 本仓统一代码规范（ESLint flat config，ESLint ≥ 9）
//
// 口径说明（**不要只看文件在不在**）：
// - 本仓以 `node --test` 为门禁、默认**零运行依赖**；本配置只在**显式安装** `eslint` 后生效。
//   未安装时它不会拦截任何提交 —— 这是有意的：不为"让自检变绿"而假装有约束。
// - **脚本入口已落地**（-232 / -233 之后的收口）：`package.json` 已补
//   `"lint": "eslint ."`、`"format": "prettier --write ."`、`"format:check": "prettier --check ."`，
//   即 `npm run lint` / `npm run format` / `npm run format:check` 均可直接用。
// - **工具链安装是人工步骤**（本仓默认零运行依赖，沙箱内 npm 不可用 ⇒ 依赖未装）。
//   人工在项目根目录终端执行：`npm i -D eslint prettier`
// - 未安装依赖时，`npm run lint` / `npm run format:check` 会报命令不存在 —— **这属预期**，
//   不是配置错误；不要为此删脚本或改判据。
// - 版本**未写死**（本环境无法验证具体版本，写死等于撒谎），由人工安装时由 npm 解析当前稳定版。
// - 与 `AGENTS.md §3` 不冲突：本文件只是配置，不改变"不 commit / 不 push"纪律。

export default [
  {
    ignores: [
      "node_modules/**",
      ".data/**",
      "docs/**",
      "docs.bak-*/**",
      "coverage/**",
      "**/*.min.js",
      "**/dist/**",
    ],
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      // 零依赖地提供 Node 全局量（避免引入 `globals` 包）
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        queueMicrotask: "readonly",
        fetch: "readonly",
        AbortController: "readonly",
        structuredClone: "readonly",
        globalThis: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        require: "readonly",
        module: "readonly",
        exports: "readonly",
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      // 只开"抓真 bug"的一组；风格类交 prettier，避免双重标准
      "no-undef": "error",
      "no-redeclare": "error",
      "no-unreachable": "error",
      "no-dupe-keys": "error",
      "no-fallthrough": "error",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-var": "warn",
      "prefer-const": "warn",
      eqeqeq: ["warn", "smart"],
    },
  },
  // 卡 `-235`（需求 `R172`）· 浏览器侧文件：`web/app.js` / `lib/client.js` 以及 `tools/bench-*.mjs`
  // 里被 `page.evaluate(...)` 带进**页面上下文**执行的代码，`window` / `document` 等是宿主提供的全局量。
  // 只给这批文件放宽 —— Node 侧文件仍要求「不许引用未声明变量」（`index.js:389` 的真缺陷就是这么抓到的）。
  {
    files: ["web/**/*.js", "lib/client.js", "tools/bench-*.mjs"],
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        localStorage: "readonly",
        WebSocket: "readonly",
        EventSource: "readonly",
        ResizeObserver: "readonly",
        MutationObserver: "readonly",
        requestAnimationFrame: "readonly",
      },
    },
  },
];

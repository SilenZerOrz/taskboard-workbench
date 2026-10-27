/**
 * 发布门禁守卫（2026-10-27）· `tools/release-precheck.mjs`
 *
 * 钉两件事：
 *   ① **扫描器真的会抓**（植入 L1 凭据 / L2 家目录 / 掩码 token 必须命中，干净文本不得误报）；
 *   ② **本仓库当前 tracked tree 是干净的**（有 `.git` 时）—— 谁把 `/Users/…` 或密钥写进仓库，
 *      `npm test` 直接变红，不必等发布前才发现。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { scanText, L1, L2, L3_WHITELIST } from "../tools/release-precheck.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("发布门禁 · L1：植入的凭据形态必须命中", () => {
  const planted = `const key = "sk-${"a".repeat(32)}";`;
  const rules = scanText(planted).map((h) => h.rule);
  assert.ok(rules.includes("openai-key"), "sk- 形式的长 token 必须被抓");
  assert.ok(scanText(`npm_${"b".repeat(36)}`).some((h) => h.rule === "npm-token"), "npm_ token 必须被抓");
  const pemHeader = ["-----BEGIN", " RSA", " PRIVATE KEY-----"].join("");
  assert.ok(scanText(pemHeader).some((h) => h.rule === "private-key"), "私钥头必须被抓");
});

test("发布门禁 · L1：掩码形态也必须命中（掩码同样泄露前缀与长度）", () => {
  const masked = `npm_${"abcdef"}...${"wxyz"}`;
  assert.ok(scanText(masked).some((h) => h.rule === "masked-token"), "6+4 掩码必须被抓");
});

test("发布门禁 · L2：家目录 / 内网段 / 内部域名必须命中", () => {
  // 注意：本文件自身会被门禁扫描，故样本一律**运行时拼接**，不写字面量（否则守卫测试自己触发 L2）。
  const join = (...parts) => parts.join("");
  const macHome = join("/", "Users", "/", "someone", "/project");
  const linuxHome = join("/", "home", "/", "someone", "/x");
  const priv192 = join("host ", ["192", "168", "1", "20"].join("."));
  const priv10 = join("listen ", ["10", "0", "0", "7"].join("."));
  const internal = join("api.", "shenke", "info.net");

  assert.ok(scanText(macHome).some((h) => h.rule === "mac-home"), "macOS 家目录路径必须被抓");
  assert.ok(scanText(linuxHome).some((h) => h.rule === "linux-home"), "Linux 家目录路径必须被抓");
  assert.ok(scanText(priv192).some((h) => h.rule === "ip-192-168"), "192.168 段必须被抓");
  assert.ok(scanText(priv10).some((h) => h.rule === "ip-10"), "10.x 段必须被抓");
  assert.ok(scanText(internal).some((h) => h.rule === "internal-domain"), "内部域名必须被抓");
});

test("发布门禁 · 不误报：干净代码 / 版本号 / 公开白名单", () => {
  assert.equal(scanText("npm install && node --test").length, 0, "普通命令不得误报");
  assert.equal(scanText("version 10.0.1 released").length, 0, "三段版本号不得误报为内网 IP");
  assert.equal(scanText("spec/团队agent.md").length, 0, "相对路径不得误报");
  assert.ok(L3_WHITELIST.length > 0, "L3 白名单非空（公开常量应显式登记）");
});

test("发布门禁 · 本仓库 tracked tree 无 L1/L2", { skip: !existsSync(`${root}/.git`) && "非 git 工作区（npm 包内跑测试）" }, () => {
  // 直接复用门禁自己的规则集（免两份口径漂移；规则源码文本本身不会自我命中）
  const rules = [...L1, ...L2].map((r) => r.re.source).join("|");
  let out = "";
  try {
    out = execFileSync("git", ["grep", "-InE", "--no-color", rules, "HEAD", "--", "."], { cwd: root, encoding: "utf8" });
  } catch (e) {
    if (e.status === 1) out = ""; // 无命中
    else throw e;
  }
  assert.equal(out.trim(), "", `tracked tree 命中敏感串：\n${out}`);
});

#!/usr/bin/env node
/**
 * mutation-check.mjs —— 证明「引入不再建条目」这条护栏**是真的**（不是摆设）。
 *
 * 做法：把 `src/server/api.mjs` 的 intake 路由**变异回旧行为**（恢复逐文档建条目），
 * 再跑 `tests/project-intake-settings.test.mjs`：
 *   - 测试**转红** ⇒ 护栏有效（退出码 0）；
 *   - 测试**仍绿** ⇒ 护栏是摆设（退出码 1）；
 *   - 变异本身不合法（改完语法都过不了）⇒ 退出码 2（**不算通过**，避免把崩溃误判成"护栏有效"）。
 *
 * 安全性：只改 `api.mjs` 一个文件，改前把原始字节写到临时目录，跑完 **无条件还原** 并校验 sha256。
 * 这不是「我手工试过了」——它是一条可重跑的命令。
 *
 * 用法：
 *   node tools/mutation-check.mjs                # 严格：护栏不存在即失败（A 落地后应当这样跑）
 *   node tools/mutation-check.mjs --allow-absent # A 落地前用：护栏不存在只告警
 *   node tools/mutation-check.mjs --dry-run      # 只打印变异 diff，不落盘、不跑测试
 */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const API = join(ROOT, "src/server/api.mjs");
const TEST = "tests/project-intake-settings.test.mjs";
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

/** 旧行为（A 之前 api.mjs intake 路由里的那一整块）——变异体就是把它塞回去。 */
const LEGACY_LOOP = `        /* [mutation] 旧行为：逐文档建条目（A 之前的样子） */
        {
          const created = [];
          const existing = new Set(store.listRequirementItems({ projectId: project.id }).map((i) => i.title));
          for (const d of built.docs) {
            if (existing.has(d.title)) continue;
            const legacyItem = store.createRequirementItem({
              projectId: project.id, title: d.title, docId: doc?.id,
              description: \`来源：\\\`\${d.relPath}\\\`\\n\\n\${d.content.slice(0, 2000)}\`,
              source: "intake", status: body.status ?? "draft",
            });
            existing.add(d.title);
            created.push({ identifier: legacyItem.identifier, title: legacyItem.title });
          }
          void created;
        }
`;

function mutate(src) {
  const steps = [];
  let out = src;

  // 1) 若 A 已落地：把整道门（`if (mode !== "doc") { … }`）短路掉。
  //    只注释 throw 是不够的——进入门体仍会抛，变异体跑不到建条目那段。
  const gate = /^(\s*)if \(mode !== "doc"\) \{$/m;
  const m1 = gate.exec(out);
  if (m1) {
    out = out.replace(m1[0], `${m1[1]}if (false) { /* [mutation] 门已短路 */`);
    steps.push('短路 intake 门（if (mode !== "doc") ⇒ if (false)）');
  } else {
    steps.push('⚠ 未找到 intake 门（A 未落地或已回退）——按"纯旧行为"做变异');
  }

  // 2) 注入旧行为：插在 intake 201 返回体之前（锚点唯一：`bytes: built.index.length`，新旧版本都存在）
  const anchor = "bytes: built.index.length";
  const idx = out.indexOf(anchor);
  if (idx < 0) throw new Error(`锚点缺失：${anchor} —— api.mjs 结构已变，请更新本脚本（不得静默通过）`);
  const ret = out.lastIndexOf("return {", idx);
  if (ret < 0) throw new Error("锚点缺失：未找到该返回体之前的 `return {`");
  out = out.slice(0, ret) + LEGACY_LOOP + out.slice(ret);
  steps.push("注入旧行为（逐文档 createRequirementItem）");

  return { out, steps };
}

const original = readFileSync(API);
const originalSha = sha(original);
const src = original.toString("utf8");

let mutated, steps;
try {
  ({ out: mutated, steps } = mutate(src));
} catch (e) {
  console.error(`[mutation] ✗ 变异失败：${e.message}`);
  process.exit(2);
}

console.log(`[mutation] target = src/server/api.mjs (sha256 ${originalSha.slice(0, 12)}…)`);
for (const s of steps) console.log(`[mutation]   · ${s}`);

if (has("dry-run")) {
  const a = src.split("\n"), b = mutated.split("\n");
  const at = b.findIndex((line, i) => line !== a[i]);
  console.log(`[mutation] diff 起始行 ≈ ${at + 1}；未落盘、未跑测试（--dry-run）`);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "tb-mutation-"));
const backup = join(dir, "api.mjs.orig");
const probe = join(dir, "api.mutated.mjs");
writeFileSync(backup, original);
writeFileSync(probe, mutated);

// 语法预检：变异体自己必须是合法的，否则「测试失败」可能只是崩溃
const chk = spawnSync(process.execPath, ["--check", probe], { encoding: "utf8" });
if (chk.status !== 0) {
  console.error(`[mutation] ✗ 变异体语法不合法（会误判成护栏有效）：\n${chk.stderr?.slice(0, 600)}`);
  process.exit(2);
}

let restored = false;
const restore = () => {
  if (restored) return;
  restored = true;
  writeFileSync(API, readFileSync(backup));
};
process.on("exit", restore);
process.on("SIGINT", () => { restore(); process.exit(130); });

let test = null;
try {
  writeFileSync(API, mutated);
  test = spawnSync(process.execPath, ["--test", TEST], { cwd: ROOT, encoding: "utf8", timeout: 180000 });
} finally {
  restore();
}

const afterSha = sha(readFileSync(API));
if (afterSha !== originalSha) {
  console.error(`[mutation] ✗✗ 还原失败！api.mjs sha256 ${afterSha.slice(0, 12)}… ≠ ${originalSha.slice(0, 12)}…`);
  console.error(`[mutation]     原始字节备份在：${backup}`);
  process.exit(3);
}
console.log(`[mutation] 已还原 api.mjs（sha256 一致 ${afterSha.slice(0, 12)}…）`);

const failed = test.status !== 0;
const tail = `${test.stdout ?? ""}\n${test.stderr ?? ""}`.trim().split("\n").slice(-6).join("\n");
console.log(`[mutation] 测试退出码 = ${test.status}（${failed ? "转红" : "仍绿"}）`);
console.log(tail.split("\n").map((l) => `           ${l}`).join("\n"));

if (failed) {
  console.log("[mutation] ✓ 护栏有效：恢复旧行为后测试转红");
  process.exit(0);
}
if (has("allow-absent")) {
  console.log("[mutation] ⚠ 护栏尚不存在（测试仍绿）—— A 未落地时的预期状态（--allow-absent）");
  process.exit(0);
}
console.log("[mutation] ✗ 护栏无效：恢复旧行为后测试仍绿 ⇒ 新测试杀不死这个变异");
process.exit(1);

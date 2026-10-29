#!/usr/bin/env node
/**
 * memory-scan.mjs —— P-M0：**离线扫候选记忆**（2026-10-28 拍板 D-M1/D-M2）
 *
 * 只做一件事：把已经写进 `docs/进度/*.md` / `docs/设计/*.md` 的**结论句**扫出来，作为
 * `memory_entries` 的候选（`proposed` 的原料）。**不落库、不改文件**（除非显式 `--out`）。
 *
 * 用法：
 *   node tools/memory-scan.mjs                       # 打印摘要
 *   node tools/memory-scan.mjs --json                # 打印完整 JSON
 *   node tools/memory-scan.mjs --out <path>          # 写 JSON 报告（供人抽检 10 条）
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 路径里含中文：必须 `fileURLToPath`，`URL.pathname` 会百分号编码（实测 EPERM）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["docs/进度", "docs/设计"];

/** 结论信号的守门词：命中即视为「可复用结论」的候选（宁少不滥，R-M1）。 */
// 只用**强信号**（"必须/不得"这类词满篇都是，实测扫出 1148 条噪声 ⇒ 宁少不滥）
const SIGNALS = [
  { kind: "decision", re: /(裁定|拍板|口径改为|口径＝|结论＝)/ },
  { kind: "pitfall", re: /(真凶|必崩|根因＝|根因是|踩坑|教训)/ },
  { kind: "convention", re: /(纪律沉淀|一律|不许|统一用|禁止)/ },
  { kind: "procedure", re: /(SOP|判据一条|一键|跑法)/ },
];
const SECRET_RE = /(sk-[A-Za-z0-9_-]{12,})|(_token\s*[:=]\s*\S+)|(-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

const args = process.argv.slice(2);
const wantJson = args.includes("--json");
const outIdx = args.indexOf("--out");
const outPath = outIdx >= 0 ? args[outIdx + 1] : null;

const candidates = [];
for (const dir of DIRS) {
  const abs = path.join(ROOT, dir);
  let names = [];
  try { names = readdirSync(abs).filter((n) => n.endsWith(".md")); } catch { continue; }
  for (const name of names.sort()) {
    const rel = path.join(dir, name);
    const text = readFileSync(path.join(ROOT, rel), "utf8");
    const lines = text.split("\n");
    let perFile = 0;
    lines.forEach((line, i) => {
      if (perFile >= 6 || candidates.length >= 200) return;
      const t = line.trim();
      if (t.length < 12 || t.startsWith("|") && t.length > 300) return;
      if (SECRET_RE.test(t)) {
        candidates.push({ kind: "rejected", file: rel, line: i + 1, title: "(含疑似密钥，已丢弃)", provenance: `doc:${rel}#L${i + 1}` });
        return;
      }
      // 只认**结论句的形状**：标题行、列表项、或带冒号/等号的陈述；长段落整段不收
      const isHeading = /^#{2,4}\s/.test(t);
      const isBullet = /^([-*]|\d+[.、])\s/.test(t);
      const isStatement = /[：＝]/.test(t) && t.length <= 240;
      if (!isHeading && !isBullet && !isStatement) return;
      const hit = SIGNALS.find((sg) => sg.re.test(t));
      if (!hit) return;
      // 标题取前 60 字（去掉 markdown 装饰），body 保留整行
      const title = t.replace(/^[#>*\-\s|`]+/, "").replace(/\*\*/g, "").slice(0, 60).trim();
      if (title.length < 8) return;
      candidates.push({ kind: hit.kind, file: rel, line: i + 1, title, body: t.slice(0, 400), provenance: `doc:${rel}#L${i + 1}` });
      perFile += 1;
    });
  }
}

const usable = candidates.filter((c) => c.kind !== "rejected");
const byKind = usable.reduce((acc, c) => { acc[c.kind] = (acc[c.kind] ?? 0) + 1; return acc; }, {});
const report = {
  generatedAt: new Date().toISOString(),
  scannedDirs: DIRS,
  total: usable.length,
  byKind,
  rejectedSecrets: candidates.length - usable.length,
  note: "候选≠记忆：写入前必须人抽检（R-M1 假记忆比空记忆更坏），落库一律 proposed。",
  candidates: usable,
};

if (outPath) {
  mkdirSync(path.dirname(path.resolve(ROOT, outPath)), { recursive: true });
  writeFileSync(path.resolve(ROOT, outPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
if (wantJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  console.log(`[memory-scan] 候选 ${usable.length} 条（${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(" / ")}）· 丢弃疑似密钥 ${report.rejectedSecrets} 条`);
  if (outPath) console.log(`[memory-scan] 报告已写：${outPath}`);
  for (const c of usable.slice(0, 5)) console.log(`  - [${c.kind}] ${c.title}  (${c.provenance})`);
}

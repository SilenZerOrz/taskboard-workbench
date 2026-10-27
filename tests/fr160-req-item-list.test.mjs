/**
 * 卡 `-160` · 需求条目列表：**宽度 / 密度优化 ＋ 完成 / 关闭状态显式化**。
 *
 * 来源（三处真机口径叠成这一条卡）：
 *   · 2026-10-22 用户真机批注：「需求条目列表还是**太宽**了，优化样式，并**新增需求是否完成&关闭等状态更新**」
 *     —— 当轮按 FR-91 ④ 做成了「自适应多列网格」。
 *   · 2026-10-27 用户再批注：多列方块不美观 ⇒ 改成**单列行式列表** + 点行开抽屉。
 *   · 本卡（第三次）：列表**仍然又宽又矮** —— 面板占满 `--board-max-width`（1248px）、列表高度死守
 *     420px；且 `done` / `closed` **只缩成一个小胶囊**，`closed` 还和「来源」胶囊同款灰色
 *     ⇒ 终态在列表里根本读不出来。行内 5 个按钮用 `opacity: 0` 隐藏，但 **opacity 不脱离布局**，
 *     每行都白占一整排按钮的宽度（这是「太宽」的隐形主因）。
 *
 * 断言方式沿用本仓前端口径（读源码文本，不做 DOM 运行时）：
 * 与 `tests/requirement-completion.test.mjs` 的「前端接线」一例同型。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const SRC = readFileSync(path.join(root, "web/app.js"), "utf8");
const CSS = readFileSync(path.join(root, "web/tokens.css"), "utf8");

/** 取出某条 CSS 规则的声明块（`sel { ... }`），找不到返回 null。规则里不含 `}`，够本文件的断言用。 */
const rule = (sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = CSS.match(new RegExp(`${esc}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : null;
};

// ── 完成 / 关闭状态显式化 ─────────────────────────────────────────────────────

test("卡 -160-1：面板头给出**四态计数**（完成 / 关闭不再隐形）", () => {
  // 此前只报「待确认 N · 已确认 N」⇒「这条需求做完了没有」在面板层读不出来。
  for (const cls of ["req-count-draft", "req-count-open", "req-count-done", "req-count-closed"]) {
    assert.ok(SRC.includes(cls), `面板头缺四态计数之一：${cls}`);
  }
  assert.ok(SRC.includes("已完成 ${doneCount}"), "面板头必须显式给出「已完成」计数");
  assert.ok(SRC.includes("已关闭 ${closedCount}"), "面板头必须显式给出「已关闭」计数");
  assert.ok(SRC.includes('const doneCount = countByStatus("done")'), "已完成计数要按状态实算，不许写死");
  assert.ok(SRC.includes('const closedCount = countByStatus("closed")'), "已关闭计数要按状态实算，不许写死");
  // 四态计数与状态筛选下拉同口径（draft/open/done/closed）
  assert.ok(/panelEl\(\s*`需求条目（\$\{allItems\.length\}）`,\s*reqCounts,?\s*\)/.test(SRC), "四态计数要进条目面板头");
  assert.ok(rule(".req-counts"), "四态计数要有自己的样式（不至于挤成一团）");
});

test("卡 -160-2：终态行在**行上**显式标记（is-done / is-closed + data-status + title）", () => {
  assert.ok(SRC.includes("const isTerminal = it.status === \"done\" || it.status === \"closed\""), "终态判定要收敛成一个谓词");
  assert.ok(SRC.includes("`req-item${isTerminal ? ` is-${it.status}` : \"\"}"), "终态要在行上带 is-done / is-closed 类名");
  assert.ok(SRC.includes("li.dataset.status = it.status"), "行要带 data-status（可样式化、可断言）");
  assert.ok(SRC.includes("li.title = `状态：${statusTxt}`"), "行的 title 要如实写状态（悬停可读）");

  const done = rule(".req-stack .req-item.is-done");
  const closed = rule(".req-stack .req-item.is-closed");
  assert.ok(done, "已完成行要有独立样式");
  assert.ok(closed, "已关闭行要有独立样式");
  assert.match(done, /box-shadow:\s*inset/, "已完成行要用内阴影画终态色条（不占布局、不与普通行错位）");
  assert.match(closed, /box-shadow:\s*inset/, "已关闭行同样要有终态色条");
  assert.match(closed, /opacity:/, "已关闭行要整体降权（不必再抢注意力）");
  // 标题划掉：两种终态都要（一眼看出"不做/做完了"，而不是还得去读胶囊）
  assert.match(CSS, /\.req-stack \.req-item\.is-done \.req-title,[\s\S]{0,120}?text-decoration:\s*line-through/, "已完成要划掉标题");
  assert.match(CSS, /\.req-stack \.req-item\.is-(done|closed) \.req-title[^{]*\{[^}]*text-decoration:\s*line-through/, "已关闭要划掉标题");
});

test("卡 -160-3：状态抽成独立一列且四态各有色（不再与「来源」胶囊同款）", () => {
  assert.ok(SRC.includes("chip req-status-chip is-${it.status}"), "状态要用专用类名 + 按状态修饰");
  // 旧口径（状态与来源同款 pill，`closed` 走默认灰）必须已撤
  assert.ok(!SRC.includes('pill(statusTxt, it.status === "draft" ? "warn"'), "状态不得再走「和来源同款」的 pill 三元式");
  assert.ok(!SRC.includes('meta.append(pill(statusTxt,'), "状态不再是 meta 里的一个小胶囊");
  const chip = rule(".req-status-chip");
  assert.ok(chip, "状态要有独立样式块");
  assert.match(chip, /flex:\s*0 0 auto/, "状态列宽度固定，行与行才对得齐");
  assert.match(chip, /min-width:/, "状态列要有最小宽度（「已完成 / 待确认」不抖动）");
  for (const st of ["draft", "open", "done", "closed"]) {
    const r = rule(`.req-status-chip.is-${st}`);
    assert.ok(r, `状态 ${st} 要有自己的配色`);
    assert.match(r, /color:/, `状态 ${st} 缺前景色`);
  }
});

// ── 宽度 / 密度 ──────────────────────────────────────────────────────────────

test("卡 -160-4：行内动作**不再占宽度**（opacity 隐藏但占位的旧口径已撤）", () => {
  const acts = rule(".req-stack .req-item-actions");
  assert.ok(acts, "行内动作要有样式块");
  assert.match(acts, /position:\s*absolute/, "动作要浮起来（absolute 才真正脱离布局流，不占行宽）");
  assert.match(acts, /pointer-events:\s*none/, "未显形时不得吃掉指针事件");
  // 实测坑（真浏览器验证台 bench-req-item-list 抓到）：浮层比行略高 ⇒ 给列表触出竖向滚动条
  // ⇒ clientWidth 掉 11px ⇒ 悬停时整列左右抖动。槽位必须常驻预留。
  const list = rule(".req-stack .req-list");
  assert.match(list, /scrollbar-gutter:\s*stable/, "列表要常驻预留滚动条槽位（否则动作浮层触出滚动条时整行宽度抖动）");
  // absolute 需要定位上下文
  const item = rule(".req-stack .req-item");
  assert.match(item, /position:\s*relative/, "行必须是动作浮层的定位上下文");
  // hover / 选中 / 键盘聚焦三档都要显形（键盘可达，不靠鼠标）
  assert.match(CSS, /\.req-stack \.req-item:focus-within \.req-item-actions\s*\{[^}]*opacity:\s*1/, "键盘聚焦也要能看到动作");
  assert.match(CSS, /\.req-stack \.req-item:hover \.req-item-actions/, "悬停要显形");
});

test("卡 -160-5：列表**两栏 + 更高**（治「又宽又矮」），行更紧凑，且不横向溢出", () => {
  const stack = rule(".req-stack");
  assert.ok(stack, "需求页容器要有样式块");
  assert.match(stack, /display:\s*grid/, "宽视口下要能分两栏（单列竖排是「又宽又矮」的根因）");
  assert.match(stack, /grid-template-columns/, "两栏要有列定义");
  // 溢出根治：`1fr` 的自动最小尺寸＝内容 min-content，长标题会把轨道顶宽 ⇒ 整页横向滚动条。
  assert.match(stack, /grid-template-columns:\s*minmax\(0,\s*1fr\)/, "窄视口单列也要用 minmax(0,1fr)（否则长标题把整页撑宽）");
  assert.match(CSS, /@media \(min-width: 1080px\)\s*\{\s*\.req-stack\s*\{[^}]*grid-template-columns/, "两栏要按视口分级（窄屏回落单列）");
  assert.match(CSS, /\.req-stack > \.panel\s*\{[^}]*min-width:\s*0/, "面板要允许收缩（grid 子项的自动最小宽度同样会顶破轨道）");

  // 条目栏拿更大的一份额度（1.18fr > 0.82fr），且两栏都用 minmax(0, …) 防溢出
  const cols = rule(".req-stack") ? CSS.match(/@media \(min-width: 1080px\)\s*\{\s*\.req-stack\s*\{([^}]*)\}/)[1] : "";
  assert.match(cols, /minmax\(0,\s*0\.82fr\)/, "文档栏用 minmax(0, 0.82fr)");
  assert.match(cols, /minmax\(0,\s*1\.18fr\)/, "条目栏用 minmax(0, 1.18fr)（拿到更大一份宽度）");

  const list = rule(".req-stack .req-list");
  assert.ok(list, "条目列表要有样式块");
  assert.ok(!/max-height:\s*420px/.test(list), "列表高度不得再死守 420px（122 条需求挤在小窗里滚）");
  assert.match(list, /max-height:\s*min\(70vh/, "列表高度要跟视口走（一屏能扫更多条）");

  assert.match(item_of(), /min-height:\s*28px/, "行高要收紧以提高密度");
});

/** `.req-stack .req-item` 的声明块（提出来避免上面被规则对象遮蔽,也便于重复使用）。 */
function item_of() {
  return rule(".req-stack .req-item") ?? "";
}

// ── 不改既有口径 ─────────────────────────────────────────────────────────────

test("卡 -160-6：功能零丢失 —— 行内动作仍齐全（确认 / 标记完成 / 关闭 / 重新打开 / 生成任务 / 删除）", () => {
  assert.ok(SRC.includes('btn("确认"'), "待确认条目的「确认」动作不得丢");
  assert.ok(SRC.includes('setReq("done", "标记完成"'), "「标记完成」不得丢");
  assert.ok(SRC.includes('setReq("closed", "关闭")'), "「关闭」不得丢");
  assert.ok(SRC.includes('setReq("open", "重新打开")'), "终态条目的「重新打开」不得丢");
  assert.ok(SRC.includes('"生成任务"'), "「生成任务」不得丢");
  assert.ok(SRC.includes('"删除"'), "「删除」不得丢");
  // 终态仍必须由人点（FR-91 红线）
  assert.ok(SRC.includes('actor: "human"'), "需求终态必须仍由人确认（actor: human）");
});

test("卡 -160-7：不改 FR-91 的状态口径（四态词表 / 筛选 / 中文标签函数不变）", () => {
  assert.ok(SRC.includes('["done", "已完成"]') && SRC.includes('["closed", "已关闭"]') && SRC.includes('["open", "在办"]'), "状态筛选四档不得改口径");
  assert.ok(SRC.includes("function reqStatusLabel("), "状态中文口径仍收敛在一个函数");
  assert.ok(SRC.includes('const isTerminal'), "终态判定仍是同一个谓词（不再各处写 `status === \"done\" || ...`）");
  // 列表仍是单列语义（FR-91 / 2026-10-27 口径未回退成多列网格）
  assert.match(rule(".req-stack .req-list") ?? "", /flex-direction:\s*column/, "条目列表仍是单列（不得回退成多列网格方块）");
  assert.ok(!/\.req-stack \.req-list\s*\{[^}]*grid-template-columns/.test(CSS), "条目列表本身不得变成网格");
});

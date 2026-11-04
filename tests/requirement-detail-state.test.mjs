/**
 * 卡 `-218`（需求 `R159` · D-1=`c` / D-3=派生）· 条目**完整性形态**守卫。
 *
 * 为什么要有：64 条历史条目的 `description` 被早期导入 `slice(0,2000)` 截断，
 * 但界面上**没有任何区别** —— 读到「R2 尾部 # ── 2) A 阶段｜重启前必做（不中」的人
 * 会以为这就是全部内容。标识必须是**行上可见**的，不是点进详情才发现。
 *
 * 口径（人拍）：派生、不落库；三态 `full / truncated / mirror`；2000 字符的镜像条目算 `mirror`（设计上限）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DETAIL_STATES, TRUNCATED_MIN_LEN, deriveDetailState } from "../src/core/requirements.mjs";
import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sp = (qs = "") => new URLSearchParams(qs);
const BODY_2000 = "x".repeat(2000);

test("A 三态判据：truncated / full / mirror / 空值", () => {
  assert.deepEqual([...DETAIL_STATES], ["full", "truncated", "mirror"], "三态口径固定");
  // 被截断：够长且末字符不是句读
  assert.equal(deriveDetailState(BODY_2000), "truncated");
  assert.equal(deriveDetailState(`${BODY_2000}（不中`), "truncated");
  // 完整：同一长度但以句读收尾
  assert.equal(deriveDetailState(`${BODY_2000}。`), "full");
  assert.equal(deriveDetailState(`${BODY_2000})`), "full");
  // 表格行尾 `|` / `>` 是完整行，不是残片（这是 `R159` 口径从 70 修正到 64 的那 4 条）
  assert.equal(deriveDetailState(`${BODY_2000}|`), "full");
  assert.equal(deriveDetailState(`${BODY_2000}>`), "full");
  // 空描述不是残片（那是另一种缺口，由 acceptanceSet 负责）
  assert.equal(deriveDetailState(""), "full");
  assert.equal(deriveDetailState(null), "full");
  assert.equal(deriveDetailState(undefined), "full");
});

test("B 边界：长度下界两侧与镜像前缀形态", () => {
  assert.equal(deriveDetailState("x".repeat(TRUNCATED_MIN_LEN - 1)), "full", "下界以下不判残片");
  assert.equal(deriveDetailState("x".repeat(TRUNCATED_MIN_LEN)), "truncated", "恰好下界判残片");
  // 镜像优先于残片：镜像 55 条同时也是"被截断"，但语义上是**设计上限**，不能报成事故
  assert.equal(deriveDetailState(`【归类 2026-10-29 · 资料索引】非需求条目：本条目由文档镜像自动生成。\n\n${BODY_2000}`), "mirror");
  assert.equal(deriveDetailState(`  【归类 2026-11-04 · 历史批次归档】一次已执行批次\n${BODY_2000}`), "mirror", "允许前导空白");
  // 只是长得像前缀（没有日期/分隔点）不算镜像 —— 否则正常条目会被误标
  assert.equal(deriveDetailState(`【归类】随便写写。`), "full");
  assert.equal(deriveDetailState(`【关闭 2026-11-04】规范正本，非需求条目。`), "full");
});

test("C 真 HTTP：列表与详情**两条路径**都带 detailState，且同一条目一致", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1", workspacePath: null });
  const cut = store.createRequirementItem({ projectId: "p1", title: "被截断的", description: `${BODY_2000}（不中` });
  const whole = store.createRequirementItem({ projectId: "p1", title: "完整的", description: "只有一句话。" });
  const mirror = store.createRequirementItem({ projectId: "p1", title: "镜像", description: `【归类 2026-10-29 · 资料索引】非需求条目\n${BODY_2000}` });
  const router = createApiRouter({ store });

  const list = await router.route({ method: "GET", pathname: "/api/requirements/items", searchParams: sp("project=p1"), body: null });
  const byId = new Map(list.payload.items.map((i) => [i.identifier, i.detailState]));
  assert.equal(byId.get(cut.identifier), "truncated");
  assert.equal(byId.get(whole.identifier), "full");
  assert.equal(byId.get(mirror.identifier), "mirror");

  for (const item of [cut, whole, mirror]) {
    const one = await router.route({ method: "GET", pathname: `/api/requirements/items/${item.identifier}`, searchParams: sp(), body: null });
    assert.equal(one.payload.item.detailState, byId.get(item.identifier), `${item.identifier}：列表与详情必须同源`);
  }
  store.close();
});

test("D 接线守卫：算出来了必须接上（DB 行映射）与画出来（列表/详情）", () => {
  const storeSrc = readFileSync(path.join(ROOT, "src/core/store.mjs"), "utf8");
  assert.match(storeSrc, /detailState:\s*deriveDetailState\(row\.description\)/, "rowToRequirementItem 必须挂 detailState（否则字段永远 undefined）");
  const webSrc = readFileSync(path.join(ROOT, "web/app.js"), "utf8");
  assert.match(webSrc, /DETAIL_STATE_LABELS\[it\.detailState\]/, "列表行必须消费 detailState（算出来不显示＝白算）");
  assert.match(webSrc, /addF\("完整性", detailStateText\(item\.detailState\)/, "详情抽屉必须有「完整性」字段");
});

test("E 反向对照：判据恒返 full ⇒ 上面的断言必红", () => {
  // 这是"守卫的守卫"：把判据换成永远返回 full 的桩，A 组的关键断言必须失败。
  const stub = () => "full";
  assert.equal(stub(BODY_2000), "full");
  assert.notEqual(stub(BODY_2000), deriveDetailState(BODY_2000), "若两者相等，说明真判据已退化成恒 full");
  assert.equal(deriveDetailState(BODY_2000), "truncated");
});

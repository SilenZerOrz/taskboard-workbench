/**
 * 卡 `-178`（2026-10-29）：改条目标题时 `norm_title` 不同步 ⇒ 去重键陈旧。
 *
 * 背景：`norm_title` 是**标题去重键**（`confirmRequirementCandidates` 与 intake 按它判「这条是不是新的」）。
 * 此前 `updateRequirementItem` 只写 `title`，`norm_title` 停在旧值 ⇒ 条目改名后会被当成「新条目」再插一次。
 * 存量实测 `normTitleMismatch = 0`（`tools/audit-intake.mjs`），所以这条是**防新增**，不是修存量。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { titleKey } from "../src/core/requirements.mjs";

const newStore = () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  return store;
};

test("-178 ① 新建条目：norm_title = titleKey(title)", () => {
  const store = newStore();
  const item = store.createRequirementItem({ projectId: "p1", title: "旧标题" });
  assert.equal(item.normTitle ?? titleKey(item.title), titleKey("旧标题"));
  assert.equal(item.normTitle, titleKey("旧标题"));
});

test("-178 ② 改标题同步 norm_title（本次修复的核心判据）", () => {
  const store = newStore();
  const item = store.createRequirementItem({ projectId: "p1", title: "旧标题" });
  const updated = store.updateRequirementItem(item.identifier, { title: "新标题" });
  assert.equal(updated.title, "新标题");
  assert.equal(updated.normTitle, titleKey("新标题"), "改名后去重键必须是新标题（否则 confirm 会重复插入）");
  assert.notEqual(updated.normTitle, titleKey("旧标题"), "不得停在旧键上");
});

test("-178 ③ 只改说明/优先级时 norm_title 不变（不误伤）", () => {
  const store = newStore();
  const item = store.createRequirementItem({ projectId: "p1", title: "标题不变" });
  const key = item.normTitle;
  const updated = store.updateRequirementItem(item.identifier, { description: "新说明", priority: "high" });
  assert.equal(updated.normTitle, key);
});

test("-178 ④ 改名后按新标题去重成立：同标题再建不会与旧键混淆", () => {
  const store = newStore();
  const item = store.createRequirementItem({ projectId: "p1", title: "旧标题" });
  store.updateRequirementItem(item.identifier, { title: "新标题" });
  const items = store.listRequirementItems({ projectId: "p1" });
  const keys = items.map((i) => i.normTitle);
  assert.deepEqual(keys.filter((k) => k === titleKey("新标题")).length, 1, "新键唯一");
  assert.equal(keys.filter((k) => k === titleKey("旧标题")).length, 0, "旧键不得残留");
});

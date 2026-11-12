/**
 * 卡 `-249` / 需求 `R179`：复核命令本身跑不起来时，不许把「配置写成了模板」谎报成「复核没过」。
 *
 * 真机 2026-11-12（`scada-vibe-1`）：复核动作写成
 * `git -C 00-project-real/scada status --porcelain && git apply --check <diff文件>`。
 * `<diff文件>` 是给人看的占位符，`spawn(cmd, { shell: true })` 交给 `/bin/sh` 解析后
 * `<` 变重定向、`>` 没有目标 ⇒ 语法错误 ⇒ 退出码 2 ⇒ 结论「失败（退出码 2）」。
 * 读起来像测试挂了，实际是命令永远跑不起来。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { detectUnrunnableVerify } from "../src/core/verify.mjs";

function setup(workspacePath) {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1", workspacePath: workspacePath ?? null });
  const router = createApiRouter({ store });
  const route = (method, pathname, body) => {
    const [p, q] = String(pathname).split("?");
    return router.route({ method, pathname: p, searchParams: new URLSearchParams(q ?? ""), body });
  };
  return { store, route };
}

test("占位符识别：<diff文件> / {{x}} 命中，合法 shell 写法不误伤", () => {
  const hit = detectUnrunnableVerify("git -C scada status --porcelain && git apply --check <diff文件>");
  assert.ok(hit, "含 <diff文件> 必须命中");
  assert.equal(hit.kind, "placeholder");
  assert.match(hit.reason, /占位符/);
  assert.equal(detectUnrunnableVerify("{{patch}} 未展开").kind, "placeholder");

  // 反例：这些是合法命令，不许误判成模板
  for (const ok of [
    "npm test",
    'node -e "console.log(1 < 2)"',
    "diff <(ls) <(ls)",
    "npm test 2>&1 | tail -5",
    "test -z \"$(git -C scada status --porcelain)\"",
  ]) {
    assert.equal(detectUnrunnableVerify(ok), null, `不该误判：${ok}`);
  }
  assert.equal(detectUnrunnableVerify(""), null);
});

test("API：复核命令含占位符 ⇒ 判「不适用」、不跑命令、退出码为 null、证据照落", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-unrunnable-"));
  try {
    const { store, route } = setup(dir);
    const task = store.createTask({
      projectId: "p1",
      title: "带占位符复核动作的卡",
      verifyCommand: "git -C scada status --porcelain && git apply --check <diff文件>",
    });
    store.teamSetTaskStatus(task.identifier, { status: "in_review", actor: "team" });

    const r = await route("POST", `/api/tasks/${task.identifier}/auto-review`, {});
    assert.equal(r.status, 201);
    assert.equal(r.payload.applicable, false, "应判不适用");
    assert.equal(r.payload.exitCode, null, "根本没跑，不许编造退出码");
    assert.match(r.payload.verdict, /不适用/, "结论不能是「失败（退出码 N）」");
    assert.match(String(r.payload.tail), /占位符/);
    assert.match(String(r.payload.tail), /workspacePath/, "要告诉人相对路径该相对谁写");

    const comments = store.listComments(task.id);
    assert.equal(comments.length, 1, "证据照落，只是结论是第三态");
    assert.match(comments[0].body, /^【自动复核】/);
    assert.match(comments[0].body, /不适用/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("反向对照：把占位符换成真实命令 ⇒ 照常执行（守卫不吞正常命令）", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-unrunnable-ok-"));
  try {
    const { store, route } = setup(dir);
    const task = store.createTask({
      projectId: "p1",
      title: "复核动作已写成真实命令",
      verifyCommand: 'node -e "console.log(\'ok\')"',
    });
    store.teamSetTaskStatus(task.identifier, { status: "in_review", actor: "team" });
    const r = await route("POST", `/api/tasks/${task.identifier}/auto-review`, {});
    assert.equal(r.payload.applicable, true);
    assert.equal(r.payload.exitCode, 0);
    assert.equal(r.payload.verdict, "通过");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

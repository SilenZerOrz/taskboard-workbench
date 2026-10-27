/**
 * CLI 契约测试（t24 起 schemaVersion=2，新增 owner）：退出码 0/2/3/4/5 + owner 读写与过滤。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "cli", "tb.mjs");

const safeParse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

function tb(args, options = {}) {
  const env = { ...process.env };
  if (options.dataDir) env.TB_DATA_DIR = options.dataDir;
  if (options.dropDataDir === true) delete env.TB_DATA_DIR;
  for (const [key, value] of Object.entries(options.env ?? {})) env[key] = value;
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8", env });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    json: safeParse(result.stdout ?? ""),
    error: safeParse(result.stderr ?? ""),
  };
}

const freshDir = (label) => mkdtempSync(path.join(os.tmpdir(), `t24-cli-${label}-`));

test("成功路径：项目 → 任务 → 读取 → 更新 → 列表 → 评论（schemaVersion=2）", () => {
  const dir = freshDir("ok");
  try {
    const project = tb(["project", "create", "--id", "demo", "--name", "Demo"], { dataDir: dir });
    assert.equal(project.code, 0, project.stderr);
    assert.equal(project.json.schemaVersion, 2);
    assert.equal(project.json.project.id, "demo");

    const created = tb(["task", "create", "--project", "demo", "--title", "第一条", "--priority", "high", "--labels", "bug,ui"], { dataDir: dir });
    assert.equal(created.code, 0, created.stderr);
    assert.equal(created.json.task.identifier, "demo-1");
    assert.deepEqual(created.json.task.labels, ["bug", "ui"]);
    assert.equal(created.json.task.owner, null);

    const fetched = tb(["task", "get", "demo-1"], { dataDir: dir });
    assert.equal(fetched.code, 0, fetched.stderr);
    assert.deepEqual(fetched.json.comments, []);

    const updated = tb(["task", "update", "demo-1", "--if-version", "1", "--status", "in_progress"], { dataDir: dir });
    assert.equal(updated.code, 0, updated.stderr);
    assert.equal(updated.json.task.status, "in_progress");
    assert.equal(updated.json.task.version, 2);

    const commented = tb(["comment", "add", "demo-1", "--body", "**验收**通过"], { dataDir: dir });
    assert.equal(commented.code, 0, commented.stderr);
    const comments = tb(["comment", "list", "demo-1"], { dataDir: dir });
    assert.equal(comments.code, 0);
    assert.equal(comments.json.count, 1);
    assert.equal(comments.json.comments[0].body, "**验收**通过");

    const listed = tb(["task", "list", "--project", "demo"], { dataDir: dir });
    assert.equal(listed.code, 0);
    assert.equal(listed.json.count, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("owner：create --owner 写入字段；update --owner/--clear-owner；list --owner 过滤", () => {
  const dir = freshDir("owner");
  try {
    tb(["project", "create", "--id", "demo", "--name", "Demo"], { dataDir: dir });
    const created = tb(["task", "create", "--project", "demo", "--title", "带负责人", "--owner", "engineer", "--labels", "bug"], { dataDir: dir });
    assert.equal(created.code, 0, created.stderr);
    assert.equal(created.json.task.owner, "engineer");
    assert.deepEqual(created.json.task.labels, ["bug"], "owner 不写进 labels");
    tb(["task", "create", "--project", "demo", "--title", "无负责人"], { dataDir: dir });

    const byOwner = tb(["task", "list", "--project", "demo", "--owner", "engineer"], { dataDir: dir });
    assert.equal(byOwner.code, 0);
    assert.deepEqual(byOwner.json.tasks.map((t) => t.identifier), ["demo-1"]);
    assert.equal(byOwner.json.tasks[0].owner, "engineer");

    const changed = tb(["task", "update", "demo-1", "--if-version", "1", "--owner", "tester"], { dataDir: dir });
    assert.equal(changed.code, 0, changed.stderr);
    assert.equal(changed.json.task.owner, "tester");
    assert.deepEqual(tb(["task", "list", "--owner", "tester"], { dataDir: dir }).json.tasks.map((t) => t.identifier), ["demo-1"]);

    const cleared = tb(["task", "update", "demo-1", "--if-version", "2", "--clear-owner"], { dataDir: dir });
    assert.equal(cleared.code, 0, cleared.stderr);
    assert.equal(cleared.json.task.owner, null);
    assert.equal(tb(["task", "list", "--owner", "tester"], { dataDir: dir }).json.count, 0);

    const unknown = tb(["task", "create", "--project", "demo", "--title", "x", "--owner"], { dataDir: dir });
    assert.equal(unknown.code, 2, "缺少值的 --owner 应报用法错误");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("版本冲突：过期 --if-version → 退出码 5 + VERSION_CONFLICT", () => {
  const dir = freshDir("conflict");
  try {
    tb(["project", "create", "--id", "demo", "--name", "Demo"], { dataDir: dir });
    tb(["task", "create", "--project", "demo", "--title", "并发"], { dataDir: dir });
    tb(["task", "update", "demo-1", "--if-version", "1", "--status", "todo"], { dataDir: dir });
    const stale = tb(["task", "update", "demo-1", "--if-version", "1", "--status", "done"], { dataDir: dir });
    assert.equal(stale.code, 5, stale.stderr);
    assert.equal(stale.error.error.code, "VERSION_CONFLICT");
    assert.equal(stale.error.error.details.currentVersion, 2);
    assert.equal(stale.error.schemaVersion, 2);

    assert.equal(tb(["task", "update", "demo-1", "--status", "done"], { dataDir: dir }).code, 2);
    assert.equal(tb(["task", "delete", "demo-1", "--if-version", "1"], { dataDir: dir }).code, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("输入错误 → 2；数据错误 → 4；存储不可用 → 3", () => {
  const dir = freshDir("codes");
  try {
    tb(["project", "create", "--id", "demo", "--name", "Demo"], { dataDir: dir });

    const badStatus = tb(["task", "create", "--project", "demo", "--title", "x", "--status", "doing"], { dataDir: dir });
    assert.equal(badStatus.code, 2);
    assert.equal(badStatus.error.error.code, "INVALID_STATUS");

    assert.equal(tb(["frobnicate", "all"], { dataDir: dir }).error.error.code, "UNKNOWN_COMMAND");
    assert.equal(tb(["task", "list", "--wat", "1"], { dataDir: dir }).error.error.code, "UNKNOWN_OPTION");
    assert.equal(tb(["task", "create", "--project", "demo"], { dataDir: dir }).code, 2);

    const help = tb(["--help"], { dataDir: dir });
    assert.equal(help.code, 2);
    assert.match(help.stderr, /用法：tb/);

    assert.equal(tb(["task", "create", "--project", "ghost", "--title", "x"], { dataDir: dir }).code, 4);
    assert.equal(tb(["task", "get", "demo-42"], { dataDir: dir }).code, 4);

    tb(["task", "create", "--project", "demo", "--title", "父"], { dataDir: dir });
    tb(["task", "create", "--project", "demo", "--title", "子", "--parent", "demo-1"], { dataDir: dir });
    const cycle = tb(["task", "update", "demo-1", "--if-version", "1", "--parent", "demo-2"], { dataDir: dir });
    assert.equal(cycle.code, 4);
    assert.equal(cycle.error.error.code, "PARENT_CYCLE");

    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    const service = tb(["project", "list", "--data-dir", path.join(blocker, "nested")], { dropDataDir: true });
    assert.equal(service.code, 3, service.stderr);
    assert.equal(service.error.error.code, "STORE_UNAVAILABLE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("默认数据目录来自 TB_DATA_DIR；--data-dir 优先级更高", () => {
  const envDir = freshDir("env");
  const flagDir = freshDir("flag");
  try {
    assert.equal(tb(["project", "create", "--id", "fromenv", "--name", "Env"], { dataDir: envDir }).code, 0);
    const flag = tb(["project", "list", "--data-dir", flagDir], { dataDir: envDir });
    assert.equal(flag.json.count, 0, "--data-dir 应覆盖 TB_DATA_DIR");
    assert.equal(tb(["project", "list"], { dataDir: envDir }).json.count, 1);
  } finally {
    rmSync(envDir, { recursive: true, force: true });
    rmSync(flagDir, { recursive: true, force: true });
  }
});

test("治理开关：默认允许智能体置 done；--enforce-governance 后拒绝", () => {
  const dir = freshDir("governance");
  try {
    tb(["project", "create", "--id", "demo", "--name", "Demo"], { dataDir: dir });
    tb(["task", "create", "--project", "demo", "--title", "治理"], { dataDir: dir });
    const allowed = tb(["task", "update", "demo-1", "--if-version", "1", "--status", "done", "--actor", "agent"], { dataDir: dir });
    assert.equal(allowed.code, 0, allowed.stderr);
    assert.equal(allowed.json.task.status, "done");

    tb(["task", "create", "--project", "demo", "--title", "治理2"], { dataDir: dir });
    const blocked = tb(["task", "update", "demo-2", "--if-version", "1", "--status", "done", "--actor", "agent", "--enforce-governance"], { dataDir: dir });
    assert.equal(blocked.code, 4);
    assert.equal(blocked.error.error.code, "AGENT_CANNOT_SET_DONE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FR-17 评论编辑：CLI 编辑留痕 + 冲突退出码 5 + 证据评论只读", () => {
  const dir = freshDir("comment-edit");
  try {
    tb(["project", "create", "--id", "demo", "--name", "Demo"], { dataDir: dir });
    tb(["task", "create", "--project", "demo", "--title", "评论编辑"], { dataDir: dir });
    const added = tb(["comment", "add", "demo-1", "--body", "原正文"], { dataDir: dir });
    assert.equal(added.code, 0, added.stderr);
    const id = added.json.comment.id;
    assert.equal(added.json.comment.version, 1);

    // 编辑成功：返回更新后的评论，且原正文进历史
    const edited = tb(["comment", "edit", "demo-1", id, "--if-version", "1", "--body", "新正文"], { dataDir: dir });
    assert.equal(edited.code, 0, edited.stderr);
    assert.equal(edited.json.comment.body, "新正文");
    assert.equal(edited.json.comment.version, 2);
    assert.equal(edited.json.comment.edited, true);

    const history = tb(["comment", "history", "demo-1", id], { dataDir: dir });
    assert.equal(history.code, 0);
    assert.deepEqual(history.json.revisions.map((r) => r.body), ["原正文"], "原内容未被静默覆盖");

    // 冲突：旧版本再提交 → 退出码 5，正文不动
    const stale = tb(["comment", "edit", "demo-1", id, "--if-version", "1", "--body", "覆盖"], { dataDir: dir });
    assert.equal(stale.code, 5, stale.stderr);
    assert.equal(stale.error.error.code, "VERSION_CONFLICT");
    const after = tb(["comment", "list", "demo-1"], { dataDir: dir });
    assert.equal(after.json.comments[0].body, "新正文", "被拒的提交一字未落盘");

    // 缺 --if-version → 退出码 2
    assert.equal(tb(["comment", "edit", "demo-1", id, "--body", "x"], { dataDir: dir }).code, 2);

    // 证据评论只读 → 退出码 4
    const ev = tb(["comment", "add", "demo-1", "--body", "【自动复核】命令=npm test；退出码=1；耗时=1.0s；结论=失败（退出码 1）"], { dataDir: dir });
    const evEdit = tb(["comment", "edit", "demo-1", ev.json.comment.id, "--if-version", "1", "--body", "改成通过"], { dataDir: dir });
    assert.equal(evEdit.code, 4);
    assert.equal(evEdit.error.error.code, "COMMENT_NOT_EDITABLE");

    // 未知 id → 退出码 4
    assert.equal(tb(["comment", "edit", "demo-1", "nope", "--if-version", "1", "--body", "x"], { dataDir: dir }).code, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

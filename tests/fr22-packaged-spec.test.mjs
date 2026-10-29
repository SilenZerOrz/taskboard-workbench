/**
 * FR-22 补口（2026-10-23）· 随包《智能体操作规范》：
 *   · `spec/团队agent.md` 新增「智能体操作规范（随包）」一节，以自洽清单写全 FR-22 六条；
 *   · `package.json#files` **只增**该文件（不把整个 `docs/` 打进包 —— `进度/`/`验证/`/`历史归档/` 是过程证据）；
 *   · 开局提示词（`buildOpeningPrompt`）改为**随包可解析**指路，不再出现「仓库 spec/团队agent.md」死链。
 * 真机显形：装成包后 `spec/团队agent.md` 不在包内、开局提示词按仓库路径指路 ⇒ 智能体读不到规范。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const spec = readFileSync(new URL("../spec/团队agent.md", import.meta.url), "utf8");
const sp = (qs = "") => new URLSearchParams(qs);

test("FR-22 · 随包：`files` 含 `spec/团队agent.md`，且**不含**整目录 `docs`（过程证据不属交付物）", () => {
  assert.ok(Array.isArray(pkg.files), "files 必须是数组");
  assert.ok(pkg.files.includes("spec/团队agent.md"), "规范正本必须随包（files 含 spec/团队agent.md）");
  assert.ok(!pkg.files.includes("docs"), "不得把整个 docs/ 打进包（进度/验证/历史归档属过程证据）");
  // P1（2026-10-29）：机器执行规范 `spec/norms/*.md` 是运行时唯一真源，必须随包
  assert.ok(pkg.files.includes("spec/norms"), "机器规范 spec/norms 必须随包（否则装到的是空规范）");
  assert.ok(!pkg.files.some((f) => f === "docs/" || f === "docs/**"), "不得用通配把整个 docs/ 纳入包内");
});

test("FR-22 · 规范正本：`spec/团队agent.md` 含小节「智能体操作规范（随包）」且六条逐条命中", () => {
  assert.match(spec, /^## 九、智能体操作规范（随包）$/m, "必须新增小节标题「智能体操作规范（随包）」");
  // ① 先读任务与评论再动手（含 acceptance / 复核动作）
  assert.match(spec, /先读任务与评论再动手/, "① 先读任务与评论再动手");
  assert.match(spec, /acceptance/, "① 须点明 acceptance（验收口径/复核动作）");
  // ② backlog 不得执行
  assert.match(spec, /`backlog` 不得执行/, "② backlog 不得执行");
  // ③ 认领需声明身份
  assert.match(spec, /认领需声明身份/, "③ 认领需声明身份");
  assert.match(spec, /声明身份/, "③ 须含「声明身份」字面");
  // ④ 提交待验收并附证据
  assert.match(spec, /提交待验收并附证据/, "④ 提交待验收并附证据");
  // ⑤ done 必须由人确认
  assert.match(spec, /`done` 必须由人确认/, "⑤ done 必须由人确认");
  // ⑥ 冲突需重读再改（VERSION_CONFLICT 可见）
  assert.match(spec, /与他人冲突需重读再改/, "⑥ 与他人冲突需重读再改");
  assert.match(spec, /VERSION_CONFLICT/, "⑥ 冲突处置须按 VERSION_CONFLICT");
  // 同源声明：不得另立第二份规范
  assert.match(spec, /本条与 FR-07 同源，不得另立第二份规范/, "节末须声明与 FR-07 同源、不另立第二份规范");
});

test("FR-22 · 开局提示词：不再指「仓库 spec/团队agent.md」，改为随包可解析指路", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1", workspacePath: null });
  store.bindInitialSession("p1", "session-old");
  const sent = [];
  store.hostSessionPort = {
    available: true,
    async createSession() { return { sessionId: "session-new-1" }; },
    async sendPrompt(sessionId, text) { sent.push(text); return { sent: true, reason: null }; },
  };
  const r = await createApiRouter({ store }).route({
    method: "POST", pathname: "/api/projects/p1/sessions/rebind", searchParams: sp(), body: { confirm: true },
  });
  assert.equal(r.payload.openingDelivered, true, "重建主会话须投递开局提示词");
  assert.equal(sent.length, 1);
  const text = sent[0];
  assert.doesNotMatch(text, /仓库 spec\/团队agent\.md/, "不得再出现装包后失效的「仓库 spec/团队agent.md」指路");
  assert.doesNotMatch(text, /详见仓库/, "不得再按仓库路径指路");
  assert.match(text, /随包/, "开局提示词须出现「随包」字样");
  assert.match(text, /spec\/团队agent\.md/, "须保留可解析的文件路径");
  assert.match(text, /智能体操作规范（随包）/, "须指向随包规范的那一节");
  store.close();
});

test("FR-22 · 规范正本随包路径可达（文件确实存在于仓库内、可被 npm pack 读取）", () => {
  assert.match(root, /03taskboard_workbench\/?$/, "测试运行在仓库根");
  assert.ok(spec.length > 0, "规范正本非空");
});

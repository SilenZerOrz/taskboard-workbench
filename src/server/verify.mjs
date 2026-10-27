/**
 * FR-90：把「跑一遍验证命令」这件 I/O 与纯函数分开，便于单测与超时兜底。
 *
 * 约束（写在最前面，避免以后被"顺手"放宽）：
 * - **只跑一条命令**，在项目配置的工作区目录里，**超时即杀**（默认 180s，可由调用方指定）；
 * - 输出**只留尾段**（默认 4000 字符）——证据评论不是日志搬运；
 * - **不改任何任务状态**：评审通过 / 完成仍然只能由人点。
 */
import { spawn } from "node:child_process";

export const VERIFY_DEFAULT_TIMEOUT_MS = 180000;

/**
 * 跑一条验证命令。
 *
 * @param {object} opts
 * @param {string} opts.command 命令行（交给 shell 执行：项目自己配置的验证脚本本就是命令行）
 * @param {string} opts.cwd 工作目录（项目 workspacePath）
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxTailChars]
 * @returns {Promise<{exitCode:number|null,timedOut:boolean,durationMs:number,tail:string}>}
 */
export function runVerifyCommand({ command, cwd, timeoutMs = VERIFY_DEFAULT_TIMEOUT_MS, maxTailChars = 4000 } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const chunks = [];
    let timedOut = false;
    let child;
    try {
      child = spawn(String(command), { cwd, shell: true, env: process.env });
    } catch (error) {
      resolve({ exitCode: null, timedOut: false, durationMs: Date.now() - startedAt, tail: `命令无法启动：${error.message}` });
      return;
    }
    const collect = (buf) => {
      chunks.push(String(buf));
      // 只保留尾部：长输出的命令（如全量测试）不该把内存与评论撑爆。
      let total = 0;
      for (let i = chunks.length - 1; i >= 0; i -= 1) {
        total += chunks[i].length;
        if (total > maxTailChars * 2) { chunks.splice(0, i); break; }
      }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* 已被回收 */ }
    }, Math.max(1000, Number(timeoutMs) || VERIFY_DEFAULT_TIMEOUT_MS));
    const finish = (exitCode) => {
      clearTimeout(timer);
      const text = chunks.join("");
      resolve({
        exitCode: timedOut ? null : exitCode,
        timedOut,
        durationMs: Date.now() - startedAt,
        tail: text.length > maxTailChars ? text.slice(text.length - maxTailChars) : text,
      });
    };
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut: false, durationMs: Date.now() - startedAt, tail: `命令执行出错：${error.message}` });
    });
    child.on("close", (code) => finish(code));
  });
}

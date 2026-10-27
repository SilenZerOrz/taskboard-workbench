/**
 * ai-elaborator.mjs —— DSH 宿主侧 AI 条目化（FR-36 首选路径）。
 *
 * T-6 结论：DSH 在 Cordis Context 上暴露 `llm` 服务（`LlmRuntime.stream`），
 * **无需发起会话**即可直连一次模型调用。本模块把它包成 api 层可注入的 `aiElaborator`。
 * 规则解析（`store.elaborateRequirementDoc`）保留为 fallback。
 *
 * 说明：真实调用依赖运行期已配置的 provider/model（【需实测】）；本文件只做接线。
 */
import { buildElaborationMessages, parseElaborationOutput } from "../core/requirements.mjs";

/**
 * @param {{ llm?: { stream?: Function }, provider?: string, model?: string }} opts
 * @returns {null | ((doc: {body: string}) => Promise<Array<object>>)}
 */
export function createLlmElaborator({ llm, provider, model } = {}) {
  if (!llm || typeof llm.stream !== "function" || !provider || !model) return null;
  return async function elaborate(doc) {
    const { system, messages } = buildElaborationMessages(doc.body);
    let text = "";
    for await (const chunk of llm.stream({ provider, model, system, messages })) {
      if (chunk && chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
    }
    return parseElaborationOutput(text);
  };
}

/**
 * server.mjs —— 独立开发验证台（零依赖 http 外壳）。
 * 路由逻辑在 api.mjs（与 DSH 宿主插件共用）；本文件只负责：
 *   · 解析 URL / 请求体，把请求交给 router；
 *   · 静态托管 web/（DSH 插件在同一路径下复用同一 handler）；
 *   · basePath 前缀剥离（DSH 挂在 /integrations/taskboard-workbench 下）。
 */
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveDataDir } from "../core/config.mjs";
import { TbError } from "../core/errors.mjs";
import { openStore } from "../core/store.mjs";
import { API_SCHEMA_VERSION, createApiRouter, httpStatusFor } from "./api.mjs";
import { createEventHub } from "./events.mjs";

export const DEFAULT_PORT = 47830;
export const DEFAULT_PROJECT_ID = "default";
export const DEFAULT_BASE_PATH = "";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const WEB_DIR = path.join(ROOT, "web");
const MAX_BODY_BYTES = 1_000_000;
const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
]);

function sendJson(response, status, payload, schemaVersion = API_SCHEMA_VERSION) {
  const body = JSON.stringify({ schemaVersion, ...payload }, null, 2);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendError(response, error, schemaVersion = API_SCHEMA_VERSION) {
  const tbError = error instanceof TbError ? error : new TbError("DATA_ERROR", error instanceof Error ? error.message : String(error));
  sendJson(response, httpStatusFor(tbError), { error: tbError.toJSON() }, schemaVersion);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new TbError("INVALID_FIELD", "请求体过大（上限 1MB）");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new TbError("INVALID_FIELD", `请求体不是合法 JSON：${error.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TbError("INVALID_FIELD", "请求体必须是 JSON 对象");
  }
  return parsed;
}

/** 首次启动若无项目则建一个内置默认项目。 */
export function ensureDefaultProject(store) {
  const projects = store.listProjects();
  if (projects.length > 0) return { created: false, projects };
  const project = store.createProject({ id: DEFAULT_PROJECT_ID, name: "默认项目" });
  return { created: true, projects: [project], project };
}

/** 剥离 basePath：不在前缀下的请求返回 null（调用方决定 404）。 */
export function stripBasePath(pathname, basePath) {
  if (!basePath || basePath === "/") return pathname;
  const prefix = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  if (pathname === prefix) return "/";
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  return null;
}

/**
 * 构造 Node 请求处理器：独立服务与 DSH 宿主插件共用。
 * @param {{store: object, webDir?: string, basePath?: string, schemaVersion?: number}} options
 */
export function createRequestHandler({ store, webDir = WEB_DIR, basePath = DEFAULT_BASE_PATH, schemaVersion = API_SCHEMA_VERSION, aiElaborator, events } = {}) {
  if (!store) throw new Error("createRequestHandler 需要 store");
  const router = createApiRouter({ store, aiElaborator, events });

  async function serveStatic(response, urlPath) {
    const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
    const base = path.resolve(webDir);
    const target = path.resolve(base, relative);
    if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
      sendJson(response, 403, { error: { code: "FORBIDDEN", message: "路径越界" } }, schemaVersion);
      return;
    }
    try {
      const info = await stat(target);
      if (!info.isFile()) throw Object.assign(new Error("not a file"), { code: "ENOENT" });
      const body = await readFile(target);
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader("referrer-policy", "no-referrer");
      response.writeHead(200, {
        "content-type": CONTENT_TYPES.get(path.extname(target)) ?? "application/octet-stream",
        "content-length": body.length,
        "cache-control": "no-store",
      });
      response.end(body);
    } catch (error) {
      if (error.code === "ENOENT") {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("404 Not Found\n");
        return;
      }
      throw error;
    }
  }

  return async function handle(request, response) {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const inner = stripBasePath(url.pathname, basePath);
      if (inner === null) {
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: `不在插件命名空间下：${url.pathname}` } }, schemaVersion);
        return;
      }
      const method = request.method ?? "GET";

      if (inner === "/api/events" && method === "GET" && events) {
        events.subscribe(response);
        return;
      }

      if (!inner.startsWith("/api/")) {
        if (method !== "GET" && method !== "HEAD") {
          response.writeHead(405, { allow: "GET, HEAD" });
          response.end();
          return;
        }
        await serveStatic(response, inner);
        return;
      }

      const body = method === "GET" || method === "HEAD" ? {} : await readJsonBody(request);
      const { status, payload } = await router.route({ method, pathname: inner, searchParams: url.searchParams, body });
      sendJson(response, status, payload, schemaVersion);
    } catch (error) {
      sendError(response, error, schemaVersion);
    }
  };
}

export function createServer(options = {}) {
  const events = options.events ?? createEventHub();
  const handler = createRequestHandler({ ...options, events });
  return http.createServer((request, response) => {
    handler(request, response).catch((error) => sendError(response, error, options.schemaVersion ?? API_SCHEMA_VERSION));
  });
}

export function startServer({ dataDir, port, host = "127.0.0.1", env = process.env, basePath = DEFAULT_BASE_PATH } = {}) {
  const store = openStore({ dataDir, env });
  const ensured = ensureDefaultProject(store);
  const server = createServer({ store, basePath });
  const resolvedPort = Number(port ?? env.TB_PORT ?? DEFAULT_PORT);
  server.listen(resolvedPort, host, () => {
    const address = server.address();
    console.log(`[tb] listening on http://${host}:${address.port}${basePath}/`);
    console.log(`[tb] dataDir=${store.dataDir}`);
    console.log(`[tb] db=${store.dbPath}`);
    console.log(`[tb] projects=${ensured.projects.length}${ensured.created ? " (auto-created default project)" : ""}`);
    console.log(`[tb] migration(owner)=${JSON.stringify(store.stats().migration)}`);
  });
  const close = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
    // 优雅重启必须真的退出（P1-4，2026-10-29 修）。
    // 根因：前端常开 `new EventSource('/api/events')`（SSE 长连接），而 `server.close(cb)` 只停止接受
    // 新连接、要等**既有连接全部结束**才回调 => 只要有一个页面开着，回调永不触发 => SIGTERM 之后进程
    // 挂着不退，继续持有 SQLite，下一个实例起来就形成同库双写者，再下次重启还要撞 EADDRINUSE。
    // 真机事故：孤儿 52278（2026-10-28）与 41116（2026-10-29）都是这一条留下的。
    // closeAllConnections 强制断开 SSE 与 keep-alive（Node >= 18.2；本包 engines 要求 >= 22.5）。
    server.closeAllConnections?.();
    // 兜底：即便运行环境没有 closeAllConnections，也必须在 3s 内退出 —— 不许再留孤儿。
    setTimeout(() => {
      try { store.close(); } catch { /* ignore */ }
      process.exit(0);
    }, 3000).unref();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return { server, store };
}

const entryHref = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entryHref === import.meta.url) {
  startServer({ dataDir: resolveDataDir({ env: process.env }), port: process.env.TB_PORT });
}

/**
 * client.js —— DSH 客户端 bundle（手写 IIFE，无构建步骤；形态对照 t17 的 p4-probe/lib/client.js）。
 *
 * 契约：window.__ModuleLoader__.load({ id, factory })，工厂可 require("react")（宿主冻结模块表）。
 * 承载形态（决策 D5）：
 *   · 会话区标签页 → conversation.view（session 作用域；对齐 对话/轨迹/上下文/团队 的放置位置）
 *   · 面板落点     → main(keyed, key="taskboard-workbench") + sidebar.panellist(list, id 同 key)
 *   · 不使用 shell.overlay（其宿主层 pointer-events:none，会"看得见点不动"）
 *   · 不注册 sidebar.footer.action（"设置上方"的侧栏底部入口已按用户要求取消）
 * 面板内容复用 web/app.js 的看板渲染（同源加载该脚本后调用 window.__TB_BOARD__.createBoard）。
 */
(() => {
  const BUNDLE_ID = "taskboard-workbench";
  const BASE = "/integrations/taskboard-workbench";
  const report = { bundle: BUNDLE_ID, base: BASE, slots: {}, errors: [], startedAt: null };
  window.__TB_PLUGIN__ = report;
  const log = (kind, payload) => {
    try {
      console.log(`[taskboard-workbench][${kind}]`, typeof payload === "string" ? payload : JSON.stringify(payload));
    } catch (_) {}
  };
  const fail = (kind, error) => {
    const message = error instanceof Error ? error.message : String(error);
    report.errors.push({ kind, message });
    log(kind, `ERROR: ${message}`);
  };

  /**
   * #region repair-draft-store
   * 宿主缺陷自愈（2026-10-18 真机定位）：**会话中心区整块白屏、只剩输入框**。
   *
   * 链路（全部在 DSH 宿主侧，本仓库无法改）：
   *  · `@deepseek-ai/dsh-client-store` 把**整值 JSON** 持久化进 localStorage，键名
   *    `dsh.conversation`（有作用域时为 `dsh.conversation.<scope>`），而 rehydrate 是
   *    `api.setState(JSON.parse(raw), true)` —— **整值覆盖、零校验**；
   *  · 于是历史遗留/旧版本写下的 `draft` 可能是**非字符串**（旧版 zustand `persist` 的
   *    `{state,version}` 包装会让 `draft` 变成 `undefined`；DSH 自己的注释也点名了
   *    「字符串草稿被炸成 `{0:'h',1:'e',…}`」这类损坏）；
   *  · `dsh-client-ui-conversation` 的 `DefaultConversationViews` effect 只判
   *    `storedDraft !== ""` 就 `inputActions.setDraft(storedDraft)`，进而在
   *    `DraftEditorRuntime.setDraft` 的 `text.replace(...)` 抛
   *    `TypeError: text.replace is not a function`；
   *  · 该错误冒泡成 `slot entry crashed in 'conversation.session'` → **整个会话区不渲染**。
   *    真机现象：任何会话、任何标签页都只剩输入框，看不到历史对话（2026-10-18 复现）。
   *
   * 处置：插件挂载时做一次**窄修复** —— `draft` 不是字符串就归位成 `""`。
   * 只碰这一个字段、幂等、失败不抛（绝不因为修复动作把面板弄崩）、不改宿主任何文件。
   * 因为宿主 store 在会话视图挂载时才 rehydrate，本修复在**下一次页面加载**即生效。
   * @param {{getItem:Function,setItem:Function}} [storage] 供测试注入；默认 window.localStorage
   */
  const repairConversationDraftStore = (storage) => {
    const result = { scanned: 0, repaired: 0, keys: [] };
    let store = storage;
    if (store === undefined) {
      try { store = typeof window !== "undefined" ? window.localStorage : undefined; } catch (_) { store = undefined; }
    }
    if (!store) return result;
    let names = [];
    try { names = Object.keys(store); } catch (_) { return result; }
    for (const name of names) {
      if (name !== "dsh.conversation" && name.indexOf("dsh.conversation.") !== 0) continue;
      result.scanned += 1;
      try {
        const raw = store.getItem(name);
        if (raw === null || raw === undefined) continue;
        const value = JSON.parse(raw);
        if (!value || typeof value !== "object") continue;
        if (typeof value.draft === "string") continue;
        value.draft = "";
        store.setItem(name, JSON.stringify(value));
        result.repaired += 1;
        result.keys.push(name);
      } catch (_) { /* 解析失败 / 不可写：保持原样，绝不影响面板 */ }
    }
    return result;
  };
  report.repairConversationDraftStore = repairConversationDraftStore;
  // #endregion

  /** 注入 tokens.css + app.js（同源绝对路径），并等待 window.__TB_BOARD__ 就绪。 */
  let assetsPromise = null; // **同一时刻**只允许一次注入（并发挂载共享同一次，避免重复拉取）
  let assetsVersion = null; // 最近一次注入用的 `?v=`（页面生命周期内允许换多次，见 ensureAssets）
  let assetsSeq = 0;        // 让同一毫秒内的多次注入也各自拿到不同的 `?v=`（避免复用旧脚本）
  const STYLE_LINK_ID = "tb-tokens-css";
  /** 回到页签时探测「服务端 app.js 是否已变」的最小间隔（毫秒）：避免 focus 风暴反复拉 240KB。 */
  const STALE_CHECK_MIN_MS = 60000;
  // 载入即登记的诊断元数据：真机上用它判断「页面跑的是不是含自愈逻辑的这一版客户端」
  // （插件客户端 bundle 由宿主按 `rev` 组合分发，光靠 ⌘R 未必换到新版）。
  report.assetsSelfHeal = { minIntervalMs: STALE_CHECK_MIN_MS, watches: ["app.js", "tokens.css"] };
  // #region pure-assets-fingerprint
  /**
   * 面板资源「变更即重载」判据（**纯函数，供 tests/dsh-plugin.test.mjs 提取执行**）。
   *
   * 真机第四次踩坑（2026-10-22 用户再报「归因门拦下可开工卡」）：`ensureAssets()` 只在
   * **每次挂载面板**时重新注入脚本，而宿主页面是长生命周期的 —— 面板开着一整天不重挂，
   * 屏上就一直是几小时前的旧构建（取证：抽屉 `版本 v3` vs 服务端 `v8`、需求条目打裸 UUID），
   * 用户据此反复判断「改的代码根本没生效」（`-80` / `-126` 同类）。
   * 处置：记住注入那一刻服务端的**字节指纹**，回到页签时比一次；变了才重注入并重建看板。
   *
   * `-80` 的补口：**指纹必须同时覆盖 `tokens.css`**。原实现只探测 `app.js`，于是「只改了 CSS、
   * 没有改动任何 JS」这一类提交在长生命周期面板上探测不到 —— 而 `-80` 恰恰就是纯 CSS 缺陷
   * （卡片徽标溢出），这会让本卡的修复在「面板不重挂」时再次失效。同理 `mergeFingerprint()` 判别
   * **哪一侧变了**，好让 CSS 变化走轻量的「只重挂样式表」而不必重建整块看板。
   */
  function assetsFingerprint(text) {
    const input = typeof text === "string" ? text : "";
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
    }
    return `${input.length.toString(16)}-${hash.toString(16)}`;
  }
  /** 把 app.js / tokens.css 两份指纹合成一个可比较的整体指纹（任一侧缺失即整体缺失 ⇒ 不重载）。 */
  function mergeFingerprint(js, css) {
    if (!js || !css) return "";
    return `js:${js}|css:${css}`;
  }
  /** 没有基线指纹（首次挂载尚未记上 / 探测失败）时**不重载**：宁可不动，也不要把能用的看板重挂一遍。 */
  function shouldReloadAssets(loadedFingerprint, currentFingerprint) {
    if (!loadedFingerprint || !currentFingerprint) return false;
    return loadedFingerprint !== currentFingerprint;
  }
  /**
   * 判别两侧变化的种类，供自愈走最轻的处置：
   *  · `js`     —— 脚本变了 ⇒ 必须重注入 + 重建看板；
   *  · `css`    —— **只有样式变了** ⇒ 重挂 `<link>` 即可，不动 DOM、不必重建（面板不闪 loading）；
   *  · `both`   —— 两边都变；
   *  · `none`   —— 没变；
   *  · `unknown`—— 基线或探测缺一侧（如探测失败）⇒ 什么都不做，绝不猜。
   */
  function classifyAssetsChange(loadedFingerprint, currentFingerprint) {
    if (!loadedFingerprint || !currentFingerprint) return "unknown";
    if (loadedFingerprint === currentFingerprint) return "none";
    const loaded = splitFingerprint(loadedFingerprint);
    const current = splitFingerprint(currentFingerprint);
    if (!loaded.js || !loaded.css || !current.js || !current.css) return "unknown";
    const jsChanged = loaded.js !== current.js;
    const cssChanged = loaded.css !== current.css;
    if (jsChanged && cssChanged) return "both";
    if (jsChanged) return "js";
    if (cssChanged) return "css";
    return "none";
  }
  function splitFingerprint(merged) {
    const input = typeof merged === "string" ? merged : "";
    const match = /^js:([^|]+)\|css:(.+)$/.exec(input);
    if (!match) return { js: "", css: "" };
    return { js: match[1], css: match[2] };
  }
  // #endregion
  /**
   * 确保样式表存在，且**每次进入面板都重挂一次**（换新的 `?v=`）。
   * 真机踩坑（2026-10-18，两次复现）：`assetsPromise` 是**页面级单例**，面板首次挂载注入的
   * tokens.css 会跟着整页一直用下去——之后修了 CSS，除非**整页 ⌘R**，否则面板里永远是修复前那份，
   * 表现成「改了代码但界面没变」（事故现场：卡片顶行徽标压出卡框、文字被挤成竖排）。
   * 改 href 而不是换元素：旧样式表在新表下载完成前**仍在生效**，因此不会闪白；同源 35KB 近乎瞬时。
   *
   * `force=true`（仅供 `checkForStaleBundle()` 自愈调用）：面板**不重挂**时同样强制换新 `?v=`，
   * 于是「只改了 CSS、面板一直开着」也能生效，不必整页 ⌘R、也不必重建看板（重挂 `<link href>`
   * 是纯样式替换，不动 DOM 结构、无需 destroy/createBoard）。
   */
  function ensureStyles(force = false) {
    let link = document.getElementById(STYLE_LINK_ID);
    if (!link) {
      link = document.createElement("link");
      link.rel = "stylesheet";
      link.id = STYLE_LINK_ID;
      link.dataset.taskboardOwned = "true";
      document.head.appendChild(link);
    }
    if (!force) {
      const href = `${BASE}/tokens.css?v=${encodeURIComponent(String(Date.now()))}`;
      if (link.getAttribute("href") !== href) link.setAttribute("href", href);
      return link;
    }
    // 与 assetsSeq 同源的序号：同一毫秒内连续自愈也要换到不同的 `?v=`（否则浏览器直接命中旧缓存）。
    assetsSeq += 1;
    const href = `${BASE}/tokens.css?v=${encodeURIComponent(`${Date.now()}-${assetsSeq}`)}`;
    link.setAttribute("href", href);
    return link;
  }
  /** 清掉已注入的脚本/样式，供自动重试重来（避免残留失败脚本）。 */
  function resetAssets() {
    assetsPromise = null;
    document.querySelectorAll('script[data-taskboard-owned="true"], link[data-taskboard-owned="true"]').forEach((el) => el.remove());
  }
  /** 面板侧最小覆盖（仅嵌入态）：不让看板按 1248px 居中（消除两侧留空），外壳改用容器高度。 */
  function ensureEmbedStyles() {
    if (document.getElementById("tb-embed-style")) return;
    const style = document.createElement("style");
    style.id = "tb-embed-style";
    style.textContent = ".tb-embed{--board-max-width:none;}.tb-embed .app-shell{height:100%;}";
    document.head.appendChild(style);
  }
  /**
   * 注入**当前版本**的 web/app.js，并等到本次注入的工厂就绪。
   *
   * 真机踩坑（2026-10-18，本类问题第三次）：看板前端脚本此前是**页面级单例** ——
   * 宿主的 client world 不会因为 `dsh web` 重启就重新加载本项目前端，页面一直活着，
   * 于是「改了 web/app.js 但界面没变」反复出现。实测取证：用户页面上
   * `script[data-taskboard-owned]` 的 `?v=` 停在 22:36:50，而同页 tokens.css 每次进面板都重挂
   * （`?v=` 是当下时间）→ **CSS 的修复能落地、JS 的修复落不了地**，用户据此认为
   * 「问题根本没修」（本轮真实症状：抽屉里仍显示旧口径的「接续存活=在线」，
   * 22:36 之后才加的「仅存于磁盘 · 未加载」四态与告警一条都不见）。
   *
   * 处置：与 tokens.css 同口径 —— **每次挂载都换新的 `?v=` 重新注入一次**。
   *  · 先清掉旧的 owned `<script>`（已执行过的脚本移除不会撤销其效果，留着只会堆积）；
   *  · 注入前**清掉 `window.__TB_BOARD__`**：否则「工厂已就绪」会立刻成立，拿到的还是上一版旧工厂
   *    （这正是本缺陷的本质）。注入失败则**回滚**旧工厂，绝不把本来能用的看板弄没。
   */
  function injectBoardBundle(styleLink) {
    return new Promise((resolve, reject) => {
      assetsSeq += 1;
      const version = `${Date.now()}-${assetsSeq}`;
      document.querySelectorAll('script[data-taskboard-owned="true"]').forEach((el) => el.remove());
      const previousFactory = window.__TB_BOARD__;
      window.__TB_BOARD__ = undefined;

      const waitForFactory = (deadline = Date.now() + 8000) => {
        if (window.__TB_BOARD__?.createBoard) {
          assetsVersion = version;
          report.assets = { css: styleLink?.href ?? null, js: version, ready: true };
          resolve(window.__TB_BOARD__);
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error("看板渲染脚本未就绪（web/app.js 未加载）"));
          return;
        }
        window.setTimeout(waitForFactory, 60);
      };

      const script = document.createElement("script");
      script.src = `${BASE}/app.js?v=${encodeURIComponent(version)}`;
      script.dataset.taskboardOwned = "true";
      script.onerror = () => {
        if (previousFactory?.createBoard) window.__TB_BOARD__ = previousFactory; // 回滚上一版工厂
        reject(new Error(`无法加载 ${BASE}/app.js`));
      };
      script.onload = () => waitForFactory();
      document.head.appendChild(script);
    });
  }

  /**
   * 拿到看板工厂。**并发挂载共享同一次注入**；本次注入结算后放行，使下一次挂载（换标签页/换会话）
   * 能取到新一版 `web/app.js` —— 这就是「前端修复不必整页 ⌘R 也能生效」的机制。
   */
  function ensureAssets() {
    ensureEmbedStyles();
    const styleLink = ensureStyles();
    if (assetsPromise) return assetsPromise;
    assetsPromise = injectBoardBundle(styleLink);
    // 结算即放行：`finally` 的回调先于调用方的 await 续体执行，因此「这一次注入已完成」与
    // 「下一次挂载会重新注入」之间没有窗口期（并发挂载仍共享同一次 —— 上方的 `if` 兜住）。
    assetsPromise.finally(() => { assetsPromise = null; }).catch(() => {});
    return assetsPromise;
  }

  /**
   * 只读取回服务端两份前端资源（app.js + tokens.css）并各记一份字节指纹当基线（失败不影响面板）。
   * 必须**两份都取到**才记基线：缺一侧就整条判据失效，宁可不自愈也不能拿半份基线去比对。
   */
  function probeAssetsFingerprints() {
    return Promise.all([
      fetch(`${BASE}/app.js`, { cache: "no-store" }).then((res) => res.text()).catch(() => ""),
      fetch(`${BASE}/tokens.css`, { cache: "no-store" }).then((res) => res.text()).catch(() => ""),
    ]).then(([js, css]) => ({ js: assetsFingerprint(js), css: assetsFingerprint(css) }));
  }

  window.__ModuleLoader__.load({
    id: BUNDLE_ID,
    factory: (require) => {
      const React = require("react");
      const h = React.createElement;
      report.startedAt = new Date().toISOString();
      // 客户端"打开会话"能力：会话切换属于**客户端**导航（宿主 uiWorkspace 服务），
      // 而非宿主插件（宿主侧永远拿不到 → ui-workspace-unavailable）。这里在点击时懒取。
      let hostOpenSession = null;

      function Panel(props) {
        const sessionId = props?.sessionId ?? null;
        const cwd = props?.cwd ?? null;
        const hostRef = React.useRef(null);
        const controllerRef = React.useRef(null);
        const retryRef = React.useRef(null);
        const [status, setStatus] = React.useState("loading");
        const [error, setError] = React.useState("");
        const [note, setNote] = React.useState("");

        React.useEffect(() => {
          let cancelled = false;
          let timer = null;
          let staleTimer = null;
          let loadedFingerprint = ""; // 注入那一刻服务端 app.js + tokens.css 的合并指纹（自愈判据基线）
          let lastStaleCheckAt = 0;   // 上次探测时刻（节流：focus 风暴不重复拉 240KB）
          const MAX_RETRIES = 5;
          const BACKOFF_MS = [300, 800, 2000, 5000, 5000];

          /** 建 / 重建看板。重建前**必须先 destroy 旧控制器**，否则旧监听与定时器会跟着页面活下去。 */
          const mountBoard = () => {
            if (cancelled || !hostRef.current) return;
            try { controllerRef.current?.destroy(); } catch (_) {}
            controllerRef.current = window.__TB_BOARD__.createBoard({ root: hostRef.current, apiBase: BASE, session: sessionId, cwd, openSession: hostOpenSession });
          };

          /** 只读取回服务端两份前端资源并记下合并字节指纹当基线（失败不影响面板）。 */
          const rememberFingerprint = () => {
            probeAssetsFingerprints()
              .then(({ js, css }) => {
                loadedFingerprint = mergeFingerprint(js, css);
                report.assetsFingerprint = loadedFingerprint;
              })
              .catch(() => {});
          };

          /**
           * 回到页签（focus / 可见性变化 / 每 2 分钟）时探测服务端前端资源是否已变。
           *  · 脚本变了 ⇒ 清掉旧脚本、重注入、重建看板（**不整页 ⌘R，也不闪 loading**）；
           *  · **只有样式变了** ⇒ 只重挂 `<link>`（纯样式替换：不 destroy、不重建，面板零闪烁）；
           *  · 探测失败 ⇒ 什么都不做，绝不阻断面板。
           */
          const checkForStaleBundle = () => {
            if (cancelled) return;
            try { if (document.visibilityState === "hidden") return; } catch (_) {}
            const now = Date.now();
            if (now - lastStaleCheckAt < STALE_CHECK_MIN_MS) return;
            lastStaleCheckAt = now;
            probeAssetsFingerprints()
              .then(({ js, css }) => {
                const current = mergeFingerprint(js, css);
                if (cancelled || !shouldReloadAssets(loadedFingerprint, current)) return;
                const kind = classifyAssetsChange(loadedFingerprint, current);
                if (kind === "unknown") return; // 半份基线不猜
                loadedFingerprint = current;
                log("panel", { staleBundle: kind, from: loadedFingerprint, to: current });
                report.assetsReload = { at: new Date().toISOString(), kind, to: current };
                if (kind === "css") {
                  // 只变了样式：重挂样式表即可，不必重建看板（`-80` 的补口：只改 CSS 也要能生效）。
                  ensureStyles(true);
                  return;
                }
                resetAssets();
                ensureAssets()
                  .then(() => { mountBoard(); log("panel", { remounted: true, bundle: assetsVersion }); })
                  .catch(() => {});
              })
              .catch(() => { /* 探测失败不阻断面板 */ });
          };
          const onReturn = () => checkForStaleBundle();
          try {
            window.addEventListener("focus", onReturn);
            document.addEventListener("visibilitychange", onReturn);
          } catch (_) {}
          staleTimer = window.setInterval(onReturn, STALE_CHECK_MIN_MS * 2);

          const attempt = (n) => {
            if (cancelled) return;
            setStatus(n === 0 ? "loading" : "retry");
            setNote(n === 0 ? "" : `正在重试（第 ${n} 次）…`);
            if (n === 0) rememberFingerprint();
            ensureAssets()
              .then(() => {
                if (cancelled || !hostRef.current) return;
                mountBoard();
                setStatus("ready");
                setNote("");
                log("panel", { mounted: true, base: BASE, attempts: n + 1, bundle: assetsVersion });
              })
              .catch((cause) => {
                if (cancelled) return;
                if (n < MAX_RETRIES) {
                  resetAssets(); // 下次重进 ensureAssets，重新注入脚本
                  const delay = BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)];
                  timer = window.setTimeout(() => attempt(n + 1), delay);
                } else {
                  setError(cause instanceof Error ? cause.message : String(cause));
                  setStatus("error");
                  fail("panel", cause);
                }
              });
          };
          retryRef.current = () => {
            resetAssets();
            setError("");
            setNote("");
            attempt(0);
          };
          attempt(0);

          return () => {
            cancelled = true;
            if (timer) window.clearTimeout(timer);
            if (staleTimer) window.clearInterval(staleTimer);
            try {
              window.removeEventListener("focus", onReturn);
              document.removeEventListener("visibilitychange", onReturn);
            } catch (_) {}
            try {
              controllerRef.current?.destroy();
            } catch (_) {}
            controllerRef.current = null;
          };
        }, [sessionId, cwd]);

        return h(
          "div",
          { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } },
          status === "loading" || status === "retry"
            ? h("div", { style: { padding: 16, opacity: 0.7, fontSize: 13 } }, status === "retry" ? note : "正在加载任务工作台…")
            : null,
          status === "error"
            ? h(
              "div",
              { style: { padding: 16, fontSize: 13 } },
              h("div", { style: { marginBottom: 8 } }, `加载失败：${error}`),
              h("button", { type: "button", onClick: () => retryRef.current?.() }, "重试"),
            )
            : null,
          h("div", {
            ref: hostRef,
            className: "tb-embed",
            style: { flex: "1 1 auto", minHeight: 0, display: status === "ready" ? "block" : "none" },
          }),
        );
      }

      const PanellistEntry = () =>
        h(
          "button",
          {
            type: "button",
            id: "taskboard-workbench-panellist",
            title: "任务工作台",
            "aria-label": "任务工作台",
            style: {
              width: 28, height: 28, borderRadius: 8, cursor: "pointer", fontSize: 13, lineHeight: 1,
              border: "1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.4))",
              background: "transparent", color: "inherit",
            },
          },
          "▦",
        );

      function register(ctx, slot, options, component, flag) {
        try {
          ctx.slots.inject(slot, () => {
            ctx.slots.register({ name: slot, ...options }, component);
            report.slots[flag] = true;
            log("slots", { slot, registered: true });
          });
        } catch (error) {
          report.slots[flag] = false;
          fail(`slots:${slot}`, error);
        }
      }

      function apply(ctx) {
        // 宿主草稿持久化自愈（见上方 #region repair-draft-store）。
        // 必须**早于**会话视图挂载：宿主在会话视图挂载时才 rehydrate `dsh.conversation`。
        try {
          const repaired = repairConversationDraftStore();
          if (repaired.repaired > 0) log("repair-draft-store", repaired);
        } catch (error) {
          fail("repair-draft-store", error);
        }
        // FR-48：客户端会话切换（对齐 DSH 的 uiWorkspace 导航服务）。失败则返回原因，由 UI 降级为"复制会话标识"。
        hostOpenSession = (id) => {
          if (!id) return { ok: false, reason: "no-session" };
          // 1) 客户端会话控制器 `ctx.sessions.open(id)`（对齐 @nanmicoder/dsh-agent-teams 的会话导航）
          try {
            // ⚠ 必须先走 `ctx.get(name)`：cordis 对**未声明在 inject 里**的属性取值会抛
            //   `cannot get property "sessions" without inject`，`ctx.sessions` 只是把它包在
            //   try/catch 里"静默失败"（2026-10-27 rc.3 真机复核确认）。`ctx.get` 缺失时返回 undefined，不抛。
            let sessions = null;
            try { sessions = ctx?.get?.("sessions") ?? null; } catch (_) { sessions = null; }
            if (!sessions) { try { sessions = ctx?.sessions ?? null; } catch (_) { sessions = null; } }
            if (typeof sessions?.open === "function") { sessions.open(id); return { ok: true, via: "sessions.open" }; }
          } catch (_) { /* 该宿主未暴露 → 试下一个 */ }
          // 2) 工作区导航 `uiWorkspace.openSession(id)`
          let ui = null;
          try { ui = ctx?.get?.("uiWorkspace") ?? ctx?.uiWorkspace ?? null; } catch (_) { ui = null; }
          if (typeof ui?.openSession === "function") {
            try { ui.openSession(id); return { ok: true, via: "uiWorkspace.openSession" }; }
            catch (error) { return { ok: false, reason: error?.message ?? String(error) }; }
          }
          return { ok: false, reason: "ui-workspace-unavailable" };
        };
        report.openSession = true;
        // 入口：会话区标签页（主） + 侧栏面板图标 + 主列面板（**取消**侧栏底部/设置上方入口）
        register(ctx, "sidebar.panellist", { id: BUNDLE_ID, order: 0, label: "任务工作台" }, PanellistEntry, "panellist");
        // keyed `main` 只认 `key`（sidebar.panellist 的 list id 与之相等即联动）；不传非契约字段。
        register(ctx, "main", { key: BUNDLE_ID }, Panel, "main");
        // 参考样式：会话作用域"中心标签页"（对齐 对话/轨迹/上下文/团队 的放置位置）
        // FR-60：注入会话上下文（对齐 ui-trajectory 的 inject(sessionId) 写法），
        // 使工作台能把"当前会话"透传给后端（/api/context?session=）并绑定项目初始会话。
        register(ctx, "conversation.view", {
          id: BUNDLE_ID, order: 40, label: "任务工作台",
          inject: (sessionId) => {
            let workspaceId = null;
            let cwd = null;
            try {
              const sessions = (() => {
                try { return ctx.get?.("sessions") ?? null; } catch (_) { return null; }
              })();
              const s = sessions?.binding?.(sessionId)?.session;
              if (s) {
                workspaceId = s.workspaceId ?? null;
                cwd = s.cwd ?? s.workspacePath ?? s.workspace?.path ?? null;
              }
            } catch (_) { /* 会话快照不可得则不传 cwd，由后端按项目回退 */ }
            return { sessionId, workspaceId, cwd };
          },
        }, Panel, "conversationView");
        log("apply", { slots: report.slots, errors: report.errors.length });
      }

      return { apply, inject: ["slots"] };
    },
  });
})();

/**
 * events.mjs —— 极简 SSE 事件中心（FR-41：进度可见，无需手动刷新）。
 * 语义与上游一致：**事件只是"失效信号"**，客户端收到后重取（不做增量合并）。
 */
export function createEventHub() {
  const clients = new Set();
  return {
    subscribe(response) {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-content-type-options": "nosniff",
      });
      response.write(": connected\n\n");
      clients.add(response);
      // unref：心跳只服务于「这条连接还活着」，**不得**因为漏 unsub / 客户端异常收尾而把整个进程
      // （含 node:test 子进程 / 测试套件）钉住 —— 真机事故：两个红用例提前抛错跳过 unsub ⇒ npm test 永久挂死。
      const ping = setInterval(() => { try { response.write(": ping\n\n"); } catch { /* ignore */ } }, 20000);
      ping.unref?.();
      const close = () => { clearInterval(ping); clients.delete(response); };
      response.on?.("close", close);
      response.on?.("error", close);
      return close;
    },
    publish(type, payload = {}) {
      const frame = `event: ${type}\ndata: ${JSON.stringify({ type, at: new Date().toISOString(), ...payload })}\n\n`;
      for (const response of clients) { try { response.write(frame); } catch { /* ignore */ } }
    },
    get size() { return clients.size; },
  };
}

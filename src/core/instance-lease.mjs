/**
 * instance-lease.mjs —— 多实例「单写者」租约（卡 `-237` / 需求 `R173`）。
 *
 * 背景（真机 2026-11-10）：dsh web 与 dsh desktop 可以**同时**打开同一个库。两个宿主各自
 * 起一份插件实例，而 `index.js` 里有两处**按进程**的行为：
 *   ① 启动期 `reconcileOrphanRuns({ boot: true })` —— 它分不清「上一进程」与「另一个活着的进程」，
 *      会把对端正**在跑**的执行当孤儿结清；
 *   ② 30s 执行循环 —— 两边各起一个定时器，同一张卡可能被**双派发**。
 * ⇒ 同一时刻只允许一个实例是 `writer`；其余降级为 `follower`（只读、不起循环、不做 boot 收口）。
 *
 * 语义（刻意保守）：
 *  - 表只有一行（`id = 1`），心跳 15s、过期 45s；
 *  - **不夺权**：对端心跳还新鲜就老实当 follower —— 静默夺权比只读更危险；
 *  - 只有对端**已过期**才接管，并回 `tookOver: true`（调用方据此补一次 boot 收口）；
 *  - 释放是尽力而为：进程被 kill 时行会留到过期，接管方自然会接上。
 *  - **默认 role = writer**：不开租约的调用方（CLI / 测试 / 单进程）行为一字不变。
 */
export const LEASE_TTL_MS = 45_000;
export const LEASE_HEARTBEAT_MS = 15_000;

const CREATE_LEASE_TABLE = `create table if not exists db_instance_lease (
  id integer primary key check (id = 1),
  instance_id text not null,
  host text not null,
  pid integer not null,
  started_at text not null,
  heartbeat_at integer not null
)`;

export function createLeaseApi({ db, nowIso, randomUUID }) {
  db.exec(CREATE_LEASE_TABLE);
  let role = "writer";
  let owner = null;
  let selfId = null;

  const readRow = () => db.prepare("select * from db_instance_lease where id = 1").get() ?? null;
  const describe = (row) => (row
    ? { instanceId: row.instance_id, host: row.host, pid: row.pid, startedAt: row.started_at, heartbeatAt: row.heartbeat_at }
    : null);

  return {
    /**
     * 抢/续租约。**幂等**：同一个 instanceId 重复调用等于心跳。
     * @returns {{role:"writer"|"follower", owner:object|null, tookOver:boolean, previous?:object|null, instanceId:string}}
     */
    acquireInstanceLease({ host = "local", pid = process.pid, nowMs = Date.now(), ttlMs = LEASE_TTL_MS, instanceId } = {}) {
      const self = instanceId || selfId || (selfId = `inst-${randomUUID().replace(/-/g, "").slice(0, 10)}`);
      const stamp = nowIso();
      const row = readRow();
      if (!row) {
        db.prepare("insert into db_instance_lease (id, instance_id, host, pid, started_at, heartbeat_at) values (1, ?, ?, ?, ?, ?)")
          .run(self, String(host), Number(pid), stamp, Number(nowMs));
        role = "writer"; owner = null;
        return { role, owner: null, tookOver: false, instanceId: self };
      }
      if (row.instance_id === self) {
        db.prepare("update db_instance_lease set heartbeat_at = ?, host = ?, pid = ? where id = 1")
          .run(Number(nowMs), String(host), Number(pid));
        role = "writer"; owner = null;
        return { role, owner: null, tookOver: false, instanceId: self };
      }
      const age = Number(nowMs) - Number(row.heartbeat_at ?? 0);
      if (age <= Number(ttlMs)) {
        role = "follower"; owner = describe(row);
        return { role, owner, tookOver: false, instanceId: self };
      }
      const previous = describe(row);
      db.prepare("update db_instance_lease set instance_id = ?, host = ?, pid = ?, started_at = ?, heartbeat_at = ? where id = 1")
        .run(self, String(host), Number(pid), stamp, Number(nowMs));
      role = "writer"; owner = null;
      return { role, owner: null, tookOver: true, previous, instanceId: self };
    },

    /** 本实例当前角色（**本地缓存**，只在 acquire 时更新）。未调用过 acquire 的调用方恒为 `writer`（零行为变化）。 */
    instanceRole() { return role; },

    /** follower 时是「谁在写」；writer 时为 null。 */
    instanceLeaseOwner() { return owner; },

    /**
     * **现读**当前角色（每个写请求都要用这一条，不要用上面的缓存）：
     * 缓存最多滞后一个心跳周期（15s）——被夺权的一方在这 15s 里仍会以为自己是 writer，
     * 若写门只看缓存，就有一段真实的双写窗口。这里直接读那一行，代价是一次主键查询。
     * 行不存在 / 是自己 / 对端已过期 ⇒ `writer`（过期由下一次心跳正式接管）。
     */
    instanceRoleFresh() {
      const row = readRow();
      if (!row) return "writer";
      if (selfId && row.instance_id === selfId) return "writer";
      const age = Date.now() - Number(row.heartbeat_at ?? 0);
      return age <= LEASE_TTL_MS ? "follower" : "writer";
    },

    /** 现读「谁在写」（搭配 instanceRoleFresh，仅 follower 时非 null）。 */
    instanceLeaseOwnerFresh() {
      const row = readRow();
      if (!row || (selfId && row.instance_id === selfId)) return null;
      const age = Date.now() - Number(row.heartbeat_at ?? 0);
      return age <= LEASE_TTL_MS ? describe(row) : null;
    },

    /** 释放租约（仅当本实例是持有者）。返回是否真的释放了。 */
    releaseInstanceLease() {
      const row = readRow();
      if (row && selfId && row.instance_id === selfId) {
        db.prepare("delete from db_instance_lease where id = 1").run();
        role = "writer"; owner = null;
        return true;
      }
      return false;
    },
  };
}

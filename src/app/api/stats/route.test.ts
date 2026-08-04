import { beforeEach, describe, expect, it } from "vitest";
import { getDb, run } from "@/lib/db";
import { GET } from "@/app/api/stats/route";
import { resetDb, seedDeployment, seedService } from "@/test/helpers";

beforeEach(async () => {
  await resetDb();
});

/** 路由无请求参数,GET 不接收 NextRequest —— 与 /api/health 的签名一致 */
async function readStats() {
  const res = await GET();
  expect(res.status).toBe(200);
  return res.json();
}

/**
 * 造一条带完整时长的终态记录。
 * seedDeployment 不接受 finished_at(现有用例都用不到),这里补一次 UPDATE。
 */
async function seedFinished(
  serviceId: number,
  status: "success" | "failed",
  startedAt: string,
  finishedAt: string
): Promise<number> {
  const id = await seedDeployment(serviceId, { status, started_at: startedAt });
  const db = await getDb();
  run(db, "UPDATE deployments SET finished_at = ? WHERE id = ?", [finishedAt, id]);
  return id;
}

/** 批量造非终态/无时长的记录,只关心状态计数 */
async function seedStatuses(name: string, statuses: string[]): Promise<number> {
  const serviceId = await seedService({ name });
  for (const status of statuses) {
    await seedDeployment(serviceId, { status });
  }
  return serviceId;
}

/**
 * Node 端独立算出的时长,用来交叉验证 SQLite strftime 差值的口径。
 * 字符串按本地时间解析(与 nowLocal() 的写入口径一致)。
 */
function durationSec(startedAt: string, finishedAt: string): number {
  const toDate = (s: string) => new Date(s.replace(" ", "T"));
  return (toDate(finishedAt).getTime() - toDate(startedAt).getTime()) / 1000;
}

/** by_env 单桶的字段集:6 个,刻意不含 avg_duration_sec */
const ENV_KEYS = ["failed", "mttr_sec", "pending", "success", "success_rate", "total"];

describe("GET /api/stats", () => {
  it("overall 返回全部 7 个字段,且都是有限数字", async () => {
    const id = await seedService({ name: "stats-shape" });
    await seedFinished(id, "success", "2026-08-03 14:00:00", "2026-08-03 14:01:00");

    const body = await readStats();
    expect(body.overall).toBeDefined();
    expect(Object.keys(body.overall).sort()).toEqual([
      "avg_duration_sec",
      "failed",
      "mttr_sec",
      "pending",
      "success",
      "success_rate",
      "total",
    ]);
    for (const [key, value] of Object.entries(body.overall)) {
      expect(typeof value, key).toBe("number");
      expect(Number.isFinite(value as number), key).toBe(true);
    }
  });

  it("空数据库 overall 返回全 0,不返回 null / NaN", async () => {
    const body = await readStats();
    expect(body.overall).toEqual({
      total: 0,
      success: 0,
      failed: 0,
      pending: 0,
      success_rate: 0,
      avg_duration_sec: 0,
      mttr_sec: 0,
    });
    // NaN 经 JSON.stringify 会变成 null,逐字段确认没踩到
    for (const [key, value] of Object.entries(body.overall)) {
      expect(value, key).not.toBeNull();
    }
  });

  it("全 success 时 overall.success_rate 为 1", async () => {
    await seedStatuses("stats-all-success", ["success", "success", "success"]);
    await expect(readStats()).resolves.toMatchObject({
      overall: {
        total: 3,
        success: 3,
        failed: 0,
        pending: 0,
        success_rate: 1,
      },
    });
  });

  it("全 failed 时 overall.success_rate 为 0", async () => {
    await seedStatuses("stats-all-failed", ["failed", "failed"]);
    await expect(readStats()).resolves.toMatchObject({
      overall: {
        total: 2,
        success: 0,
        failed: 2,
        pending: 0,
        success_rate: 0,
      },
    });
  });

  it("3 success + 1 failed 时 overall.success_rate 为 0.75", async () => {
    await seedStatuses("stats-mixed", ["success", "success", "success", "failed"]);
    await expect(readStats()).resolves.toMatchObject({
      overall: {
        total: 4,
        success: 3,
        failed: 1,
        success_rate: 0.75,
      },
    });
  });

  it("pending 不进成功率分母(3 success + 1 failed + 5 pending 仍是 0.75)", async () => {
    await seedStatuses("stats-pending-rate", [
      "success",
      "success",
      "success",
      "failed",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    await expect(readStats()).resolves.toMatchObject({
      overall: {
        pending: 5,
        success_rate: 0.75,
      },
    });
  });

  it("pending 计入 total 但不影响 success / failed 计数", async () => {
    await seedStatuses("stats-pending-total", [
      "success",
      "failed",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    const body = await readStats();
    const o = body.overall;
    expect(o).toMatchObject({ total: 7, success: 1, failed: 1, pending: 5 });
    expect(o.success + o.failed + o.pending).toBe(o.total);
  });

  it("overall.avg_duration_sec 是终态时长的平均,与 Node 端算法零偏差", async () => {
    const id = await seedService({ name: "stats-avg" });
    const first = { startedAt: "2026-08-03 14:00:00", finishedAt: "2026-08-03 14:01:00" };
    const second = { startedAt: "2026-08-03 15:00:00", finishedAt: "2026-08-03 15:03:00" };
    await seedFinished(id, "success", first.startedAt, first.finishedAt);
    await seedFinished(id, "failed", second.startedAt, second.finishedAt);

    const expected =
      (durationSec(first.startedAt, first.finishedAt) +
        durationSec(second.startedAt, second.finishedAt)) /
      2;
    expect(expected).toBe(120); // 60s 与 180s

    // SQLite 的 strftime 差值与 Node 的 Date 差值完全一致:两侧同样按 UTC 解析,
    // 时区偏移在相减时抵消(见 route.ts 注释),不需要任何补偿项
    await expect(readStats()).resolves.toMatchObject({
      overall: { avg_duration_sec: expected },
    });
  });

  it("overall.avg_duration_sec 只算终态,新增 pending 不改变结果", async () => {
    const id = await seedService({ name: "stats-avg-pending" });
    await seedFinished(id, "success", "2026-08-03 14:00:00", "2026-08-03 14:01:00");
    await seedFinished(id, "failed", "2026-08-03 15:00:00", "2026-08-03 15:03:00");
    const before = (await readStats()).overall.avg_duration_sec;
    expect(before).toBe(120);

    // pending 记录即使带 started_at 也不该进分母
    await seedDeployment(id, { status: "pending", started_at: "2026-08-03 16:00:00" });

    await expect(readStats()).resolves.toMatchObject({
      overall: {
        avg_duration_sec: before,
        pending: 1,
        total: 3,
      },
    });
  });

  it("overall.mttr_sec 只算 failed 那条的时长,不等于 avg", async () => {
    const id = await seedService({ name: "stats-mttr" });
    const success = { startedAt: "2026-08-03 14:00:00", finishedAt: "2026-08-03 14:00:30" };
    const failed = { startedAt: "2026-08-03 15:00:00", finishedAt: "2026-08-03 15:05:00" };
    await seedFinished(id, "success", success.startedAt, success.finishedAt);
    await seedFinished(id, "failed", failed.startedAt, failed.finishedAt);

    const body = await readStats();
    const o = body.overall;
    expect(o.mttr_sec).toBe(durationSec(failed.startedAt, failed.finishedAt));
    expect(o.mttr_sec).toBe(300);
    // avg 是两条的平均(30s 与 300s => 165s),与 mttr 必然不同 —— 证明 mttr 不是抄的 avg
    expect(o.avg_duration_sec).toBe(165);
  });

  it("没有 failed 记录时 overall.mttr_sec 为 0", async () => {
    const id = await seedService({ name: "stats-no-failed" });
    await seedFinished(id, "success", "2026-08-03 14:00:00", "2026-08-03 14:01:00");
    await seedDeployment(id, { status: "pending" });

    await expect(readStats()).resolves.toMatchObject({
      overall: {
        mttr_sec: 0,
        avg_duration_sec: 60,
      },
    });
  });

  it("没有终态记录时 overall.avg_duration_sec 为 0", async () => {
    await seedStatuses("stats-no-settled", ["pending", "pending"]);
    await expect(readStats()).resolves.toMatchObject({
      overall: {
        total: 2,
        pending: 2,
        avg_duration_sec: 0,
        mttr_sec: 0,
      },
    });
  });
});

describe("GET /api/stats by_env", () => {
  it("始终包含 test/staging/prod 三个 key", async () => {
    const body = await readStats();
    expect(body.by_env).toBeDefined();
    expect(Object.keys(body.by_env).sort()).toEqual(["prod", "staging", "test"]);
    for (const env of ["test", "staging", "prod"] as const) {
      expect(body.by_env[env]).toBeDefined();
      expect(body.by_env[env]).not.toBeNull();
    }
  });

  it("空库各 env 全 0(不是 undefined,也不含 null)", async () => {
    const body = await readStats();
    for (const env of ["test", "staging", "prod"] as const) {
      const e = body.by_env[env];
      expect(e, env).toEqual({
        total: 0,
        success: 0,
        failed: 0,
        pending: 0,
        success_rate: 0,
        mttr_sec: 0,
      });
      for (const [key, value] of Object.entries(e)) {
        expect(value, `${env}.${key}`).not.toBeNull();
        expect(Number.isFinite(value as number), `${env}.${key}`).toBe(true);
      }
    }
  });

  it("造一条 prod failed,by_env.prod.failed=1 且其他 env 不变", async () => {
    const id = await seedService({ name: "stats-env-isolation" });
    await seedFinished(id, "failed", "2026-08-03 10:00:00", "2026-08-03 10:02:00");

    const body = await readStats();
    expect(body.by_env.prod).toMatchObject({
      total: 1,
      failed: 1,
      success: 0,
      pending: 0,
      success_rate: 0,
      mttr_sec: 120,
    });
    // 其他 env 不被影响
    expect(body.by_env.test).toMatchObject({ total: 0, success: 0, failed: 0, pending: 0 });
    expect(body.by_env.staging).toMatchObject({ total: 0, success: 0, failed: 0, pending: 0 });
  });

  it("各 env 成功率独立:prod 全 failed → by_env.prod.success_rate=0,其他 env 不受影响", async () => {
    const prodId = await seedService({ name: "stats-env-rate-prod" });
    for (let i = 0; i < 3; i++) {
      await seedFinished(prodId, "failed", "2026-08-03 09:00:00", "2026-08-03 09:01:00");
    }
    // 平行造 staging 全 success,验证 staging 的 success_rate 仍是 1
    const stagingId = await seedService({ name: "stats-env-rate-staging" });
    await seedDeployment(stagingId, { status: "success", environment: "staging" });
    // test 不放任何记录

    const body = await readStats();
    expect(body.by_env.prod.success_rate).toBe(0);
    expect(body.by_env.prod.failed).toBe(3);
    expect(body.by_env.staging.success_rate).toBe(1);
    expect(body.by_env.staging.total).toBe(1);
    expect(body.by_env.test).toMatchObject({ total: 0, success_rate: 0 });
  });

  it("by_env 没有 avg_duration_sec 字段(防回归:有人手贱复制粘贴时把它加回来)", async () => {
    const id = await seedService({ name: "stats-env-no-avg" });
    await seedFinished(id, "success", "2026-08-03 14:00:00", "2026-08-03 14:01:00");

    const body = await readStats();
    for (const env of ["test", "staging", "prod"] as const) {
      const e = body.by_env[env];
      expect(Object.keys(e).sort(), env).toEqual(ENV_KEYS);
      expect(Object.prototype.hasOwnProperty.call(e, "avg_duration_sec"), `${env}.avg_duration_sec`).toBe(false);
    }
  });

  it("一个 env 全是 pending,断言 mttr_sec=0 而非 NaN", async () => {
    const id = await seedService({ name: "stats-env-pending-mttr" });
    await seedDeployment(id, { status: "pending", environment: "test" });
    await seedDeployment(id, { status: "pending", environment: "test" });
    await seedDeployment(id, { status: "pending", environment: "test" });

    const body = await readStats();
    // pending 进入 total / pending 计数,但没有 failed → mttr_sec 必须是 0(不能是 NaN)
    expect(body.by_env.test).toMatchObject({
      total: 3,
      pending: 3,
      success: 0,
      failed: 0,
      success_rate: 0,
      mttr_sec: 0,
    });
    expect(Number.isNaN(body.by_env.test.mttr_sec)).toBe(false);
    // 顺便把 mttr_sec 也逐字段确认是有限数
    expect(Number.isFinite(body.by_env.test.mttr_sec)).toBe(true);
  });
});

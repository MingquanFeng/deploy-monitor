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

describe("GET /api/stats", () => {
  it("200 返回全部 7 个字段,且都是有限数字", async () => {
    const id = await seedService({ name: "stats-shape" });
    await seedFinished(id, "success", "2026-08-03 14:00:00", "2026-08-03 14:01:00");

    const body = await readStats();
    expect(Object.keys(body).sort()).toEqual([
      "avg_duration_sec",
      "failed",
      "mttr_sec",
      "pending",
      "success",
      "success_rate",
      "total",
    ]);
    for (const [key, value] of Object.entries(body)) {
      expect(typeof value, key).toBe("number");
      expect(Number.isFinite(value as number), key).toBe(true);
    }
  });

  it("空数据库返回全 0,不返回 null / NaN", async () => {
    const body = await readStats();
    expect(body).toEqual({
      total: 0,
      success: 0,
      failed: 0,
      pending: 0,
      success_rate: 0,
      avg_duration_sec: 0,
      mttr_sec: 0,
    });
    // NaN 经 JSON.stringify 会变成 null,逐字段确认没踩到
    for (const [key, value] of Object.entries(body)) {
      expect(value, key).not.toBeNull();
    }
  });

  it("全 success 时 success_rate 为 1", async () => {
    await seedStatuses("stats-all-success", ["success", "success", "success"]);
    await expect(readStats()).resolves.toMatchObject({
      total: 3,
      success: 3,
      failed: 0,
      pending: 0,
      success_rate: 1,
    });
  });

  it("全 failed 时 success_rate 为 0", async () => {
    await seedStatuses("stats-all-failed", ["failed", "failed"]);
    await expect(readStats()).resolves.toMatchObject({
      total: 2,
      success: 0,
      failed: 2,
      pending: 0,
      success_rate: 0,
    });
  });

  it("3 success + 1 failed 时 success_rate 为 0.75", async () => {
    await seedStatuses("stats-mixed", ["success", "success", "success", "failed"]);
    await expect(readStats()).resolves.toMatchObject({
      total: 4,
      success: 3,
      failed: 1,
      success_rate: 0.75,
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
      pending: 5,
      success_rate: 0.75,
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
    expect(body).toMatchObject({ total: 7, success: 1, failed: 1, pending: 5 });
    expect(body.success + body.failed + body.pending).toBe(body.total);
  });

  it("avg_duration_sec 是终态时长的平均,与 Node 端算法零偏差", async () => {
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
    await expect(readStats()).resolves.toMatchObject({ avg_duration_sec: expected });
  });

  it("avg_duration_sec 只算终态,新增 pending 不改变结果", async () => {
    const id = await seedService({ name: "stats-avg-pending" });
    await seedFinished(id, "success", "2026-08-03 14:00:00", "2026-08-03 14:01:00");
    await seedFinished(id, "failed", "2026-08-03 15:00:00", "2026-08-03 15:03:00");
    const before = (await readStats()).avg_duration_sec;
    expect(before).toBe(120);

    // pending 记录即使带 started_at 也不该进分母
    await seedDeployment(id, { status: "pending", started_at: "2026-08-03 16:00:00" });

    await expect(readStats()).resolves.toMatchObject({
      avg_duration_sec: before,
      pending: 1,
      total: 3,
    });
  });

  it("mttr_sec 只算 failed 那条的时长,不等于 avg", async () => {
    const id = await seedService({ name: "stats-mttr" });
    const success = { startedAt: "2026-08-03 14:00:00", finishedAt: "2026-08-03 14:00:30" };
    const failed = { startedAt: "2026-08-03 15:00:00", finishedAt: "2026-08-03 15:05:00" };
    await seedFinished(id, "success", success.startedAt, success.finishedAt);
    await seedFinished(id, "failed", failed.startedAt, failed.finishedAt);

    const body = await readStats();
    expect(body.mttr_sec).toBe(durationSec(failed.startedAt, failed.finishedAt));
    expect(body.mttr_sec).toBe(300);
    // avg 是两条的平均(30s 与 300s => 165s),与 mttr 必然不同 —— 证明 mttr 不是抄的 avg
    expect(body.avg_duration_sec).toBe(165);
  });

  it("没有 failed 记录时 mttr_sec 为 0", async () => {
    const id = await seedService({ name: "stats-no-failed" });
    await seedFinished(id, "success", "2026-08-03 14:00:00", "2026-08-03 14:01:00");
    await seedDeployment(id, { status: "pending" });

    await expect(readStats()).resolves.toMatchObject({
      mttr_sec: 0,
      avg_duration_sec: 60,
    });
  });

  it("没有终态记录时 avg_duration_sec 为 0", async () => {
    await seedStatuses("stats-no-settled", ["pending", "pending"]);
    await expect(readStats()).resolves.toMatchObject({
      total: 2,
      pending: 2,
      avg_duration_sec: 0,
      mttr_sec: 0,
    });
  });
});

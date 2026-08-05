import { beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/trend/route";
import {
  plainRequest,
  resetDb,
  seedDeployment,
  seedService,
} from "@/test/helpers";

/**
 * 端点契约:
 *   GET /api/trend?days=N        N: 1-30,缺省 7
 *   400:  days 必须是 1-30 之间的整数
 *   200:  { days, granularity: "hour"|"day",
 *           points: [{ ts:"YYYY-MM-DD HH:00:00" | "YYYY-MM-DD 00:00:00",
 *                       test:    { total, failed },
 *                       staging: { total, failed },
 *                       prod:    { total, failed } }] }
 *   granularity:
 *     days <= 3 → "hour", points.length = days * 24
 *     days >  3 → "day",  points.length = days
 *
 * by_env 维度:
 *   - 每个 env 桶只有 total + failed 两个数字(与 /api/timeline 一致,
 *     与 /api/stats 的 by_env 区分开 —— stats 多 success/pending)
 *   - 空库时三个 env 都要出现 { total:0, failed:0 },前端画 3 条线要 3 个 key
 *   - 0 数据时间段在 JS 端按已知窗口补全(1h / 1d 步长)
 */

const URL_BASE = "http://localhost:3000/api/trend";

beforeEach(async () => {
  await resetDb();
});

function urlWithDays(days: string | number | undefined): string {
  if (days === undefined) return URL_BASE;
  return `${URL_BASE}?days=${encodeURIComponent(String(days))}`;
}

async function getTrend(
  days: string | number | undefined,
  expectedStatus: 200 | 400
): Promise<unknown> {
  const res = await GET(plainRequest("GET", urlWithDays(days)));
  expect(res.status, `status for days=${String(days)}`).toBe(expectedStatus);
  return res.json();
}

type TrendBody = {
  days: number;
  granularity: "hour" | "day";
  points: Array<{
    ts: string;
    test: { total: number; failed: number };
    staging: { total: number; failed: number };
    prod: { total: number; failed: number };
  }>;
};

async function readTrend(days: string | number | undefined): Promise<TrendBody> {
  return (await getTrend(days, 200)) as TrendBody;
}

/** 把 YYYY-MM-DD HH 字符串在 UTC 语义下倒推 N 小时,取小时部分。 */
function backHour(anchor: string, hoursBack: number): string {
  const [d, h] = anchor.split(" ");
  const [y, m, day] = d.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day, Number(h)));
  dt.setUTCHours(dt.getUTCHours() - hoursBack);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    dt.getUTCFullYear() +
    "-" + pad(dt.getUTCMonth() + 1) +
    "-" + pad(dt.getUTCDate()) +
    " " + pad(dt.getUTCHours())
  );
}

/** 倒推 N 天,返回 YYYY-MM-DD(UTC 语义下锚点倒推)。 */
function backDay(anchor: string, daysBack: number): string {
  const [y, m, d] = anchor.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - daysBack);
  return dt.toISOString().slice(0, 10);
}

/** 一个点上三个 env 的 total 之和(便于把旧测试里的「count=N」翻译到新形状)。 */
function sumTotal(p: TrendBody["points"][number]): number {
  return p.test.total + p.staging.total + p.prod.total;
}

/** 一个点上三个 env 的 failed 之和。 */
function sumFailed(p: TrendBody["points"][number]): number {
  return p.test.failed + p.staging.failed + p.prod.failed;
}

describe("GET /api/trend 输入校验", () => {
  it("400:days=0", async () => {
    await getTrend(0, 400);
  });
  it("400:days=31", async () => {
    await getTrend(31, 400);
  });
  it("400:days=-1", async () => {
    await getTrend(-1, 400);
  });
  it("400:days=abc", async () => {
    await getTrend("abc", 400);
  });
  it("400:days=7.5", async () => {
    await getTrend("7.5", 400);
  });

  it("400 响应包含 days 描述", async () => {
    const res = await GET(plainRequest("GET", urlWithDays(0)));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
    expect(body.error).toMatch(/1.*30/);
  });
});

describe("GET /api/trend 响应形状", () => {
  it("基础形状:days + granularity + points(每点 3 env × {total, failed})", async () => {
    const body = await readTrend(7);
    expect(typeof body.days).toBe("number");
    expect(["hour", "day"]).toContain(body.granularity);
    expect(Array.isArray(body.points)).toBe(true);
    for (const p of body.points) {
      expect(p).toMatchObject({
        ts: expect.any(String),
        test: { total: expect.any(Number), failed: expect.any(Number) },
        staging: { total: expect.any(Number), failed: expect.any(Number) },
        prod: { total: expect.any(Number), failed: expect.any(Number) },
      });
    }
  });

  it("缺省 days=7,granularity=day,points.length=7", async () => {
    const body = await readTrend(undefined);
    expect(body.days).toBe(7);
    expect(body.granularity).toBe("day");
    expect(body.points).toHaveLength(7);
  });

  it("明确 days=7,granularity=day,points.length=7", async () => {
    const body = await readTrend(7);
    expect(body.days).toBe(7);
    expect(body.granularity).toBe("day");
    expect(body.points).toHaveLength(7);
  });

  it("days=1 → granularity=hour,points.length=24", async () => {
    const body = await readTrend(1);
    expect(body.days).toBe(1);
    expect(body.granularity).toBe("hour");
    expect(body.points).toHaveLength(24);
    // 所有 ts 都是 YYYY-MM-DD HH:00:00 格式
    for (const p of body.points) {
      expect(p.ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:00:00$/);
    }
  });

  it("days=3 → granularity=hour,points.length=72", async () => {
    const body = await readTrend(3);
    expect(body.days).toBe(3);
    expect(body.granularity).toBe("hour");
    expect(body.points).toHaveLength(72);
  });

  it("days=4 → granularity=day,points.length=4", async () => {
    const body = await readTrend(4);
    expect(body.days).toBe(4);
    expect(body.granularity).toBe("day");
    expect(body.points).toHaveLength(4);
    for (const p of body.points) {
      expect(p.ts).toMatch(/^\d{4}-\d{2}-\d{2} 00:00:00$/);
    }
  });

  it("days=30 → granularity=day,points.length=30(上限)", async () => {
    const body = await readTrend(30);
    expect(body.days).toBe(30);
    expect(body.granularity).toBe("day");
    expect(body.points).toHaveLength(30);
  });
});

describe("GET /api/trend 0 数据占位", () => {
  it("空库时 points 全部 total/failed=0,长度严格 = days*24 / days", async () => {
    const bodyHour = await readTrend(2); // hour,24*2=48
    expect(bodyHour.points).toHaveLength(48);
    expect(bodyHour.points.every((p) => sumTotal(p) === 0 && sumFailed(p) === 0)).toBe(true);
    // 空库时三个 env key 都必须存在(前端画 3 条线要 3 个 key)
    for (const p of bodyHour.points) {
      expect(p).toHaveProperty("test");
      expect(p).toHaveProperty("staging");
      expect(p).toHaveProperty("prod");
    }

    const bodyDay = await readTrend(7); // day,7
    expect(bodyDay.points).toHaveLength(7);
    expect(bodyDay.points.every((p) => sumTotal(p) === 0 && sumFailed(p) === 0)).toBe(true);
  });
});

describe("GET /api/trend 时间序列单调性", () => {
  it("ts 字典序严格单调递增(hour 模式)", async () => {
    const body = await readTrend(2);
    for (let i = 1; i < body.points.length; i++) {
      expect(body.points[i].ts > body.points[i - 1].ts).toBe(true);
    }
  });

  it("ts 字典序严格单调递增(day 模式)", async () => {
    const body = await readTrend(7);
    for (let i = 1; i < body.points.length; i++) {
      expect(body.points[i].ts > body.points[i - 1].ts).toBe(true);
    }
  });

  it("days=2 hour 模式:最后一个 ts 是次日 23:00:00(连续递增 48 小时)", async () => {
    const body = await readTrend(2);
    expect(body.points).toHaveLength(48);
    const last = body.points[body.points.length - 1].ts;
    // 以 anchor 倒推 0 小时 = 当前 hour,与 last 比较应差 47 小时
    const anchor = last.slice(0, 13); // YYYY-MM-DD HH
    const head = body.points[0].ts.slice(0, 13);
    expect(head).toBe(backHour(anchor, 47));
  });
});

describe("GET /api/trend 数据归集", () => {
  it("同一小时分散造 5 条,该小时点 prod.total=5 / failed=0,其他 23 个点 sumTotal=0", async () => {
    const body = await readTrend(1); // hour,24
    const anchorHour = body.points[0].ts.slice(0, 13);

    const id = await seedService({ name: "trend-same-hour" });
    // 同一小时 5 个不同的分钟
    for (const mm of ["01", "05", "17", "33", "59"]) {
      await seedDeployment(id, {
        environment: "prod",
        status: "success",
        started_at: `${anchorHour}:${mm}:00`,
      });
    }

    const body2 = await readTrend(1);
    const targetTs = `${anchorHour}:00:00`;
    const lastIdx = body2.points.findIndex((p) => p.ts === targetTs);
    expect(lastIdx).toBeGreaterThanOrEqual(0);
    expect(body2.points[lastIdx].prod.total).toBe(5);
    expect(body2.points[lastIdx].prod.failed).toBe(0);
    // 其他 23 个小时仍为 0(env 都是 0)
    const otherSum = body2.points
      .filter((_, i) => i !== lastIdx)
      .reduce((acc, p) => acc + sumTotal(p), 0);
    expect(otherSum).toBe(0);
  });

  it("跨日期分散造数,对应日期点 staging.total 对得上", async () => {
    const body = await readTrend(7); // day,7
    const anchorDay = body.points[body.points.length - 1].ts.slice(0, 10);

    // 在锚点日的 0/2/5 天前各造 N 条 → 期望 staging.total=N
    const id = await seedService({ name: "trend-cross-day" });
    const offsets = [0, 2, 5];
    const counts = [3, 5, 7]; // 不同 days 前造不同数
    for (let i = 0; i < offsets.length; i++) {
      const target = backDay(anchorDay, offsets[i]);
      for (let k = 0; k < counts[i]; k++) {
        await seedDeployment(id, {
          environment: "staging",
          status: "success",
          started_at: `${target} 10:00:00`,
        });
      }
    }

    const body2 = await readTrend(7);
    const byTs = new Map(body2.points.map((p) => [p.ts, p]));
    for (let i = 0; i < offsets.length; i++) {
      const target = backDay(anchorDay, offsets[i]);
      const p = byTs.get(`${target} 00:00:00`)!;
      expect(p).toBeDefined();
      expect(p.staging.total).toBe(counts[i]);
    }
    // 不在 dates 里的日期仍 total=0
    const someOtherDay = body2.points.find(
      (p) =>
        p.ts !== `${backDay(anchorDay, 0)} 00:00:00` &&
        p.ts !== `${backDay(anchorDay, 2)} 00:00:00` &&
        p.ts !== `${backDay(anchorDay, 5)} 00:00:00`
    )!;
    expect(sumTotal(someOtherDay)).toBe(0);
  });

  it("env 不参与聚合的旧行为:同一天 prod+staging+test 各一条 → 当天 sumTotal=3(每个 env total=1)", async () => {
    const body = await readTrend(7);
    const anchorDay = body.points[body.points.length - 1].ts.slice(0, 10);

    const id = await seedService({ name: "trend-no-env" });
    await seedDeployment(id, { environment: "test", status: "success", started_at: `${anchorDay} 08:00:00` });
    await seedDeployment(id, { environment: "staging", status: "success", started_at: `${anchorDay} 09:00:00` });
    await seedDeployment(id, { environment: "prod", status: "success", started_at: `${anchorDay} 10:00:00` });

    const body2 = await readTrend(7);
    const last = body2.points[body2.points.length - 1];
    expect(last.ts).toBe(`${anchorDay} 00:00:00`);
    expect(last.test.total).toBe(1);
    expect(last.staging.total).toBe(1);
    expect(last.prod.total).toBe(1);
    expect(sumTotal(last)).toBe(3);
  });

  it("status 不区分:success / failed / pending 都计入 total,只有 failed 计入 failed", async () => {
    const body = await readTrend(7);
    const anchorDay = body.points[body.points.length - 1].ts.slice(0, 10);

    const id = await seedService({ name: "trend-no-status" });
    await seedDeployment(id, { status: "success", environment: "prod", started_at: `${anchorDay} 08:00:00` });
    await seedDeployment(id, { status: "failed", environment: "prod", started_at: `${anchorDay} 09:00:00` });
    await seedDeployment(id, { status: "pending", environment: "prod", started_at: `${anchorDay} 10:00:00` });

    const body2 = await readTrend(7);
    const last = body2.points[body2.points.length - 1];
    expect(last.prod.total).toBe(3);
    expect(last.prod.failed).toBe(1);
  });

  it("窗口外数据不计入:早于窗口的部署不出现", async () => {
    const body = await readTrend(3); // hour,72
    const anchorHour = body.points[body.points.length - 1].ts.slice(0, 13);

    const id = await seedService({ name: "trend-out-of-window" });
    // 4 天前:早于 days=3 窗口起点
    const outside = backHour(anchorHour, 24 * 4);
    await seedDeployment(id, {
      environment: "prod",
      status: "success",
      started_at: `${outside}:30:00`,
    });

    const body2 = await readTrend(3);
    expect(body2.points.every((p) => sumTotal(p) === 0)).toBe(true);
  });

  it("started_at IS NULL 的行不计入", async () => {
    const id = await seedService({ name: "trend-null-started-at" });
    // 直接 SQL 写入 started_at = NULL,绕过 helper 的 default "2026-01-01 00:00:00"
    const { getDb: getDbFn } = await import("@/lib/db");
    const db = await getDbFn();
    db.prepare(
      `INSERT INTO deployments
         (service_id, environment, version, status, deployed_by, note, started_at)
       VALUES (?, 'prod', 'v1.0.0', 'success', '', '', NULL)`
    ).run([id]);

    const body = await readTrend(7);
    // NULL 行被过滤,全部 total/failed=0
    expect(body.points.every((p) => sumTotal(p) === 0 && sumFailed(p) === 0)).toBe(true);
  });

  /**
   * 回归:曾经 SQL 窗口终点写的是 currentHour(锚点的"当前小时"),
   * 但 points 铺满今天 24 个小时 —— 于是当前小时之后的那些小时永远 count=0。
   * 夜间发布(22:00 之后)是常见场景,这个洞在白天跑测试时完全看不出来。
   * 这里显式往今天 23:00 写一条,它必须出现在最后一个点上。
   */
  it("今天当前小时之后的数据也要计入(窗口终点不能是 currentHour)", async () => {
    const body = await readTrend(1); // hour,24 个点,最后一个是今天 23:00
    const lastTs = body.points[body.points.length - 1].ts;
    expect(lastTs.endsWith(" 23:00:00")).toBe(true);

    const id = await seedService({ name: "trend-late-night" });
    await seedDeployment(id, {
      environment: "prod",
      status: "success",
      started_at: `${lastTs.slice(0, 13)}:47:00`,
    });

    const body2 = await readTrend(1);
    expect(body2.points[body2.points.length - 1]).toEqual({
      ts: lastTs,
      test: { total: 0, failed: 0 },
      staging: { total: 0, failed: 0 },
      prod: { total: 1, failed: 0 },
    });
  });
});

describe("GET /api/trend by_env 维度", () => {
  it("[1] 200 基础形状:points 每个都带 test/staging/prod × {total, failed}", async () => {
    const body = await readTrend(7);
    expect(body.days).toBe(7);
    expect(body.granularity).toBe("day");
    expect(body.points.length).toBe(7);
    for (const p of body.points) {
      expect(p).toHaveProperty("test");
      expect(p).toHaveProperty("staging");
      expect(p).toHaveProperty("prod");
      expect(p.test).toEqual({ total: expect.any(Number), failed: expect.any(Number) });
      expect(p.staging).toEqual({ total: expect.any(Number), failed: expect.any(Number) });
      expect(p.prod).toEqual({ total: expect.any(Number), failed: expect.any(Number) });
    }
  });

  it("[2] 每天点都有 test/staging/prod 三个 key(非空情况下也成立)", async () => {
    const body0 = await readTrend(7);
    const anchorDay = body0.points[body0.points.length - 1].ts.slice(0, 10);
    const id = await seedService({ name: "trend-three-keys" });
    await seedDeployment(id, { environment: "prod", status: "success", started_at: `${anchorDay} 09:00:00` });

    const body = await readTrend(7);
    const last = body.points[body.points.length - 1] as TrendBody["points"][number];
    expect(Object.keys(last).sort()).toEqual(["prod", "staging", "test", "ts"].sort());
  });

  it("[3] 空库各 env 都是 {total:0, failed:0}(前端画 3 条线需要 3 个 key)", async () => {
    const body = await readTrend(7);
    for (const p of body.points) {
      expect(p.test).toEqual({ total: 0, failed: 0 });
      expect(p.staging).toEqual({ total: 0, failed: 0 });
      expect(p.prod).toEqual({ total: 0, failed: 0 });
    }
  });

  it("[4] 造 N 条 prod failed(今天日期),断言对应点 prod.failed === N、test/staging 不变", async () => {
    const body0 = await readTrend(7);
    const anchorDay = body0.points[body0.points.length - 1].ts.slice(0, 10);

    const id = await seedService({ name: "trend-prod-failed" });
    const N = 4;
    for (let i = 0; i < N; i++) {
      await seedDeployment(id, {
        environment: "prod",
        status: "failed",
        started_at: `${anchorDay} ${String(8 + i).padStart(2, "0")}:00:00`,
      });
    }

    const body = await readTrend(7);
    const last = body.points[body.points.length - 1];
    expect(last.ts).toBe(`${anchorDay} 00:00:00`);
    expect(last.prod.failed).toBe(N);
    expect(last.prod.total).toBe(N); // 全部都是 failed
    expect(last.test).toEqual({ total: 0, failed: 0 });
    expect(last.staging).toEqual({ total: 0, failed: 0 });
  });

  it("[5] 跨 env 同日:prod+staging+test 各一条,断言当天 test.total=1, staging.total=1, prod.total=1", async () => {
    const body0 = await readTrend(7);
    const anchorDay = body0.points[body0.points.length - 1].ts.slice(0, 10);

    const id = await seedService({ name: "trend-cross-env-same-day" });
    await seedDeployment(id, { environment: "test", status: "success", started_at: `${anchorDay} 08:00:00` });
    await seedDeployment(id, { environment: "staging", status: "success", started_at: `${anchorDay} 09:00:00` });
    await seedDeployment(id, { environment: "prod", status: "success", started_at: `${anchorDay} 10:00:00` });

    const body = await readTrend(7);
    const last = body.points[body.points.length - 1];
    expect(last.test.total).toBe(1);
    expect(last.staging.total).toBe(1);
    expect(last.prod.total).toBe(1);
    expect(last.test.failed).toBe(0);
    expect(last.staging.failed).toBe(0);
    expect(last.prod.failed).toBe(0);
  });

  it("[6] status 区分:同 env 同日造 1 success + 1 failed,断言 total=2, failed=1", async () => {
    const body0 = await readTrend(7);
    const anchorDay = body0.points[body0.points.length - 1].ts.slice(0, 10);

    const id = await seedService({ name: "trend-status-mix" });
    await seedDeployment(id, { environment: "prod", status: "success", started_at: `${anchorDay} 08:00:00` });
    await seedDeployment(id, { environment: "prod", status: "failed", started_at: `${anchorDay} 09:00:00` });

    const body = await readTrend(7);
    const last = body.points[body.points.length - 1];
    expect(last.prod.total).toBe(2);
    expect(last.prod.failed).toBe(1);
    // 其他 env 不受波及
    expect(last.test).toEqual({ total: 0, failed: 0 });
    expect(last.staging).toEqual({ total: 0, failed: 0 });
  });

  it("[7] hour 模式 + 同 env 同小时 5 条,断言该小时点 test.total=5, failed=0", async () => {
    const body0 = await readTrend(1); // hour,24
    const anchorHour = body0.points[0].ts.slice(0, 13);

    const id = await seedService({ name: "trend-hour-5-test" });
    // 用 test env,5 条 success 都落在 anchorHour
    for (const mm of ["01", "05", "17", "33", "59"]) {
      await seedDeployment(id, {
        environment: "test",
        status: "success",
        started_at: `${anchorHour}:${mm}:00`,
      });
    }

    const body = await readTrend(1);
    const targetTs = `${anchorHour}:00:00`;
    const idx = body.points.findIndex((p) => p.ts === targetTs);
    expect(idx).toBeGreaterThanOrEqual(0);
    const p = body.points[idx];
    expect(p.test.total).toBe(5);
    expect(p.test.failed).toBe(0);
    expect(p.staging).toEqual({ total: 0, failed: 0 });
    expect(p.prod).toEqual({ total: 0, failed: 0 });
    // 其他 23 个小时仍为 0
    const otherSum = body.points
      .filter((_, i) => i !== idx)
      .reduce((acc, q) => acc + sumTotal(q), 0);
    expect(otherSum).toBe(0);
  });

  it("[8] 0 数据时间段占位:连续 7 天 day 模式只有 1 天有数据,其他 6 天仍带 3 个 env key 且全 0", async () => {
    const body0 = await readTrend(7);
    const anchorDay = body0.points[body0.points.length - 1].ts.slice(0, 10);

    const id = await seedService({ name: "trend-sparse-day" });
    // 仅在锚点日造 1 条 prod success
    await seedDeployment(id, {
      environment: "prod",
      status: "success",
      started_at: `${anchorDay} 10:00:00`,
    });

    const body = await readTrend(7);
    expect(body.points).toHaveLength(7);
    // 锚点日(最后一点)prod.total=1,其他全 0
    const last = body.points[body.points.length - 1];
    expect(last.prod.total).toBe(1);
    expect(last.test).toEqual({ total: 0, failed: 0 });
    expect(last.staging).toEqual({ total: 0, failed: 0 });
    // 其他 6 天每个都带 3 个 env key,且 total/failed 都是 0
    for (let i = 0; i < body.points.length - 1; i++) {
      const p = body.points[i];
      expect(p).toHaveProperty("test");
      expect(p).toHaveProperty("staging");
      expect(p).toHaveProperty("prod");
      expect(p.test).toEqual({ total: 0, failed: 0 });
      expect(p.staging).toEqual({ total: 0, failed: 0 });
      expect(p.prod).toEqual({ total: 0, failed: 0 });
    }
  });
});
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
 *                       count: number }] }
 *   granularity:
 *     days <= 3 → "hour", points.length = days * 24
 *     days >  3 → "day",  points.length = days
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

async function readTrend(days: string | number | undefined) {
  return (await getTrend(days, 200)) as {
    days: number;
    granularity: "hour" | "day";
    points: Array<{ ts: string; count: number }>;
  };
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
  it("基础形状:days + granularity + points", async () => {
    const body = await readTrend(7);
    expect(typeof body.days).toBe("number");
    expect(["hour", "day"]).toContain(body.granularity);
    expect(Array.isArray(body.points)).toBe(true);
    for (const p of body.points) {
      expect(p).toMatchObject({ ts: expect.any(String), count: expect.any(Number) });
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
  it("空库时 points 全部 count=0,长度严格 = days*24 / days", async () => {
    const bodyHour = await readTrend(2); // hour,24*2=48
    expect(bodyHour.points).toHaveLength(48);
    expect(bodyHour.points.every((p) => p.count === 0)).toBe(true);

    const bodyDay = await readTrend(7); // day,7
    expect(bodyDay.points).toHaveLength(7);
    expect(bodyDay.points.every((p) => p.count === 0)).toBe(true);
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
  it("同一小时分散造 5 条,该小时点 count=5,其他 23 个点 count=0", async () => {
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
    expect(body2.points[lastIdx].count).toBe(5);
    // 其他 23 个小时仍为 0
    const otherSum = body2.points
      .filter((_, i) => i !== lastIdx)
      .reduce((acc, p) => acc + p.count, 0);
    expect(otherSum).toBe(0);
  });

  it("跨日期分散造数,对应日期点 count 对得上", async () => {
    const body = await readTrend(7); // day,7
    const anchorDay = body.points[body.points.length - 1].ts.slice(0, 10);

    // 在锚点日的 0/2/5 天前各造 1 条 → 期望对应点 count=1
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
    const byTs = new Map(body2.points.map((p) => [p.ts, p.count]));
    for (let i = 0; i < offsets.length; i++) {
      const target = backDay(anchorDay, offsets[i]);
      expect(byTs.get(`${target} 00:00:00`)).toBe(counts[i]);
    }
    // 不在 dates 里的日期仍 count=0
    const someOtherDay = body2.points.find(
      (p) =>
        p.ts !== `${backDay(anchorDay, 0)} 00:00:00` &&
        p.ts !== `${backDay(anchorDay, 2)} 00:00:00` &&
        p.ts !== `${backDay(anchorDay, 5)} 00:00:00`
    )!;
    expect(someOtherDay.count).toBe(0);
  });

  it("env 不参与聚合:同一天 prod+staging+test 各一条 → 当天 count=3", async () => {
    const body = await readTrend(7);
    const anchorDay = body.points[body.points.length - 1].ts.slice(0, 10);

    const id = await seedService({ name: "trend-no-env" });
    await seedDeployment(id, { environment: "test", status: "success", started_at: `${anchorDay} 08:00:00` });
    await seedDeployment(id, { environment: "staging", status: "success", started_at: `${anchorDay} 09:00:00` });
    await seedDeployment(id, { environment: "prod", status: "success", started_at: `${anchorDay} 10:00:00` });

    const body2 = await readTrend(7);
    const last = body2.points[body2.points.length - 1];
    expect(last.ts).toBe(`${anchorDay} 00:00:00`);
    expect(last.count).toBe(3);
  });

  it("status 不区分:success / failed / pending 都计数", async () => {
    const body = await readTrend(7);
    const anchorDay = body.points[body.points.length - 1].ts.slice(0, 10);

    const id = await seedService({ name: "trend-no-status" });
    await seedDeployment(id, { status: "success", environment: "prod", started_at: `${anchorDay} 08:00:00` });
    await seedDeployment(id, { status: "failed", environment: "prod", started_at: `${anchorDay} 09:00:00` });
    await seedDeployment(id, { status: "pending", environment: "prod", started_at: `${anchorDay} 10:00:00` });

    const body2 = await readTrend(7);
    const last = body2.points[body2.points.length - 1];
    expect(last.count).toBe(3);
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
    expect(body2.points.every((p) => p.count === 0)).toBe(true);
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
    // NULL 行被过滤,全部 count=0
    expect(body.points.every((p) => p.count === 0)).toBe(true);
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
      count: 1,
    });
  });
});

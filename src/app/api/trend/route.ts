import { NextRequest, NextResponse } from "next/server";
import { getDb, query } from "@/lib/db";

/**
 * 部署趋势:近 N 天的部署计数,按 hour 或 day 聚合。
 *
 * 必须每次实时执行 —— 部署计数随时间变化,该路由没有静态化价值。
 * 同 /api/timeline 与 /api/health 的处理。
 */
export const dynamic = "force-dynamic";

/** 窗口上下界:1-30,缺省 7。非法值(含小数/负数/越界)→ 400 */
const DEFAULT_DAYS = 7;
const MIN_DAYS = 1;
const MAX_DAYS = 30;

/** 3 天以内保留小时细节,超过则降级到日,避免点过密看不清趋势 */
const HOUR_GRANULARITY_CUTOFF = 3;

type RawHourRow = {
  h: string; // substr(started_at, 1, 13) → 本地日历小时 YYYY-MM-DD HH
  count: number;
};
type RawDayRow = {
  d: string; // substr(started_at, 1, 10) → 本地日历日 YYYY-MM-DD
  count: number;
};

/**
 * 时区策略与 /api/timeline 完全一致:
 *   写入路径 src/lib/db.ts nowLocal() 已经把 started_at 写成本地时间
 *   字符串 YYYY-MM-DD HH:MM:SS,字面前缀就是写入者本地日历/小时,
 *   不依赖 SQLite 的 UTC/localtime 解释,跨编译与跨时区都稳定。
 *
 * 与 timeline 唯一差异:聚合键从字符 1-10(YYYY-MM-DD)改为 1-13(YYYY-MM-DD HH),
 * GROUP BY/having 同样用字符串字典序,闭区间过滤。
 */
function parseDays(raw: string | null): number | "invalid" {
  if (raw === null || raw === "") return DEFAULT_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_DAYS || n > MAX_DAYS) return "invalid";
  return n;
}

/**
 * 以「现在」的本地分量构造锚点时间,所有步进只动分量,不动 epoch——
 * 与 SQL 端的 substr 路线一致,不踩 SQLite 时区陷阱。
 *
 * 返回的 anchor 是一对 { day, hour } 字符串前缀:
 *   day  = YYYY-MM-DD
 *   hour = YYYY-MM-DD HH(整点)
 */
function anchorNow(): { day: string; hour: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const day =
    now.getFullYear() +
    "-" + pad(now.getMonth() + 1) +
    "-" + pad(now.getDate());
  const hour = day + " " + pad(now.getHours());
  return { day, hour };
}

/**
 * 给定本地日历日 dayKey = YYYY-MM-DD 与 hour offset,返回对应的 hourKey。
 *
 * 注意:小时分量的偏移只能跨日时变更日期部分 —— 用 baseMs + offset*3600*1000
 * 走 Date 的本地分量再 pad,与 timeline buildDayKey 同套路。
 *
 * 兼容性:输入若含小时段(如 "YYYY-MM-DD HH",hour 模式每次步进时再调用本函数),
 * split("-") 会因为 HH 段也含空格被错切。这里只信任前 10 个字符。
 */
function shiftHour(dayKey: string, hourOffset: number): string {
  const dayOnly = dayKey.slice(0, 10); // YYYY-MM-DD
  const [y, m, d] = dayOnly.split("-").map(Number);
  const baseMs = new Date(y, m - 1, d).getTime();
  const targetMs = baseMs + hourOffset * 3600 * 1000;
  const dt = new Date(targetMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    dt.getFullYear() +
    "-" + pad(dt.getMonth() + 1) +
    "-" + pad(dt.getDate()) +
    " " + pad(dt.getHours())
  );
}

/** 给定本地日历日 dayKey + day offset,返回 dayKey。 */
function shiftDay(dayKey: string, dayOffset: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const targetMs = new Date(y, m - 1, d).getTime() + dayOffset * 86400 * 1000;
  const dt = new Date(targetMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    dt.getFullYear() +
    "-" + pad(dt.getMonth() + 1) +
    "-" + pad(dt.getDate())
  );
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const days = parseDays(searchParams.get("days"));
  if (days === "invalid") {
    return NextResponse.json(
      { error: "days 必须是 1-30 之间的整数" },
      { status: 400 }
    );
  }

  const granularity: "hour" | "day" =
    days <= HOUR_GRANULARITY_CUTOFF ? "hour" : "day";

  const db = await getDb();
  const { day: today } = anchorNow();

  if (granularity === "hour") {
    // 窗口本地小时 [today - (N-1) days @ 00:00, today 23:00],闭区间长度 = days*24
    // 不要用 currentHour: WHERE 拿到当前小时之后就停了,但前端 points 铺满今天 24 小时,
    // 当前小时以后的点永远 count=0 —— 而夜间发布(22:00 以后)是常见场景。
    const windowStart = shiftHour(today, -(days - 1) * 24);
    const windowEnd = `${today} 23`;

    type Raw = RawHourRow;
    const rows = query<Raw>(
      db,
      `SELECT substr(started_at, 1, 13) AS h,
              COUNT(*)                 AS count
         FROM deployments
        WHERE started_at IS NOT NULL
          AND substr(started_at, 1, 13) >= ?
          AND substr(started_at, 1, 13) <= ?
        GROUP BY substr(started_at, 1, 13)`,
      [windowStart, windowEnd]
    );

    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.h, r.count);

    const totalPoints = days * 24;
    const points: { ts: string; count: number }[] = [];
    for (let i = 0; i < totalPoints; i++) {
      // 起点是 windowStart(=windowEnd - totalPoints + 1 hour)
      const ts = shiftHour(windowStart, i);
      points.push({ ts: `${ts}:00:00`, count: counts.get(ts) ?? 0 });
    }
    return NextResponse.json({ days, granularity, points });
  }

  // granularity === "day"
  const windowStart = shiftDay(today, -(days - 1));
  const windowEnd = today;

  type Raw = RawDayRow;
  const rows = query<Raw>(
    db,
    `SELECT substr(started_at, 1, 10) AS d,
            COUNT(*)                 AS count
       FROM deployments
      WHERE started_at IS NOT NULL
        AND substr(started_at, 1, 10) >= ?
        AND substr(started_at, 1, 10) <= ?
      GROUP BY substr(started_at, 1, 10)`,
    [windowStart, windowEnd]
  );

  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.d, r.count);

  const points: { ts: string; count: number }[] = [];
  for (let i = 0; i < days; i++) {
    const ts = shiftDay(windowStart, i);
    points.push({ ts: `${ts} 00:00:00`, count: counts.get(ts) ?? 0 });
  }
  return NextResponse.json({ days, granularity, points });
}

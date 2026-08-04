import { NextResponse } from "next/server";
import { getDb, query } from "@/lib/db";

/**
 * 聚合统计每次都要实时算。该路由没有请求参数,Next.js 会把它判定为可静态化
 * 并在构建期预渲染出一个「永远是构建那一刻的数字」的快照,面板将永远显示 0。
 * 同 /api/health 的处理。
 */
export const dynamic = "force-dynamic";

/**
 * 时长口径:`strftime('%s', ts)` 把不带时区后缀的字符串按 **UTC** 解析,
 * 而 started_at / finished_at 由 nowLocal() 写入的是本地时间 —— 单个时间戳
 * 转出的 epoch 确实偏了一个时区(东八区偏 -8h)。
 *
 * 但这里只取**两个时间戳的差**,两侧偏移量相同、相减抵消,结果与 Node 端
 * `(new Date(finished) - new Date(started)) / 1000` 完全一致(已实测,含跨日边界)。
 * 所以不需要 `- 8*3600` 之类的补偿 —— 补偿反而会把差值算错。
 *
 * 前提是本地时区不含夏令时跨越(中国无 DST)。若将来要部署到有 DST 的时区,
 * 时间字段应改为存 UTC 或带偏移的 ISO 串,而不是在这里打补丁。
 */
const DURATION_SEC = "strftime('%s', finished_at) - strftime('%s', started_at)";

/** 终态且时间戳完整,才有资格进时长统计 */
const MEASURABLE = "finished_at IS NOT NULL AND started_at IS NOT NULL";

type StatsRow = {
  total: number;
  success: number;
  failed: number;
  pending: number;
  avg_duration_sec: number;
  mttr_sec: number;
};

export async function GET() {
  const db = await getDb();

  // 一条 SQL 而非三条:计数与两个均值必须来自**同一次表扫描**。
  // 拆成多条独立 query 时,并发写入可能落在两条 query 之间,
  // 导致 total ≠ success + failed + pending 这种自相矛盾的响应。
  // 顺带只走一次全表扫描。
  //
  // COALESCE 兜住空集:AVG() 在 0 行时返回 NULL,契约要求返回 0。
  // SUM(status = 'x') 利用 SQLite 布尔即 0/1;0 行时 SUM 也是 NULL,同样兜住。
  const rows = query<StatsRow>(
    db,
    `SELECT
       COUNT(*)                                   AS total,
       COALESCE(SUM(status = 'success'), 0)       AS success,
       COALESCE(SUM(status = 'failed'), 0)        AS failed,
       COALESCE(SUM(status = 'pending'), 0)       AS pending,
       COALESCE(AVG(CASE WHEN status IN ('success','failed') AND ${MEASURABLE}
                         THEN ${DURATION_SEC} END), 0) AS avg_duration_sec,
       COALESCE(AVG(CASE WHEN status = 'failed' AND ${MEASURABLE}
                         THEN ${DURATION_SEC} END), 0) AS mttr_sec
     FROM deployments`
  );

  const r = rows[0];

  // 分母只算终态。pending 是「还没有结论」,把它计入分母会让刚触发的一批部署
  // 把成功率瞬间压低,是错误的信号。分母为 0 时返回 0 而非 NaN ——
  // NaN 经 JSON.stringify 会变成 null,前端拿到后所有算术都被污染。
  const settled = r.success + r.failed;
  const success_rate = settled === 0 ? 0 : r.success / settled;

  return NextResponse.json({
    total: r.total,
    success: r.success,
    failed: r.failed,
    pending: r.pending,
    success_rate,
    avg_duration_sec: r.avg_duration_sec,
    mttr_sec: r.mttr_sec,
  });
}

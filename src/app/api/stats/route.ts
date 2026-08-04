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

/** env 在 SQL 里硬编码为 test/staging/prod,与 CHECK 约束一致。
 * 不用 SELECT DISTINCT environment —— 空库时仍要保证三个 key 都出现,
 * 前端就不必再兜 null/undefined。 */
const ENVS = ["test", "staging", "prod"] as const;

type Env = (typeof ENVS)[number];

type AggregateRow = {
  env: string;
  total: number;
  success: number;
  failed: number;
  pending: number;
  avg_duration_sec: number;
  mttr_sec: number;
};

/** 按 env 分桶的契约:6 个字段,刻意不带 avg_duration_sec
 *  —— /stats 页面 by_env 卡层已有 MTTR,平均时长已折进 MTTR 的 sub 里
 * (详见 /stats 页面注释);只比总体少这一个字段,
 * 让前端类型更窄、TS 严格模式更受益。 */
type EnvStats = {
  total: number;
  success: number;
  failed: number;
  pending: number;
  success_rate: number;
  mttr_sec: number;
};

/** 单 SQL:4 条 UNION ALL 子查询(1 总体 + 3 env),各自输出 7 个指标。
 * 一次表扫描里读出所有桶 —— 与原实现的「单次表扫描保证一致性」同源:
 * 拆成多条 query 时,两次 query 之间并发写入会让 total ≠ success+failed+pending。
 * 现在 4 个桶共享同一次 FROM deployments 的扫描,SUM/COUNT 的快照原子,
 * 同一个 env 在桶内不会自相矛盾,且总体 = 三个 env 之和(也是测试要断言的不变量)。
 *
 * env 列用 `'__overall__'` 哨兵,区分总体那一行与三条 by_env 行;
 * UNION ALL 不会去重,4 行固定。
 *
 * COALESCE 兜住空集:AVG() 在 0 行时返回 NULL,契约要求返回 0。
 * SUM(status = 'x') 利用 SQLite 布尔即 0/1;0 行时 SUM 也是 NULL,同样兜住。 */
const AGGREGATE_SQL = `
  SELECT '__overall__' AS env,
         COUNT(*)                                   AS total,
         COALESCE(SUM(status = 'success'), 0)       AS success,
         COALESCE(SUM(status = 'failed'), 0)        AS failed,
         COALESCE(SUM(status = 'pending'), 0)       AS pending,
         COALESCE(AVG(CASE WHEN status IN ('success','failed') AND ${MEASURABLE}
                           THEN ${DURATION_SEC} END), 0) AS avg_duration_sec,
         COALESCE(AVG(CASE WHEN status = 'failed' AND ${MEASURABLE}
                           THEN ${DURATION_SEC} END), 0) AS mttr_sec
    FROM deployments
  UNION ALL
  SELECT 'test',
         COUNT(*)                                   AS total,
         COALESCE(SUM(status = 'success'), 0)       AS success,
         COALESCE(SUM(status = 'failed'), 0)        AS failed,
         COALESCE(SUM(status = 'pending'), 0)       AS pending,
         0                                          AS avg_duration_sec,
         COALESCE(AVG(CASE WHEN status = 'failed' AND ${MEASURABLE}
                           THEN ${DURATION_SEC} END), 0) AS mttr_sec
    FROM deployments WHERE environment = 'test'
  UNION ALL
  SELECT 'staging',
         COUNT(*)                                   AS total,
         COALESCE(SUM(status = 'success'), 0)       AS success,
         COALESCE(SUM(status = 'failed'), 0)        AS failed,
         COALESCE(SUM(status = 'pending'), 0)       AS pending,
         0                                          AS avg_duration_sec,
         COALESCE(AVG(CASE WHEN status = 'failed' AND ${MEASURABLE}
                           THEN ${DURATION_SEC} END), 0) AS mttr_sec
    FROM deployments WHERE environment = 'staging'
  UNION ALL
  SELECT 'prod',
         COUNT(*)                                   AS total,
         COALESCE(SUM(status = 'success'), 0)       AS success,
         COALESCE(SUM(status = 'failed'), 0)        AS failed,
         COALESCE(SUM(status = 'pending'), 0)       AS pending,
         0                                          AS avg_duration_sec,
         COALESCE(AVG(CASE WHEN status = 'failed' AND ${MEASURABLE}
                           THEN ${DURATION_SEC} END), 0) AS mttr_sec
    FROM deployments WHERE environment = 'prod'
`;

/** 分母只算终态。pending 是「还没有结论」,把它计入分母会让刚触发的一批部署
 * 把成功率瞬间压低,是错误的信号。分母为 0 时返回 0 而非 NaN ——
 * NaN 经 JSON.stringify 会变成 null,前端拿到后所有算术都被污染。 */
function successRate(row: { success: number; failed: number }): number {
  const settled = row.success + row.failed;
  return settled === 0 ? 0 : row.success / settled;
}

export async function GET() {
  const db = await getDb();
  const rows = query<AggregateRow>(db, AGGREGATE_SQL);

  const byEnvRows = new Map<Env, AggregateRow>();
  let overallRow: AggregateRow | undefined;
  for (const r of rows) {
    if (r.env === "__overall__") {
      overallRow = r;
    } else if ((ENVS as readonly string[]).includes(r.env)) {
      byEnvRows.set(r.env as Env, r);
    }
  }

  // SQL 必然产出 4 行,SQLite 永远不会丢 UNION ALL 的分支 —— 但若驱动未来换了,
  // 这里兜一下不让任何 env 出现 undefined。
  const overall: AggregateRow = overallRow ?? {
    env: "__overall__",
    total: 0,
    success: 0,
    failed: 0,
    pending: 0,
    avg_duration_sec: 0,
    mttr_sec: 0,
  };

  const by_env = Object.fromEntries(
    ENVS.map((env) => {
      const r = byEnvRows.get(env) ?? {
        env,
        total: 0,
        success: 0,
        failed: 0,
        pending: 0,
        avg_duration_sec: 0,
        mttr_sec: 0,
      };
      const stats: EnvStats = {
        total: r.total,
        success: r.success,
        failed: r.failed,
        pending: r.pending,
        success_rate: successRate(r),
        mttr_sec: r.mttr_sec,
      };
      return [env, stats];
    })
  ) as Record<Env, EnvStats>;

  return NextResponse.json({
    overall: {
      total: overall.total,
      success: overall.success,
      failed: overall.failed,
      pending: overall.pending,
      success_rate: successRate(overall),
      avg_duration_sec: overall.avg_duration_sec,
      mttr_sec: overall.mttr_sec,
    },
    by_env,
  });
}

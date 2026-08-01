import { NextResponse } from "next/server";
import { getDb, nowLocal, query } from "@/lib/db";

/**
 * 健康检查必须每次实时执行。
 * 该路由没有请求参数,Next.js 会把它判定为可静态化的路由并在构建期
 * 预渲染出一个「永远 status: ok」的快照 —— 容器编排 / 负载均衡拿到缓存响应后
 * 即使数据库已经挂了也会认为实例健康,探活彻底失效。
 */
export const dynamic = "force-dynamic";

type CheckStatus = "ok" | "error";

export async function GET() {
  let database: CheckStatus = "ok";
  try {
    const db = await getDb();
    // 轻量探针:只验证 sql.js 已初始化且能执行语句,不读业务表、不产生写入
    query(db, "SELECT 1");
  } catch {
    database = "error";
  }

  const healthy = database === "ok";

  // 503 而非 500:语义是「实例暂时不可用,请把流量摘走」,
  // 这是 k8s readinessProbe / ALB target group 判定 unhealthy 的标准信号。
  return NextResponse.json(
    {
      status: healthy ? "ok" : "error",
      timestamp: nowLocal(),
      checks: { database },
    },
    { status: healthy ? 200 : 503 }
  );
}

/**
 * 部署失败的 Server酱 通知。订阅 deployment.updated，
 * 仅在 pending → failed 这一次迁移时推一次。
 * 未配置 SERVERCHAN_KEY 时静默跳过。
 */
import { getDb, query } from "@/lib/db";
import type { ChangeEvent, DeploymentChangeEvent } from "@/lib/events";
import { subscribe } from "@/lib/events";

const SCF_API_BASE = process.env.SCF_API_BASE?.trim() || "https://sctapi.ftqq.com";

export function isNewFailure(
  event: ChangeEvent
): event is DeploymentChangeEvent & { type: "deployment.updated" } {
  return (
    event.type === "deployment.updated" &&
    event.previousStatus === "pending" &&
    event.status === "failed"
  );
}

async function handle(event: ChangeEvent): Promise<void> {
  if (!isNewFailure(event)) return;
  const key = process.env.SERVERCHAN_KEY?.trim();
  if (!key) return;

  const db = await getDb();
  const rows = query<{
    service_name: string;
    environment: string;
    version: string;
    deployed_by: string;
    finished_at: string | null;
    started_at: string | null;
  }>(
    db,
    `SELECT d.environment, d.version, d.deployed_by, d.started_at, d.finished_at,
            s.name AS service_name
       FROM deployments d
       JOIN services s ON d.service_id = s.id
      WHERE d.id = ?`,
    [event.deploymentId]
  );
  if (!rows.length) return;
  const row = rows[0];
  const dash = (v: string | null) => (v?.trim() ? v : "-");
  const envLabel = row.environment === "prod" ? "生产" : row.environment === "staging" ? "预发" : "测试";
  const title = row.environment === "prod"
    ? `[生产] ${row.service_name} 部署失败`
    : `${row.service_name} 部署失败（${envLabel}）`;
  const desp = [
    `服务：${row.service_name}`,
    `环境：${envLabel}`,
    `版本：${dash(row.version)}`,
    `部署人：${dash(row.deployed_by)}`,
    `时间：${dash(row.finished_at ?? row.started_at)}`,
  ].join("\n");

  try {
    const res = await fetch(`${SCF_API_BASE}/${key}.send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, desp }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(`[notify] Server酱 推送失败 HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }
  } catch (e) {
    console.warn(`[notify] Server酱 推送异常: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// 模块顶层自注册。详见 CLAUDE.md（不能用 instrumentation.ts）。
let stopExisting: (() => void) | null = null;
export function startFailureNotifier(): () => void {
  if (stopExisting) return stopExisting;
  const unsubscribe = subscribe((event) => void handle(event));
  stopExisting = () => {
    unsubscribe();
    stopExisting = null;
  };
  return stopExisting;
}
startFailureNotifier();
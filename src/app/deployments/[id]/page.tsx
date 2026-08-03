"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useToast } from "@/components/Toast";
import { useChangeStream } from "@/hooks/useChangeStream";
import { affectsService } from "@/lib/changeStream";
import {
  BUTTON_SECONDARY,
  ENV_LABELS,
  STATUS_BADGE,
  STATUS_GLYPH,
  STATUS_LABELS,
} from "@/lib/constants";
import { formatDateTime, parseDbDate } from "@/lib/format";
import type { Deployment } from "@/types";

/**
 * 耗时。started_at / finished_at 都是数据库写入的本地墙上时间，
 * 必须走 parseDbDate 解析（直接 new Date 会踩跨引擎的非标准兜底解析，
 * 见 src/lib/format.ts 顶部说明）。
 *
 * 任一端解析失败或算出负值（时钟漂移）时返回 null，调用方据此整行不渲染 ——
 * 显示「-1 分 0 秒」比不显示更糟。
 */
function formatDuration(
  startedAt: string,
  finishedAt: string
): string | null {
  const start = parseDbDate(startedAt);
  const end = parseDbDate(finishedAt);
  if (!start || !end) return null;

  const totalSec = Math.round((end.getTime() - start.getTime()) / 1000);
  if (totalSec < 0) return null;

  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min} 分 ${sec} 秒` : `${sec} 秒`;
}

/** 状态徽章。与列表页视觉一致：色块 + 字形（色盲用户不能只靠颜色区分）。 */
function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[status]}`}
    >
      <span aria-hidden="true">{STATUS_GLYPH[status]}</span>
      {STATUS_LABELS[status]}
    </span>
  );
}

/** 主体卡里的一个字段。用 dt/dd 而非 div，让读屏软件能把标签和值配对播报。 */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="mt-1 text-sm text-gray-900">{children}</dd>
    </div>
  );
}

/**
 * 相邻部署卡。deployment 为 null 时渲染虚线占位卡
 * —— 保持两列网格的高度与对齐，不让「没有上一条」把布局塌成一列。
 */
function AdjacentCard({
  label,
  emptyHint,
  deployment,
}: {
  label: string;
  emptyHint: string;
  deployment: Deployment | null;
}) {
  if (!deployment) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 p-4">
        <p className="text-xs text-gray-400">{label}</p>
        <p className="mt-2 text-sm text-gray-400">{emptyHint}</p>
      </div>
    );
  }

  return (
    <Link
      href={`/deployments/${deployment.id}`}
      className="block rounded-lg border border-gray-200 bg-white p-4 hover:border-gray-300 hover:shadow-sm transition"
    >
      <p className="text-xs text-gray-400">{label}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-gray-900">
          {deployment.version || "-"}
        </span>
        <span
          className={
            deployment.environment === "prod"
              ? "text-xs font-semibold text-gray-900"
              : "text-xs text-gray-600"
          }
        >
          {ENV_LABELS[deployment.environment]}
        </span>
        <StatusBadge status={deployment.status} />
      </div>
      <p className="mt-2 text-xs text-gray-500">
        {formatDateTime(deployment.started_at)}
      </p>
    </Link>
  );
}

/**
 * 「回滚自」指向的那条记录。三种状态必须可区分，不能都塌成 null：
 *   null        — 本条不是回滚（rollback_from 为空），字段整个不渲染
 *   "missing"   — 是回滚，但源记录已被删（GET 返回非 2xx），渲染纯文本兜底
 *   Deployment  — 源记录健在，渲染成可点的链接
 * 用 null 兼表「没有」和「查不到」会让被删的源记录静默消失，
 * 页面上看不出这是一次回滚 —— 恰好是回滚场景里最需要保留的信息。
 */
type RollbackSource = Deployment | "missing" | null;

export default function DeploymentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [siblings, setSiblings] = useState<Deployment[]>([]);
  const [rollbackSource, setRollbackSource] = useState<RollbackSource>(null);
  // 找不到（被别人删了 / URL 里的 id 不存在）与「还在加载」是两种状态，
  // 共用 deployment===null 会让删除后的页面永远停在「加载中...」。
  const [missing, setMissing] = useState(false);
  const [updating, setUpdating] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/deployments/${id}`);
    if (!res.ok) {
      setMissing(true);
      setDeployment(null);
      setSiblings([]);
      setRollbackSource(null);
      return;
    }
    const data: Deployment = await res.json();
    setMissing(false);
    setDeployment(data);

    /**
     * 回滚源。每次 load 都要先归零 —— load 会被 SSE 反复调用，
     * 不清空的话「源记录刚被删掉」这一步只会让 fetch 失败，
     * 旧的 Deployment 对象还留在 state 里，链接继续指向一条已经不存在的记录。
     *
     * 用 !== null 而非 truthy 判断：id 不会是 0，但 `if (data.rollback_from)`
     * 会把将来任何 0/"" 的脏数据也当成「不是回滚」而静默跳过。
     */
    if (data.rollback_from !== null && data.rollback_from !== undefined) {
      setRollbackSource(null);
      const srcRes = await fetch(`/api/deployments/${data.rollback_from}`);
      setRollbackSource(srcRes.ok ? await srcRes.json() : "missing");
    } else {
      setRollbackSource(null);
    }

    // 相邻部署要按 service_id 查，而这个字段只能从主数据里拿到，
    // 所以两次请求必须串行，不能并发发出去。
    const sibRes = await fetch(`/api/deployments?service_id=${data.service_id}`);
    if (sibRes.ok) setSiblings(await sibRes.json());
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * 复用 affectsService 而不是按 deploymentId 过滤 —— 本页的内容不止这一条记录：
   *   - 同服务新增部署 → 「下一条」相邻卡要变（deployment.created，deploymentId 不是本条）
   *   - 服务改名 → 标题里的 service_name 要变（service.updated，压根没有 deploymentId）
   *   - 服务被删 → 级联删掉本条，要重拉才能显示「不存在」（service.deleted）
   * 按 deploymentId 过滤会静默漏掉前三种，正好是最难发现的那类失效。
   *
   * deployment 尚未加载时不触发：那时还不知道自己属于哪个服务，
   * 首次数据由上面的 useEffect 负责。
   */
  useChangeStream((event) => {
    if (deployment && affectsService(event, deployment.service_id)) load();
  });

  const updateStatus = async (status: string) => {
    setUpdating(true);
    try {
      const res = await fetch(`/api/deployments/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        toast.error("状态更新失败");
        return;
      }
      toast.success(`已标记为「${STATUS_LABELS[status]}」`);
      // 主动重拉，不等 SSE 把自己的变更推回来 —— 断线重连窗口内事件会丢，
      // 那时用户点了按钮却看不到变化，会以为没生效而重复点击。
      await load();
    } finally {
      setUpdating(false);
    }
  };

  if (missing) {
    return (
      <div>
        <Link
          href="/deployments"
          className="mb-2 inline-block text-sm text-gray-500 hover:text-gray-900 hover:underline"
        >
          ← 返回部署列表
        </Link>
        <p className="text-gray-500">该部署记录不存在或已被删除。</p>
      </div>
    );
  }

  if (!deployment) return <div className="text-gray-500">加载中...</div>;

  /**
   * 相邻记录。列表接口按 started_at DESC 返回（见 GET /api/deployments），
   * 所以两侧取法不对称：
   *   - 更早的一批仍是 DESC，第一条就是时间上最接近的 → [0]
   *   - 更晚的一批也是 DESC，第一条是**最新**的那条，最接近的在末尾 → at(-1)
   * 两边都取 [0] 是这里最容易写错的地方：「下一条」会跳到该服务的最新部署，
   * 而不是紧挨着的下一条，且在只有两条记录时看起来完全正常。
   *
   * 字符串直接比较即可：格式固定为 YYYY-MM-DD HH:MM:SS，字典序等价于时间序。
   */
  const older = siblings.filter((d) => d.started_at < deployment.started_at);
  const newer = siblings.filter((d) => d.started_at > deployment.started_at);
  const prevDeployment = older[0] ?? null;
  const nextDeployment = newer.length ? newer[newer.length - 1] : null;

  const duration = deployment.finished_at
    ? formatDuration(deployment.started_at, deployment.finished_at)
    : null;

  return (
    <div>
      {/* 区块 A：头部 */}
      <div className="mb-6">
        <Link
          href="/deployments"
          className="mb-2 inline-block text-sm text-gray-500 hover:text-gray-900 hover:underline"
        >
          ← 返回部署列表
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">
            <Link
              href={`/services/${deployment.service_id}`}
              className="hover:text-blue-600 hover:underline"
            >
              {deployment.service_name}
            </Link>
          </h1>
          <span
            className={
              deployment.environment === "prod"
                ? "font-semibold text-gray-900"
                : "text-gray-600"
            }
          >
            {ENV_LABELS[deployment.environment]}
          </span>
        </div>
        <p className="mt-1 text-sm text-gray-500">
          部署于 {formatDateTime(deployment.started_at)}
        </p>
      </div>

      {/* 区块 B：主体卡 */}
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
          <Field label="版本">
            <span className="font-mono">{deployment.version || "-"}</span>
          </Field>
          <Field label="状态">
            <StatusBadge status={deployment.status} />
          </Field>
          <Field label="部署人">{deployment.deployed_by || "-"}</Field>
          <Field label="开始时间">
            {formatDateTime(deployment.started_at)}
          </Field>
          {/* pending 时没有结束时间可显示，整个字段不出现，而不是显示一个 "-" */}
          {deployment.finished_at && (
            <Field label="结束时间">
              {formatDateTime(deployment.finished_at)}
            </Field>
          )}
          {duration && <Field label="耗时">{duration}</Field>}
          {/* 回滚来源。只在本条确实是回滚时出现；源记录已删则退化为纯文本，
              不给一个点进去必然 404 的链接。 */}
          {rollbackSource && (
            <Field label="回滚自">
              {rollbackSource === "missing" ? (
                <span className="text-gray-500">
                  已删除的部署 #{deployment.rollback_from}
                </span>
              ) : (
                <Link
                  href={`/deployments/${rollbackSource.id}`}
                  className="font-mono text-blue-600 hover:underline"
                >
                  {rollbackSource.version || `#${rollbackSource.id}`}
                </Link>
              )}
            </Field>
          )}
        </dl>

        {deployment.note && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <p className="text-xs text-gray-500">备注</p>
            <p className="mt-1 whitespace-pre-wrap text-gray-600">
              {deployment.note}
            </p>
          </div>
        )}
      </div>

      {/* 区块 C：操作栏。pending 时是就地改状态，failed 时是发起回滚。
          两者互斥（状态机上 pending 与 failed 不可能同时成立），
          但仍写成两个独立分支而不是三元 —— 将来加 success 态的操作时不用重构。 */}
      {deployment.status === "pending" && (
        <div className="mt-4 flex gap-3">
          <button
            onClick={() => updateStatus("success")}
            disabled={updating}
            aria-label={`将 ${deployment.version || "该部署"} 标记为成功`}
            className="text-xs text-green-600 hover:underline disabled:opacity-40"
          >
            成功
          </button>
          <button
            onClick={() => updateStatus("failed")}
            disabled={updating}
            aria-label={`将 ${deployment.version || "该部署"} 标记为失败`}
            className="text-xs text-red-600 hover:underline disabled:opacity-40"
          >
            失败
          </button>
        </div>
      )}

      {/* 回滚入口。视觉权重高于上面的「成功/失败」纯文字按钮：那两个是
          就地改一个字段，这个会离开当前页去填一张表单，属于不同量级的动作。 */}
      {deployment.status === "failed" && (
        <div className="mt-4">
          <Link
            href={`/deployments/new?service_id=${deployment.service_id}&rollback_from=${deployment.id}`}
            className={BUTTON_SECONDARY}
          >
            回滚此版本
          </Link>
        </div>
      )}

      {/* 区块 D：相邻部署（同服务） */}
      <div className="mt-8 border-t border-gray-200 pt-6">
        <h2 className="mb-4 text-lg font-semibold">前后相邻部署</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <AdjacentCard
            label="上一条"
            emptyHint="这是该服务最早一条部署"
            deployment={prevDeployment}
          />
          <AdjacentCard
            label="下一条"
            emptyHint="这是该服务最新一条部署"
            deployment={nextDeployment}
          />
        </div>
      </div>
    </div>
  );
}

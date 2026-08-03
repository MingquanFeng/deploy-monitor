"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useToast } from "@/components/Toast";
import { useChangeStream } from "@/hooks/useChangeStream";
import { affectsService } from "@/lib/changeStream";
import {
  BUTTON_PRIMARY,
  CELL_CLASS,
  ENV_LABELS,
  INPUT_CLASS,
  STATUS_BADGE,
  STATUS_GLYPH,
  STATUS_LABELS,
} from "@/lib/constants";
import { formatDateTime } from "@/lib/format";
import type { Service, Deployment } from "@/types";

export default function ServiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [service, setService] = useState<Service | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [envFilter, setEnvFilter] = useState("");
  // 正在提交的部署 id 集合。按下后立刻禁用两个按钮,
  // 避免连点产生重复 PUT。
  const [updating, setUpdating] = useState<Set<number>>(new Set());

  const load = useCallback(() => {
    fetch(`/api/services/${id}`).then((r) => r.json()).then(setService);
    fetch(`/api/deployments?service_id=${id}`)
      .then((r) => r.json())
      .then(setDeployments);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  /**
   * 只关心本服务的事件。这是过滤收益最明显的一页：一个有几十个服务的实例上，
   * 别的服务频繁部署时本页完全不需要动 —— 不过滤的话每条事件都会触发两次 fetch。
   *
   * `id` 来自 useParams，是字符串；事件里的 serviceId 是数字，
   * 必须显式转换。用 === 直接比会永远为 false，且 TypeScript 不报错
   * （两边类型不同但比较合法），是个静默失效的坑。
   */
  useChangeStream((event) => {
    if (affectsService(event, Number(id))) load();
  });

  const updateStatus = async (depId: number, status: string) => {
    setUpdating((prev) => new Set(prev).add(depId));
    try {
      const res = await fetch(`/api/deployments/${depId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        toast.error("状态更新失败");
        return;
      }
      toast.success(`已标记为「${STATUS_LABELS[status]}」`);
      /**
       * 自己的操作仍然主动重拉，不依赖 SSE 把自己的变更推回来。
       * SSE 断线时（重连窗口内）事件会丢，此时用户点了按钮却看不到行变化，
       * 会以为没生效而重复点击。这次多余的 fetch 只在用户真的操作时发生，
       * 代价可忽略，换来的是「点了就一定有反应」这个确定性。
       */
      const listRes = await fetch(`/api/deployments?service_id=${id}`);
      setDeployments(await listRes.json());
    } finally {
      setUpdating((prev) => {
        const next = new Set(prev);
        next.delete(depId);
        return next;
      });
    }
  };

  const filtered = envFilter
    ? deployments.filter((d) => d.environment === envFilter)
    : deployments;

  if (!service) return <div className="text-gray-500">加载中...</div>;

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/services"
          className="mb-2 inline-block text-sm text-gray-500 hover:text-gray-900 hover:underline"
        >
          ← 返回服务列表
        </Link>
        <h1 className="text-2xl font-bold">{service.name}</h1>
        {service.description && (
          <p className="mt-1 text-gray-500">{service.description}</p>
        )}
        {service.owner && (
          <p className="mt-1 text-sm text-gray-400">负责人: {service.owner}</p>
        )}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">部署历史</h2>
        <label htmlFor="detail-env" className="sr-only">
          按环境筛选
        </label>
        <select
          id="detail-env"
          value={envFilter}
          onChange={(e) => setEnvFilter(e.target.value)}
          className={`${INPUT_CLASS} w-auto`}
        >
          <option value="">全部环境</option>
          <option value="test">测试</option>
          <option value="staging">预发</option>
          <option value="prod">生产</option>
        </select>
        <Link href="/deployments/new" className={`${BUTTON_PRIMARY} ml-auto`}>
          新建部署
        </Link>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full min-w-[820px] text-sm">
          <caption className="sr-only">
            {service.name} 的部署历史，共 {filtered.length} 条记录
          </caption>
          <thead className="bg-gray-50 text-left">
            <tr>
              <th scope="col" className={`${CELL_CLASS} font-medium text-gray-700`}>版本</th>
              <th scope="col" className={`${CELL_CLASS} font-medium text-gray-700`}>环境</th>
              <th scope="col" className={`${CELL_CLASS} font-medium text-gray-700`}>状态</th>
              <th scope="col" className={`${CELL_CLASS} font-medium text-gray-700`}>部署人</th>
              <th scope="col" className={`${CELL_CLASS} font-medium text-gray-700`}>开始时间</th>
              <th scope="col" className={`${CELL_CLASS} font-medium text-gray-700`}>备注</th>
              <th scope="col" className={`${CELL_CLASS} font-medium text-gray-700`}>操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((d) => {
              const busy = updating.has(d.id);
              return (
                <tr key={d.id} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className={`${CELL_CLASS} font-mono`}>
                    <Link href={`/deployments/${d.id}`} className="font-mono text-blue-600 hover:underline">
                      {d.version || "-"}
                    </Link>
                  </td>
                  <td className={CELL_CLASS}>
                    {/* 生产环境加粗,和 test/staging 拉开视觉权重。 */}
                    <span
                      className={
                        d.environment === "prod"
                          ? "font-semibold text-gray-900"
                          : "text-gray-600"
                      }
                    >
                      {ENV_LABELS[d.environment]}
                    </span>
                  </td>
                  <td className={CELL_CLASS}>
                    <span
                      className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${
                        STATUS_BADGE[d.status]
                      }`}
                    >
                      <span aria-hidden="true">{STATUS_GLYPH[d.status]}</span>
                      {STATUS_LABELS[d.status]}
                    </span>
                  </td>
                  <td className={CELL_CLASS}>{d.deployed_by || "-"}</td>
                  <td className={`${CELL_CLASS} whitespace-nowrap text-gray-500`}>
                    {formatDateTime(d.started_at)}
                  </td>
                  <td className={`${CELL_CLASS} max-w-[200px] truncate text-gray-500`}>
                    {d.note || "-"}
                  </td>
                  <td className={CELL_CLASS}>
                    {d.status === "pending" && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => updateStatus(d.id, "success")}
                          disabled={busy}
                          aria-label={`将 ${d.version || "该部署"} 标记为成功`}
                          className="text-xs text-green-600 hover:underline disabled:opacity-40"
                        >
                          成功
                        </button>
                        <button
                          onClick={() => updateStatus(d.id, "failed")}
                          disabled={busy}
                          aria-label={`将 ${d.version || "该部署"} 标记为失败`}
                          className="text-xs text-red-600 hover:underline disabled:opacity-40"
                        >
                          失败
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                  暂无部署记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

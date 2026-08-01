"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ENV_LABELS, STATUS_COLORS, STATUS_GLYPH, STATUS_LABELS } from "@/lib/constants";
import { formatRelativeTime } from "@/lib/format";
import type { Service, Deployment } from "@/types";

/** 状态指示:颜色 + 字形双编码,不让色盲用户只能靠颜色分辨。 */
function StatusDot({ status }: { status: string | null }) {
  if (!status) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-gray-200 text-[9px] leading-none text-gray-500"
      >
        –
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold leading-none text-white ${STATUS_COLORS[status]}`}
    >
      {STATUS_GLYPH[status]}
    </span>
  );
}

/** 顶部聚合条的单个数字。 */
function StatCard({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "danger" | "warning" | "ok";
}) {
  const tones = {
    neutral: "text-gray-900",
    danger: "text-red-600",
    warning: "text-yellow-600",
    ok: "text-green-600",
  } as const;

  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className={`mt-0.5 text-2xl font-semibold tabular-nums ${tones[tone]}`}>
        {value}
      </dd>
    </div>
  );
}

export default function Dashboard() {
  const [services, setServices] = useState<Service[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);

  useEffect(() => {
    fetch("/api/services").then((r) => r.json()).then(setServices);
    fetch("/api/deployments").then((r) => r.json()).then(setDeployments);
  }, []);

  const getLatestDeployments = (serviceId: number) => {
    const envs: Record<string, Deployment> = {};
    let lastDeployment: Deployment | null = null;
    // 列表已按 started_at DESC 排序,首个匹配即最新
    for (const d of deployments) {
      if (d.service_id !== serviceId) continue;
      if (!envs[d.environment]) envs[d.environment] = d;
      if (!lastDeployment) lastDeployment = d;
    }
    return { envs, lastDeployment };
  };

  /**
   * 聚合口径:只看每个「服务 × 环境」组合的最新一条。
   * 直接统计全表会把历史失败也算进去,那个数字只会越滚越大、
   * 无法回落,对「当前是否健康」没有指示意义。
   */
  const latestPerSlot = new Map<string, Deployment>();
  for (const d of deployments) {
    const key = `${d.service_id}:${d.environment}`;
    if (!latestPerSlot.has(key)) latestPerSlot.set(key, d);
  }
  const currentStates = [...latestPerSlot.values()];
  const failedCount = currentStates.filter((d) => d.status === "failed").length;
  const pendingCount = currentStates.filter((d) => d.status === "pending").length;

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">仪表盘</h1>

      <dl className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="服务总数" value={services.length} />
        <StatCard label="当前失败" value={failedCount} tone={failedCount > 0 ? "danger" : "neutral"} />
        <StatCard label="进行中" value={pendingCount} tone={pendingCount > 0 ? "warning" : "neutral"} />
        <StatCard label="部署记录" value={deployments.length} />
      </dl>

      {services.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white py-20 text-center text-gray-500">
          暂无服务，去{" "}
          <Link href="/services" className="text-blue-600 underline">
            服务管理
          </Link>{" "}
          创建一个吧
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {services.map((s) => {
            const { envs: latest, lastDeployment } = getLatestDeployments(s.id);
            const prod = latest.prod;
            return (
              <li key={s.id}>
                <Link
                  href={`/services/${s.id}`}
                  className="flex h-full flex-col rounded-lg border border-gray-200 bg-white p-5 transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  <h2 className="mb-1 text-lg font-semibold">{s.name}</h2>
                  {s.description && (
                    <p className="mb-3 text-sm text-gray-500">{s.description}</p>
                  )}

                  {/*
                    prod 单独提出来放大展示。生产环境挂了和测试环境挂了
                    不是一个量级的事,视觉权重应该体现这个差别。
                  */}
                  <div
                    className={`mt-auto flex items-center gap-2 rounded-md border px-3 py-2 ${
                      prod?.status === "failed"
                        ? "border-red-200 bg-red-50"
                        : "border-gray-200 bg-gray-50"
                    }`}
                  >
                    <StatusDot status={prod?.status ?? null} />
                    <span className="text-sm font-semibold text-gray-900">生产</span>
                    <span className="ml-auto text-xs text-gray-600">
                      {prod ? STATUS_LABELS[prod.status] : "暂无部署"}
                    </span>
                    {prod?.version && (
                      <span className="font-mono text-xs text-gray-500">{prod.version}</span>
                    )}
                  </div>

                  <div className="mt-2 flex gap-4">
                    {(["test", "staging"] as const).map((env) => {
                      const dep = latest[env];
                      return (
                        <div key={env} className="flex items-center gap-1.5">
                          <StatusDot status={dep?.status ?? null} />
                          <span className="text-xs text-gray-600">
                            {ENV_LABELS[env]}
                            <span className="sr-only">
                              ：{dep ? STATUS_LABELS[dep.status] : "暂无部署"}
                            </span>
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {s.owner && (
                    <p className="mt-3 text-xs text-gray-400">负责人: {s.owner}</p>
                  )}
                  <p className="mt-1 text-xs text-gray-400">
                    最后部署:{" "}
                    {lastDeployment
                      ? formatRelativeTime(lastDeployment.started_at)
                      : "暂无部署"}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

interface Service {
  id: number;
  name: string;
  description: string;
  owner: string;
}

interface Deployment {
  id: number;
  service_id: number;
  environment: string;
  version: string;
  status: string;
  deployed_by: string;
  note: string;
  started_at: string;
  finished_at: string | null;
}

const ENV_LABELS: Record<string, string> = {
  test: "测试",
  staging: "预发",
  prod: "生产",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "进行中",
  success: "成功",
  failed: "失败",
};

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  success: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

export default function ServiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [service, setService] = useState<Service | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [envFilter, setEnvFilter] = useState("");

  useEffect(() => {
    fetch(`/api/services/${id}`).then((r) => r.json()).then(setService);
    fetch(`/api/deployments?service_id=${id}`)
      .then((r) => r.json())
      .then(setDeployments);
  }, [id]);

  const updateStatus = async (depId: number, status: string) => {
    await fetch(`/api/deployments/${depId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const res = await fetch(`/api/deployments?service_id=${id}`);
    setDeployments(await res.json());
  };

  const filtered = envFilter
    ? deployments.filter((d) => d.environment === envFilter)
    : deployments;

  if (!service) return <div className="text-gray-500">加载中...</div>;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">{service.name}</h1>
        {service.description && (
          <p className="text-gray-500 mt-1">{service.description}</p>
        )}
        {service.owner && (
          <p className="text-sm text-gray-400 mt-1">负责人: {service.owner}</p>
        )}
      </div>

      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-lg font-semibold">部署历史</h2>
        <select
          value={envFilter}
          onChange={(e) => setEnvFilter(e.target.value)}
          className="border rounded px-2 py-1 text-sm"
        >
          <option value="">全部环境</option>
          <option value="test">测试</option>
          <option value="staging">预发</option>
          <option value="prod">生产</option>
        </select>
        <a
          href="/deployments/new"
          className="ml-auto text-sm bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700"
        >
          新建部署
        </a>
      </div>

      <div className="bg-white border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left">
            <tr>
              <th className="px-4 py-2">版本</th>
              <th className="px-4 py-2">环境</th>
              <th className="px-4 py-2">状态</th>
              <th className="px-4 py-2">部署人</th>
              <th className="px-4 py-2">开始时间</th>
              <th className="px-4 py-2">备注</th>
              <th className="px-4 py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((d) => (
              <tr key={d.id} className="border-t hover:bg-gray-50">
                <td className="px-4 py-2 font-mono">{d.version || "-"}</td>
                <td className="px-4 py-2">{ENV_LABELS[d.environment]}</td>
                <td className="px-4 py-2">
                  <span
                    className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                      STATUS_BADGE[d.status]
                    }`}
                  >
                    {STATUS_LABELS[d.status]}
                  </span>
                </td>
                <td className="px-4 py-2">{d.deployed_by || "-"}</td>
                <td className="px-4 py-2 text-gray-500">{d.started_at}</td>
                <td className="px-4 py-2 text-gray-500 max-w-[200px] truncate">
                  {d.note || "-"}
                </td>
                <td className="px-4 py-2">
                  {d.status === "pending" && (
                    <div className="flex gap-1">
                      <button
                        onClick={() => updateStatus(d.id, "success")}
                        className="text-green-600 hover:underline text-xs"
                      >
                        成功
                      </button>
                      <button
                        onClick={() => updateStatus(d.id, "failed")}
                        className="text-red-600 hover:underline text-xs"
                      >
                        失败
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
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

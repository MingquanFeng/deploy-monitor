"use client";

import { useEffect, useState } from "react";
import { ENV_LABELS, STATUS_LABELS, STATUS_BADGE } from "@/lib/constants";
import type { Deployment } from "@/types";

export default function DeploymentsPage() {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [envFilter, setEnvFilter] = useState("");
  const [search, setSearch] = useState("");

  const load = () => {
    const params = new URLSearchParams();
    if (envFilter) params.set("env", envFilter);
    fetch(`/api/deployments?${params}`)
      .then((r) => r.json())
      .then(setDeployments);
  };

  useEffect(() => { load(); }, [envFilter]);

  const filtered = search
    ? deployments.filter((d) =>
        d.service_name.toLowerCase().includes(search.toLowerCase())
      )
    : deployments;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">部署历史</h1>

      <div className="flex gap-3 mb-4 flex-wrap">
        <input
          placeholder="搜索服务名..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="border rounded px-3 py-1.5 text-sm flex-1 min-w-[200px]"
        />
        <select
          value={envFilter}
          onChange={(e) => setEnvFilter(e.target.value)}
          className="border rounded px-3 py-1.5 text-sm"
        >
          <option value="">全部环境</option>
          <option value="test">测试</option>
          <option value="staging">预发</option>
          <option value="prod">生产</option>
        </select>
      </div>

      <div className="bg-white border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left">
            <tr>
              <th className="px-4 py-2">服务</th>
              <th className="px-4 py-2">版本</th>
              <th className="px-4 py-2">环境</th>
              <th className="px-4 py-2">状态</th>
              <th className="px-4 py-2">部署人</th>
              <th className="px-4 py-2">时间</th>
              <th className="px-4 py-2">备注</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((d) => (
              <tr key={d.id} className="border-t hover:bg-gray-50">
                <td className="px-4 py-2 font-medium">{d.service_name}</td>
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

"use client";

import { useEffect, useState } from "react";

interface Service {
  id: number;
  name: string;
  description: string;
  owner: string;
}

interface Deployment {
  service_id: number;
  environment: string;
  status: string;
  started_at: string;
  version: string;
}

const ENV_LABELS: Record<string, string> = {
  test: "测试",
  staging: "预发",
  prod: "生产",
};

const STATUS_COLORS: Record<string, string> = {
  success: "bg-green-500",
  pending: "bg-yellow-500",
  failed: "bg-red-500",
};

export default function Dashboard() {
  const [services, setServices] = useState<Service[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);

  useEffect(() => {
    fetch("/api/services").then((r) => r.json()).then(setServices);
    fetch("/api/deployments").then((r) => r.json()).then(setDeployments);
  }, []);

  const getLatestDeployments = (serviceId: number) => {
    const envs: Record<string, Deployment> = {};
    for (const d of deployments) {
      if (d.service_id === serviceId && !envs[d.environment]) {
        envs[d.environment] = d;
      }
    }
    return envs;
  };

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">仪表盘</h1>
      {services.length === 0 ? (
        <div className="text-center text-gray-500 py-20">
          暂无服务，去{" "}
          <a href="/services" className="text-blue-600 underline">
            服务管理
          </a>{" "}
          创建一个吧
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {services.map((s) => {
            const latest = getLatestDeployments(s.id);
            return (
              <a
                key={s.id}
                href={`/services/${s.id}`}
                className="block bg-white rounded-lg border border-gray-200 p-5 hover:shadow-md transition-shadow"
              >
                <h2 className="text-lg font-semibold mb-1">{s.name}</h2>
                {s.description && (
                  <p className="text-sm text-gray-500 mb-3">{s.description}</p>
                )}
                <div className="flex gap-3">
                  {(["test", "staging", "prod"] as const).map((env) => {
                    const dep = latest[env];
                    return (
                      <div key={env} className="flex items-center gap-1.5">
                        <span
                          className={`w-2.5 h-2.5 rounded-full ${
                            dep ? STATUS_COLORS[dep.status] : "bg-gray-300"
                          }`}
                        />
                        <span className="text-xs text-gray-600">
                          {ENV_LABELS[env]}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {s.owner && (
                  <p className="text-xs text-gray-400 mt-3">负责人: {s.owner}</p>
                )}
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

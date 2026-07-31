"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Service } from "@/types";

export default function NewDeploymentPage() {
  const router = useRouter();
  const [services, setServices] = useState<Service[]>([]);
  const [serviceId, setServiceId] = useState("");
  const [env, setEnv] = useState("test");
  const [version, setVersion] = useState("");
  const [deployedBy, setDeployedBy] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch("/api/services").then((r) => r.json()).then(setServices);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);

    const res = await fetch("/api/deployments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id: Number(serviceId),
        environment: env,
        version,
        deployed_by: deployedBy,
        note,
      }),
    });

    if (!res.ok) {
      const data = await res.json();
      setError(data.error);
      setSubmitting(false);
      return;
    }

    router.push("/deployments");
  };

  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-bold mb-6">新建部署</h1>

      <form onSubmit={handleSubmit} className="bg-white border rounded-lg p-6 space-y-4">
        {error && <p className="text-red-600 text-sm">{error}</p>}

        <div>
          <label className="block text-sm font-medium mb-1">服务 *</label>
          <select
            value={serviceId}
            onChange={(e) => setServiceId(e.target.value)}
            className="w-full border rounded px-3 py-2 text-sm"
            required
          >
            <option value="">请选择服务</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">环境 *</label>
          <select
            value={env}
            onChange={(e) => setEnv(e.target.value)}
            className="w-full border rounded px-3 py-2 text-sm"
          >
            <option value="test">测试</option>
            <option value="staging">预发</option>
            <option value="prod">生产</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">版本号</label>
          <input
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder="v1.0.0"
            className="w-full border rounded px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">部署人</label>
          <input
            value={deployedBy}
            onChange={(e) => setDeployedBy(e.target.value)}
            className="w-full border rounded px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">备注</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            className="w-full border rounded px-3 py-2 text-sm"
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700 disabled:opacity-50 text-sm"
        >
          {submitting ? "提交中..." : "创建部署"}
        </button>
      </form>
    </div>
  );
}

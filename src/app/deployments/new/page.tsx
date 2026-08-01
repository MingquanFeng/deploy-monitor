"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import { BUTTON_PRIMARY, INPUT_CLASS, TEXTAREA_CLASS } from "@/lib/constants";
import type { Service } from "@/types";

export default function NewDeploymentPage() {
  const router = useRouter();
  const toast = useToast();
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
      toast.error(data.error || "创建部署失败");
      setSubmitting(false);
      return;
    }

    const serviceName = services.find((s) => String(s.id) === serviceId)?.name ?? "";
    toast.success(`${serviceName} 的部署记录已创建`);
    router.push("/deployments");
  };

  return (
    <div className="max-w-xl">
      <h1 className="mb-6 text-2xl font-bold">新建部署</h1>

      <form
        onSubmit={handleSubmit}
        className="space-y-4 rounded-lg border border-gray-200 bg-white p-6"
      >
        {error && (
          <p role="alert" aria-live="assertive" className="text-sm text-red-600">
            {error}
          </p>
        )}

        <div>
          <label htmlFor="dep-service" className="mb-1 block text-sm font-medium">
            服务 <span className="text-red-500">*</span>
          </label>
          <select
            id="dep-service"
            value={serviceId}
            onChange={(e) => setServiceId(e.target.value)}
            className={INPUT_CLASS}
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
          <label htmlFor="dep-new-env" className="mb-1 block text-sm font-medium">
            环境 <span className="text-red-500">*</span>
          </label>
          <select
            id="dep-new-env"
            value={env}
            onChange={(e) => setEnv(e.target.value)}
            className={INPUT_CLASS}
          >
            <option value="test">测试</option>
            <option value="staging">预发</option>
            <option value="prod">生产</option>
          </select>
          {/* 选中生产时给一句提示,降低误选的概率。 */}
          {env === "prod" && (
            <p className="mt-1.5 text-xs text-yellow-700">
              这条记录将标记为生产环境部署。
            </p>
          )}
        </div>

        <div>
          <label htmlFor="dep-version" className="mb-1 block text-sm font-medium">
            版本号
          </label>
          <input
            id="dep-version"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder="v1.0.0"
            className={INPUT_CLASS}
          />
        </div>

        <div>
          <label htmlFor="dep-by" className="mb-1 block text-sm font-medium">
            部署人
          </label>
          <input
            id="dep-by"
            value={deployedBy}
            onChange={(e) => setDeployedBy(e.target.value)}
            className={INPUT_CLASS}
          />
        </div>

        <div>
          <label htmlFor="dep-note" className="mb-1 block text-sm font-medium">
            备注
          </label>
          <textarea
            id="dep-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            className={TEXTAREA_CLASS}
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          // 只加 w-full。不要再叠 h-10:BUTTON_PRIMARY 里已有 h-9,
          // 两个 h-* 同时存在时谁生效取决于 Tailwind 生成的 CSS 顺序,
          // 而不是这里的书写顺序 —— 是个不会报错的坑。高度统一走 h-9。
          className={`${BUTTON_PRIMARY} w-full`}
        >
          {submitting ? "提交中..." : "创建部署"}
        </button>
      </form>
    </div>
  );
}

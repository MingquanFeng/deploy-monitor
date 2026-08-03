"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useToast } from "@/components/Toast";
import { BUTTON_PRIMARY, INPUT_CLASS, TEXTAREA_CLASS } from "@/lib/constants";
import type { Deployment, Service } from "@/types";

/**
 * 回滚目标的解析状态。四态而不是 `Deployment | null`：
 *   - null      URL 里没有 rollback_from，就是一次普通新建
 *   - loading   有参数、还在查 —— 此时先把服务下拉框锁住，避免用户刚点开
 *               能改、200ms 后突然变灰（且他的选择被覆盖）
 *   - failed    id 不存在 / 接口出错 → 降级成普通新建表单，不卡住用户
 *   - ready     拿到了被回滚的那条记录
 */
type RollbackState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; target: Deployment };

/**
 * useSearchParams() 会让整棵子树进入按需渲染，必须被 Suspense 包裹，
 * 否则 `next build` 直接失败（useSearchParams() should be wrapped in a
 * suspense boundary）。所以读参数的部分单独拆成这个组件，
 * 默认导出只负责套边界。
 */
function NewDeploymentForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useToast();

  const rollbackFromParam = searchParams.get("rollback_from");
  const serviceIdParam = searchParams.get("service_id");

  const [services, setServices] = useState<Service[]>([]);
  const [serviceId, setServiceId] = useState(serviceIdParam ?? "");
  const [env, setEnv] = useState("test");
  const [version, setVersion] = useState("");
  const [deployedBy, setDeployedBy] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [rollback, setRollback] = useState<RollbackState>(
    rollbackFromParam ? { kind: "loading" } : { kind: "none" }
  );

  useEffect(() => {
    fetch("/api/services")
      .then((r) => r.json())
      .then(setServices)
      .catch(() => setServices([]));
  }, []);

  /**
   * 拉取被回滚的那条记录。只在挂载时按参数跑一次，
   * 所以下面对 note / serviceId / env 的预填不会覆盖用户之后的编辑。
   */
  useEffect(() => {
    if (!rollbackFromParam) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/deployments/${rollbackFromParam}`);
        if (!res.ok) throw new Error("not found");
        const target: Deployment = await res.json();
        if (cancelled) return;

        setRollback({ kind: "ready", target });
        // 以记录里的 service_id 为准，而不是 URL 上的 service_id：
        // 两者不一致时（手改过地址栏）只有前者是对的 —— 回滚一定发生在
        // 被回滚记录所属的那个服务上。
        setServiceId(String(target.service_id));
        // 环境同理跟随目标记录。默认值 test 会让「回滚一次生产失败」
        // 静悄悄记到测试环境上，是个不会报错的错。
        setEnv(target.environment);
        setNote(`回滚 ${target.version || `#${target.id}`}`);
      } catch {
        if (!cancelled) setRollback({ kind: "failed" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [rollbackFromParam]);

  // 服务锁定：确定是回滚、或还在确认是不是回滚时都锁住。
  // failed 降级后恢复可选，此时表单与普通新建完全一致。
  const serviceLocked = rollback.kind === "ready" || rollback.kind === "loading";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // disabled 的 select 不参与浏览器原生校验，required 在锁定态形同虚设，
    // 这里补一道：没有服务就不该发出请求（否则会 POST service_id: 0）。
    if (!serviceId) {
      setError("请选择服务");
      return;
    }

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
        ...(rollback.kind === "ready"
          ? { rollback_from: rollback.target.id }
          : {}),
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
    toast.success(
      rollback.kind === "ready"
        ? `${serviceName} 的回滚记录已创建`
        : `${serviceName} 的部署记录已创建`
    );
    router.push("/deployments");
  };

  return (
    <div className="max-w-xl">
      <h1 className="mb-6 text-2xl font-bold">
        {rollback.kind === "ready" ? "新建回滚部署" : "新建部署"}
      </h1>

      <form
        onSubmit={handleSubmit}
        className="space-y-4 rounded-lg border border-gray-200 bg-white p-6"
      >
        {/* 回滚提示条。内容是异步到达的，用 aria-live 让已经聚焦在表单里的
            读屏用户也能知道这张表的性质变了。 */}
        <div aria-live="polite">
          {rollback.kind === "ready" && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              这是一次回滚操作，将回滚版本{" "}
              <Link
                href={`/deployments/${rollback.target.id}`}
                className="font-mono font-semibold underline hover:no-underline"
              >
                {rollback.target.version || `#${rollback.target.id}`}
              </Link>
              。服务已锁定为被回滚记录所属的服务。
            </div>
          )}
        </div>

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
            disabled={serviceLocked}
            aria-describedby={serviceLocked ? "dep-service-hint" : undefined}
            required
          >
            <option value="">请选择服务</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {rollback.kind === "ready" && (
            <p id="dep-service-hint" className="mt-1.5 text-xs text-gray-500">
              回滚只能针对同一个服务，此项不可更改。
            </p>
          )}
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
          {submitting
            ? "提交中..."
            : rollback.kind === "ready"
              ? "创建回滚部署"
              : "创建部署"}
        </button>
      </form>
    </div>
  );
}

export default function NewDeploymentPage() {
  return (
    <Suspense fallback={<div className="text-gray-500">加载中...</div>}>
      <NewDeploymentForm />
    </Suspense>
  );
}

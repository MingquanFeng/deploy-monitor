/**
 * 端到端验证部署失败通知（一次性验证脚本，不属于测试套件）。
 *
 * 用法：服务器需已在 3000 端口启动，且设置 SERVERCHAN_KEY 环境变量指向假服务器：
 *   SERVERCHAN_KEY=fake-key SCF_API_BASE=http://127.0.0.1:8791 node scripts/verify-notify.mjs
 *
 * 不填 SCF_API_BASE 则发往真实的 Server酱（不推荐，会推到你的微信）。
 */

import http from "http";

const APP = process.env.APP_BASE ?? "http://127.0.0.1:3000";
const SERVER = process.env.SCF_API_BASE ?? "https://sctapi.ftqq.com";
const PORT = Number(process.env.FAKE_SERVER_PORT ?? 8791);

const received = [];

const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ method: req.method, url: req.url, body: JSON.parse(body || "{}") });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 0, msg: "success" }));
  });
});

async function api(method, path, body) {
  const res = await fetch(`${APP}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* ignore */ }
  return { status: res.status, json, text };
}

async function waitFor(n, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (received.length >= n) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

await new Promise((r) => fake.listen(PORT, "127.0.0.1", () => r()));
console.log(`假 Server酱 服务器: localhost:${PORT}\n`);
console.log(`假 Server酱 服务器: ${SERVER.replace("https://", "")} -> localhost:${PORT}\n`);

const suffix = Date.now().toString(36);
const serviceName = `notify-e2e-${suffix}`;

console.log("1) 生产环境 pending → failed 应推送一条");
const svc = await api("POST", "/api/services", {
  name: serviceName,
  description: "端到端通知验证",
  owner: "verify-script",
});
if (svc.status !== 201) {
  console.error("建服务失败:", svc.status, svc.text.slice(0, 400));
  process.exit(1);
}
const serviceId = svc.json.id;

const dep = await api("POST", "/api/deployments", {
  service_id: serviceId,
  environment: "prod",
  version: "v9.9.9",
  deployed_by: "verify-script",
});
if (dep.status !== 201) {
  console.error("建部署记录失败:", dep.status, dep.text.slice(0, 400));
  process.exit(1);
}
const deploymentId = dep.json.id;

const put1 = await api("PUT", `/api/deployments/${deploymentId}`, { status: "failed" });
check("PUT 返回 200", put1.status === 200, `实际 ${put1.status}`);

const got = await waitFor(1);
check("假 Server酱 收到推送（listener 与路由同模块实例）", got,
  got ? "" : "8s 内没收到");

if (!got) {
  console.error("\n链路不通，后续断言无意义。");
  fake.close();
  process.exit(1);
}

const first = received[0];
console.log("\n--- 推送内容 ---");
console.log("标题:", first.body.title);
console.log("正文:\n" + first.body.desp);
console.log("------------------\n");

check("URL 含 /<key>.send", first.url?.includes(".send"), first.url ?? "(空)");
check("含服务名", String(first.body.title).includes(serviceName));
check("生产标题含 [生产]", String(first.body.title).startsWith("[生产]"));
check("正文含环境", first.body.desp.includes("生产"));
check("正文含版本", first.body.desp.includes("v9.9.9"));
check("正文含部署人", first.body.desp.includes("verify-script"));

console.log("\n2) 重复标记 failed 不应再推");
const before = received.length;
await api("PUT", `/api/deployments/${deploymentId}`, { status: "failed" });
await api("PUT", `/api/deployments/${deploymentId}`, { status: "failed" });
await new Promise((r) => setTimeout(r, 1500));
check("没有新增推送", received.length === before, `新增 ${received.length - before} 条`);

console.log("\n3) success → failed 不应推");
const before3 = received.length;
await api("PUT", `/api/deployments/${deploymentId}`, { status: "success" });
await api("PUT", `/api/deployments/${deploymentId}`, { status: "failed" });
await new Promise((r) => setTimeout(r, 1500));
check("没有新增推送", received.length === before3, `新增 ${received.length - before3} 条`);

console.log("\n4) 测试环境失败应收到推送");
const before4 = received.length;
const dep2 = await api("POST", "/api/deployments", {
  service_id: serviceId,
  environment: "test",
  version: "v0.0.1",
  deployed_by: "verify-script",
});
await api("PUT", `/api/deployments/${dep2.json.id}`, { status: "failed" });
const got4 = await waitFor(before4 + 1);
check("收到推送", got4);
if (got4) {
  const t = received[received.length - 1];
  check("标题不含 [生产]", !String(t.body.title).startsWith("[生产]"));
}

await api("DELETE", `/api/services/${serviceId}`);

fake.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.log("失败项:");
  for (const f of failed) console.log(`  - ${f.name} ${f.detail}`);
  process.exit(1);
}
console.log("端到端链路验证通过。");

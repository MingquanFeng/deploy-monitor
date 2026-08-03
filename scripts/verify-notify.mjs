/**
 * 端到端验证部署失败通知。
 *
 * 用法：启动 dev/standalone 时设 SCF_API_BASE=http://127.0.0.1:8791 把通知转到假服务器，
 * 然后跑这个脚本：
 *   APP_BASE=http://127.0.0.1:3000 node scripts/verify-notify.mjs
 *
 * 不设 SCF_API_BASE 则发到真实 Server酱（会推到你的微信）。
 */

import http from "node:http";

const APP = process.env.APP_BASE ?? "http://127.0.0.1:3000";
const PORT = Number(process.env.FAKE_SERVER_PORT ?? 8791);

const received = [];
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ url: req.url, body: JSON.parse(body || "{}") });
    res.end('{"code":0}');
  });
});

const api = (method, path, body) =>
  fetch(APP + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  }).then((r) => r.json());

const waitFor = (n, ms = 8000) =>
  new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const tick = () => (received.length >= n || Date.now() > deadline ? resolve() : setTimeout(tick, 100));
    tick();
  });

await new Promise((r) => fake.listen(PORT, "127.0.0.1", r));
console.log(`假 Server酱: localhost:${PORT}\n`);

const name = `verify-${Date.now().toString(36)}`;
const { id: serviceId } = await api("POST", "/api/services", { name, owner: "verify" });
const { id: depId } = await api("POST", "/api/deployments", {
  service_id: serviceId,
  environment: "prod",
  version: "v1",
  deployed_by: "verify",
});

console.log("1) pending → failed 应推送");
await api("PUT", `/api/deployments/${depId}`, { status: "failed" });
await waitFor(1);
console.log(`   收到 ${received.length} 条`);
const r = received[0];
console.log(`   标题: ${r.body.title}`);
console.log(`   正文:\n${r.body.desp.split("\n").map((l) => "   " + l).join("\n")}`);

console.log("\n2) failed → failed 不应再推");
const before = received.length;
await api("PUT", `/api/deployments/${depId}`, { status: "failed" });
await waitFor(before + 1, 1500);
console.log(`   新增 ${received.length - before} 条 ${received.length === before ? "✓" : "✗"}`);

console.log("\n3) success → failed 不应推");
const before2 = received.length;
await api("PUT", `/api/deployments/${depId}`, { status: "success" });
await api("PUT", `/api/deployments/${depId}`, { status: "failed" });
await waitFor(before2 + 1, 1500);
console.log(`   新增 ${received.length - before2} 条 ${received.length === before2 ? "✓" : "✗"}`);

await api("DELETE", `/api/services/${serviceId}`);
fake.close();
console.log(`\n总共收到 ${received.length} 条推送`);
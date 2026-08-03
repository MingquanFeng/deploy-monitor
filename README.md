# 部署监控面板

[![CI](https://github.com/MingquanFeng/deploy-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/MingquanFeng/deploy-monitor/actions/workflows/ci.yml)

轻量级服务部署状态监控面板，打开网页即可查看每个服务在各环境的部署状态，告别 SSH 看日志和群里问"上线了吗"。

## 功能

- **仪表盘** — 卡片式展示所有服务，绿/黄/红一目了然
- **服务管理** — 创建、编辑、删除服务，支持搜索
- **部署记录** — 手动录入部署，标记成功/失败
- **环境隔离** — 支持 test / staging / prod 三套环境
- **筛选查询** — 按服务名、环境灵活筛选部署历史

## 快速开始

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

访问 http://localhost:3000

## Docker 部署

```bash
# 准备环境变量（至少设置 WEBHOOK_TOKEN）
cp .env.example .env

# 构建并后台启动
docker compose up -d

# 查看日志
docker compose logs -f

# 停止
docker compose down
```

访问 http://localhost:3000

SQLite 数据文件通过命名卷 `deploy-monitor-data` 挂载到容器内 `/app/data`，
容器重建或升级镜像后数据不会丢失。如需彻底清除数据：

```bash
docker compose down -v
```

## 技术栈

| 层 | 选型 |
|----|------|
| 框架 | Next.js 15 (App Router) |
| 语言 | TypeScript |
| UI | Tailwind CSS |
| 数据库 | SQLite (better-sqlite3，原生驱动 + WAL) |

## 项目结构

```
src/
├── app/
│   ├── api/services/          # 服务 CRUD
│   ├── api/deployments/       # 部署记录 CRUD
│   ├── page.tsx               # 仪表盘首页
│   ├── services/              # 服务管理
│   └── deployments/           # 部署历史 & 新建部署
├── lib/db.ts                  # SQLite 数据库层
└── types/index.ts             # 类型声明
```

## API

```
GET    /api/services           # 服务列表
POST   /api/services           # 新建服务
GET    /api/services/:id       # 服务详情
PUT    /api/services/:id       # 更新服务
DELETE /api/services/:id       # 删除服务

GET    /api/deployments        # 部署历史 (?service_id=&env=)
POST   /api/deployments        # 新建部署记录
PUT    /api/deployments/:id    # 更新部署状态

POST   /api/webhook/deploy     # CI 接入（鉴权：Bearer WEBHOOK_TOKEN）

GET    /api/health             # 健康检查，供容器编排 / 负载均衡探活
```

### 健康检查

`GET /api/health` 无需鉴权，实时执行一次数据库探针后返回：

```json
{
  "status": "ok",
  "timestamp": "2026-07-31 22:30:00",
  "checks": { "database": "ok" }
}
```

数据库不可用时 `status` 与 `checks.database` 变为 `"error"`，HTTP 状态码为 **503**，
正常时为 **200**。docker-compose 已配置 `healthcheck` 调用该端点，
Kubernetes 可直接用作 `readinessProbe` / `livenessProbe`，
ALB / Nginx 可用作 upstream 健康检查路径。

### Webhook 接入

设置环境变量 `WEBHOOK_TOKEN` 后，CI 在部署完成后上报：

```bash
curl -X POST http://your-host/api/webhook/deploy \
  -H "Authorization: Bearer $WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "service": "user-service",
    "environment": "prod",
    "version": "v1.2.3",
    "status": "success",
    "deployed_by": "github-actions",
    "note": "deploy #456"
  }'
```

字段说明：
- `service`（必填）：服务名，需在面板中已存在
- `environment`（必填）：`test` / `staging` / `prod`
- `status`（可选，默认 `success`）：`pending` / `success` / `failed`
- `version` / `deployed_by` / `note`：可选

### 部署失败通知（Server酱）

配置以下环境变量后，部署状态从**进行中变为失败**时自动推送至微信：

```bash
# 登入 https://sct.ftqq.com/ 获取 SendKey
SERVERCHAN_KEY=your-sendkey-here
```

未配置时通知功能**静默关闭**，不影响其他功能、不打日志、不报错 —— 这是本地开发与未接入推送的部署的默认状态。

推送内容示例：

```
[生产] user-service 部署失败

服务：user-service
环境：生产
版本：v2.0.1
部署人：bob
时间：2026-08-03 10:30:00
```

生产环境的显著性体现在标题的 `[生产]` 前缀，通知列表预览行里第一行就能看出严重性。

**只在 `pending → failed` 这一次状态迁移时推送一次。** 重复把同一条记录标记为失败（`failed → failed`）不会重复推送；`success → failed` 视为人工纠正记录，也不推送。判定实现见 `isNewFailure()`（`src/lib/notify.ts`）。

通知复用 SSE 的进程内事件总线（`src/lib/events.ts`）：订阅一个 listener 监听 `deployment.updated`，而不是在各个写入点分别调用推送。推送失败（网络异常、Server酱返回错误）只记 `console.warn`，绝不影响已经成功落库的那次请求。

> 多副本部署时，事件总线是进程内的，通知由处理该写请求的实例推送 —— 恰好只推一次。但若按 `src/lib/events.ts` 的建议改造成 Redis Pub/Sub 跨实例广播，必须额外处理跨实例去重。

## License

[MIT](LICENSE)

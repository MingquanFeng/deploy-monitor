# 部署监控面板

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

## 技术栈

| 层 | 选型 |
|----|------|
| 框架 | Next.js 15 (App Router) |
| 语言 | TypeScript |
| UI | Tailwind CSS |
| 数据库 | SQLite (sql.js WASM) |

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
└── types/sql.js.d.ts          # 类型声明
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
```

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

## License

[MIT](LICENSE)

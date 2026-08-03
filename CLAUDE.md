# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

部署监控面板 — 网页界面，实时查看各服务部署状态（绿/黄/红），支持服务管理、手动录入部署记录、按服务/环境筛选。

## 常用命令

```bash
npm run dev      # 开发服务器 http://localhost:3000
npm run build    # 生产构建
npm run start    # 启动生产服务
npm run lint     # ESLint 检查
```

## 技术栈

- **框架**: Next.js 15 App Router + TypeScript
- **UI**: Tailwind CSS（无组件库，纯实用类）
- **数据库**: SQLite via `better-sqlite3`（原生同步驱动，启用 WAL），数据库文件位于 `data/deploy.db`（gitignore）

> 需要 Node >= 22（`better-sqlite3@13` 的 `engines` 要求）。Dockerfile 与 CI 均为 node 22。

## 架构要点

### 数据库层 (`src/lib/db.ts`)

使用 `better-sqlite3`（原生同步驱动）。连接在模块顶层建立，同时设好 WAL、`foreign_keys`、`busy_timeout` 等连接级 PRAGMA。

驱动本身是同步的，但 `getDb()` 仍保留 `async` 签名——16 处调用点都写着 `await getDb()`，维持该契约让驱动替换对上层零改动。

- `getDb(): Promise<Db>` — 取连接（单例）
- `query<T>(db, sql, params)` — 查询，返回 `T[]`
- `run(db, sql, params)` — 执行写操作，返回 void
- `runInfo(db, sql, params)` — 执行写操作并返回 `{ changes, lastInsertRowid }`；INSERT 后需要新行 id 时用它
- `isUniqueViolation(e)` — 判定 UNIQUE 冲突（优先用结构化 `e.code === "SQLITE_CONSTRAINT_UNIQUE"`，并保留 message 兜底）
- `nowLocal()` — 返回 `YYYY-MM-DD HH:MM:SS` 本地时间

写入直接落盘，**没有** `save()` 这类手动持久化步骤。WAL 会在数据目录额外产生 `deploy.db-wal` / `deploy.db-shm`，已被 `.gitignore` 的 `data/` 规则覆盖。

`next.config.ts` 有两处必需配置：
- `serverExternalPackages: ["better-sqlite3"]` — 原生 `.node` 模块不能被 webpack 打包
- `outputFileTracingIncludes` 显式包含 `better-sqlite3/prebuilds/**` — 该包在运行时按 `${platform}-${arch}` 拼字符串 `require` 二进制，静态分析跟不到，不显式声明则 standalone 启动即报 "Cannot find module"

### API 路由模式

所有路由在 `src/app/api/` 下，使用 Next.js App Router Route Handlers。

写操作流程：
```ts
const db = await getDb();
run(db, "INSERT INTO ...", [params]);
const rows = query(db, "SELECT * FROM ... WHERE id = ?", [id]);
return NextResponse.json(rows[0]);
```

INSERT 后需要回读新建的那一行时，用 `lastInsertRowid` 精确定位，不要用 `ORDER BY id DESC LIMIT 1`：
```ts
const info = runInfo(db, "INSERT INTO deployments (...) VALUES (...)", [params]);
const rows = query(db, "SELECT * FROM deployments WHERE id = ?", [Number(info.lastInsertRowid)]);
```

`POST /api/services` 与 `PUT /api/services/[id]` 用 `isUniqueViolation(e)` 判断服务名重复并返回 409。

**面向页面的部署记录查询要 JOIN 出 `service_name`**，不要裸 `SELECT * FROM deployments`：

```ts
query(db, `SELECT d.*, s.name AS service_name
             FROM deployments d JOIN services s ON d.service_id = s.id
            WHERE d.id = ?`, [idNum]);
```

`src/types/index.ts` 的 `Deployment` 把 `service_name` 声明为必填 `string`，但该列不在 `deployments` 表上，只由 JOIN 产出。裸 SELECT 少这个字段而 `query<T>` 是无校验断言，TS 不报错，前端到运行时才拿到 `undefined`。`GET /api/deployments` 与 `GET /api/deployments/[id]` 都已 JOIN；`POST` / `PUT` 的回读没有（它们的调用方不读 service_name）。

### 数据模型

`services` 表：id, name(UNIQUE), description, owner, created_at  
`deployments` 表：id, service_id(FK→services), environment(test/staging/prod), version, status(pending/success/failed), deployed_by, note, started_at, finished_at

外键级联删除：删除服务会同时删除其所有部署记录。

### 部署失败通知 (`src/lib/notify.ts`)

`pending → failed` 迁移时通过 Server酱 推送至微信。配置 `SERVERCHAN_KEY`，未配置静默跳过（不报错、不打日志）。

判据是状态迁移，不是当前状态。`DeploymentChangeEvent` 带 `status` / `previousStatus` 两个可选字段，前态由 `PUT /api/deployments/[id]` 在 `UPDATE` **之前**读出 —— `publish()` 发生在 UPDATE 之后，那时库里已经查不到改动前的值。

注册方式：`src/lib/notify.ts` 模块顶层自注册，由 `PUT /api/deployments/[id]` 用副作用 import 拉进来。不要改成 `src/instrumentation.ts` —— Next 15.1 下 webpack 把 instrumentation打进独立 chunk，进程里出现两份 `events.ts` 实例，通知静默失效且无报错；附带的 Edge runtime 编译问题会让全部路由返回 500。详见 CLAUDE.md。

`console.warn` 而非抛错：链路起点是一次已成功落库的 PUT，通知失败不能影响那个 200。`send()` 内部自己收干净所有异常。

`SCF_API_BASE` 仅用于端到端验证（指向假服务器），生产不设置。验证脚本 `scripts/verify-notify.mjs` 已同步更新。

### 页面路由

| 路径 | 类型 | 说明 |
|------|------|------|
| `/` | 客户端组件 | 仪表盘，服务卡片+状态颜色 |
| `/services` | 客户端组件 | 服务列表+新建+搜索 |
| `/services/[id]` | 客户端组件 | 服务详情+部署历史+状态更新 |
| `/deployments` | 客户端组件 | 全局部署历史+服务名搜索+环境筛选 |
| `/deployments/[id]` | 客户端组件 | 单条部署详情+状态更新+同服务相邻部署 |
| `/deployments/new` | 客户端组件 | 新建部署表单 |

所有页面都是 `"use client"` 客户端组件，通过 `fetch` 调用 API。

### 类型声明

数据库类型由 `@types/better-sqlite3` 提供（官方 DefinitelyTyped 包），无需手写声明文件。
`src/lib/db.ts` 再导出 `Db` 类型别名（即 `Database.Database`），业务代码统一用它标注数据库参数。

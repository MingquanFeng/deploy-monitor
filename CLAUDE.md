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

### 数据模型

`services` 表：id, name(UNIQUE), description, owner, created_at  
`deployments` 表：id, service_id(FK→services), environment(test/staging/prod), version, status(pending/success/failed), deployed_by, note, started_at, finished_at

外键级联删除：删除服务会同时删除其所有部署记录。

### 页面路由

| 路径 | 类型 | 说明 |
|------|------|------|
| `/` | 客户端组件 | 仪表盘，服务卡片+状态颜色 |
| `/services` | 客户端组件 | 服务列表+新建+搜索 |
| `/services/[id]` | 客户端组件 | 服务详情+部署历史+状态更新 |
| `/deployments` | 客户端组件 | 全局部署历史+服务名搜索+环境筛选 |
| `/deployments/new` | 客户端组件 | 新建部署表单 |

所有页面都是 `"use client"` 客户端组件，通过 `fetch` 调用 API。

### 类型声明

数据库类型由 `@types/better-sqlite3` 提供（官方 DefinitelyTyped 包），无需手写声明文件。
`src/lib/db.ts` 再导出 `Db` 类型别名（即 `Database.Database`），业务代码统一用它标注数据库参数。

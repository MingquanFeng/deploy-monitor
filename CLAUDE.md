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
- **数据库**: SQLite via `sql.js`（WASM，无需原生编译），数据库文件位于 `data/deploy.db`（gitignore）

## 架构要点

### 数据库层 (`src/lib/db.ts`)

使用 `sql.js`（WASM 版 SQLite），模块顶层异步初始化。所有 API 路由必须 `await getDb()` 获取数据库实例。

- `query<T>(db, sql, params)` — 查询，返回 `T[]`
- `run(db, sql, params)` — 执行写操作，**自动调用 `save()` 将内存数据库写回磁盘**
- `save()` — 手动持久化（一般不需要直接调用，`run` 已内置）

`next.config.ts` 中 `serverExternalPackages: ["sql.js"]` 是必需配置，防止 webpack 打包 WASM 模块导致运行时报错。

### API 路由模式

所有路由在 `src/app/api/` 下，使用 Next.js App Router Route Handlers。

写操作流程：
```ts
const db = await getDb();
run(db, "INSERT INTO ...", [params]);  // 自动持久化
const rows = query(db, "SELECT * FROM ... WHERE id = ?", [id]);
return NextResponse.json(rows[0]);
```

`POST /api/services` 需处理 UNIQUE 约束错误（服务名重复返回 409）。

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

`src/types/sql.js.d.ts` 为 sql.js 提供 TypeScript 类型，必须保留。

# MVP 功能规格（Phase 1）

## 功能清单

### 1. 服务管理
- 新建服务：名称、描述、负责人
- 编辑 / 删除服务
- 每个服务支持多个环境（test / staging / prod）

### 2. 部署记录（手动录入）
- 选择服务 + 环境
- 填写版本号、部署人、备注
- 状态：进行中 → 成功 / 失败
- 支持更新状态（部署完成后改状态）

### 3. 仪表盘首页
- 卡片布局，每个服务一张卡
- 卡片上显示：服务名、各环境最新部署状态
- 状态颜色：绿=成功、黄=进行中、红=失败
- 最后部署时间

### 4. 部署历史
- 按服务查看历史部署列表
- 字段：版本号、环境、状态、部署人、时间、备注
- 按时间倒序

### 5. 筛选
- 按服务名搜索
- 按环境筛选

## 数据模型

### services 表
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 主键 |
| name | TEXT UNIQUE | 服务名 |
| description | TEXT | 描述 |
| owner | TEXT | 负责人 |
| created_at | DATETIME | 创建时间 |

### deployments 表
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 主键 |
| service_id | INTEGER FK | 关联服务 |
| environment | TEXT | test/staging/prod |
| version | TEXT | 版本号 |
| status | TEXT | pending/success/failed |
| deployed_by | TEXT | 部署人 |
| note | TEXT | 备注 |
| started_at | DATETIME | 开始时间 |
| finished_at | DATETIME | 结束时间 |

## 页面结构

```
/                    → 仪表盘首页（服务卡片）
/services            → 服务列表 + 新建
/services/[id]       → 服务详情 + 部署历史
/deployments         → 全局部署历史
/deployments/new     → 新建部署记录
```

## API Routes

```
GET    /api/services          → 服务列表
POST   /api/services          → 新建服务
GET    /api/services/[id]     → 服务详情
PUT    /api/services/[id]     → 更新服务
DELETE /api/services/[id]     → 删除服务

GET    /api/deployments       → 部署历史（支持 ?service_id=&env= 筛选）
POST   /api/deployments       → 新建部署记录
PUT    /api/deployments/[id]  → 更新部署状态
```

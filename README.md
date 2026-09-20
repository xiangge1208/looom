# Looom —— 亚马逊 Listing 与广告分析工具

复刻 Sif 的 Web 后台核心功能：流量结构分析、关键词反查、广告架构还原。

> 数据来源：本期全部为 seed 模拟数据。不含任何采集/爬虫逻辑。

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Vue 3 + TypeScript + Vite + Vue Router + Pinia + Element Plus + ECharts |
| 后端 | NestJS + TypeScript，mysql2 直连 Doris |
| 数据库 | Apache Doris（MySQL 协议，FE 9030） |
| 认证 | JWT access + refresh token，bcrypt |
| AI | OpenAI 兼容协议，可切 mock / 任意厂商 |

## 快速开始

### 1. 配置环境变量

```bash
cp .env.example .env
```

按注释填入 Doris 密码。`DB_HOST` 怎么选：

| 后端跑在哪 | DB_HOST |
|---|---|
| 本机 | `127.0.0.1` |
| 容器里，Doris 在宿主机 | `host.docker.internal` |
| 走公网 | Doris 服务器公网 IP |

### 2. 初始化数据库（幂等，可重复执行）

```bash
bash scripts/setup-doris.sh
```

建库 + 建 55 张表 + 授权。加 `--skip-seed` 可跳过 seed。

> 后端**不会**自动建库建表。库不存在时会打中文错误日志提示先跑这个脚本。

### 3. 启动

两种方式选一种。

#### A. Docker Compose（一条命令）

```bash
docker compose up -d
```

前端 http://localhost:8080，后端 http://localhost:3000/api

端口冲突时用环境变量改，不用动 compose 文件：

```bash
API_PORT=13000 WEB_DOCKER_PORT=18080 docker compose up -d
```

> Doris 不在 compose 里（是外部实例）。容器内访问宿主机 Doris 用
> `DB_HOST=host.docker.internal`；若 Doris 与 Docker 在同一台 Linux 机器上，
> 用 docker 网桥地址（通常 `172.17.0.1`）。

#### B. 本地开发（热重载）

```bash
# 后端
cd apps/api && npm install && npm run start:dev

# 前端（另开终端）
cd apps/web && npm install && npm run dev
```

前端 http://localhost:5173，后端 http://localhost:3000/api

健康检查：

```bash
curl http://localhost:3000/api/health
```

## AI 配置

开发环境默认 `AI_PROVIDER=mock`，返回预置假分析结果，**不消耗任何费用**。

接真实模型只改三项：

```
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://api.deepseek.com/v1
AI_API_KEY=sk-xxx
AI_MODEL=deepseek-chat
```

任何兼容 OpenAI `/v1/chat/completions` 的服务都能接：
OpenAI、DeepSeek、通义千问、Moonshot、本地 vLLM、Ollama。

## 目录结构

```
apps/api/   NestJS 后端
  src/database/    Doris 连接（启动自检）
  src/common/      雪花 ID、响应信封、异常过滤器
  src/auth/        注册/登录/刷新/登出
  src/ai/   AI 模块（provider 抽象 + prompt 版本管理 + SSE）
apps/web/          Vue 3 前端
  src/api/  Axios 封装（401 自动刷新）、SSE 客户端
  src/components/  AiAnalysisCard 等通用组件
db/         建表 SQL + 生成器
scripts/    setup-doris.sh
docs/       侦察产出（SPEC / DATA_DICTIONARY / DORIS_SETUP）
```

## 文档

| 文件 | 内容 |
|---|---|
| `docs/SPEC.md` | 页面清单、接口契约、权限模型 |
| `docs/DATA_DICTIONARY.md` | 55 张表的字段定义与设计依据 |
| `docs/DORIS_SETUP.md` | Doris 接入步骤与**踩过的 8 个坑** |
| `docs/NAMING.md` | 表名字段名规范 |

## 阶段进度

- [x] **P0** Doris 建表 + 认证 + AI 骨架 + SSE
- [x] **P1** 核心读流程（13 个业务页面接 seed 数据）
- [x] **P2** AI 插入点 1-3 + 用户中心 + 积分（流水为权威 + 并发防超扣）
- [x] **P3** AI 插入点 4-6 + 供应商占位页 + 权限点守卫 + 查询历史
- [x] **P4** 打磨（加载骨架、空态/错误态、窄屏适配、AI 结果缓存与失败退款）

6 个 AI 插入点前后端已全部对齐（prompt 注册表 ↔ 页面挂载点）。

### 已知未完成项

- **未接支付**：无充值入口，测试额度由 seed 预置（goal.md 明确不引入付费服务）
- **计费只覆盖 AI 分析**：`reverse_keyword` 等业务查询当前不扣费，计价表也只下发
  实际收费项，避免界面报价却不收费
- **供应商页为占位实现**：数据全部来自 seed，不含任何采集/对接逻辑
- **限流为单机内存计数**：多副本部署需换 Redis storage
- **建表与 seed 需手动执行一次** `scripts/setup-doris.sh`，容器启动不自动建表
  （见下方「与 goal.md 的偏离」）

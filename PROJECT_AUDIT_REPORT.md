# Looom 项目全量检查报告

审计日期：2026-09-19（Asia/Shanghai）  
审计对象：`D:\workspace\looom` 当前工作树  
审计方式：源码静态检查、文档/Schema/Seed 检查、构建检查、HTTP 运行时验证、真实浏览器页面巡检与交互观察  
审计原则：运行时证据与静态推断分开；数据正确性、时间口径、权限和部署可复现性单独核验  

> 本次只生成本报告，没有修改业务源码、数据库 Schema、Seed 或配置。构建命令产生的 `dist/` 属于构建产物，不作为业务修改结论。报告不包含任何 access token、refresh token、数据库密码或 API Key。

## 1. 结论摘要

### 1.1 总体判断

项目已经形成了一个可运行的 Looom/Sif 后台复刻 Demo：前端 Vue 3 页面、NestJS API、Doris 数据访问、JWT 登录、积分、AI Mock/SSE、权限守卫和 Docker Compose 骨架均已接通。当前工作树可以完成登录、核心 ASIN 查询、页面跳转、AI 流式分析和供应商权限分支的演示。

但是，当前版本还不能按“真实生产数据产品”验收。主要原因不是构建失败，而是数据口径、站点参数、时间片、注册授权、凭据审计和 Docker 可复现性仍有高风险缺口。最严重的已验证问题是：流量页推荐专栏比例跨历史日期累加，页面实际显示的四个比例合计约 153%，与当前流量时间片不一致。

### 1.2 交付等级

| 维度 | 结论 | 证据/说明 |
|---|---|---|
| 本地 Demo 可运行 | 通过 | 前后端均成功构建；`/api/health` 返回 `ok`；核心页面返回 Seed 数据 |
| 登录/注册主链路 | 基本通过 | 登录、注册、JWT、refresh、logout 代码链路存在；Seed 用户登录成功 |
| 核心页面可展示 | 通过（Seed 数据） | 销量、流量、关键词、广告、变体、时光机、推荐、竞品、诊断页面可加载 |
| AI Mock 流式路径 | 通过 | 实测收到 `start → delta → done`，响应为 SSE，实际扣除 5 积分 |
| 数据口径可靠性 | 不通过 | 推荐专栏比例跨日期累加；竞品流量缺时间片；统一 freshness/partial 标识缺失 |
| 多站点行为 | 不通过 | 多个页面固定传 `US`，未统一读取 URL 或用户默认站点 |
| 新用户授权完整性 | 不通过 | 注册只写用户和积分账户，不写 `user_roles`；供应商权限默认不可用 |
| 生产部署复现性 | 不通过 | Docker 未使用 lockfile；Web 未复制 `public/`；Web 只等待 API `service_started` |
| 自动化回归 | 不通过 | 未发现测试文件或完整 unit/integration/e2e 流程 |
| 真实生产准备度 | 未达到 | 数据为 Seed；未验证真实采集、真实 AI provider、压力、故障恢复和完整 Docker 部署 |

### 1.3 优先修复顺序

1. 修复推荐专栏和竞品流量的时间片过滤，建立统一 `dataWatermark/timePieceValue/dataStatus` 契约。
2. 明确新用户的默认角色与积分策略；如果供应商面向普通用户，注册时必须授予角色。
3. 统一所有前端查询的 `country` 来源，禁止页面隐式固定 `US`。
4. 修复 refresh token 轮换时 `user_agent`/`ip` 丢失，以及积分/AI 跨表非原子问题的对账策略。
5. 修复 Docker lockfile、`public/`、health dependency 和生产类型检查门禁。
6. 为上述规则补充 API、数据质量和浏览器回归测试。

## 2. 审计范围与限制

### 2.1 已检查范围

- 根目录说明：`README.md`、`goal.md`、`REVIEW_REPORT.md`。
- 产品与数据文档：`docs/SPEC.md`、`docs/API_INVENTORY.md`、`docs/DATA_DICTIONARY.md`、`docs/DORIS_SETUP.md`、`docs/MODULE_DATA_FLOW.md`、`docs/ROUTES_TITLES.md`、`docs/ER_BUSINESS.md`、`docs/ETL_GAP_ANALYSIS.md`。
- 前端：`apps/web/src` 下路由、布局、API、Pinia、组件和所有视图。
- 后端：`apps/api/src` 下 Auth、Users、Business、Credits、AI、Doris、异常过滤器和响应拦截器。
- 数据库：`db/schema-01-system.sql`、`db/schema-02-business.sql`、`db/seed.sql`、生成器和 `scripts/setup-doris.sh`。
- 部署：两个 Dockerfile、`docker-compose.yml`、Nginx 配置和 `.dockerignore`。
- 运行时：本地前端 `127.0.0.1:5173`、API `127.0.0.1:3000`、外部 Doris 连接、登录后浏览器页面和 HTTP API。

### 2.2 审计限制

- 当前分支为 `master`，Git 没有任何 commit，工作树文件均为未跟踪状态，因此本报告是“当前工作树全量审计”，不是基于提交差异的 Code Review。
- 项目内业务数据是 Seed 模拟数据，不是实时 Amazon、1688 或其他真实数据源；不应把页面展示的数字当作生产业务事实。
- 未执行真实 OpenAI-compatible provider 调用、真实采集、真实 1688 对接、并发压力测试、长时间稳定性测试、容器完整启动和真实用户迁移。
- `scripts/setup-doris.sh` 已做静态检查并确认有目标库护栏，但本次没有在隔离空库上实际执行“建库→建表→Seed→读回”全流程，因此不能把脚本声明为已完成空库可重建验证。
- 修改密码和创建/吊销 API Key 属于会改变账户安全状态的操作，本次只检查页面和代码，不执行最终提交动作。
- AI 首次成功流已实测；缓存命中、用户主动取消、provider 超时后的退款和并发重复退款只做了源码审查，未在本次运行环境中逐一制造故障验证。

## 3. 项目概况

### 3.1 目录与职责

```text
D:\workspace\looom
├─ apps/api/                 NestJS + TypeScript API
├─ apps/web/                 Vue 3 + TypeScript + Vite 前端
├─ db/                       Doris Schema、Seed 生成器和 Seed SQL
├─ docs/                     产品规格、接口清单、数据字典、流程和原站侦察材料
├─ scripts/                  Doris 初始化脚本
├─ docker-compose.yml        API + Web 编排；Doris 为外部实例
├─ README.md / goal.md       项目目标和使用说明
└─ REVIEW_REPORT.md          既有检查报告；本次未覆盖写入
```

当前源码统计：

- `apps/api/src` + `apps/web/src`：74 个源码文件，约 10,965 行。
- `db/schema-*.sql`：55 个 `CREATE TABLE` 定义。
- 前端路由表：19 个 `path` 声明，包含登录、注册、业务页、维护页和 404 页。
- `apps/api/package-lock.json`、`apps/web/package-lock.json` 存在，但 Dockerfile 没有使用它们。

### 3.2 技术栈

| 层 | 技术 |
|---|---|
| Web | Vue 3、TypeScript、Vite、Vue Router、Pinia、Element Plus、ECharts |
| API | NestJS 10、TypeScript、Passport/JWT、class-validator、mysql2 |
| 数据库 | Apache Doris，通过 MySQL 协议访问；项目库名为 `looom` |
| 认证 | bcrypt 密码哈希、JWT access token、refresh token 哈希存储 |
| AI | Mock Provider；可切换 OpenAI-compatible Provider；SSE 流式返回 |
| 部署 | API + Web Docker Compose；Doris 不由 Compose 管理，属于外部依赖 |

### 3.3 产品边界

代码和文档均明确：当前供应商页是占位实现，数据来自项目 Seed；不包含真实采集、爬虫、Amazon 实时采集或真实 1688 对接。这个边界在 `SuppliersView.vue` 页面也向用户显示，避免把演示供应商数据冒充真实货源，这一点是正确的。

## 4. 端到端流程检查

### 4.1 浏览器启动与路由守卫

主路由位于 `apps/web/src/router/index.ts`：

1. Guest 页面为 `/login`、`/register`、`/maintain` 和 404。
2. 其他页面进入前检查 `tokenStore.access`，没有 token 时跳转 `/login?redirect=...`。
3. 有 token 时调用 `auth.restore()`，恢复用户资料。
4. 路由切换时设置 `title`、`description` 和 `robots`；业务页默认 `noindex,nofollow`。
5. `scrollBehavior` 将页面切换回顶部。

结论：路由结构完整，登录态与 guest 态分支存在；但业务页面参数中的 `country` 未在路由层统一建模，导致下层视图各自决定默认站点，见 P1-03。

### 4.2 HTTP 客户端与 401 刷新

`apps/web/src/api/http.ts` 实现了：

- 请求头自动附加 access token。
- 401 时使用共享 `refreshing` Promise 合并并发 refresh，避免多个请求同时轮换 refresh token。
- refresh 成功后重放原请求；失败则清理 token。
- SSE 请求与普通请求共享刷新 Promise 的设计意图已写在代码注释中。

这是一个较完整的客户端鉴权实现。风险在于 refresh token 轮换服务端没有保留 UA/IP 元数据，以及 refresh 撤销、签发、失败恢复不是跨表事务，见 P2-06。

### 4.3 注册、登录、积分和权限

注册 `apps/api/src/auth/auth.service.ts:42-90`：

- 先查邮箱，再写 `users`。
- 密码使用 bcrypt 哈希。
- 创建 `credit_accounts`，初始余额为 0。
- 返回 access token + refresh token。
- 没有插入 `user_roles`。

登录：

- 邮箱不存在和密码错误使用同一提示，避免枚举邮箱。
- 检查账号 `status`。
- 写回最后登录时间/IP。
- 发放双 token。

权限：

- `BusinessController` 类级别使用 `JwtAuthGuard` 与 `PermissionsGuard`。
- 供应商接口额外要求 `supplier:read`。
- Seed 普通用户的角色含 `query:read`、`supplier:read`；新注册用户没有该角色。

实际运行观察到：Seed 普通用户可以进入供应商页；新注册用户路径按当前代码会在供应商接口收到 403，页面显示“没有访问权限”。这说明守卫工作正常，但注册初始化流程不完整。

### 4.4 业务查询流程

业务请求的一般链路为：

```text
页面 AsinSearchBar
  → views/*.vue search()
  → api/business.ts
  → axios /api/business/*
  → JwtAuthGuard + PermissionsGuard
  → Controller DTO/defaults
  → Business Service
  → DorisService 参数化 SQL
  → 统一响应拦截器 { code, message, data }
  → 页面 loading / data / empty / error 状态
```

正向设计：

- SQL 参数使用 `?` 绑定；动态排序字段有白名单。
- Doris BIGINT 通过 `supportBigNumbers` / `bigNumberStrings` 按字符串处理，降低 Snowflake ID 精度损失风险。
- 页面普遍存在 skeleton、loading、empty、error 分支。
- 历史记录采用游标分页，不使用深分页。

主要缺口：时间片与站点参数没有统一传递；多个 API response 使用 `any`；freshness 和 partial coverage 没有统一返回。

### 4.5 AI 分析流程

代码流程位于 `apps/api/src/ai/ai.service.ts`：

```text
校验 insertPoint
  → 根据 prompt/version 构造 inputHash
  → 查询成功缓存
  → 缓存命中：不扣费，发 cached + done
  → 未命中：扣积分
  → 建 ai_tasks(running)
  → 发 start
  → provider.chatStream()
  → 按 delta 发 SSE
  → 成功写 ai_analyses + 更新 task(success)
  → 异常/空结果/取消：重试或退款
```

真实运行证据：

- 页面点击“开始分析（5 积分）”后余额从 100 变为 95。
- `POST /api/ai/analyze` 返回 `201 Created`，`Content-Type: text/event-stream`。
- 事件顺序为 `start`、多个 `delta`、`done`，最后有 `[DONE]`。
- Mock Provider 返回了完整中文分析卡片。

静态风险：Doris 不提供跨表事务，AI 任务、分析结果、积分流水、余额缓存之间仍有非原子窗口；退款的 `bizId` 是先查后写，代码自己注明并发重复退款不是强保证。

## 5. 页面、路由与交互检查

### 5.1 路由覆盖矩阵

| 路由 | 页面 | 运行时结果 | 主要交互/分支 | 结论 |
|---|---|---|---|---|
| `/login` | 登录 | 可加载、可登录 | 邮箱、密码、登录、注册跳转 | 通过 |
| `/register` | 注册 | 页面存在 | 邮箱、昵称、密码校验 | 主链路存在；角色初始化有缺口 |
| `/dashboard` | 概览 | Seed 用户可加载 | ASIN 输入、功能入口、最近查询、使用指南 | 通过 |
| `/sales?asin=...` | 查销量 | 3 个变体、趋势和 AI 卡片可展示 | 变体/Size 单选、表格操作、AI | 通过；站点固定 US |
| `/traffic?asin=...` | 查流量结构 | 自然/广告、推荐专栏和变体表可展示 | 堆积图/分列对比、广告入口、AI | 数据口径 P1 |
| `/keywords?asin=...` | 反查流量词 | 17 条关键词 Seed 可展示 | 搜索筛选、列排序、流量来源、AI | 基本通过；抽屉和排序需回归自动化 |
| `/ads?asin=...` | 广告透视 | 活动/小组/广告词 Tab 结构存在 | campaign → groups → terms，游标加载 | 代码路径完整；查询无 URL 同步 |
| `/variations?asin=...` | 多变体自然位 | 日趋势和关键词变体列表可展示 | 趋势图、自然位列表 | 无 URL 同步 |
| `/timeline?asin=...` | 运营时光机 | 指标趋势与事件结构存在 | 买入/价格/BSR/评分切换 | 无 URL 同步 |
| `/recommendations?asin=...` | 推荐专栏 | 专栏卡片可展示 | ASIN 查询、动态 shortCode 降级 | 无 URL 同步；时间粒度需明确 |
| `/competitors?asins=...` | 竞品对比 | 价格、评分、销量和流量可展示 | 添加/删除 ASIN、排序 | 前端校验；后端 DTO 未绑定 |
| `/diagnosis?asin=...` | AI 综合诊断 | 数据完整性和缺失域可展示 | 站点 query、AI 入口 | country 处理相对完整 |
| `/suppliers` | 供应商 | Seed 用户显示示例货源；无权限用户显示 403 分支 | 关键词、地区、价格、搜索、加载更多 | 权限机制通过；新注册角色缺失 |
| `/history` | 查询历史 | 类型筛选、游标分页、重查结构存在 | ASIN 重查保留 country | 通过；非 ASIN 重查按设计不带 asin |
| `/settings` | 账户设置 | 资料、密码、积分、API Key Tab 可见 | 保存资料、修改密码、积分流水、创建/吊销 Key | 页面通过；安全写操作本次未提交 |
| `/maintain` | 维护页 | 路由存在 | 静态提示 | 通过 |
| `/:pathMatch(.*)*` | 404 | 路由存在 | 未知路径 | 通过 |

### 5.2 交互观察

- 登录实际跳转 `/dashboard`，顶栏显示邮箱和积分余额。
- 销量页显示父体说明、3 个子体和“父体本身没有销量数据”的提示。
- 流量页变体分布显示自然、SP、SB、SBV 等渠道；页面文本同时展示图形标签和表格标签，存在可读性重复但不是功能错误。
- 关键词页显示筛选输入框、排序按钮、流量来源按钮和“已加载全部 17 条”。
- 广告页代码明确实现三个 Tab，并且点击活动后在本页切换到投放小组；广告词 Tab 首次切换时才加载数据。
- 竞品页前端输入 `bad` 后显示“以下不是合法 ASIN（需 10 位）”，未把非法值加入对比组。
- 供应商页明确显示“占位实现，数据均为示例，不是真实 1688 货源”。
- 设置页的 API Key 区域说明明文只在创建成功时显示一次，代码只保存哈希；本次没有创建持久化凭据。
- 移动端 `390×844` 检查未发现整体文档横向溢出；表格使用自身横向滚动容器。
- 浏览器观察到 `/favicon.ico` 404；不会阻塞业务，但属于资源交付不完整。

### 5.3 尚未完全证明的交互

- Element Plus radio 的底层 `<input>` 被可见 label 拦截，直接用自动化 ref 点击时超时；这不是已确认的用户侧故障，但说明当前没有稳定的浏览器回归定位器。
- 关键词“流量来源”抽屉、广告 Tab 的完整三段下钻、设置资料保存、积分分页、API Key 创建/吊销、修改密码提交没有全部执行端到端提交验证。
- 修改密码和创建/吊销 API Key 会改变安全状态，审计时只做了页面/代码检查，没有为了审计制造持久化副作用。

## 6. 数据库、Schema 与数据流检查

### 6.1 Doris 连接和表状态

后端启动日志显示：

```text
Doris 连接正常：120.24.248.175:9030/looom（55 张表）
```

`GET /api/health` 实际返回：

```json
{"code":0,"message":"ok","data":{"status":"ok"}}
```

数据库初始化脚本有以下安全护栏：

- 只操作 `$DB_NAME`。
- 拒绝 `reroll_analysis`、`loom`、`mysql`、`information_schema` 等受保护库名。
- 密码通过 `MYSQL_PWD` 传递，不直接拼在 mysql 命令行中。
- Schema 使用 `CREATE TABLE IF NOT EXISTS`。

### 6.2 Seed 与真实性

当前项目数据库和页面主要依赖 `db/seed.sql`。因此：

- `created_at` 代表 Seed 写入或模拟时间，不代表 Amazon 业务事件发生时间。
- 页面显示的月销量、流量比例、广告活动、推荐专栏均是演示数据。
- 项目没有完成从真实采集源到 Doris 的生产 ETL、去重、迟到数据和回补闭环。
- 报告中所有运行时业务数字只用于证明页面/接口链路，不用于业务决策。

### 6.3 文档与运行时的状态漂移

`docs/MODULE_DATA_FLOW.md` 的说明仍写着“Doris 端已建 43 张业务表”，且把多变体、推荐专栏和广告域标为红灯；本次后端启动日志和 Schema 检查显示目标库已有 55 张表，页面也能从 Seed 返回完整演示数据。二者并不必然矛盾（文档可能记录 ETL 就绪度而不是表存在性），但当前缺少明确的“表存在 / 数据可用 / 真实覆盖 / Seed 演示”四态定义，容易让开发和验收方误解当前完成度。

建议在数据字典和模块流文档中增加：`schemaReady`、`seedReady`、`sourceReady`、`freshness`、`coverage`、`statusMessage` 六类字段或状态。

## 7. 问题清单（按严重程度）

严重度定义：

- **P0**：阻断核心使用或造成不可接受的数据/安全错误。
- **P1**：会直接误导业务判断、破坏核心产品口径或使默认用户流程不可用。
- **P2**：重要一致性、部署、契约或可维护性问题，需在生产前修复。
- **P3**：局部质量、可观测性、文档或体验问题。

### P1-01：流量页推荐专栏比例跨历史日期聚合，实际合计约 153%

- 文件：`apps/api/src/business/traffic.service.ts:91-102`
- 现象：查询 `fact_asin_rec_column_period` 时按 ASIN 和 country 聚合，但没有按 `stat_date`、最新月份或传入的 `timePieceValue` 过滤。
- 运行时证据：`/traffic?asin=B0SEEDSSP0` 显示：
  - 顾客常看：46.900%
  - 当下热门：45.498%
  - 达人推荐：42.278%
  - 社媒同款：18.776%
  - 合计约 153.452%
- 影响：页面把多个历史时间点的比例累加到当前流量卡片，用户无法把该比例与上方自然/广告当前时间片对应起来。
- 严重度/置信度：P1 / 高。
- 建议：先按 country 取最新可用月份或使用明确 `timePieceValue`，再按该时间片聚合；同时明确比例分母是 ASIN 级总流量、渠道总流量还是推荐专栏内部总和，并在接口返回分母与时间水位。
- 验收标准：四个推荐专栏比例的合计符合定义；旧月份不会混入；同一请求重复结果稳定。

### P1-02：竞品流量查询缺少 `time_piece_value`，同一 ASIN 可能由返回顺序决定月份

- 文件：`apps/api/src/business/insights.service.ts:214-226`
- 现象：查询过滤了 `country`、`time_piece_type='month'`、渠道和 ASIN，但未过滤 `time_piece_value`。
- 代码风险：后续 `Map` 用 `tMap.set(t.asin, cur)` 写入同一个 ASIN 的多个月份；最终值取决于 Doris 返回顺序，而不是明确的最新月份。
- 影响：竞品页的自然/广告流量可能是旧月份或非确定月份；页面没有把时间片展示给用户。
- 严重度/置信度：P1 / 高。
- 建议：查询前按 country 取 `MAX(time_piece_value)`，或新增明确的 `timePieceValue` 参数；响应返回 `timePieceValue`/`dataWatermark`。
- 验收标准：同一数据集多次请求结果稳定；SQL 只返回一个 ASIN、一个月份、一个渠道记录；页面标明统计月份。

### P1-03：多站点支持在后端存在，但多个前端页面硬编码 `US`

- 文件示例：
  - `apps/web/src/views/SalesView.vue:148`
  - `apps/web/src/views/KeywordsView.vue:246`
  - `apps/web/src/views/AdsView.vue:250`
  - `apps/web/src/api/business.ts:92-171`
  - 页面间跳转：`SalesView.vue:267-270`、`TrafficView.vue:180`
- 现象：设置页支持 `US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR`，用户资料也有 `defaultCountry`；但销量、关键词、广告及多个跳转只传 ASIN，业务调用固定或默认 `US`。
- 影响：用户在设置页选择非 US 站点后，核心查询仍可能查 US；历史记录携带 country 重查时，部分页面会丢失站点；AI 输入也可能使用 US 数据。
- 严重度/置信度：P1 / 中高（当前 Seed 主要是 US，跨站错误在当前数据上不一定显现）。
- 建议：建立统一 `useQueryContext()`，优先级为 `route.query.country → 用户 defaultCountry → US`；所有页面查询、页面跳转和 AI input 都传递 country；后端 DTO 继续使用 `@IsIn(COUNTRIES)`。
- 验收标准：将默认站点改为非 US 后，从 Dashboard、历史、销量、流量、关键词、广告、诊断的请求和 URL 均保持同一 country。

### P1-04：新注册用户没有自动角色，供应商功能默认不可用

- 文件：`apps/api/src/auth/auth.service.ts:42-90`；权限守卫 `apps/api/src/auth/permissions.ts`；供应商控制器 `apps/api/src/business/business.controller.ts:227-253`。
- 现象：注册写入 `users` 和 `credit_accounts`，没有写 `user_roles`。Seed 普通用户通过独立 Seed 关系获得 `supplier:read`，新用户没有任何角色。
- 运行时证据：供应商接口对无该权限用户返回 403，页面显示“当前账号缺少 supplier:read 权限，请联系管理员开通”。守卫本身是有效的。
- 影响：如果产品设计是普通用户可用供应商搜索，新用户完成注册后会进入不可用页面；如果供应商确实是授权功能，则注册页和产品说明需要明确该限制。
- 严重度/置信度：P1 / 高。
- 建议：二选一并固化规则：
  1. 注册后插入普通用户角色，并明确初始积分；或
  2. 保持管理员授权，但在注册/供应商页明确“需授权”，并提供授权入口或联系信息。
- 验收标准：新注册账户的角色、积分、可访问页面和产品文案一致；不得出现“注册成功但默认核心入口 403”的隐式状态。

### P2-01：四个页面查询成功后不写回 URL，刷新/分享不能复现

- 文件：`apps/web/src/views/AdsView.vue:35-50`、`TimelineView.vue:23-33`、`VariationsView.vue:23-33`、`RecommendationsView.vue:21-32`。
- 现象：`search()` 只更新本地 `asin` 并请求 API，没有 `router.replace()`。
- 影响：用户输入 ASIN 后刷新页面，结果丢失；复制链接给同事时无法复现当前查询；与 Sales、Traffic、Keywords、Diagnosis 的 URL 行为不一致。
- 严重度/置信度：P2 / 高。
- 建议：所有查询页采用统一 `commitQuery({ asin, country })`，查询成功前或提交时同步 URL；加载初始 URL 时只触发一次请求，避免重复查询。

### P2-02：竞品 DTO 已定义但控制器没有使用，后端对非法 ASIN 返回 200 空结果

- 文件：`apps/api/src/business/business.controller.ts:31-39` 定义了 `CompareDto`，但 `:213-217` 使用 `@Query('asins') asins: string`，没有 `@Query() q: CompareDto`。
- 运行时证据：请求 `/api/business/competitors?asins=bad&country=US` 返回 HTTP 200 和 `{code:0,message:"ok",data:{country:"US",items:[]}}`。
- 对照：前端输入 `bad` 会显示“需 10 位”的提示，说明前端校验存在，但不能替代后端校验。
- 影响：非法输入、空输入、过多 ASIN 会被当成正常成功请求；调用方难以区分参数错误和真实无数据。
- 严重度/置信度：P2 / 高。
- 建议：使用 `CompareDto`，对每项增加 10 位 ASIN `@Matches`，限制 1-10 个，country 使用 `@IsIn`；空列表返回 400；`slice(0,10)` 不应静默截断而应明确报错或在契约中说明。

### P2-03：refresh token 轮换丢失 `user_agent` 和 `ip`

- 文件：`apps/api/src/auth/auth.service.ts:137-187`，尤其 `:179-186`。
- 现象：`refresh()` 查询只取 `id/user_id/token_hash/expires_at/revoked_at/created_at`，吊销旧 token 时写回也没有 UA/IP；随后 `issueTokens(row.user_id, user.email)` 没有传入原请求 meta。新 token 的 `user_agent`/`ip` 因此为空。
- Schema：`db/schema-01-system.sql:48-56` 明确设计了 `user_agent`、`ip` 用于登录设备管理。
- 影响：登录设备审计、异常登录追踪和用户自助设备管理无法在 refresh 后保持连续记录。
- 严重度/置信度：P2 / 高。
- 建议：refresh 时读取旧行的 UA/IP，或由控制器传入当前请求 UA/IP；轮换写回时完整保留 nullable 字段；增加“登录 → refresh → 查看 refresh_tokens 元数据”的集成测试。

### P2-04：Docker 构建不使用 lockfile，依赖不可完全复现

- 文件：`apps/api/Dockerfile:12-15,30-32`、`apps/web/Dockerfile:9-10`。
- 现象：只复制 `package.json`，执行 `npm install`，没有复制 `package-lock.json`，也没有使用 `npm ci`。
- 影响：镜像可能解析到与本地不同的依赖版本；供应链和回滚可重复性下降。
- 严重度/置信度：P2 / 高。
- 建议：复制 package.json + package-lock.json，使用 `npm ci`；builder 和 runner 分别使用对应的锁文件策略。

### P2-05：Web Dockerfile 未复制 `public/`，静态资源交付不完整

- 文件：`apps/web/Dockerfile:12-13,23-24`。
- 现象：builder 只复制 tsconfig、vite config、index.html 和 src，没有 `COPY apps/web/public ./public`。
- 运行时旁证：本地开发页观察到 `/favicon.ico` 404；仓库存在 `apps/web/public/robots.txt`，但生产 builder 不会收到该目录。
- 影响：robots、favicon 或其他公共静态资源不会进入生产镜像。
- 严重度/置信度：P2 / 中高。
- 建议：复制 `public/`，并在镜像构建后检查 robots/favicon 的 HTTP 200。

### P2-06：Compose 只等待 API `service_started`，没有等待 health

- 文件：`docker-compose.yml:58-68`。
- 现象：API 虽然定义了 healthcheck，但 Web 使用 `depends_on.api.condition: service_started`。
- 影响：Web 可能在 API 尚未连通外部 Doris、尚未通过 `/api/health` 时开始提供页面，首次访问会产生一批失败请求。
- 严重度/置信度：P2 / 高。
- 建议：改为 `condition: service_healthy`；同时在部署检查中区分“容器已启动”“API 健康”“Doris 可达”“核心接口可用”。

### P2-07：生产 Docker 构建跳过 `vue-tsc`，本地与镜像质量门禁不一致

- 文件：`apps/web/Dockerfile:15-17`。
- 现象：注释明确 Docker 只跑 `vite build`，而本地 `npm run build` 执行 `vue-tsc --noEmit && vite build`。
- 影响：本地类型错误可能在生产镜像构建时不被拦截；构建绿灯不代表模板/API 类型契约正确。
- 严重度/置信度：P2 / 中高。
- 建议：将类型检查作为 CI/发布门禁；如果出于速度不在 Docker 内执行，至少在唯一可信的 CI workflow 中强制运行并保存结果。

### P2-08：Doris 下积分和 AI 状态跨表写入非原子，幂等只依赖先查后写

- 文件：`apps/api/src/credits/credits.service.ts:327-382`、`apps/api/src/ai/ai.service.ts:244-303`。
- 现象：`grant()` 先查询 `bizId` 是否已存在，再插入流水；余额缓存、流水、AI task、analysis 是不同写入。代码注释已承认两个并发退款可能同时查不到对方。
- 影响：重复回调、连接中断、进程崩溃和并发失败时可能出现余额与流水不一致、退款重复或 task 状态与分析结果不一致。
- 严重度/置信度：P2 / 高。
- 建议：引入可验证的唯一业务键/外部队列/幂等表、定时对账和修复任务；明确“余额权威来源”以及各表的恢复顺序；为同一 task 并发退款和进程中断增加故障测试。

### P2-09：统一数据水位、生成时间和部分覆盖标记缺失

- 相关服务：`sales.service.ts`、`traffic.service.ts`、`keywords.service.ts`、`insights.service.ts`、`diagnosis.service.ts`。
- 现象：部分服务内部使用 `MAX(time_piece_value)`，返回只带 `timePieceValue` 或完全不带水位；没有统一 `dataWatermark`、`generatedAt`、`dataStatus`、`coverage`。
- 影响：用户无法区分事件时间、统计窗口、Seed 写入时间和 API 生成时间；空、旧、部分覆盖和真实零值可能混淆。
- 严重度/置信度：P2 / 中高。
- 建议：统一响应元数据：`dataStatus: COMPLETE|PARTIAL|UNAVAILABLE|SEED`、`dataWatermark`、`generatedAt`、`timePieceValue`、`coverageNote`；页面在非 COMPLETE 时显示明确提示。

### P3-01：业务响应和页面状态大量使用 `any`

- 代表性位置：`apps/api/src/business/*.service.ts`、`apps/web/src/api/business.ts`、`apps/web/src/views/AdsView.vue`、`TrafficView.vue`、`VariationsView.vue`、`TimelineView.vue`、`CompetitorsView.vue`。
- 现象：接口响应大量使用 `any[]`、`Record<string, any>`，例如 `business.ts:108-171`、多个视图的 `ref<any>`。
- 影响：字段改名、nullability 变化和 API contract 漂移不能在编译阶段发现，最终依赖运行时页面才暴露问题。
- 严重度/置信度：P3 / 高。
- 建议：为每个业务 API 建立 response interface；后端使用 query result 类型；诊断服务不要通过 `as any` 组合多个结果。

### P3-02：Favicon/公共静态资源 404

- 证据：浏览器 console 观察到 `GET http://127.0.0.1:5173/favicon.ico -> 404`。
- 影响：低；会污染控制台和监控，但不影响业务。
- 建议：添加 favicon 或在 `index.html` 中显式指向现有静态资源。

### P3-03：文档对“表存在、Seed 可用、真实源可用”的状态没有分层

- 证据：`docs/MODULE_DATA_FLOW.md` 的 ETL 就绪表与当前 55 张表、可返回 Seed 数据的运行时状态混在同一套 🟢/🟡/🔴 语义中。
- 影响：开发、测试和业务方对“页面能展示”与“生产数据可用”的理解容易混淆。
- 建议：文档中拆开 schema、seed、source、freshness、coverage、production readiness 六个状态。

## 8. 已验证的正向结果

### 8.1 构建与运行

- Web `npm run build` 通过：`vue-tsc --noEmit` 通过，Vite 转换 2,378 个模块并成功生成生产产物。
- API `npm run build` 通过：Nest build，0 errors。
- `/api/health` 返回统一响应且不泄露数据库内部详情。
- 3000 端口已有 `dist/main.js` 进程运行；重复启动得到 `EADDRINUSE`，证明不是“两个空启动命令都成功”的假象。

### 8.2 认证与安全基础

- bcrypt 密码哈希。
- access token 与 refresh token 分离。
- refresh token 数据库存哈希，不存明文。
- 前端 401 refresh 有并发合并机制。
- 登录错误信息避免邮箱枚举。
- 业务接口默认需要 JWT。
- 供应商权限守卫真实生效。
- API Key 页面文案和代码均按“只显示一次、数据库只存哈希”设计。

### 8.3 SQL 与数据处理

- Doris 查询使用参数绑定。
- 动态排序字段采用白名单而不是直接拼接用户输入。
- BIGINT/Snowflake ID 设计上按字符串传递，避免 JS 53 位精度问题。
- 父体/子体解析、时间粒度和不同业务事实表基本按模块拆分，没有把所有时间粒度强行合并。
- 历史记录采用游标分页，页面保留站点信息。

### 8.4 页面体验

- 页面都有 loading、空态或错误清空逻辑。
- AI 统一使用 `AiAnalysisCard`，避免每个页面独立实现 SSE 渲染。
- 供应商页面明确标注示例数据，不冒充真实 1688。
- 移动端整体页面无横向溢出。
- 业务页标题、description、robots meta 会随路由更新。

## 9. 测试与验证记录

### 9.1 已执行命令

```powershell
cd D:\workspace\looom\apps\web
npm run build

cd D:\workspace\looom\apps\api
npm run build
```

结果：均通过。

### 9.2 已实际请求的 API

认证与用户：

```text
GET  /api/health
POST /api/auth/login
GET  /api/auth/me
GET  /api/credits/balance
GET  /api/credits/pricing
GET  /api/users/me/profile
GET  /api/users/me/stats
```

业务：

```text
GET /api/business/sales/overview?asin=B0SEEDSSP0&country=US
GET /api/business/sales/trend?asin=B0SEEDSSP0&country=US
GET /api/business/traffic/structure?asin=B0SEEDSSP0&country=US
GET /api/business/traffic/variants?asin=B0SEEDSSP0&country=US
GET /api/business/keywords?asin=B0SEEDSS02&country=US
GET /api/business/ads/campaigns?asin=B0SEEDHD03&country=US
GET /api/business/variations?asin=B0SEEDSSP0&country=US
GET /api/business/timeline?asin=B0SEEDSSP0&country=US
GET /api/business/recommendations?asin=B0SEEDSS02&country=US
GET /api/business/competitors?asins=B0SEEDSS02,B0SEEDSS03&country=US
GET /api/business/diagnosis?asin=B0SEEDSSP0&country=US
```

异常/权限：

```text
GET /api/business/competitors?asins=bad&country=US
→ HTTP 200，data.items=[]（后端校验缺失）

GET /api/business/suppliers?keyword=ssd
→ 对无 supplier:read 的账号返回权限错误；页面显示权限不足
```

AI：

```text
POST /api/ai/analyze
→ HTTP 201
→ Content-Type: text/event-stream
→ start / delta / done / [DONE]
→ Seed 普通用户余额 100 → 95
```

### 9.3 页面访问矩阵

已使用真实浏览器加载并检查 DOM/可访问性树：

```text
/login
/register
/dashboard
/sales?asin=B0SEEDSSP0
/traffic?asin=B0SEEDSSP0
/keywords?asin=B0SEEDSS02
/variations?asin=B0SEEDSSP0
/timeline?asin=B0SEEDSSP0
/ads?asin=B0SEEDHD03
/recommendations?asin=B0SEEDSS02
/competitors?asins=B0SEEDSS02,B0SEEDSS03
/diagnosis?asin=B0SEEDSSP0
/suppliers
/history
/settings
/maintain
/not-found
```

## 10. 建议的修复后验收方案

### 10.1 数据口径门禁

- 每个时间序列接口必须返回 `timePieceValue` 或 `dateRange`。
- 每个核心接口必须返回 `dataStatus`、`dataWatermark`、`generatedAt`。
- 推荐专栏比例测试：最新月份过滤后，比例按定义落在合法范围，不能跨月累加。
- 竞品测试：插入两个历史月份，接口必须只返回最新月份，重复请求结果一致。
- 多站点测试：US/UK 各放不同数据，页面不得交叉读错。

### 10.2 认证/权限门禁

- 注册后查询 `users`、`credit_accounts`、`user_roles` 三张表，确认产品定义的默认角色和积分。
- 登录后 refresh，检查 `refresh_tokens.user_agent/ip` 不丢失。
- 并发 refresh 同一旧 token，验证旧 token只能成功一次，失败路径不会造成不可恢复登录状态。
- API Key 创建只显示一次；列表只返回前缀/状态；吊销后立即不可用。

### 10.3 AI/积分门禁

- 缓存命中：返回 `cached`，积分不减少。
- 余额不足：返回明确 error，任务表不留下 running 垃圾记录。
- provider 超时/空结果：任务失败、只退款一次、余额和流水可对账。
- 客户端断开：任务标记 cancelled，不写空分析，不进入缓存。
- 运行两次并发失败回调，检查 `bizId` 唯一性和对账结果。

### 10.4 部署门禁

- Docker 使用 `npm ci` 和 lockfile。
- Web 生产镜像检查 `/robots.txt`、favicon 和静态 chunk 均返回 200。
- Compose 使用 `service_healthy`，并在启动后执行 `/api/health`、登录、一个核心业务接口和 AI Mock smoke test。
- CI 至少执行：API build、Web typecheck + build、API contract test、浏览器 smoke test。

## 11. 最终判定

当前版本适合：

- 产品原型演示；
- UI/路由/交互走查；
- Doris Seed 查询链路验证；
- Mock AI 流程验证；
- 后续真实 ETL 与数据契约开发的前端壳。

当前版本不适合直接宣称：

- 数据已接入真实生产源；
- 流量/推荐/竞品指标口径已准确；
- 多站点查询已完整支持；
- 新注册用户默认可用所有产品功能；
- Docker 构建完全可复现；
- AI 计费、退款和高并发幂等已达到生产级一致性。

综合评级：**Demo/开发验收可用；生产发布不通过，需先关闭 P1 项并完成 P2 门禁。**

## 12. 关键文件索引

- [README.md](README.md)
- [goal.md](goal.md)
- [docs/SPEC.md](docs/SPEC.md)
- [docs/API_INVENTORY.md](docs/API_INVENTORY.md)
- [docs/DATA_DICTIONARY.md](docs/DATA_DICTIONARY.md)
- [docs/MODULE_DATA_FLOW.md](docs/MODULE_DATA_FLOW.md)
- [apps/api/src/business/traffic.service.ts](apps/api/src/business/traffic.service.ts)
- [apps/api/src/business/insights.service.ts](apps/api/src/business/insights.service.ts)
- [apps/api/src/business/business.controller.ts](apps/api/src/business/business.controller.ts)
- [apps/api/src/auth/auth.service.ts](apps/api/src/auth/auth.service.ts)
- [apps/api/src/auth/permissions.ts](apps/api/src/auth/permissions.ts)
- [apps/api/src/ai/ai.controller.ts](apps/api/src/ai/ai.controller.ts)
- [apps/api/src/ai/ai.service.ts](apps/api/src/ai/ai.service.ts)
- [apps/api/src/credits/credits.service.ts](apps/api/src/credits/credits.service.ts)
- [apps/web/src/router/index.ts](apps/web/src/router/index.ts)
- [apps/web/src/api/http.ts](apps/web/src/api/http.ts)
- [apps/web/src/api/business.ts](apps/web/src/api/business.ts)
- [apps/web/src/views/SettingsView.vue](apps/web/src/views/SettingsView.vue)
- [apps/web/src/views/CompetitorsView.vue](apps/web/src/views/CompetitorsView.vue)
- [db/schema-01-system.sql](db/schema-01-system.sql)
- [db/schema-02-business.sql](db/schema-02-business.sql)
- [scripts/setup-doris.sh](scripts/setup-doris.sh)
- [docker-compose.yml](docker-compose.yml)

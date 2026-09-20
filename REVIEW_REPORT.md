# Looom 项目全面检查报告

> 检查日期：2026-09-19
> 检查范围：全仓库 —— 后端 `apps/api`（NestJS，42 个源文件全量精读）、前端 `apps/web`（Vue 3，47 个文件全量精读）、数据库 `db/`（55 张 Doris 表 schema + seed）、需求文档（goal.md / docs/）、部署编排（docker-compose / Dockerfile / nginx / 脚本）。
> 检查方法：三路并行深度代码审查（后端逻辑与安全 / 前端页面与交互 / 需求-数据库-基础设施交叉核对），关键 P0 结论已逐条人工复核源码确认。
> 本报告只做检查与建议，未修改任何业务代码。

---

## 目录

1. [项目概况](#一项目概况)
2. [总体结论](#二总体结论)
3. [问题清单](#三问题清单)
   - [3.1 安全问题](#31-安全问题)
   - [3.2 后端逻辑与商业闭环](#32-后端逻辑与商业闭环)
   - [3.3 前端页面与交互](#33-前端页面与交互)
   - [3.4 数据库设计](#34-数据库设计)
   - [3.5 部署与基础设施](#35-部署与基础设施)
   - [3.6 文档、合规与需求管理](#36-文档合规与需求管理)
   - [3.7 建议项（P3）汇总](#37-建议项p3汇总)
4. [需求覆盖度对照表](#四需求覆盖度对照表)
5. [页面与 API 清单](#五页面与-api-清单)
6. [做得好的方面](#六做得好的方面)
7. [修复路线图](#七修复路线图)

---

## 一、项目概况

### 1.1 产品定位

复刻 sif.com 的 Web 后台 —— 亚马逊卖家 Listing 与广告优化 SaaS：按 ASIN 反查站内流量（自然搜索 / PPC 广告 / 搜索推荐 / Deal）、找畅销变体、监控关键词排名、分析广告结构，并叠加 AI 诊断能力。本期数据全部使用自造 seed 模拟，真实数据后续从 Sif 购买；只做 Web 后台，不含任何爬虫/采集逻辑。

### 1.2 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Vue 3 + TypeScript + Vite + Element Plus + Pinia + Vue Router + ECharts（vue-echarts）+ markdown-it |
| 后端 | NestJS 10 + mysql2（MySQL 协议直连 Doris FE:9030）+ JWT + bcrypt + SSE |
| 数据库 | Apache Doris（外部实例），Unique Key + MoW，55 张表（14 系统 + 43 业务） |
| AI | OpenAI 兼容协议，provider 工厂（mock / openai-compatible），SSE 流式输出 |
| 部署 | docker-compose（api + web/nginx），Doris 外置 |

### 1.3 架构与数据流

```
浏览器 (Vue 3 SPA)
   │  axios（带 401 自动刷新拦截器）/ 原生 fetch（AI SSE 流）
   ▼
web 容器 nginx ──(反代 /api，SSE 三件套)──► api 容器 (NestJS)
   │  GlobalPrefix('api') → ValidationPipe → JwtAuthGuard(每请求查库校验状态)
   │  → [PermissionsGuard 可选权限点] → Controller → Domain Service
   ▼
DorisService（mysql2 连接池，时区 Z，BIGINT 转字符串）
   ▼
Apache Doris（looom 库，55 表；余额以 credit_transactions 流水 SUM 为权威）
```

认证流程：注册（bcrypt cost 10）→ 登录签发 2h access JWT + 30d refresh（SHA-256 落库）→ 改密码吊销全部 refresh token。权限模型：user_roles 多对多 → roles.permissions JSON（`*` 通配，每请求查库即时生效）。

AI 流程：`POST /ai/analyze`（SSE）→ 扣积分 → 缓存命中直接回放（不扣费）→ 未命中则建 ai_task → provider 流式生成（失败重试 2 次、指数退避）→ 成功落 ai_analysis；取消/失败双路退款 + bizId 幂等。

### 1.4 后端模块

| 模块 | 职责 |
|---|---|
| DatabaseModule（全局） | DorisService 连接池，唯一 DB 入口，无 ORM |
| AuthModule | 注册/登录/刷新/登出、JWT 策略、权限守卫 |
| UsersModule | 资料、改密、API Key、查询历史（审计埋点） |
| CreditsModule | 余额/流水/计价只读接口 + spend/grant 计费引擎 |
| AiModule | SSE 流式分析、6 个插入点 prompt、缓存、重试、退款 |
| BusinessModule | 7 个域 Service：sales / traffic / keywords / ads / insights / suppliers / diagnosis，17 个 GET 端点 |

### 1.5 前端结构

13 个业务视图 + 登录/注册 + 404/维护页，全部懒加载挂载于 MainLayout；共用组件 4 个（AsinSearchBar、QuerySkeleton、BaseChart、AiAnalysisCard）；AI 插入点 6 处与后端 prompt 注册表一一对应；API 层统一封装（AI SSE 除外，见问题 20）。

---

## 二、总体结论

**健康度评级：B-（可部署前需先完成 P0/P1 修复）**

核心读链路质量高：全链路 SQL 参数化无注入、BIGINT 精度与时区处理闭环正确、Doris 无事务/无行锁特性被系统性消化（积分流水化、Unique Key 整行覆盖语义、幂等 seed）。**但配置面的生产安全存在 2 个 P0（公网数据库明文凭据、JWT 验证回退密钥），商业闭环未接完（计价表对外展示 4 个计费项、实际只有 AI 分析真扣费），前端存在 1 个 P0 交互断链**。共发现问题 66 项：

| 严重度 | 数量 | 说明 |
|---|---|---|
| **P0** | **3** | 必须立即修复，否则上线即事故 |
| **P1** | **12** | 上线前应修复：安全短板、商业逻辑错误、体验断链 |
| **P2** | **31** | 规划内修复：逻辑毛边、健壮性、可维护性 |
| **P3** | **20** | 打磨项：死代码、重复代码、一致性 |

里程碑完成度：goal.md 的 P0~P3 里程碑**代码层均已实现**（README 的进度声明严重滞后，见问题 37），P4（打磨/缓存/SEO）未完成。有三处对书面需求的结构性偏离（自动建表、ads 三页合一、keywords/source 未独立成页），其中"容器自动建表+seed"改为手动脚本是合理的主动决策，但应回写需求文档确认。

---

## 三、问题清单

> 每条含：位置（文件:行号）、问题、影响、修复建议。路径均相对仓库根目录。

### 3.1 安全问题

#### 1.【P0】`.env` 存放公网数据库真实凭据 + 弱 JWT 密钥
- **位置**：`.env:1-7`（后端经 `apps/api/src/app.module.ts:34-37` 加载）；同类文件 `.env.remote:5-8` 含 root 与 etl_user 两套真实密码
- **问题**：Doris FE（9030）暴露在公网 IP，root/etl_user 两套密码明文落盘；`JWT_SECRET` 是人工可猜字符串且文件名自注 "dev_only"。当前 git 仓库 0 提交、11 个路径全部 untracked，尚未实际泄漏——但一旦误提交即全库沦陷（用户 bcrypt 哈希、积分流水可被直接篡改，等于可给自己充值）。
- **建议**：① Doris 9030 加防火墙白名单/仅内网监听；② 轮换两套密码；③ JWT_SECRET 换 `openssl rand -hex 32`；④ 生产用密管而非 .env；⑤ **首次 git commit 前再次确认 `.env` / `.env.remote` / `docs/raw/` 不入库**。

#### 2.【P0】JWT 验证密钥存在硬编码回退值 `'dev_secret'`（潜在认证绕过路径）
- **位置**：`apps/api/src/auth/jwt.strategy.ts:35`
  ```ts
  secretOrKey: config.get<string>('JWT_SECRET') ?? 'dev_secret',
  ```
- **问题**：签发侧 `auth.service.ts:200-206` 无回退，验证侧却回退到众所周知的字符串。当环境变量漏配（容器编排失误、.env 加载失败）时，攻击者可用 `'dev_secret'` 自签 `{sub: <用户ID>}` 通过 JwtAuthGuard——用户 ID 非完全保密（雪花 ID 有时间戳结构可枚举，且 `apps/api/t.json` 落有一份真实 userId 样例）。
- **建议**：与签发侧对齐，缺失时启动即抛错拒绝运行；同时删除 `t.json`（见问题 33）。

#### 3.【P1】登录/注册/刷新接口完全无限流与防爆破
- **位置**：`apps/api/src/auth/auth.controller.ts:13-32`；`apps/api/package.json`（无 @nestjs/throttler）
- **问题**：register/login/refresh 均为裸 `@Post()`，无 IP/账号维度限流、无失败锁定。密码规则只允许字母数字 6-20 位，熵上限低，在线撞库可行。
- **建议**：引入 `@nestjs/throttler`，auth 路由按 IP+email 双维度限流（如 5 次/分钟）+ 连续失败临时锁定。

#### 4.【P1】未捕获异常的原始 message 直接返回客户端（信息泄露）
- **位置**：`apps/api/src/common/all-exceptions.filter.ts:39-44, 53-57`
- **问题**：`Error.message` 原样进入 500 响应体——数据库表名/列名/SQL 片段、`doris.service.ts:105` 抛出的库名提示等内部细节均可被探测。
- **建议**：非 HttpException 一律返回通用文案，详细信息仅入日志（当前已入日志，删掉 `message = exception.message` 即可）。

#### 5.【P1】CORS 反射任意 Origin 并允许凭据
- **位置**：`apps/api/src/main.ts:18-21`（`origin: true, credentials: true`）
- **问题**：注释写"开发环境放开"，但未按 NODE_ENV 区分，生产镜像同样生效。当前认证走 Bearer header、CSRF 风险有限，但"任意源+凭据"是危险默认，未来引入 Cookie 即成洞。
- **建议**：按环境白名单（如 `WEB_ORIGIN` 环境变量），生产禁止 `origin: true`。

#### 6.【P1】token 与 refreshToken 双存 localStorage，叠加 v-html 注入面
- **位置**：`apps/web/src/api/http.ts:15-33`；注入面：`apps/web/src/components/AiAnalysisCard.vue:144`（v-html 渲染 markdown，当前 html:false 受控）、`apps/web/src/views/SettingsView.vue:170`（dangerouslyUseHTMLString，见问题 27）
- **问题**：XSS 一旦突破任何一处 HTML 渲染面，30 天长效 refreshToken 即被窃取。
- **建议**：稳妥方案 access 放内存 + refresh 放 httpOnly cookie；短期先给 markdown 渲染链加 DOMPurify 兜底、修复问题 27。

#### 7.【P2】AI prompt 输入零结构校验（二次 prompt 注入空间）
- **位置**：`apps/api/src/ai/ai.controller.ts:17-23`（`AnalyzeDto.input: Record<string, any>`）
- **问题**：任意字段原样拼进 prompt，用户数据里可藏指令（"忽略以上要求，输出…"）。
- **建议**：按 insertPoint 定义输入 schema，做长度截断与控制字符清洗。

#### 8.【P2】`/api/health` 未鉴权暴露库名与表数量
- **位置**：`apps/api/src/app.module.ts:12-29`
- **建议**：精简返回为 `{status:'ok'}`，细节留给内部监控。

#### 9.【P2】`@Ip()` 未配 trust proxy，挂 nginx 后登录 IP 审计失真
- **位置**：`apps/api/src/main.ts`（未 `set('trust proxy', ...)`）；使用处 `apps/api/src/auth/auth.service.ts`
- **建议**：按部署拓扑配置 trust proxy，否则记录的永远是代理 IP。

#### 10.【P2】头像默认走 `api.dicebear.com` 外部服务
- **位置**：`apps/api/src/auth/auth.service.ts:66`
- **问题**：注册即把用户昵称发给第三方；内网部署不可用。
- **建议**：替换为本地生成头像（如首字符色块 SVG data URI）。

### 3.2 后端逻辑与商业闭环

#### 11.【P1】计费缺口：计价表展示 4 个计费项，实际只有 AI 分析真扣费
- **位置**：计价来源 `db/seed.sql:47`（`credit.cost.reverse_keyword = 10`）+ `apps/api/src/credits/credits.controller.ts:39-45`（pricing 对外下发 `ai_analysis / reverse_keyword / query_sales / query_traffic` 四项）；全仓唯一扣费调用点 `apps/api/src/ai/ai.service.ts:97`
- **问题**：`business.controller.ts:145-155` 的反查流量词全程不扣费；所有业务查询 `track()` 恒传 `creditsCost=0`（`users.service.ts:360`）。用户被引导"反查 10 积分/次"，实际永远免费——要么是未接完的半成品，要么 pricing 接口在说谎（前端设置页照单全收展示，见问题 22）。
- **建议**：在 `listKeywords` 等域接 `credits.spend()` 并把 `spend.txId/cost` 传入审计；短期至少让 pricing 只返回真实生效的计费项。

#### 12.【P1】Refresh token 无轮换、无重用检测
- **位置**：`apps/api/src/auth/auth.service.ts:137-166`
- **问题**：refresh 成功后签发新 token 并插入新行，但旧 token 不写 `revoked_at`，直到 30 天自然过期一直可用——一旦泄露，攻击者可与用户并行无限续期。
- **建议**：refresh 成功即吊销旧 token（整行覆盖写法可抄 `logout()` 185-190 行）；再进一步做重用检测（发现已轮换 token 被二次使用 → 吊销该用户全部 token）。

#### 13.【P2】AI：先扣费、后建任务，任务落库失败时积分永久丢失
- **位置**：`apps/api/src/ai/ai.service.ts:97-131`（97 行 spend → 113 行 INSERT ai_tasks，失败无退款；退款只存在于流式循环结束与取消分支 245-246 行）
- **建议**：建任务包 try/catch，失败按 `spend.cost` 走 grant 退款。

#### 14.【P2】AI：流中途失败重试会向客户端重复推送已发内容
- **位置**：`apps/api/src/ai/ai.service.ts:145-241`
- **问题**：重试循环内每次 attempt 重新 `provider.chatStream`，而 delta 实时 yield 给 SSE——第 1 次尝试在第 N 块断流后重试，客户端会先收到半篇文章、再收到从头开始的完整文章。
- **建议**：重试前先发 `{type:'reset'}` 事件让前端清空缓冲，或首个 delta 落地前不对外 yield，或失败即终止不重试。

#### 15.【P2】AI 缓存键不含 user_id，全局共享缓存允许 0 余额用户白嫖
- **位置**：`apps/api/src/ai/ai.service.ts:68-91`（WHERE 无 user_id；命中后不扣费）
- **问题**：用户 A 付费生成后，任何 0 积分用户 B 对同一输入永久免费命中；schema 注释表明是有意设计，但与"analysis 属于付费产物"冲突。
- **建议**：明确产品决策——要么按 user_id 隔离，要么在 goal.md/文档落字确认共享策略。

#### 16.【P2】关键词游标分页：NULL 排序值的行永远翻不到，且可能提前截断
- **位置**：`apps/api/src/business/keywords.service.ts:56-62, 78-85`（排序字段 `nf_last_rank`/`listing_score_ratio` 可空；`makeCursor` 把 NULL 编成 0）
- **问题**：NULL 行对游标条件永不命中——DESC 排序时 NULL 行在尾部，第一页就 `hasMore=false` 则用户永远看不到这些词；NULL 编码为 0 也会跳过真实行。
- **建议**：SQL 侧 `ORDER BY sortCol IS NULL, sortCol DESC`，游标里编码 isNull 标志，或 `COALESCE` 成哨兵值。

#### 17.【P2】"最新月份"跨站点取全局 MAX，多站点数据不齐时误判为"无数据"
- **位置**：`apps/api/src/business/traffic.service.ts:245-251`、`keywords.service.ts:194-200`（无 country 过滤的 `MAX(time_piece_value)`）；`sales.service.ts:82-84`、`insights.service.ts:230-234`（`stat_month = (SELECT MAX(...))`）
- **问题**：真实多站点数据不齐时（US 到 2026-08、JP 只到 2026-06），查 JP 会拿到全局最新月 → 空结果被当"该 ASIN 无数据"。当前单站点 seed 掩盖了问题。
- **建议**：MAX 加 `WHERE country = ?`；销量概览改为按 asin 各自取 MAX。

#### 18.【P2】流量结构-推荐专栏聚合无时间边界，ratio 总和已超 1
- **位置**：`apps/api/src/business/traffic.service.ts:91-101`（`fact_asin_rec_column_period` 是按日存行的表，查询只有 asin+country 条件，无日期过滤）；佐证：`apps/api/r.json` 中 4 个专栏 ratio 相加约 1.53
- **建议**：与频道查询一致地按 time_piece/日期范围过滤，或明确接口语义注释。

#### 19.【P2】MATCH_ANY / LIKE 的用户输入未做语法转义
- **位置**：`apps/api/src/business/keywords.service.ts:50-53`（MATCH_ANY）；`suppliers.service.ts:46-51`（LIKE）
- **问题**：MATCH_ANY 串含 `+ - () "*` 等操作符字符直接查询报错（叠加问题 4 会以 500 原始 message 返回）；LIKE 的 `%`/`_` 未转义，传 `%` 即全扫。无注入风险（已参数化），纯健壮性问题。
- **建议**：MATCH_ANY 前仅保留中英文数字按空格分词；LIKE 前转义 `%_\`。

#### 20.【P2】API Key 是"有建无管"的死功能
- **位置**：`apps/api/src/users/users.service.ts:157-265`（创建/列表/吊销齐全）；全仓无任何 Guard 读取 `key_hash` 做认证
- **问题**：界面提示"仅此一次返回"引导用户生成 Key，但系统内无处可用。
- **建议**：本期不开放 OpenAPI 则隐藏该设置页；否则补 ApiApiKeyGuard 并让查询接口双轨认证。

#### 21.【P2】权限注释与 seed 矛盾：普通用户实际拥有 `supplier:read`
- **位置**：`apps/api/src/business/business.controller.ts:224-225`（注释称普通用户无此权限）vs `db/seed.sql:30`（实际包含）
- **影响**：`@RequirePermissions('supplier:read')` 对全部 seed 用户形同虚设，误导后续维护者的安全验证。
- **建议**：修正注释（前端 SuppliersView 的理解是对的），并在 README 记录权限点清单。

#### 22.【P2】密码策略不一致：注册允许 6 位纯字母数字，改密码要求 8 位且无复杂度校验
- **位置**：`apps/api/src/auth/dto/auth.dto.ts:18-21`（6-20 位+字母数字）vs `users.service.ts:123-125` / `users/dto/user.dto.ts:48`（8 位，无正则）
- **建议**：抽共享的自定义校验 decorator 统一两处。

#### 23.【P2】竞品对比 `best.bought` 在无销量数据时错误地全标 true
- **位置**：`apps/api/src/business/insights.service.ts:255-270`
- **问题**：组内恰有一个 ASIN `bought_lower_bound = 0` 时 `maxBought === 0`，所有无销量数据的 ASIN 都满足 `0 === 0` → `best.bought = true`。
- **建议**：无 label 的项直接返回 null，不参与比较。

#### 24.【P2】依赖健康：lint 脚本引用未安装的 eslint；@types/express 大版本错配
- **位置**：`apps/api/package.json:11`（`lint` 脚本，devDependencies 无 eslint）与 `package.json:33`（`@types/express ^5`，而 platform-express 10 依赖 express 4）
- **建议**：补 eslint 或删脚本；@types/express 降 `^4.17.x`。

#### 25.【P3】REST 与响应风格细节（合并列出）
- 改密码用 `POST /users/me/password` 宜为 PATCH（`users.controller.ts:43`）；
- 错误响应 `code` 复用 HTTP 状态码而成功为 `code:0`，语义需文档明确（`all-exceptions.filter.ts:53-57`）；
- `getTask/getAnalysis` 返回原始 snake_case 且查不到时返回 `data:null`，与其他接口 camelCase + NotFoundException 风格不一致，前端无法区分"任务不存在"和"还在跑"（`ai.service.ts:306-321`）；
- 审计埋点只在 5 个端点埋 `track()`，trend/ads/variations/timeline/recommendations/competitors 等无记录，查询历史页会缺条目（`business.controller.ts`；若设计是"每页面只记入口查询"应注释说明）；
- `changePassword` 后 access token 仍有效至 2h 未同步吊销（`users.service.ts:147-150`，可加 token 版本号）；
- `touchLastLogin` 整行覆盖在并发下会回滚管理员刚做的状态变更（`auth.service.ts:241-271`，低概率）；
- `credits.getCost` 缺配置即免费（fail-open，`credits.service.ts:204-211`），接真实支付需改 fail-closed；
- `computeBalance` 每次扣费至少 3 次全量 SUM（`credits.service.ts:82-88`），量大后需缓存；
- openai provider 的 abort 监听器未移除、用户取消后仍会白跑重试退避（`openai-compatible.provider.ts:43`、`ai.service.ts:167-175`，功能正确但多等 3 秒）。

#### 26.【P3】可维护性：死代码与重复代码（合并列出）
- 死代码：`business.controller.ts:31-39` 的 `CompareDto`（competitors 实际走裸 `@Query('asins')` 拆分，顺带绕过 ASIN 格式与 country 校验）；`doris.service.ts:145-164` 的 upsert 系列；`format.ts:46-60` 的 num/numOr/bool（各 service 反而手写 null→Number 转换数十处，应统一用 helper）；`snowflake.ts:74-76` 的 `nextIdStr()`。
- 重复代码：父/子 ASIN 解析在 `sales.service.ts:37-50`、`traffic.service.ts:224-242`、`insights.service.ts:282-296` 三处复制（第三处返回类型还不同）；`now()`（UTC 时间串）在 auth/users/credits/ai 四个 service 重复定义（`credits.service.ts:448-450` 注释自认曾因私写时区踩过 8 小时偏移坑）——应集中到 common；游标 where 拼装在 users/credits/suppliers 三处雷同。
- 其他：`tsconfig.json:16-18` `noImplicitAny:false` 等宽松配置 + 诊断服务 13 处 `as any`；mock provider 每字符 24ms 导致联调一次约 6 秒（`mock.provider.ts:31-40`，可参数化）。

### 3.3 前端页面与交互

#### 27.【P0】流量结构页"查广告架构"按钮点击即断链
- **位置**：`apps/web/src/views/TrafficView.vue:180`
  ```html
  <el-button ... @click="router.push({ name: 'ads-campaigns', query: { asin } })">查广告架构 →</el-button>
  ```
- **问题**：路由表中广告页 name 是 `ads`（`src/router/index.ts:105`，已人工复核）。`DashboardView.vue:32-36` 注释明确记录过同一个 bug 并修了 Dashboard，TrafficView 漏修。点击后 Vue Router 报 "No match found"，页面无反应，核心下钻链路（流量 → 广告）断裂。
- **建议**：改为 `{ name: 'ads', ... }`；并全局 grep 所有 `router.push({ name:` 与路由表比对（同类风险点：问题 31 的历史重查）。

#### 28.【P1】"默认站点"设置是死功能：保存后没有任何查询页使用它
- **位置**：`apps/web/src/views/SettingsView.vue:237-242`（提示"查询页未指定站点时用这个"）vs `src/api/business.ts`（11 个方法硬编码 `country = 'US'` 兜底；grep 确认所有视图调用均不传 country）
- **问题**：用户把默认站点改成 UK/JP 后，所有查询仍查 US，设置项暗示了不存在的行为。
- **建议**：业务 API 层读取用户 profile 的 defaultCountry 作为默认值，或各视图显式传入。

#### 29.【P1】AI 流式请求绕过 axios 拦截器：token 过期无自动刷新
- **位置**：`apps/web/src/api/ai.ts:49-62`（裸 `fetch('/api/ai/analyze')`，access 为空时仍发送 `Bearer ` 空凭据）
- **问题**：axios 实例（`http.ts:92-109`）有 401→refresh→重放逻辑，AI 用裸 fetch 直连——登录态过期后点"开始分析"只会看到生硬的"请求失败（HTTP 401）"，需整页刷新恢复，与其他页面体验不一致。
- **建议**：onError 遇 401 先复用 `doRefresh()`（可从 http.ts 导出）再重试一次；access 为空直接引导重新登录。

#### 30.【P1】历史"重查/回放"对 keyword 类型记录的处理必然失败
- **位置**：`apps/web/src/views/DashboardView.vue:51-54`（keyword 类型被当 ASIN 跳到查销量页，后端 DTO 400）；`src/views/HistoryView.vue:50-55`（跳 `/keywords` 时把关键词塞进 `asin` 参数，触发无效查询；跳 `/suppliers` 带的参数 SuppliersView 根本不读）
- **建议**：keyword 类型跳 `/keywords` 且参数名用 `keyword`；Dashboard 回放优先使用记录里的 `pageRoute`（后端 stats 接口需补该字段）。

#### 31.【P1】积分计价展示误导（与问题 11 前后端呼应）
- **位置**：`apps/web/src/views/SettingsView.vue:310-316`（照单展示 4 个计费项）+ `apps/web/src/views/DashboardView.vue:118`（硬编码"AI 分析 5 积分/次"，与专门的 `credits.costOf('ai_analysis')` 机制冲突，注释还写明"避免前端硬编码价格"）
- **建议**：后端只下发真实计费项或前端注明"查询类当前免费"；Dashboard 改用 `costOf()`。

#### 32.【P2】查询失败与"未查询"状态不可区分，错误态一律退回初始空态
- **位置**：同一模式遍布 7 个视图：`SalesView.vue:50-55,289-293`、`TrafficView.vue:36-41,290`、`KeywordsView.vue:55-60,237`、`AdsView.vue:45-49,263`、`RecommendationsView.vue:27-32,110`、`TimelineView.vue:28-32,174`、`VariationsView.vue:28-32,176`
- **问题**：catch 里清空数据，模板兜底是"输入 ASIN 开始查询"——接口 500 后输入框里明明有 ASIN，用户以为没触发查询。
- **建议**：增加 error 状态（el-alert + 重试按钮），与 idle 空态区分。

#### 33.【P2】测试样例 JSON（含真实 token）混在源码根目录
- **位置**：`apps/api/r.json`、`r1.json`、`r2.json`、`r3.json`、`t.json`（手工联调的接口响应快照；`t.json` 内含真实 accessToken/refreshToken 明文，userId 380000000000000001）
- **影响**：refreshToken 30 天内有效（除非已手动登出）；夹具干扰构建与检索（.dockerignore 已挡住，但文件仍在）。
- **建议**：移到 `test/fixtures/` 并脱敏，删除 token。

#### 34.【P2】AI 卡片"重新分析/重试"不受 disabled 约束，可用空输入再次扣费
- **位置**：`apps/web/src/components/AiAnalysisCard.vue:124-129`（done 态按钮无 `:disabled`）
- **场景**：SuppliersView 跑完 AI 后清空勾选，再点"重新分析"会以 `suppliers: []` 扣费请求。
- **建议**：done/error 态按钮同样绑定 disabled，或 start() 校验 input 非空。

#### 35.【P2】Element Plus 全量引入使按需加载配置形同虚设
- **位置**：`apps/web/src/main.ts:3-5,41`（全量 import + `app.use(ElementPlus)`）vs `vite.config.ts:22-23`（ElementPlusResolver 按需 resolver）
- **影响**：element chunk 全量打包约 1MB 原始体积，JS 侧按需未生效。
- **建议**：去掉全量 `app.use`，locale 改用 `ElConfigProvider`；或接受全量并删除误导注释。

#### 36.【P2】杂项健壮性问题（合并列出）
- `SettingsView.vue:165-171`：`dangerouslyUseHTMLString` 内插服务端字符串（key 生成规则变化或代理篡改即成注入点），改 slot 或先 escapeHtml；
- 未处理 Promise 拒绝：`MainLayout.vue:61-68`（logout confirm 取消）、`SettingsView.vue:36-43,99-112,140-147,177-186`、`AdsView.vue:67-83`——每次取消/失败控制台都报 unhandledrejection，掩盖真实异常；统一 `.catch(() => 'cancel')`；
- `KeywordsView.vue:76-85, 259-309`：关键词来源抽屉请求失败或后端返回 null 时全白（后端 `keywords.service.ts:147-148` 确有 `return null` 分支），抽屉内加 `el-empty` 兜底；
- `TimelineView.vue:150,152`：模板直接访问 `data.events.length` 无空值防御，后端字段缺失即整页白屏；
- `apps/web/src/api/business.ts:108-169`：9 个 API 返回 `any`，视图直接 `row.best.price`、`row.encryptCampaignId` 等取值，字段拼错/后端改名编译期零报警——后端 service 已有明确返回形状，抄一遍补类型即可；
- 商品查询页对 `route.query.asin` 变化不响应（仅 DiagnosisView 有 watch，其余 8 页只 onMounted 读一次）——抽 `useAsinQuery(search)` 组合式函数统一；
- `stores/auth.ts:57-59`：`restore()` 吞掉所有错误（含断网），出现"有 token 但顶栏显示未登录"的中间态。

#### 37.【P3】前端打磨项（合并列出）
- 死代码/未用导入：`AdsView.vue:2` 的 computed、`SalesView.vue:4` 的 ElMessage、`TrafficView.vue:118-131` 的 stackStyle 残留、`/maintain` 路由 + MaintainView 全站无跳转入口（http.ts 只 toast，注释宣称的"500→/maintain"未落地）、`env.d.ts` 的 stage meta 与重复的 RouteMeta 声明；
- `env.d.ts:3-7` 的 `*.vue` shim 把组件 props 类型检查整个废掉（已有 unplugin 生成的 components.d.ts，应删 shim）；
- 魔法数字：专栏条宽 `ratio*100*6`（TrafficView.vue:202）与 `*8`（RecommendationsView.vue:95）两处倍率不同且会饱和，应统一相对最大值归一化；
- `DiagnosisView.vue:138,145`：`pct()` 返回 `—` 直接当 CSS width，非法样式应回退 `0%`；
- `TimelineView.vue:164`：`JSON.stringify(row.detail)` 直出原始 JSON 串；
- 文案一致性：CompetitorsView 空态写"输入 2 个以上 ASIN"但 `add()` 允许只加 1 个；SettingsView 计价区直出英文 bizType（`ai_analysis`）；MainLayout 积分 `?? '—'` 使加载中与真实为空不可区分；
- `http.ts:106`：401 兜底跳转只带 pathname 丢 query；refreshing Promise 并发清理有轻微竞态（94-96 行）；
- 可访问性：BaseChart 无 aria-label、AI 流式区未标 aria-live、顶栏 emoji 图标无文本替代（QuerySkeleton 做得对，可作标准推广）；
- `index.html` 缺 favicon 声明，`/favicon.ico` 经 SPA 回退返回 HTML；
- 构建细节：manualChunks 缺 markdown-it（约 100KB 留在业务 chunk）；`vite.config.ts:40-46` 给 Vite 内置代理设 nginx 专用头 `x-accel-buffering` 无意义。

### 3.4 数据库设计

**总体**：55 张表 = 14 系统（schema-01-system.sql）+ 43 业务（schema-02-business.sql，由 `db/gen-business-schema.mjs` 生成，声明"勿手工编辑"）。业务表按 `dim_`（8）/`fact_`（18）/`rel_`（6）/`dict_`（10）分层。8 条 Doris 约束（goal.md）全部遵守：全表 Unique Key + MoW + 单副本、应用层雪花 ID、无外键、HASH 分桶（分布键均取自 UNIQUE KEY 前缀子集，逐表核对无违规）、倒排索引（MATCH_ANY）、余额流水化。

#### 38.【P2】18 张 fact_ 时序表全部无分区
- **位置**：`db/schema-02-business.sql` 全部 CREATE TABLE
- **问题**：只有 HASH 分桶无 RANGE 分区——无分区裁剪，历史清理只能批量 DELETE，compaction 压力随时间线性涨。`schema-01-system.sql:60` 已意识到"过期清理用定时任务"，但没有分区支撑。
- **建议**：P2 前给 fact_ 表补 `PARTITION BY RANGE(stat_date)`，或记入技术债清单。

#### 39.【P3】设计假设与生成器细节（合并列出）
- `dim_keyword` 的 country 不在主键——依据"实测 keywordId 全局唯一、三站 ID 段不重叠"（对第三方行为的观察归纳，文档已自我标注，若后续实测范围扩大需复核）；
- `fact_word_frequency` 主键 7 列，Doris 支持但索引/存储开销偏大，可观察；
- `gen-business-schema.mjs:30` 起多处行首缩进错乱（纯可读性）；表 COMMENT 清理只删单引号，若未来 comment 含反斜杠仍有注入注释区可能（低风险）；
- `docs/sql/variant_sales_list.sql:15-20`：size_text 将 Color 和 Size 两类属性混拼一列，前端需二次拆分。

### 3.5 部署与基础设施

#### 40.【P2】两个 Dockerfile 均未复制 package-lock.json，构建不可复现
- **位置**：`apps/api/Dockerfile:14-15,30-32`、`apps/web/Dockerfile:9-10`（只 COPY package.json 后 `npm install`；仓库两份 lock 文件均存在）
- **影响**：两次构建可能装入不同版本依赖（element-plus/vite 皆有行为变更前科）；`npm install` 也比 `npm ci` 慢。
- **建议**：COPY lock 文件并改 `npm ci`（runner 用 `npm ci --omit=dev`）。

#### 41.【P2】web 镜像未 COPY public/，robots.txt 不进镜像
- **位置**：`apps/web/Dockerfile:12-13`
- **影响**：当前仅 robots.txt 丢失；P4 做 SEO 时直接踩坑（路由层 robots meta 已做，构成不一致）。
- **建议**：COPY apps/web/public/ 进构建产物。

#### 42.【P2】compose web 依赖用 service_started 而非 service_healthy
- **位置**：`docker-compose.yml:66-68`
- **影响**：api 未就绪窗口内 nginx 反代短暂 502（自动恢复）。
- **建议**：升级为 `condition: service_healthy`（api 已配健康检查，现成可用）。

#### 43.【P2】环境变量文件治理
- **位置**：`.env.remote:19` 与 `:21` 重复定义 `API_PORT`（3000 与 13000，dotenv 后者生效，易误导排查）；`.env.remote` 的 `WEB_DOCKER_PORT` 未收录进 `.env.example`（README.md:58 有提到）；compose 的 `JWT_SECRET`/`DB_PASSWORD` 无默认值，.env 缺失时只告警不拦截。
- **建议**：清理重复定义、补全 .env.example、compose 侧对必填变量做前置校验。

#### 44.【P3】编排其余细节
- compose 服务依赖顺序、健康检查（api 用 node 原生 http GET /api/health + start_period 20s）、host.docker.internal 映射、端口可配置化均正确；Doris 外置不入 compose 符合需求；
- `apps/api` 无 `nest-cli.json`（nest build 靠默认值工作）；
- `setup-doris.sh:102-104`：etl_user 授权失败静默降级（`2>/dev/null || 可忽略`），首次执行若用户不存在不会显式报错——幂等重跑可修复，但首跑失败不易察觉。

### 3.6 文档、合规与需求管理

#### 45.【P1】README 进度声明与实际严重不符
- **位置**：`README.md:126-130`（勾选仅 P0 完成）vs `apps/web/src/router/index.ts:24-27`（注释声称 P1~P3 已实现）+ 9 个业务视图、17 个业务端点实际存在
- **影响**：两处必有一处过期，直接误导验收。
- **建议**：以实际代码为准更新 README 里程碑勾选。

#### 46.【P1】对第三方站点的登录态自动化访问与抓取物残留（合规风险，如实陈述）
- **位置**：`tools/sif-proxy.mjs`（本地回环反向代理到 sif.com，改写 Set-Cookie 保持登录态，带抓包能力默认截获 `asinAdCampaignView|/api/struct/`）；`docs/raw/_probe/`（原站 1.0MB bundle + 117 个 chunk 共 14MB + 83 条路由 + 335 个 API 端点清单）；`docs/raw/capture.ndjson`（真实账号的响应数据）
- **评估**：侦察行为本身在 goal.md 授权范围内（goal.md 明确要求页面/接口侦察，且产品本身约定真实数据从 Sif 购买、供应商模块明令禁止爬虫——复刻产品不含任何采集逻辑）。风险控制意识良好：.gitignore 已将 `docs/raw/`、`tools/sif-proxy.mjs` 全部排除出仓库并注明侵权顾虑。**残余风险**：登录态自动化访问大概率违反对方 ToS；抓取物与含真实账号数据的 capture.ndjson 仍留本地；若仓库对外公开，API_INVENTORY/SPEC 中的原站接口契约有法律暴露面。
- **建议**：侦察完成后清除或加密归档 docs/raw 与 capture.ndjson；对外公开前对 SPEC/API_INVENTORY 做脱敏裁决。

#### 47.【P1】goal.md 硬性要求"容器启动时自动建表+seed"未实现，属未确认偏离
- **位置**：goal.md:526 vs 实际实现（手动 `bash scripts/setup-doris.sh` + 后端启动自检打中文错误提示，README.md:41、docker-compose.yml:8-10）
- **评估**：偏离理由充分（同机已有 loom/reroll_analysis 两个在用库，自动建表脚本在容器里跑 root SQL 风险更高；setup-doris.sh 本身幂等且带保护库护栏），且文档如实记录。但这是对书面需求的偏离，需求方应正式确认并回写。
- **建议**：在 goal.md 补勘误注记，正式确认此决策。

#### 48.【P2】文档滞后项（合并列出）
- `db/DATA_DICTIONARY.md:3-4` 头部仍写"目标库：sif_replica""状态：侦察进行中"——实际 55 表已建成、库名已改 `looom`（因 Doris 服务器已有在用的 `loom` 库，见 `docs/DORIS_SETUP.md:46-57`，setup 脚本 `scripts/setup-doris.sh:44-51` 已加保护库护栏）；
- goal.md 仍写库名 `sif_replica`、DB_HOST=127.0.0.1；
- 三处对 goal.md 16 页清单的结构偏离未回写：`/ads` 三页合并为 AdsView 单页（端点仍分立）、`/keywords/source` 未独立成页（实现为 KeywordsView 内下钻抽屉 + 独立端点）、`/competitors` 属 goal 原创设计（原站无此页）。

---

### 3.7 建议项（P3）汇总

除上文各节已合并列出的 P3 外，再补充：

1. **完全没有测试**：前后端均无任何 `*.spec.ts` / test script。最值得优先补的：snowflake、cursor、credits 并发逻辑（spend/前缀余额，纯函数可模拟）、路由名静态校验（本报告 P0-27 正是 lint/测试能拦住的类别）。
2. 审计与可观测：nginx 侧未落访问日志格式约定；后端日志无 request-id 串联。
3. 开发体验：mock provider 速度参数化（见问题 26）；前端补 eslint+prettier（当前仅 vue-tsc）。

---

## 四、需求覆盖度对照表

| 需求项（goal.md） | 状态 | 证据 |
|---|---|---|
| P0：compose 骨架 + setup-doris.sh + 全量建表 + 认证 + AI 骨架 + mock provider + SSE | ✅ 已实现 | docker-compose.yml；ai.module/service/controller、双 provider、SSE（ai.controller.ts:45）、/api/health |
| P1：9 个核心读页面接 seed | ✅ 已实现（README 未同步） | 9 个非空壳视图 + business.controller 17 个 GET 端点 |
| P2：AI 插入点 1-3 + 用户中心 + 积分 | ✅ 已实现 | SettingsView 547 行、credits 模块、6 个 prompt 注册 |
| P3：AI 插入点 4-6 + suppliers 占位 + 权限 + 历史 | ✅ 已实现 | SuppliersView（含 403 区分与"示例数据"提示条）、DiagnosisView、HistoryView |
| P4：打磨/缓存/SEO | ⏳ 未完成 | router/index.ts:28 自述待做 |
| seed：5 ASIN×50 词×30 天 + 3 活动 + 10 供应商×5 产品 + 2 用户 | ✅ 已实现且超标 | seed.sql 尾注：分渠道 1275 行、30 天排名 7650 行、3 活动/9 投放小组、50 供应商货源；测试账号 user@looom.dev / admin@looom.dev（密码 test1234） |
| Doris 8 条约束 | ✅ 全部遵守 | schema 逐条对应 |
| 容器启动自动建表+seed（goal.md:526） | ⚠️ 有意偏离，待需求方确认 | 见问题 47 |
| 统一响应 `{code,message,data}` / 游标分页 / 401 自动刷新 | ✅ 已实现（401 刷新覆盖 AI SSE 除外） | 问题 29 |
| `/keywords/source` 独立页面 | ⚠️ 偏离（合并为抽屉下钻 + 独立端点） | 问题 48 |
| ads 三页 | ⚠️ 偏离（合并为单页"广告透视"，端点仍分立） | 问题 48 |
| 供应商模块无爬虫 | ✅ 遵守 | 全仓无采集代码，seed 全自造 |
| 侦察（页面/接口逆向） | ✅ 完成（有合规残余风险） | docs/SPEC.md、routes.json、API_INVENTORY.md；静态推断被实测推翻 10 处（含"page 参数被静默忽略"关键坑） |

---

## 五、页面与 API 清单

### 5.1 前端页面（17 个视图全部挂载，无 TODO/占位残留；唯一"占位"是供应商页，goal.md 明确要求且已用提示条说明）

| 路由 | 视图 | 功能 | 主要问题 |
|---|---|---|---|
| /dashboard | DashboardView | 快捷查询入口 + 积分/查询统计 + 最近查询回放 + 使用指南 | 硬编码 AI 价格（31）、keyword 回放失败（30） |
| /sales | SalesView | 父体/变体销量概要、月度趋势折线、变体明细、AI 解读 | 错误态退空态（32） |
| /traffic | TrafficView | 自然vs广告饼图、广告细分、推荐专栏、分变体渠道堆积、AI 诊断 | **断链按钮（27）** |
| /keywords | KeywordsView | ASIN 流量词列表（筛选/服务端排序/游标加载）、词来源抽屉、AI 投放建议 | 抽屉白屏（36） |
| /variations | VariationsView | 多变体得分/占位数双轴图 + 关键词×变体占位分布表 | — |
| /timeline | TimelineView | 四指标走势 + 运营事件 markLine + 事件表 | events 空值防御（36） |
| /ads | AdsView | 活动→投放小组→买家搜索词三 Tab 下钻 + AI 优化 | 错误态（32） |
| /recommendations | RecommendationsView | ASIN 所处推荐位卡片网格（逐日流量条形） | — |
| /competitors | CompetitorsView | 多 ASIN（≤10）并排对比、组内最优高亮、URL 可复现 | 空态文案矛盾（37） |
| /diagnosis | DiagnosisView | 四域数据完整性总览 + 各域摘要 + AI 根因诊断 | pct() 样式（37） |
| /suppliers | SuppliersView | 占位实现：筛选 + 示例货源 + 勾选 AI 评估（403 区分） | AI 卡 disabled（34） |
| /history | HistoryView | 按类型筛选查询流水、游标分页、点击回跳 | 回跳参数错（30） |
| /settings | SettingsView | 资料/改密/积分流水与计价/API Key 四 Tab | 计价误导（31）、多个未 catch（36） |
| /login /register | Login/Register | 表单校验与后端 DTO 对齐的游客页 | — |
| /maintain /404 | Maintain/NotFound | 404 生效；维护页为死路由 | 37 |

路由守卫（router/index.ts:196-224）逻辑正确：无 token → login 带 redirect；已登录访问 guest 页 → dashboard；业务页统一 noindex + SEO meta。

### 5.2 后端 API 端点（前缀 /api）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | /health | 无 | 健康检查（暴露表数，问题 8） |
| POST | /auth/register · /login · /refresh · /logout | 无 | 无限流（问题 3） |
| GET | /auth/me | JWT | 探针 |
| GET/PATCH | /users/me/profile | JWT | 资料（IP 回显，P3） |
| POST | /users/me/password | JWT | 改密（吊销 refresh） |
| GET | /users/me/stats · /me/query-logs | JWT | 概览统计/查询历史（游标） |
| GET/POST/DELETE | /users/me/api-keys[/:id] | JWT | API Key（死功能，问题 20） |
| GET | /credits/balance · /transactions · /pricing | JWT | 积分只读（计价与实际扣费不符，问题 11） |
| POST | /ai/analyze | JWT | SSE 流式分析（6 插入点，扣费+缓存+重试+退款） |
| GET | /ai/tasks/:id · /tasks/:id/result | JWT | 任务状态/结果（风格不一致，问题 25） |
| GET | /business/sales/overview · /sales/trend | JWT | 销量概览/40 月趋势 |
| GET | /business/traffic/structure · /traffic/variants | JWT | 流量结构/分变体 |
| GET | /business/keywords · /keywords/:keywordId/source | JWT | 反查词（游标/排序）/词来源 |
| GET | /business/ads/campaigns · /:id/groups · /ads/keywords | JWT | 广告三段下钻 |
| GET | /business/variations · /timeline · /recommendations · /competitors | JWT | 自然位/时光机/推荐专栏/竞品对比 |
| GET | /business/suppliers · /suppliers/locations | JWT+`supplier:read` | 供应商占位搜索 |
| GET | /business/diagnosis | JWT | AI 综合诊断数据汇总 |

---

## 六、做得好的方面

为避免"只报忧"，以下是审查中确认质量较高的设计与实现：

**后端**
- **SQL 注入零发现**：所有用户输入 `?` 参数化；动态 IN 子句按占位符生成；排序字段白名单映射；LIMIT 强制 1-100；upsert 的表名/列名插值无用户输入可达。
- **BIGINT 精度与时区闭环**：连接层 `supportBigNumbers + bigNumberStrings`（雪花 ID 19 位超 JS 2^53，静默写错的坑已在 DORIS_SETUP.md:222-253 记录）；连接 `timezone:'Z'` + 全链路 UTC 字符串，写入读取一致。
- **积分并发设计**：append-only 流水 + 雪花 ID 前缀余额 + 反连接回滚，是对 Doris 无行锁现实的合理妥协（credit_accounts 表注释中 20 并发 CAS 实测论证完整）；seed 流水 ID 故意用 1e17 量级避开前缀判定坑。
- **AI 主链路健壮**：双 provider 工厂、prompt 版本号参与缓存键、空结果不落缓存、取消/失败双路退款 + bizId 幂等，两处"事后补修"注释详实。
- **注释密度高**：踩坑记录写在代码现场，DORIS_SETUP.md 的 8 个 Doris 坑（roles 保留字、replication_num、MoW 整行替换语义等）全部带实测证据。

**前端**
- `http.ts` 的 401 并发刷新合并（共享 refreshing Promise + `_retried` 防重放）与框架错误文案过滤考虑周到；
- `AiAnalysisCard` 四态机完整，卸载时中断 SSE 防止后端继续烧 token，markdown `html:false` 关闭注入；
- `AsinSearchBar` 前端正则与后端 DTO 对齐（就地报错不发请求）；`QuerySkeleton` 含 prefers-reduced-motion 与 aria；
- 全仓 **0 处 console.log / debugger / TODO 残留**； SuppliersView 对 403 与空结果区分处理。

**数据库与部署**
- country 进业务表主键（基于实测原站拦截器强制追加 country、13 站点的结论）；43 张同构表由生成器产出保证列对齐；seed 用确定性 LCG + bcrypt 自检 + utf8mb4 双保险 + chunk=200 适配；
- nginx 配置质量高：assets 长缓存 immutable、index.html no-cache、SSE 三件套（proxy_buffering/cache off + read_timeout 300s）、SPA 回退；
- setup-doris.sh 幂等 + 连通性预检 + 保护库护栏 + 密码走 MYSQL_PWD 不进进程列表。

---

## 七、修复路线图

**第一阶段：上线前必须（P0，约 0.5 天）**
1. 轮换数据库密码 + Doris 9030 加白名单 + 更换 JWT_SECRET（问题 1）
2. 删除 `jwt.strategy.ts:35` 的 `'dev_secret'` 回退，缺失即启动失败（问题 2）
3. 修复 TrafficView 路由名 `ads-campaigns` → `ads`，全局比对一遍 `router.push({ name:`（问题 27）
4. 删除 `apps/api/t.json` 及 r*.json（问题 33）；确认 .env/.env.remote/docs/raw 不入库后再首次 commit

**第二阶段：上线前应做（P1，约 2-3 天）**
5. auth 接口加 @nestjs/throttler 限流（问题 3）
6. 异常过滤器不再回传原始 message（问题 4）+ CORS 按环境白名单（问题 5）
7. 决策计费闭环：接入 reverse_keyword 等扣费，或 pricing 只下发 ai_analysis（问题 11、31）
8. refresh token 轮换吊销（问题 12）
9. defaultCountry 打通（问题 28）+ AI fetch 401 刷新（问题 29）+ 历史重查参数修正（问题 30）
10. README 里程碑更新（问题 45）；goal.md 确认"手动建表"偏离（问题 47）；合规材料归档裁决（问题 46）

**第三阶段：上线后迭代（P2，按域排期）**
- 后端：AI 退款路径（13）→ SSE 重试 reset（14）→ 游标 NULL（16）→ MAX 加 country（17）→ 专栏时间边界（18）→ MATCH_ANY/LIKE 转义（19）→ API Key 收敛（20）→ 密码策略统一（22）→ best.bought（23）
- 前端：错误态组件化（32）→ AI 卡 disabled（34）→ 类型补齐（36）→ Element Plus 按需（35）
- 基建：Dockerfile npm ci（40）→ public/ 入镜像（41）→ compose healthy（42）→ fact 表分区技术债（38）

**第四阶段：工程化（P3）**
补最小单测（credits/cursor/snowflake + 路由名静态校验）→ 前后端 eslint → 死代码与重复代码清理（26）→ 可访问性 → SEO（P4 里程碑）。

---

*报告完。检查方法与全部证据均来自对仓库当前工作区（0 提交状态）的全量阅读，未依赖任何构建产物。*

# 角色

你是我的全栈工程师搭档。我们要一起复刻一个网站的后台部分。

# 目标

复刻 sif.com 的 Web 后台。它已经在你的内置浏览器里打开，并且处于已登录状态。
目标不是像素级照抄，而是复刻它的**核心功能、信息架构和交互流程**，
产出一个我能自己跑起来、自己继续扩展的完整项目。

# 站点定位（已确认）

Sif 是一个面向亚马逊卖家的 Listing 和广告优化 SaaS 工具。
核心能力是对亚马逊站内流量做全覆盖分析，包括：
- 自然搜索流量
- PPC 广告流量（SP / SB / SBV）
- 搜索推荐流量（Amazon Choice、Editorial Recommendation、Top Rated）
- Deal 流量（限时优惠、秒杀、优惠券）

帮助卖家：反查竞品流量词、找出最畅销变体、监控关键词排名、
分析广告结构、挖掘市场机会词。

原站是浏览器插件 + Web 后台混合形态。我们**只复刻 Web 后台**，
不做浏览器插件。用户通过粘贴 ASIN 或关键词来查询数据。

**数据来源暂不考虑**：真实数据后续从 Sif 购买，本期全部用 seed 模拟数据。

# 技术栈（已定，不要替换）

- 前端：Vue 3 + TypeScript + Vite + Vue Router + Pinia + Element Plus + Axios
- 后端：NestJS + TypeScript，通过 mysql2 驱动连接 Doris
- 数据库：Apache Doris（MySQL 协议，FE 端口 9030）
- 认证：JWT access token + refresh token，密码用 bcrypt
- 图表：ECharts（vue-echarts 封装）
- Markdown 渲染：markdown-it
- 部署：Docker Compose 只负责后端 + 前端；Doris 用已有的外部实例（不部署）

# Doris 连接信息（已部署，直接用这个）

Doris 已经部署好了，不要尝试用 Docker 部署 Doris，也不要改它的配置。
直接用下面的连接信息：

  内网地址:     127.0.0.1
  外网地址:     120.24.248.175
  MySQL 端口:   9030
  HTTP/Web UI:  8030
  现有库:       reroll_analysis        ← 已有数据，**绝对不要动**
  建库/建表账号: root / <YOUR_DB_ROOT_PASSWORD>
  ETL 写入账号:  etl_user / <YOUR_DB_PASSWORD>

执行约定：
1. 用 root 账号连接，**新建一个库**（建议名 `sif_replica`，
   如果你想换名在确认前告诉我）
2. 所有建表和写入都只在新库里进行，
   **绝对不要读写或修改 reroll_analysis 里的任何东西**
3. 后端运行时连接用 etl_user。如果 etl_user 对新库没有权限，
   用 root 补授权（GRANT），并把授权 SQL 记到 docs/DORIS_SETUP.md 里给我
4. 判断用内网还是外网：
   - 后端跑在本机 → 用 127.0.0.1:9030
   - 后端跑在容器里、Doris 在宿主机 → 用 host.docker.internal:9030
     （或宿主机内网 IP）
   - 后端部署到别处 → 用 120.24.248.175:9030
   把这个判断写进 .env 注释，方便我后面切换
5. 密码走 .env，不要硬编码进代码。
   .env 加入 .gitignore，.env.example 里只留占位符：

   DB_HOST=127.0.0.1
   DB_PORT=9030
   DB_USER=etl_user
   DB_PASSWORD=<你的密码>
   DB_NAME=sif_replica

6. 交付时给一份 docs/DORIS_SETUP.md，包含：
   - 建库 SQL
   - 授权 SQL（如果执行过）
   - 从零到跑通的验证步骤（比如用 mysql client 连一次、跑一条 SELECT 1）
   - 遇到过的坑

# Doris 使用约束（重要，先读完再动手）

Doris 不是 MySQL，建表和写代码时严格遵守：

1. 所有业务表使用 **Unique Key 模型 + `enable_unique_key_merge_on_write = true`**，
   这样才能按主键更新单行。
   所有建表语句前面都要有 `USE sif_replica;` 或
   `CREATE TABLE sif_replica.xxx`，不要裸写表名
2. 没有自增主键，**所有 ID 在应用层生成**（雪花算法），类型 BIGINT
3. 没有外键，实体关系只在应用层维护，不做级联删除
4. **没有跨行/跨表事务**。凡是需要"同时写多张表"的操作，
   写成一个 Service 方法 + 补偿逻辑，并在注释里标注这里不是原子的
5. 每张表必须指定 `DISTRIBUTED BY HASH(主键) BUCKETS N`，
   开发环境 BUCKETS 用 1 或 2 即可
6. 分页用游标分页（基于 id 或 created_at），不要用深 OFFSET
7. 列表关键词搜索优先用 Doris 倒排索引（建表时加 `INDEX ... USING INVERTED`），
   退而求其次才用 LIKE
8. 高频计数（查询次数、积分余额）如果直接写 Doris 有压力，
   用 Redis 缓冲 + 定时批量回写，先按这个设计，实现可以后置

建表 SQL 风格示例：

CREATE TABLE sif_replica.some_table (
  id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  field_a VARCHAR(255),
  created_at DATETIME,
  INDEX idx_field_a (field_a) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(id)
DISTRIBUTED BY HASH(id) BUCKETS 2
PROPERTIES ("enable_unique_key_merge_on_write" = "true");

# 数据字典的产出要求（这是重点，先看这段）

**禁止凭经验直接写业务表的建表语句。** 数据字典必须分两部分产出，
每一部分在第一步侦察结束后，写入 `docs/DATA_DICTIONARY.md`：

## 第一部分：系统表（平台自身运行需要，可以直接按你的经验设计）

这部分我可以接受你按通用 SaaS 后台的最佳实践来定，包括但不限于：

- 用户与认证：users、refresh_tokens（或 sessions）
- 积分体系：credit_accounts、credit_transactions
- 查询审计：query_logs（用户每次查 ASIN / 关键词 / 供应商都记一条）
- AI 层：ai_tasks、ai_analyses
- 权限：roles、user_roles（如果原站有角色区分）
- API Key：api_keys（对应原站 /settings 里的 API Key 管理）
- 系统配置：system_configs（键值对，存开关和常量）

这些表你在 DATA_DICTIONARY.md 里列出字段、类型、索引、用途说明即可。
我要审查一遍，但你可以先按最佳实践写。

## 第二部分：业务数据表（必须探查后产出，不许拍脑袋）

这部分是 Sif 特有的亚马逊商品业务数据，**必须从实际页面和接口反推**，
不许用你的先验知识补全。探查时按下面的方法做：

1. 打开每一个页面（清单见后），在 Network 面板里抓取所有 XHR 请求
2. 对每个接口记录：请求参数、响应 JSON 结构、字段含义推断
3. 把同一实体在不同页面的字段**合并去重**，形成候选字段集
4. 对拿不准语义的字段，在 DATA_DICTIONARY.md 里标 ⚠️ 并在"待确认"里列出
5. 明确区分：
   - 基础实体表（比如 ASIN 主表、关键词主表）
   - 时序快照表（比如每日销量、每日排名、每日流量结构）
   - 关系表（比如 ASIN 与关键词的关联、变体父子关系）
   - 枚举/字典表（比如流量渠道类型、推荐专栏类型）

**已知探查线索**（从截图看到，帮你定位重点，但字段仍需你实地核对）：

顶部 Tab 至少包含：
查销量 / 查流量结构 / 反查流量词 / 运营时光机 / 查多变体自然位 /
查广告架构 / 查广告组 / 查广告词 / 查推荐专栏

「查销量」页面：
- 变体维度销量折线图：支持"不同变体销量 / 不同Color销量 / 不同Size销量"切换，
  横轴是月份（从 2023-05 起），纵轴是销量
- ASIN 信息表格列：图片、ASIN、标题、评分（如 4.6 (219,050)）、
  价格（$12.81）、Color 属性、Size 属性、近30天销量、月销量趋势小图、操作列
- 顶部统计："子体 B01N..." "最近30天销量 20,000+"
- 有分页，分页下方有"搜索到1个结果，其余14个为同组变体"提示
- 操作列跳转到：查流量结构 / 反查流量词 / 查广告架构 / 查运营节奏

「查流量结构」页面：
- 顶部三块分布图：
  - Listing 自然-广告流量分布（自然流量 xxxx 84%、广告流量 xxx 16%）
  - 广告流量分布（SP(常规)、SP(推荐)、SB(常规)、SBV，每项带数值和占比，
    右侧有"查广告架构"跳转按钮）
  - 推荐专栏流量分布（Customers frequently viewed、Trending now、
    Picks from Amazon Influencers、Seen on social media）
- 下方表格（支持"不同变体 / 不同Color / 不同Size"切换）：
  列包括 #、变体ASIN、总流量占比、自然-广告流量分布（堆叠条）、
  自然流量占比、SP(常规)流量占比、SP(推荐)流量占比、
  SB(常规)流量占比、SBV流量占比
- 表头右侧有"展示流量得分"开关、"分列对比模式 / 堆积图模式"切换

# AI 功能层（独立模块，横切能力）

项目里会有多处 AI 分析功能，不要散落在各页面里写，抽成统一模块。

## 架构

用户触发分析 → 后端创建 ai_task（落库，status=pending）
             → 队列消费 → 调用模型（流式）
             → SSE 推送增量内容到前端
             → 完成后落库 ai_analysis 结果

前端统一用 `<AiAnalysisCard>` 组件展示：
- 未触发：显示"AI 分析"按钮
- 进行中：流式打字效果 + 取消按钮
- 已完成：Markdown 渲染的结论 + 重新分析按钮
- 失败：错误提示 + 重试

## 后端模块结构

apps/api/src/ai/
  ai.module.ts
  ai.service.ts          # 统一调用入口，处理 provider 切换、重试、计费
  ai-task.service.ts     # 任务生命周期管理
  ai.controller.ts       # SSE 端点 + 任务查询
  prompts/               # 每个分析点一个文件，导出带版本号的 prompt 模板
    traffic-insight.v1.ts
    keyword-recommend.v1.ts
    competitor-strategy.v1.ts
    supplier-evaluate.v1.ts
    ad-optimize.v1.ts
    diagnosis.v1.ts
  providers/
    openai-compatible.provider.ts   # 通用 OpenAI 兼容协议实现
    mock.provider.ts                # 开发环境用，返回固定假数据，避免烧钱

## 模型配置（.env）

不要硬编码任何模型或厂商。所有 AI 调用走 OpenAI 兼容协议：

AI_PROVIDER=openai-compatible    # openai-compatible | mock
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=
AI_MODEL=gpt-4o-mini
AI_MAX_TOKENS=2000
AI_TEMPERATURE=0.7
AI_TIMEOUT_MS=60000
AI_ENABLE_CACHE=true

说明：
- 任何兼容 OpenAI `/v1/chat/completions` 协议的服务都能接入
  （OpenAI、DeepSeek、通义千问、Moonshot、本地 vLLM、Ollama 等）
- 只需改 AI_BASE_URL / AI_API_KEY / AI_MODEL 三项即可切换
- 开发环境默认 AI_PROVIDER=mock，返回预置假分析结果，跑通流程不烧钱

## AI 插入点（P2 实现前 3 个，P3 补后 3 个）

1. 查销量页 → 变体销量趋势解读 + 异常点标注
2. 反查流量词页 → 从结果里挑出最值得投的词并排序
3. 查流量结构页 → 流量构成诊断（自然弱还是广告重，下一步动作）
4. 供应商搜索结果页 → 每个供应商一行初步评估摘要
5. 查广告架构页 → 预算浪费识别 + 优化动作
6. 全站诊断页 → 综合根因分析报告

每个插入点都必须：
- 有独立的 prompt 文件，带 version
- 输入做 hash，命中缓存直接返回，不重复扣费
- 失败自动重试 2 次，仍失败则退还积分并标记 task 失败
- 输出统一 Markdown，前端用 markdown-it 渲染

# 页面清单（按此结构复刻，路由名可调整）

1. `/login` `/register` — 邮箱密码注册，不要抄原站的微信扫码流程
2. `/dashboard` — 概览：最近查询记录、积分余额、快速查询入口、使用指南
3. `/sales` — 查销量（截图里的第一个 Tab）
4. `/traffic` — 查流量结构（截图里的第二个 Tab）
5. `/keywords` — 反查流量词
6. `/keywords/source` — 某个关键词的流量来源分析
7. `/timeline` — 运营时光机
8. `/variations` — 查多变体自然位
9. `/ads/campaigns` — 查广告架构
10. `/ads/groups` — 查广告组
11. `/ads/keywords` — 查广告词
12. `/recommendations` — 查推荐专栏
13. `/competitors` — 竞品对比（如果原站有独立页面）
14. `/diagnosis` — AI 综合诊断
15. `/suppliers` — 供应商搜索。**本期只做入口和占位 UI**：
    - 搜索框（关键词 / 类目 / 地区）
    - 结果列表骨架（字段待定，先按你的探查结果或通用字段渲染）
    - "AI 初步评估"按钮，调用插入点 4
    - 数据先用 seed 的假供应商，真实数据后续从 1688 购买后导入
    - **不要实现任何采集、爬虫、对接逻辑**
16. `/settings` — 账户设置、积分管理、API Key 管理

原站的 MCP 集成页**不做**。

另外：Doris 已经部署好，探查阶段不用管它，把注意力放在 Sif 网站本身。

# 第一步：侦察（此阶段禁止写业务代码）

用浏览器工具对已打开的页面做系统调研，产出两份文档。
探查按下面「并行探查协议」执行。

# 并行探查协议

## 总原则

先探测你当前环境的能力，再决定并行策略。不要假设，要试。

需要试的能力：
- 你能不能同时开多个独立的 browser context
  （每个 context 有自己的 tab、cookie 副本、Network 面板）？
- 你能不能派多个子 Agent，并且让它们各自持有独立的浏览器会话？
- 你一次能稳定并发跑多少个 Agent 而不互相干扰？

**试的方法**：开两个 context，各自打开 sif.com 的不同页面，
各自触发一个带参数的请求，看两边 Network 面板的响应会不会串。
如果不会串，说明可以并行操作浏览器；
如果会串（比如 cookie 被覆盖、Network 混流），就只能串行操作浏览器。

把你的探测结论写进 `docs/SPEC.md` 的开头一节「并行能力评估」。

## 策略 A：环境支持独立浏览器会话

如果探测结果表明多个 Agent 可以各持一个独立会话：

1. 直接把页面清单分给 N 个子 Agent（N = 你的稳定并发上限，
   建议先从 3 开始试，跑通再往上加）
2. 每个子 Agent 自己开独立 context、自己抓素材、自己分析
3. 全部完成后，你（主 Agent）合并产出

## 策略 B：环境不支持独立浏览器会话

如果探测结果表明会话会串：

1. **阶段 A（串行，你亲自做）**：统一操作浏览器，
   依次访问每个页面，把原始素材落盘
2. **阶段 B（并行，派子 Agent）**：为每个页面的素材包派一个子 Agent，
   子 Agent 只读素材不碰浏览器，各自独立分析
3. **阶段 C（串行，你亲自做）**：合并所有子 Agent 产出，
   去重、仲裁冲突、产出终稿

## 策略选择不确定时

如果你试下来处于两者之间（比如浏览器不能并行但子 Agent 可以访问
网络资源），优先保数据不串——**宁可串行抓素材、并行做分析**。
数据污染比慢更严重。

## 阶段 A：抓素材（无论哪种策略都需要）

对页面清单里的每个路由，依次执行：

1. 打开页面，等加载完成
2. 清空 Network 面板，执行该页面的核心操作
   （比如切换 Tab、点筛选、翻页、点"查广告架构"跳转）
3. 导出所有 XHR/fetch 请求的原始响应 JSON
4. 全页截图（至少：初始态、操作后、空状态如有）
5. 落盘到：

   docs/raw/<page-slug>/
     requests.json       # 该页所有接口原始响应，按时间顺序
     screenshot-1.png
     screenshot-2.png
     notes.md            # 你观察到但不在响应里的信息（控件位置、交互反馈）

page-slug 用路由转写，例如：
  /sales           → sales
  /traffic         → traffic
  /keywords        → keywords
  /keywords/source → keywords-source
  /ads/campaigns   → ads-campaigns
  ...以此类推

如果某个页面依赖前置操作（比如必须先输 ASIN 才能出结果），
把前置操作写进 notes.md，方便后续分析时理解数据从哪来。

如果素材量特别大（比如 /keywords 反查流量词一个响应几千行），
把 requests.json 做一次字段裁剪：保留前 3 条记录的完整结构 +
全量的字段名清单。这样既能反推表结构，又不会撑爆上下文。

## 阶段 B：派子 Agent 并行分析

为每个 `docs/raw/<page-slug>/` 派一个子 Agent。
一个页面一个子 Agent，不要合并，也不要拆分同一页面的接口和 UI，
因为这两者需要互相印证。

给每个子 Agent 的提示词模板如下（你按实际情况替换 <占位>）：

---- 子 Agent 提示词模板 开始 ----

你是数据勘察员。你负责分析 Sif 网站的 <页面名> 页面，
产出该页面的规格片段和数据字典片段。

## 你的输入

- 原始素材目录：docs/raw/<page-slug>/
- 全局背景：docs/SPEC.md 的「站点定位」章节、
              docs/DATA_DICTIONARY.md 的「系统表」章节
  （这两个文件此时可能还不存在或只有骨架，
   如果不存在就跳过，不要自己编）

## 你的产出（两个文件）

### 产出 1：docs/fragments/<page-slug>.spec.md

- 页面路由与标题
- 页面区块拆解（每个区块：用途、控件、交互）
- 交互流程（用户操作 → 触发什么接口 → 界面如何变化）
- 接口契约表：
  | 方法 | 路径 | 请求参数 | 响应结构 | 鉴权 | 触发场景 |
- 空状态、加载态、错误态（截图里能看到的）
- 本页面的不确定清单

### 产出 2：docs/fragments/<page-slug>.dict.md

从接口响应反推本页面涉及的**业务数据实体**，按下面的分类：

  基础实体 / 时序快照 / 关系 / 枚举字典

每个实体列出：
- 表名建议（你自己拟，主 Agent 会统一）
- 用途
- 字段表：| 字段名 | 类型 | 说明 | 来源 |
  来源必须写清楚是哪个接口的哪个字段路径，比如
  `requests.json > req#3 > data.variants[].sales`
- 推断的字段标 ⚠️ 并在不确定清单里说明
- 与其他实体的关系（你观察到或推断的）

**不要凭经验补字段。** 响应里没有的字段就是没有，
不确定就先留空或标 ⚠️，不要脑补。

## 纪律

- 只基于 docs/raw/<page-slug>/ 里的素材下结论
- 素材里没有的信息，写"素材未覆盖"，不要编
- 你不需要读其他页面的素材，也不需要和别的子 Agent 协调
- 产出必须能独立成立，主 Agent 会直接拿去合并

## 完成后

在你的最终回复里给出：
1. 两个产出文件的路径
2. 一句话总结这个页面是干什么的
3. 本页面最关键的 3 个数据实体名
4. 待主 Agent 裁决的问题清单

---- 子 Agent 提示词模板 结束 ----

派发规则：
- 能并发就并发。如果工具支持，一次派多个，不要排队等
- 如果工具对并发数有限制，分批派，每批完成后立刻派下一批
- 如果某个页面的素材量特别大，可以给这个页面派两个子 Agent 交叉验证，
  但让他们产出到不同文件（<page-slug>.a.dict.md / <page-slug>.b.dict.md），
  由你（主 Agent）比对
- 策略 A 下，子 Agent 自己抓素材自己分析；策略 B 下，
  子 Agent 只读素材。具体哪种，取决于你前面探测的结果

## 阶段 C：合并（你亲自做）

所有子 Agent 完成后，你按下面的顺序合并：

1. **统一命名**：各子 Agent 自己拟的表名大概率会撞车或重复。
   你读所有 *.dict.md，把指向同一实体的合并，
   起一个统一表名，记录原名映射
2. **合并字段**：同一实体在不同页面的字段做并集，
   冲突的地方（类型不一致、语义矛盾）标 ⚠️ 并在
   DATA_DICTIONARY.md 的"待确认"里列出，让我裁决
3. **校验时序**：凡是带日期维度的字段（销量、排名、流量占比），
   确认是否所有页面都用同一粒度和同一张快照表，
   不一致的不要硬合并，保留为独立表并说明差异
4. **产出终稿**：
   - docs/SPEC.md（合并所有 *.spec.md，按页面清单顺序组织）
   - docs/DATA_DICTIONARY.md（分「系统表」+「业务数据表」两部分，
     业务表按分类组织）
5. **在 DATA_DICTIONARY.md 末尾附两节**：
   - 「合并日志」：哪些子 Agent 的哪些表被合并了、为什么
   - 「待确认」：所有 ⚠️ 字段和跨页面冲突，列给我裁决

## 异常处理

- 某个子 Agent 失败或产出缺字段：重派一次；
  再失败就自己补，并在合并日志里标注"该页面未并行处理"
- 素材缺失导致子 Agent 无法判断：让子 Agent 标"素材未覆盖"，
  不要阻止流程；你统一汇总后一起问我
- 发现两个子 Agent 的结论矛盾：不要自己选一个，
  两份都保留，标 ⚠️ 交给我裁决

## 并发度建议

页面清单里预计有 14-16 个页面。策略 A 下建议先试 3 并发，
稳定后加到 5；策略 B 下素材抓取串行，分析阶段建议 5-8 并发。
具体上限按你环境的实际情况调整。

## 产出 1：`docs/SPEC.md`

1. **并行能力评估**（放最前面）：你试出来的结论，用了哪种策略
2. **页面清单**：逐个访问上面列出的路由，记录页面标题、主要区块、
   关键交互、控件布局，并截图
3. **接口契约**：把所有 XHR/fetch 请求整理成表格：
   | 方法 | 路径 | 请求参数 | 响应结构 | 鉴权方式 | 触发场景 |
   并据此写出 OpenAPI 风格的接口清单
4. **交互细节**：图表类型、筛选项、排序规则、空状态、加载态、
   页面之间的跳转关系
5. **权限模型**：未登录 / 普通用户 / 付费用户 / 管理员分别能看什么
6. **不确定清单**：所有没看明白或无法验证的地方，列成问题问我

## 产出 2：`docs/DATA_DICTIONARY.md`

按前面「数据字典的产出要求」那一段执行，分两部分：

### A. 系统表（你按最佳实践设计）

每个表列出：表名、用途、字段（名/类型/说明）、主键、索引、Doris 建表注意事项。
包括：users、refresh_tokens、credit_accounts、credit_transactions、
query_logs、ai_tasks、ai_analyses、api_keys、roles（如有）、
system_configs 等。你觉得还需要的可以补。

### B. 业务数据表（必须探查后产出）

按"基础实体 / 时序快照 / 关系 / 枚举字典"分类，每个表列出：
表名、用途、字段（名/类型/说明/来源页面或接口）、主键、索引、
Doris 建表注意事项、与其他表的关系。

对每个字段要标注**来源**：
- 是从哪个页面 / 接口看到的
- 还是推断的（标 ⚠️）

**如果某张业务表你不确定该不该拆、或某个字段语义拿不准，不要猜，
列到"待确认"里问我。**

# 第二步：停下来等我确认

把三份东西给我：

1. docs/SPEC.md（含开头的「并行能力评估」）
2. docs/DATA_DICTIONARY.md（含末尾的「合并日志」和「待确认」两节）
3. 一份简报：用了哪种并行策略、哪些页面并行处理了、哪些失败重试过、
   共识别出多少个业务实体

我会逐条核对业务表字段。确认后再进入实现阶段。
不要自作主张开始写代码。

# 第三步：实现

目录结构：
- `apps/web`（Vue 3 前端）
- `apps/api`（NestJS 后端）
- `db/`（Doris 建表 SQL + seed 数据，schema 从已确认的 DATA_DICTIONARY 生成）

硬性要求：
- `docker compose up` 一条命令把后端、前端跑起来（Doris 是外部的，
  不在 compose 里）；容器启动时自动执行建表 SQL 和 seed
  （如果表已存在则跳过建表，不要报错中断）
- 提供 `scripts/setup-doris.sh`：单独执行一次，
  用 root 连上 Doris、建库、建表、灌 seed。
  这个脚本幂等，可重复执行
- 后端启动时如果发现目标库不存在或表为空，打明确的中文错误日志，
  提示我先跑 scripts/setup-doris.sh，不要自己去 CREATE DATABASE
- `db/schema.sql` 严格从 DATA_DICTIONARY.md 生成，不要另起炉灶
- `db/seed.sql` 至少：
  - 5 个 ASIN（含多变体父子关系）× 50 个关键词 × 30 天排名快照
  - 3 个广告活动示例
  - 10 个假供应商 + 每个 5 个产品
  - 2 个测试用户（普通 + 管理员）
- 提供 `.env.example`，README 写清楚启动步骤、Doris 连接配置、AI 供应商配置
- 接口统一响应格式 `{ code, message, data }`，统一异常过滤器
- 列表接口支持游标分页、排序、关键词搜索
- 前端表单要有校验，后端也要校验（class-validator）
- 前端请求统一封装 Axios 实例，自动附带 token，401 自动刷新
- 代码注释和 README 用中文

分阶段交付，每个阶段结束时项目都必须是可运行的状态：

- P0：Docker Compose 骨架（只含后端 + 前端）+ scripts/setup-doris.sh
     + 全量建表（按 DATA_DICTIONARY，建到 sif_replica）+ 后端连上已有 Doris
     + 认证（注册/登录/登出）+ ai.module 骨架 + mock provider + SSE 端点跑通
- P1：核心读流程（dashboard → sales → traffic → keywords → keywords/source
     → ads 系列 → recommendations → variations → timeline，
     全部接 seed 数据）
- P2：AI 插入点 1-3（销量解读、关键词推荐、流量诊断）
     + 用户中心 + 积分系统基础
- P3：AI 插入点 4-6（供应商评估、广告优化、综合诊断）
     + `/suppliers` 页面（只接 seed 数据）+ 权限控制 + 我的查询历史
- P4：打磨（加载态、空状态、错误处理、响应式、基础 SEO）
     + AI 结果缓存、失败重试、积分退还

每个阶段完成后向我汇报：改了哪些文件、怎么验证、遗留问题、下一步计划。
每完成一个阶段等我确认再继续。

# 约束

- 不要复制原站的 Logo、图片素材、专有文案、真实用户数据；
  全部用占位图和自造的中文文案
- 不要引入需要我付费的第三方服务（AI 模型走我自己配的 key）
- 不要一次性生成几千行代码然后说完成了；小步提交，每步可验证
- 遇到你无法从浏览器观察到的信息，直接问我，不要猜
- 遇到 Doris 不支持的特性（事务、外键、子查询限制等），
  不要硬套 MySQL 写法，改用应用层方案，并在代码注释里说明
- 供应商模块**只做 UI 占位和表结构**，不要写任何采集、爬虫、
  1688 对接逻辑，数据先用 seed
- **业务数据表的建表语句必须来自已确认的 DATA_DICTIONARY.md，
  不许在写代码时临时改字段或加表**
- **凭据安全**：Doris 的密码只出现在 .env（已 gitignore）和
  docs/DORIS_SETUP.md 里，不要写进代码、日志、README 主文档、
  报错信息、前端任何地方。docs/DORIS_SETUP.md 里如果写密码，
  加一行注释"此文件含凭据，不要提交到公开仓库"
- **绝对不要碰 reroll_analysis 库**：所有 SQL 都必须针对新库，
  任何 DROP / TRUNCATE / ALTER 操作只允许在新库执行。
  如果你不确定某条 SQL 会影响哪个库，先停下来问我

# 现在开始

执行第一步侦察。先探测并行能力，写出 `docs/SPEC.md` 开头的
「并行能力评估」，再按对应策略推进，产出 docs/SPEC.md 和
docs/DATA_DICTIONARY.md。
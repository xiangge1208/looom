# 未实现功能族实现计划（M10 ~ M15；M16 AI工具 / M17 更多已裁决不做）

> ## ✅ 2026-09-21 审计收口：sif 20/20 个页面核对完毕，本文档按以下修订版执行
>
> 五轮核对（3 轮浏览器逐页实查 + 2 轮并行 API 直查/前端逆向）共推翻 **28 处判断**。
> 审计原文以 `SIF_UI_AUDIT_2026-09-21.md`（§8b~§8e）+ `docs/audit/` 四份专项文档为准：
> [skill-keywords-library.md](audit/skill-keywords-library.md)（AI 管道）、
> [subscribe-family.md](audit/subscribe-family.md)（M14 全套参数与定价）、
> [more-menu.md](audit/more-menu.md)（实时竞价/批量备注/MCP）、
> [model-introductions.md](audit/model-introductions.md)（27 个模块官方口径）。
> **冲突时的优先级：SIF_UI_AUDIT + docs/audit/ > M13_PROBE_FINDINGS > 本文档正文。**
>
> ### 修订后的模块清单与排期（取代正文 §2 的分期表）
>
> | 期 | 模块 | 修订后范围 | 依据 |
> |---|---|---|---|
> | 0 | **前置修复** | ✅ 已完成（分区/守卫/init-db） | §1 |
> | 0.5 | **M13 数据层返工** | 竞价表**改名** `fact_keyword_acos_estimate`（33,019 行 ACOS/CPA 原样有效）→ 重建新语义 `fact_keyword_bid_estimate(keyword, country, category_id, match_type, bid_strategy, stat_month)`（seed）；metric 表加 `video_asin_num` + top3 集中度两列（字段名待探）、改 `sale_num` 注释；`dict_traffic_channel` 加 `rec`；新建 `rel_keyword_asin_traffic_share` —— **🟡 web-compete-pattern 82 条 ok 但仅 22 条有数据、覆盖 9 个词**（详见 AUDIT §11.8，原「🟢 真实 ETL」判断过于乐观）。全部明细见 [DORIS_SCHEMA_GAP_ANALYSIS.md](DORIS_SCHEMA_GAP_ANALYSIS.md) | AUDIT §0 判1/判3/判6 + §11 |
> | 1 | **M13 选词**（4 页：conversion-rate / amount / compete / cpc-browsetree） | 转化率页 ACOS 按自定义毛利率**前端实时算**（service 只返回 cpa + 默认毛利 acos）；`/amount` 加 ABA Top3 集中度两列与 `videoAsinNum`；`/compete` 改为 **ASIN×6 流量位份额**矩阵；竞价页按**类目×匹配×策略**三层嵌套渲染。**不含 `/cpc-realtime`**（随「更多」砍掉，见下） | AUDIT §8c |
> | 2 | **M14 排名监控**（3 页一体） | 一张 `rank_monitor` 任务表（granularity=hour/day/snapshot 特例化）；小时排名参数 `duration 7/14/28 × period 1/2/3/6/12h × pages 3/7 × isAutoProceed`，定价 **20 积分**线性；快照固定 42 积分；每日排名走**配额制**（50/200 词）；数据结构照抄 `dates[]+rankInfo[]` 下标对齐、`rankStr="p2,3/16"`、`flag` 三态。⚠️ **Loom 无积分体系**：`integral_cost` 仅作字段记录，不做扣费（保持 §4.6「业务查询不扣分」现状） | [subscribe-family.md](audit/subscribe-family.md) |
> | 3 | **M15a 库管理**（提前！） | 产品库（`focusAsins`，三类用途：拓词竞品/对标竞品/ASIN定投，上限 500）+ 词库（`focusKeywords`，两级：产品词库→阶段词库×4，有效/否定成对）**先做管理面**，是 M10/M12 的输入源 | AUDIT §8d.5/8d.6 |
> | 4 | **M10 多产品对比**（1 页 3 Tab） | 上限 **10 ASIN**；对比流量词=动态列+基准差值；对比结构=`flowResources` 命名位清单+10 类计数；对比销量=`boughtHistory` 31 个月序列；组内最优 `*Best` 全部**现算不落库** | AUDIT §8c/§8d |
> | 5 | **M12 拓词筛查**（4 Tab 流水线） | 相关性=**自然位前 4/8/16/32/48 占位率+用户阈值**（自算，非 NLP——**取代正文 §M12 的「词根重合度启发式」旧方案 A**，数据在 `fact_keyword_rank_history` 117,740 行 + `rel_keyword_top_asin`）；词根拓词与品类拓词**字段不同构**分表存；`matchTypes` 含 **DropDownBox**；带 `estSearchesNumHistoryPrev` 同比 53 周；UI 带「词库预筛」对话框与 `keywordsId` 批量 hash 机制 | AUDIT §8d.1/8d.2 |
> | 6 | **M11 产品时光机**（1 页） | **按关键词查历史畅销产品榜**（720 天，100 行×12 列商品属性）；`fact_asin_listing_daily` 大表**取消** | AUDIT §8b |
> | 7 | **M15b 关注体系** | 各列表页插关注/收藏按钮（放最后避免反复改） | — |
>
> ### ❌ 已裁决不做（2026-09-21 用户确认）
>
> | 菜单 | 内容 | 连锁处理 |
> |---|---|---|
> | **AI工具** | `/skill/keywords-library` WS 管道、`/datacenter`、`/mcp` | 现有 6 个页面内 AI 插入点 + DiagnosisView **不受影响**（那是 M1~M9 的功能）；M12 相关性自算与 AI 管道无关，**不受影响**。审计文档保留备查 |
> | **更多** | 批量备注（`/ad-multiNotes-*`）、**实时查产品竞价（`/cpc-realtime`）**、**查ASIN定位广告（`/adxray-productTarget`）**、MCP | `sys_user_ad_note` 空壳表保持闲置；`/cpc-realtime` 虽属竞价语境但归「更多」组，**一并砍**（将来要做属增量，不影响 M13 其余 4 页）；`/adxray-productTarget` 是 AdXray 族页面，若归「查广告打法」可再议；**对接 sif MCP 拿数据**的选项一并搁置（如自建爬虫受阻可重启评估） |
>
> ### 开工前探源待办（✅ 2026-09-21 已完成，详见 DORIS_SCHEMA_GAP_ANALYSIS.md）
>
> PG `sif_api_log` 实查结论：**有源**——`web-compete-pattern`（82 ok，M13 /compete 走真实 ETL）、
> `web-keyword-extend`（625 ok，M12 词根拓词走真实 ETL）。
> **无源维持 seed**——`keywordByCategory`、`category/suggestion`、`summaryKeyword`（M11）；
> M10 四个聚合端点无日志但本就零 ETL 从既有表组合。
> 表级差距全量清单（12 张可用 / 5 张要改 / 11 张要建 / 3 张取消）见
> [DORIS_SCHEMA_GAP_ANALYSIS.md](DORIS_SCHEMA_GAP_ANALYSIS.md)；
> **目标态全库设计（69 张表 + 全部新表 DDL 级定义 + 变更清单 + schema 文件规划）见
> [DORIS_SCHEMA_DESIGN.md](DORIS_SCHEMA_DESIGN.md)** —— 实施时以后者为建表依据。
>
> ### 修订后估算
>
> | 期 | 0.5 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 合计 |
> |---|---|---|---|---|---|---|---|---|---|
> | 人日 | 2 | 13 | 10.5 | 4 | 6 | 12 | 3 | 1.5 | **≈52**（×1.3 ≈ **68**） |
>
> （M16/M17 本就不在原 53.5 人日估算内，砍掉不影响总量；M14 因任务/配额模型 +2，M12 因 4 Tab 收敛 -3，
> M11 因取消大表 -2，M10 因动态列/命名位清单 +0.5。）
>
> ### 官方口径必须照抄进 UI（防止用户对不上数据）
>
> 销量=**订单量**（不含退款/取消，回溯 2023.05，月初更新）｜流量=**搜索页有效曝光**（不含详情页关联流量）｜
> 广告组=亚马逊隐藏「**投放小组**」+**客户搜索词**（仅 SP，不含 SB/SD）｜竞价=**建议竞价**（非 CPC/出价，与品类强相关）｜
> 转化率=**商机探测器独立口径**（关键词级均值，不可与单产品对比）｜流量结构=最新一周 ABA、每天更新、抓前 3 页
>
> 正文 §3~§9 的模块细节仍可参考，但**凡与本修订表冲突处，以本表 + 审计文档为准**。

---

## 0. 三项已裁决前提

| 议题 | 裁决 | 影响 |
|---|---|---|
| 覆盖范围 | **全部 6 族，按数据就绪度分期** | 20 个页面全部纳入，分 6 期 |
| 无源功能 | **建表 + seed 模拟数据，UI 全做** | 品类拓词/批量筛查/坑位快照/小时排名/cpc 一律做完整 UI，数据走 seed |
| 现存缺陷 | **一并修** | 见 §1，其中 1 项经实测已不成立 |

seed 策略沿用 `goal.md:26`「数据来源暂不考虑，本期全部用 seed 模拟数据」的原则：
**表结构按真实响应设计，数据用生成器造**，真实数据到位后只换 ETL 不改表不改前端。

---

## 1. 前置修复（P0，先做完再开新功能）

> **✅ 已于 2026-09-21 完成执行。** 实施结果见各小节的「实施记录」。

用户勾选了 4 项，实测后 3 项成立、1 项已被修复。

### 1.1 ✅ 已不成立：后端 3 处 JOIN 仍用 keyword_id

**实测结论：已经全部改完，无需处理。**

- `keywords.service.ts:82` — `JOIN dim_keyword k` 已按 `(keyword, country)`，文件头 `:21` 写明理由
- `ads.service.ts:157` — `LEFT JOIN dim_keyword k` 已改，`:145` 留了「原先是 JOIN keyword_id，有两个致命问题」的注释
- `insights.service.ts:57` — 已改，`:37` 注释写明「JOIN 按 (keyword, country)」

残留的 `keyword_id` 引用（ads 7 处 / keywords 13 处 / insights 3 处）都是**输出列或对账列**，不参与 JOIN。
Explore 报告的这一条是误判，本计划不再包含此项。

### 1.2 schema-04 每次 setup 清空 16 张关键词表

**现状**：`db/schema-04-keyword-text-key.sql:20` 自述「幂等：DROP IF EXISTS + CREATE，可重复执行（会清空数据，由 ETL 重灌）」。
`scripts/setup-doris.sh:91-95` 用 glob 遍历 `db/schema-*.sql` 全部执行，schema-04 排在最后必被执行。

**风险**：`dim_keyword`(13,070 真实行)、`fact_keyword_competition_snapshot`(3,244)、
`fact_keyword_conversion_funnel`(854) 会被清空，需重跑 ETL 才能恢复。

**修法**（二选一，建议 A）：

- **A. 加执行守卫**（改动小、语义明确）
  在 `setup-doris.sh` 里把 schema-04 从 glob 中排除，改成显式 opt-in：
  ```bash
  for f in "$ROOT_DIR"/db/schema-0[123]-*.sql; do ... done
  if [ "$RESET_KEYWORD_DOMAIN" = "1" ]; then run_sql < db/schema-04-keyword-text-key.sql; fi
  ```
  并在脚本 usage 里说明 `RESET_KEYWORD_DOMAIN=1` 会清空关键词域。

- **B. 改成 IF NOT EXISTS**（更安全但会掩盖 schema 漂移）
  把 16 处 `DROP TABLE IF EXISTS` + `CREATE TABLE` 改成 `CREATE TABLE IF NOT EXISTS`。
  代价：首次建库后再改字段不会生效，需人工 ALTER，容易与 DDL 文件脱节。

**验收**：连续跑两次 `setup-doris.sh`，`SELECT COUNT(*) FROM dim_keyword` 保持 13,070。

**实施记录（2026-09-21，方案 A）**
- `scripts/setup-doris.sh` glob 改为 `schema-0[!45]-*.sql`，排除 04（破坏性重建）和 05（分区迁移）
- schema-04 改为 `RESET_KEYWORD_DOMAIN=1` 显式 opt-in
- 额外加了**全新库探测**：若 `dim_keyword` 不存在会打印提示，告知需带该变量才能建出关键词域 16 张表
  （否则新库会缺表且后端按文本键写的 JOIN 会报 `Unknown column 'keyword'`）
- ✅ 连跑两次 setup，`dim_keyword` 保持 13,070；`fact_keyword_competition_snapshot` 21,328、
  `fact_keyword_conversion_funnel` 5,875 也完好（⚠️ 实际行数比文档记的 3,244/854 多，ETL 后来又跑过）

### 1.3 init-db.mjs 漏跑 schema-03/04

**现状**：`apps/api/scripts/init-db.mjs:40-44` 的 `FILES` 数组硬编码 3 个文件，
缺 `schema-03-gap-tables.sql`（3 张补缺表）和 `schema-04-keyword-text-key.sql`（16 张关键词表的文本键改造）。

**后果**：容器自动初始化出的库与手动 `setup-doris.sh` 建的库 **schema 不一致** ——
容器环境缺 3 张表，且关键词域仍是旧 `keyword_id` 主键，后端按文本键写的 JOIN 会报 `Unknown column 'keyword'`。

**修法**：补全 `FILES` 数组，顺序与 glob 一致：
```js
const FILES = [
  '/app/db/schema-01-system.sql',
  '/app/db/schema-02-business.sql',
  '/app/db/schema-03-gap-tables.sql',
  '/app/db/schema-04-keyword-text-key.sql',   // 新建时必跑，见 1.2 的守卫讨论
  '/app/db/seed.sql',
]
```
同时确认 `apps/api/Dockerfile` 的 `COPY` 覆盖了这两个文件（需核对）。
schema-04 的 DROP 语义在容器首次启动场景下无害（库是空的），但要与 1.2 的守卫方案保持一致：
若 1.2 选 A，则 init-db.mjs 里也应只在 `DB_FRESH=1` 时跑 schema-04。

**验收**：`docker compose up` 起一个全新环境，`SHOW TABLES` 数量与手动建库一致（58 张）。

**实施记录（2026-09-21）**
- `init-db.mjs` 的 `FILES` 补入 `schema-03-gap-tables.sql`
- schema-04 单独抽成 `KEYWORD_SCHEMA` 常量 + 守卫：`dim_keyword` 不存在（全新库）或
  `RESET_KEYWORD_DOMAIN=1` 时才执行，与 setup-doris.sh 的守卫语义对齐
- ⚠️ schema-04 的执行位置放在 `FILES` **之前** —— seed.sql 里有往关键词表插数的语句，
  若先 seed 再 DROP 重建会把插进去的数据清掉
- 把逐条执行 SQL 的循环抽成 `runFile(conn, file)`，两条路径共用
- `apps/api/Dockerfile:40` 的 COPY 补上 schema-03 和 schema-04
- ✅ `node --check` 通过。**未做**全新容器环境的端到端验证（需要一个干净的 Doris 库，
  当前实例已有数据），留作后续验证项

### 1.4 大表零分区

**现状**：4 个 schema 文件 **`PARTITION BY` 出现 0 次**（实查）。
两张追加型大表已到量级：`fact_asin_subbsr_snapshot` 165 万行（日粒度）、
`fact_asin_bought_monthly` 80 万行（月粒度）。

**为什么现在必须处理**：本计划的 M11（产品时光机）和 M14（每日排名）都是**日粒度历史范围查询**，
无分区会导致全表扫描。且 Doris 加分区需要重建表，数据越多代价越大——现在是最后的低成本窗口。

**修法**：新建 `db/schema-05-partitions.sql`，对 4 张表加 RANGE 分区：

| 表 | 分区键 | 粒度 | 预留范围 |
|---|---|---|---|
| `fact_asin_subbsr_snapshot` | `stat_date` | 按月 | 2023-01 ~ 2027-12 |
| `fact_asin_bought_monthly` | `stat_month` ⚠️ VARCHAR | 需先改 DATE 或加派生列 | 同上 |
| `fact_asin_traffic_channel` | `stat_month` | 同上问题 | 同上 |
| `fact_keyword_rank_history` | `stat_date` | 按月 | 同上 |

⚠️ **已知障碍**：`stat_month` 是 VARCHAR 类型（见 `keywords.service.ts:199-206` 按 VARCHAR 取 MAX）。
Doris RANGE 分区要求分区列是 DATE/DATETIME/INT 类型。两条路：
- 加 `stat_month_date DATE` 派生列做分区键，业务查询仍用 VARCHAR 列（冗余但不改前端）
- 把 `stat_month` 改成 DATE 存月初，前端/service 改格式化（改动面大）

**建议**：本期只对 `stat_date` 型的两张表（subbsr / rank_history）加分区，
VARCHAR 型的两张留到 M13/M14 动它们时一并处理，避免前置修复膨胀。

**验收**：`SHOW PARTITIONS FROM fact_asin_subbsr_snapshot` 返回多个分区；
一条带 `stat_date BETWEEN` 的查询在 EXPLAIN 里显示分区裁剪生效。

**实施记录（2026-09-21）—— 做法与计划有出入，见下**

计划里写的是「枚举 RANGE 分区，预留 2023-01 ~ 2027-12 共 60 个」。
实测这个 Doris 是 **4.1.3**，支持 `AUTO PARTITION`，写入时按月自动建分区、无需预先枚举也无需定期维护，
比枚举方案更省事。先用临时表验证语法通过后才改的正式表。

- 新建 `db/schema-05-partitions.sql`：`CREATE ... AS SELECT` 到 `_new` 表 → RENAME 旧表为 `_old` → RENAME 新表就位。
  不直接 DROP 旧表是因为搬数据是 `INSERT ... SELECT`，中途失败无从恢复
- 分区语法：`AUTO PARTITION BY RANGE (date_trunc(stat_date, 'month')) ()`
- `fact_asin_subbsr_snapshot` 的 BUCKETS 从 2 提到 8（165 万行下单分区 2 桶每桶过大）
- `fact_keyword_rank_history` 顺带补了 `INDEX idx_rank_kw (keyword) USING INVERTED`
- **同步改了源 DDL**：`schema-02-business.sql`（subbsr）和 `schema-04`（rank_history）也加上 AUTO PARTITION，
  否则重跑这两个文件会退回无分区版本
- `setup-doris.sh` 加 `RUN_PARTITION_MIGRATION=1` 守卫（搬 165 万行，只需跑一次）

实测结果：
| 表 | 迁移前 | 迁移后 | 分区数 |
|---|---:|---:|---:|
| `fact_asin_subbsr_snapshot` | 1,654,767 | 1,654,767 | 45 |
| `fact_keyword_rank_history` | 117,740 | 117,740 | 3 |

✅ 行数完全一致，`_old` 表已核对后删除，库内 58 张表。
✅ 分区裁剪生效：`WHERE stat_date BETWEEN '2026-08-01' AND '2026-09-18'` 的 EXPLAIN 显示
`partitions=2/45`（只扫 2 个分区，不是全表）。

⚠️ **实测修正两处文档陈述**：
- `fact_keyword_rank_history` 实际 **117,740 行**，不是文档记的 7,689（且不全是 `B0SEED` 种子）
- `subbsr` 日期范围 2023-01-01 ~ 2026-09-18，`rank_history` 只有 2026-07-29 ~ 2026-09-19
  （所以分区数 45 vs 3 差距大）

VARCHAR 型的两张表（`fact_asin_bought_monthly`、`fact_asin_traffic_channel`）按计划**未处理**，
留到 M13/M14 动它们时一并做。

---

## 2. 模块总览与分期

编号沿用既有惯例：**module N = 一个原站功能族 = 一个 ETL 脚本**（M1~M9 已用，见 `docs/MODULE_DATA_FLOW.md:1160-1168`）。

| 模块 | 功能族 | 页面数 | 数据源 | 需新建表 | 需新 ETL | 期次 |
|---|---|---:|---|---:|---|---:|
| **M13** | 选词 / 关键词竞争分析 | 4 | 🟢 有源（最成熟） | 0（扩列） | 扩写既有 | **第 1 期** |
| **M14** | 查坑位 / 推排名 | 3 | 🟡 部分有源 | 2 | 新建 | **第 2 期** |
| **M11** | 产品时光机 | 1 | 🟢 有源（100% 填充） | 1 | 新建 | **第 3 期** |
| **M10** | 多产品对比 | 3 | 🟡 部分有源 | **0** | **无需** | **第 4 期**（可与 1-3 并行） |
| **M12** | 拓词 & 筛查 | 7 | 🟡 部分有源 | 3 | 新建 | **第 5 期** |
| **M15** | 产品库 / 词库 | 2 | — 用户自产 | 0（表已建） | 无需 | **第 6 期** |

合计 **20 个页面、6 张新表、4 个新 ETL 脚本**。

排期依据（沿用 `MODULE_DATA_FLOW.md:1398-1417` 的「能出成品优先」原则）：
1. M13 两张表**已灌真实数据**（21,328 + 5,875 行），改造成本最低、产出最直接
2. M14 源已结构化落地，`keyword_id` 100% 可得
3. M11 源 100% 填充，但要先扩日粒度表
4. M10 零 ETL、纯查询层，可与前三项并行开发
5. M12 需先解析 2 个 endpoint 且 Doris 无落点
6. M15 是应用层 CRUD，不占 ETL 排期

### 就绪度图例

🟢 有源且填充率高，可直接 ETL ｜ 🟡 有主干、缺关键列，需 seed 补 ｜ 🔴 无源，纯 seed

---

## 3. 逐模块设计

### M13 · 选词 / 关键词竞争分析（第 1 期，4 页）

原站路由：`/conversion-rate`（关键词转化率）、`/amount`（流量位竞品数量）、
`/compete`（流量位竞争格局）、`/cpc-browsetree` + `/cpc-realtime`（查关键词竞价）。

#### 数据现状

> ### ⛔ 本表的行数与就绪度已全部过期，以下为 2026-09-21 Doris 实测
>
> 下表是计划撰写期（ETL 之前）的状态。第 1 期 M13 的 ETL 已经跑完，
> 数据层返工也已执行（`db/schema-07-m13-rework.sql`）。**现状看这张表**：
>
> | 表 | 计划期写的 | Doris 实测 | 说明 |
> |---|---|---|---|
> | `fact_keyword_conversion_funnel` | 854 行 | **5,875** | ETL 已灌 |
> | `fact_keyword_competition_snapshot` | 3,244 行 | **21,328** | ETL 已灌 |
> | `fact_keyword_metric_snapshot` | 「需加 9 列」 | **22,320 行 / 已加 11 列** | 含补的 `video_asin_num` |
> | `fact_keyword_acos_estimate` | 不存在 | **33,019** | 原 `fact_keyword_bid_estimate` 改名拆维 |
> | `rel_keyword_top_asin` | — | **56,795** | top 46,451 + conv 10,344 |
> | `rel_keyword_asin_traffic_share` | 不存在 | **0**（已建待 ETL） | /compete 的真实数据模型 |
> | `fact_keyword_bid_estimate` | 「无落点」 | **0**（已建待 seed） | 真正的建议竞价，带类目维 |
>
> ⚠️ **`/compete`「流量位竞争格局」的就绪度从 🟢 降为 🟡 真实但覆盖极窄**：
> 下表原判它可用 `web-compete-keyword`（361 ok）落 `fact_keyword_competition_snapshot`，
> 但审计 §2 实测该页真实接口是 `competePattern`，数据模型是
> **ASIN × 流量位份额**而非关键词级度量。
> `fact_keyword_competition_snapshot` 那 21,328 行是关键词级的，**服务不了这页**。
> PG 侧 `web-compete-pattern` 有真实数据但量很小（AUDIT §11.8）：
> 753 条请求 / 82 条 ok / **仅 22 条真有 asins / 覆盖 9 个去重关键词 / 1,637 行 ASIN**。
> 字段结构与新表完全吻合，可以真实 ETL，但**要配 seed 补足覆盖面**。

| 子功能 | 源 | 落点 | 就绪度 |
|---|---|---|---|
| 关键词转化率 | `sif_api_log`[ep=`web-keyword-conversion`]，449 ok | `fact_keyword_conversion_funnel`（**已建已灌 854 行**） | 🟢 |
| 流量位竞争格局 | ⛔ 本行已失效，见上方 ⚠️ | ~~`fact_keyword_competition_snapshot`（已建已灌 3,244 行）~~ | ⛔ |
| 流量位竞品数量 | 同上响应的竞品计数字段 | 需给 `fact_keyword_metric_snapshot` **加 9 列** | 🟡 |
| 查关键词竞价 | 原站 `/api/search/cpc/*` 10 个接口**全未爬** | 无落点 | 🔴 纯 seed |

两张已建表的 DDL 在 `db/schema-03-gap-tables.sql:25-44`（转化漏斗，含 14 个度量列，
实测值域已写进 COMMENT）和 `:56`（竞争快照）。

⚠️ **这两张表的主键仍是 `keyword_id`**（`schema-03:26` 注释「源无 keywordId，需按 (country,keyword) 反查」），
而 schema-04 已把关键词域统一改文本键。本模块第一步必须**把这两张表也迁到 `(keyword, country)`**，
否则 M13 的查询要在两套键之间来回翻译。做法：在 schema-04 末尾追加这两张表的重建语句，
保持「关键词域主键统一」这条不变量。

#### 数据库改动

1. **迁移 2 张表主键** → `(keyword, country, stat_week)` / `(keyword, country, stat_date)`
2. **`fact_keyword_metric_snapshot` 加 9 列**（竞品数量维度）：
   需先跑一次 `sif_schema_probe.py` 确认 `web-compete-keyword` 响应里竞品计数的确切字段名和填充率，
   再定列名。**不要凭文档推测列名**——`ETL_GAP_ANALYSIS.md` 的字段名来自采样，本模块要按实际响应定。
3. **新建 `fact_keyword_cpc_bid`**（竞价，纯 seed）：
   `UNIQUE KEY(keyword, country, stat_date, match_type)`，列含 `suggested_bid` / `bid_range_low` /
   `bid_range_high` / `category_id`。DDL 注释必须写明「本表数据为 seed 模拟，原站 cpc 接口未采集」。

#### 后端

新建 `apps/api/src/business/wordpick.service.ts`（命名沿用现有 `xxx.service.ts` 风格），
在 `business.module.ts` 的 providers/exports 注册（该模块已 import `[AuthModule, UsersModule]`，无需改 imports）。

接口（挂在既有 `@Controller('business')` 下，全局前缀 `/api`）：

| 路由 | 说明 | 分页 |
|---|---|---|
| `GET business/wordpick/conversion` | 关键词转化率，按 keyword 查 | 游标 |
| `GET business/wordpick/competition` | 流量位竞争格局 | 游标 |
| `GET business/wordpick/amount` | 流量位竞品数量 | 游标 |
| `GET business/wordpick/cpc` | 关键词竞价（seed） | 游标 |

必须遵守的既有约定（逐条对应现有代码）：
- 主查询参数用 DTO，放 `business/dto/query.dto.ts`，数字字段加 `@Transform`（照 `query.dto.ts:64,117`）
- 次要参数直接 `@Query('country') country = 'US'`，不进 DTO
- service 直接 return 裸对象，**不自己包信封**（`ResponseInterceptor` 会包，成功 `code: 0`）
- 排序字段走白名单 map（照 `keywords.service.ts:34-39` 的 `SORT_COLUMNS`），不拼用户输入
- 游标是**复合键 `(排序值, keyword)`**，tie-break 用 keyword 文本而非 keyword_id
  （`keywords.service.ts:138-150` 记了原因：keyword_id 可空，NULL 参与比较整行被过滤，翻页漏数据）
- `LIMIT ?` 传 `limit + 1`，交给 `buildPage()` 判 `hasMore`，**不跑 COUNT**
- 输出 camelCase，BIGINT 用 `String()`，DECIMAL 用 `Number()`
- 主查询接口调 `track()` 埋点（`business.controller.ts:71-91`），次要接口不调
- 写库时间戳照抄各 service 顶部的本地 `now()`（UTC 口径），不用本地时区 API

#### 前端

4 个新页面，`src/views/` 下 PascalCase + `View.vue`：
`ConversionRateView.vue` / `CompetitionView.vue` / `CompetitorAmountView.vue` / `CpcBidView.vue`。

每页结构照抄 `SalesView.vue` / `TrafficView.vue` 的骨架：
- `<script setup>` + 局部 `ref`（**不进 Pinia**，业务查询结果一律页面局部）
- `data = ref<T | null>(null)`，null 表示未查询/失败
- 加载态 `<QuerySkeleton v-if="loading && !data" />`，空态 `<el-empty v-else-if="!loading" :image-size="90" />`
- 错误态不做页面 UI，置 null 回落空态（http 拦截器已弹 toast）
- 查询成功后 `router.replace({ query: { ...route.query, keyword: v } })`，`onMounted` 读 query 自动查
- 表格直接用 `el-table`，排序页**必须给 `row-key`**（`SalesView.vue:391` 记了无 key 时排序徽标错位的坑）
- 图表用 `<BaseChart :option="computed" :loading="loading" />`

⚠️ **需新建的复用组件**：现有 `AsinSearchBar.vue` 内置 `/^[A-Z0-9]{10}$/` 校验，
本模块是**按关键词查**而非按 ASIN。需新建 `KeywordSearchBar.vue`（同样的 props/emit 契约，校验改成非空 + 长度 ≤128）。
这个组件 M12/M14 也要用，值得抽。

导航注册（4 处，缺一不可）：
1. `src/router/index.ts` 的 `/` children 加 4 条，`meta.title` 必填
2. `src/layouts/MainLayout.vue:21` 的 `navGroups` —— **新增「选词」分组**，`name` 必须与路由名严格一致
3. `src/api/business.ts` 的 `businessApi` 加 4 个方法 + 导出类型
4. 可选：`DashboardView.vue:49-56` 的 `quickEntries`（`:42-48` 记了 name 写错导致路由抛错的事故）

#### ETL

扩写既有 gap-table ETL。现有 4 个 ETL 脚本的模式：**连 PG 读 → Python 转换 → Doris 写入**。
新脚本 `scripts/etl_module13_wordpick.py` 照抄 `etl_module5b_keyword_metrics.py` 的骨架
（它已在处理 `fact_keyword_metric_snapshot`，是最近的邻居）。

关键词归一规则必须执行：`keyword_norm = btrim(lower(keyword))`（schema-04:17 定的防御性规则）。

#### AI 插入点

新增第 7 个：**「选词建议」** —— 从转化率 + 竞争格局 + 竞品数量三个维度给「这个词值不值得投」的结论。
注册到 `apps/api/src/ai/prompts/index.ts` 的 `PROMPTS` 表（照 `keywordRecommendV1:52` 的结构）。
前端复用 `AiAnalysisCard`（SSE 流式，已有封装）。

#### 验收

- 4 个页面能查、能翻页、能排序、空态正常
- `fact_keyword_conversion_funnel` / `fact_keyword_competition_snapshot` 迁主键后行数不丢（854 / 3,244）
- cpc 页面明确标注「模拟数据」，不让用户误以为是真实竞价
- 命中率验证：方案 A 落地后关键词 JOIN 命中率应接近 100%（改造前 15.2% / 9.4%，见 `MODULE_DATA_FLOW.md:1283-1285`）

---

### M14 · 查坑位 / 推排名（第 2 期，3 页）

原站路由：`/snapshot`（坑位快照）、`/dailyrank`（每日排名）、`/hourlyrank`（小时排名）。

#### 数据现状

| 子功能 | 源 | 就绪度 |
|---|---|---|
| 每日排名 | `sif_asin_keyword.raw -> 'allRankHistory'`，已结构化落地且比 api_log 大 47 倍，`keyword_id` **100% 可得** | 🟢 |
| 坑位快照 | 原站 `/api/monitorSnapshot/*` 未爬；`fact_asin_keyword_snapshot` 有排名但无「坑位」语义 | 🔴 纯 seed |
| 小时排名 | 原站小时粒度接口未爬；现有源最细到日 | 🔴 纯 seed |

`fact_keyword_rank_history` 表已建，但 7,689 行**全是 `B0SEED` 种子**（无真实数据）。
每日排名的真实数据要从 `sif_asin_keyword.raw` 的 JSON 数组展开灌进来。

#### 数据库改动

1. **`fact_keyword_rank_history` 加分区**（`stat_date` 按月），已在 §1.4 列为前置项
2. **新建 `fact_keyword_rank_hourly`**（小时排名，纯 seed）：
   `UNIQUE KEY(keyword, country, asin, stat_hour)`，`stat_hour DATETIME`。
   按天 RANGE 分区（小时粒度数据量大，日分区避免单分区过大）
3. **新建 `fact_keyword_slot_snapshot`**（坑位快照，纯 seed）：
   `UNIQUE KEY(keyword, country, stat_date, slot_position)`，
   列含 `slot_type`（自然位/SP/SB/SBV/推荐位）、`occupant_asin`、`occupant_brand`、`slot_price`。
   DDL 注释写明数据为 seed。

#### 后端

新建 `apps/api/src/business/rank.service.ts` + 3 个接口：
`GET business/rank/daily` / `business/rank/hourly` / `business/rank/slot-snapshot`。

⚠️ **排名类接口的分页特殊性**：每日排名是「一个词 × N 天」的时间序列，
天然按日期倒序，游标就是 `(stat_date, asin)`。但前端图表需要**完整区间**而不是分页——
建议 `daily` 接口走 `startDate` / `endDate` 参数返回全量（区间上限 90 天，超出报 400），
只有「多 ASIN 排名列表」这种才用游标分页。这是与 M13 不同的取舍，要在 service 注释里写明。

#### 前端

`DailyRankView.vue` / `HourlyRankView.vue` / `SlotSnapshotView.vue`。
新增「排名监控」导航分组。

- 每日/小时排名主体是**折线图**（`BaseChart`），多 ASIN 多条线，配 `PALETTE`（照 `SalesView.vue:240`）
- 坑位快照主体是**表格 + 坑位占位可视化**，形态接近 `TrafficView` 的渠道构成条
- 时间区间选择器：Element Plus `el-date-picker` type="daterange"，
  ⚠️ 注意时区——`http.ts` 不开 `dateStrings`，日期传给后端要用 `fmtDate` 口径（UTC），
  不要直接 `.toISOString()` 后截断（会因本地时区偏移差一天）

#### ETL

`scripts/etl_module14_rank.py`。核心是 JSON 数组展开：
从 `sif_asin_keyword.raw -> 'allRankHistory'` 取每日排名序列，展平成行。
⚠️ 必须保留 `jsonb_typeof` 守卫（`ETL_GAP_ANALYSIS.md:22-33` 记了教训：
遇到非数组行会报 `cannot extract elements from a scalar`）。

#### 验收

- `fact_keyword_rank_history` 真实数据行数 >> 7,689（当前全是 seed）
- 每日排名图表能画出连续折线，缺数日断线而非补 0
- 小时/坑位页面明确标注模拟数据
- 分区裁剪在 EXPLAIN 里生效

---

### M11 · 产品时光机（第 3 期，1 页）

原站路由：`/timemachine-product`。与已实现的**运营时光机**（`/timemachine-traffic`，M6）是不同页面。

#### 数据现状 🟢 源 100% 填充，卡点在 schema

`traffic-trend` 响应的 `buyboxPrice[]` / `review[]` / `bsr[]` / `woot[]` 实测 **2,462/2,462 = 100%** 都带这些数组
（`MODULE_DATA_FLOW.md:1350`）。`sif_asin_traffic_daily` 已有 157 万行日粒度数据，
含 `buybox_price` / `bsr` / `star` / `review` / `promotion` / `coupon_info` / `title_img` / `deal_price`。

**唯一障碍**：`fact_asin_listing_snapshot` 是**月粒度**，日粒度被聚合掉了
（`MODULE_DATA_FLOW.md:1350` 明确「若要日趋势需扩表」）。

另有 5 个未接列可用：`woot`(86.2%)、`buybox_seller`(86.2%)、`seller`(86.5%)、
`bought_past_month`(66.3%)、`deal_price`(86.1%)。

#### 数据库改动

**新建 `fact_asin_listing_daily`**（不改月粒度表，两者并存）：
```
UNIQUE KEY(asin, country, stat_date)
DISTRIBUTED BY HASH(asin) BUCKETS 8      -- 157 万行起步，比默认 2 桶要多
PARTITION BY RANGE(stat_date) 按月
```
列：`buybox_price` / `deal_price` / `bsr` / `star` / `review_cnt` / `promotion` /
`coupon_info` / `title_img` / `woot` / `buybox_seller` / `seller` / `bought_past_month`。

⚠️ **为什么不改 `fact_asin_listing_snapshot`**：它已被 M1/M4 的查询依赖，
改粒度会破坏现有页面。新建日表 + 保留月表，月表可由日表聚合生成（后续优化，本期不做）。

#### 后端

`apps/api/src/business/timemachine.service.ts`（M6 的运营时光机在 `insights.service.ts` 里，
产品时光机独立成 service 更清楚）。

接口：`GET business/timemachine/product?asin=&startDate=&endDate=`
返回多条时间序列（价格/BSR/评分/评论数/促销），区间上限 180 天。

#### 前端

`ProductTimemachineView.vue`。形态是**多轴折线图 + 事件标记**：
- 主图：价格（左轴）+ BSR（右轴，反向，数值越小越好）
- 副图：评分 + 评论数
- 促销/Coupon 用 ECharts `markArea` 标出区间
- 表格：按日列出所有字段，支持导出（导出功能本期不做，留 TODO）

⚠️ BSR 轴要 `inverse: true`——BSR 数值小代表排名好，不反转会让图形直觉相反。

#### ETL

`scripts/etl_module11_product_timemachine.py`。
可复用 `etl_module6_timemachine.py` 的 `lag()` 相邻日 diff 模式（M6 已在做这个）。
本模块只需**原样搬运日粒度行**，不需要 diff（diff 是运营事件的逻辑，不是时光机的）。

#### AI 插入点

新增第 8 个：**「时光机解读」** —— 识别价格调整、BSR 突变、评分下滑的时间点及可能原因。

#### 验收

- `fact_asin_listing_daily` 行数接近 157 万（源填充率 100%，允许少量 ASIN 缺失）
- 图表在 180 天区间下渲染不卡（ECharts `sampling: 'lttb'` 降采样）
- BSR 轴方向正确

---

### M10 · 多产品对比（第 4 期，3 页，零 ETL）

原站路由：`/compare-sales`（对比销量）、`/compare-structure`（对比流量结构）、`/compare-traffic`（对比流量词）。

#### 数据现状 🟡 部分有源，但**不需要新表**

**关键结论**（`DATA_DICTIONARY.md:471`）：
> 竞品对比独有表：实测**无独有指标**，`*Best` 是 `MAX() OVER (组)` 结果不可持久化。

即「组内最佳」标记（最便宜、评分最高）是相对当前对比组算出来的，换一组就变，
所以**不落库、每次请求现算**。现有 `CompetitorsView.vue:15-16` 已经写明了这个设计。

三个页面的源就是已灌好的 M1/M4/M5 表做多 ASIN 并排查询：

| 页面 | 复用表 | 就绪度 |
|---|---|---|
| 对比销量 | `fact_asin_bought_monthly`（已灌 809,553 行） | 🟢 |
| 对比流量结构 | `fact_asin_traffic_channel`（已灌 149,460 行） | 🟢 |
| 对比流量词 | `fact_asin_keyword_snapshot` + `dim_keyword` | 🟡 |

⚠️ 文档 `DATA_DICTIONARY.md:591` 曾记「`/compare-structure` `/compare-traffic` 依赖接口失效，
只有 `/compare-sales` 能复刻」——**那是指原站接口失效，不是我们没数据**。
我们的对比页是从自己的表拼，不依赖原站 compare 接口，所以三页都能做。这条遗留问题可以关闭。

#### 数据库改动

**无。** 这是本计划里唯一零 DDL 的模块。

#### 后端

扩写现有 `business.controller.ts:213` 的 `competitors` 接口族，
或新建 `compare.service.ts`。建议后者——现有 `competitors` 是单表并列，
三个新页面各有独立的数据形态（月度序列 / 渠道构成 / 关键词交集），塞进一个接口会很臃肿。

接口：
- `GET business/compare/sales?asins=A,B,C&country=` → 每个 ASIN 的月度销量序列
- `GET business/compare/structure?asins=...` → 每个 ASIN 的渠道构成占比
- `GET business/compare/traffic?asins=...` → 关键词交集/差集矩阵

⚠️ **对比数上限**：现有 `CompetitorsView.vue:48` 用 `MAX_COMPARE` 限制，
后端也要校验（DTO 里加 `@ArrayMaxSize`），否则 20 个 ASIN 的 `IN` 查询会拖慢 Doris。
建议上限 5（与现有前端一致）。

#### 前端

`CompareSalesView.vue` / `CompareStructureView.vue` / `CompareTrafficView.vue`。

复用现有 `CompetitorsView.vue` 的 ASIN 多选交互（`:48` 的上限校验、
`:66,78-88` 的 URL 逗号拼接与恢复）——**建议先把这段抽成 `AsinMultiInput.vue` 组件**，
四个页面（含现有竞品对比）共用，避免第四份复制。

- 对比销量：多条折线（每 ASIN 一条）+ 组内最佳标记
- 对比流量结构：堆叠柱状图（每 ASIN 一根柱，渠道分段）
- 对比流量词：交集矩阵表格，行=关键词，列=ASIN，格子里放排名

#### AI 插入点

复用已有的第 6 个（综合诊断），加一个对比语境的 prompt 变体即可，不算新插入点。

#### 验收

- 三页都能加载，5 个 ASIN 并排不卡
- 「组内最佳」标记随对比组变化而变（验证是现算不是落库）
- 超过 5 个 ASIN 返回 400 而非静默截断

---

### M12 · 拓词 & 筛查（第 5 期，7 页）

原站路由：`/keywords`（以词拓词）、`/root-relatedness`（以词拓词并筛查）、
`/expand`（通过竞品拓词）、`/asin-relatedness`（多竞品拓词并自动筛查）、
`/category`（品类定制词库）、`/niche-relatedness`（细分品类拓词并筛查）、
`/keyword-relatedness`（批量导入关键词筛查）。

⚠️ 命名冲突提醒：**原站 `/keywords` 是「以词拓词」，不是反查流量词**。
我们已把反查流量词放在 `/keywords`（`router/index.ts` 有意为之，`keywords.service.ts:9` 也写明）。
本模块的页面路径要另起，建议统一挂 `/expand/*` 前缀，避免与现有 `/keywords` 撞车。

#### 数据现状

| 子功能 | 源 | 就绪度 |
|---|---|---|
| 以词拓词 | `sif_api_log`[ep=`web-keyword-extend`]，**473 ok**，120 条样本打平 108 字段 | 🟢 |
| 相似竞品拓词 | `web-compete-keyword`（361 ok）+ `web-compete-pattern`（82 ok 但 CLI 实测返回空） | 🟡 |
| 品类拓词 | 原站 `/api/search/category/suggestion` 等**均未爬** | 🔴 纯 seed |
| 批量导入筛查 | **用户上传驱动，本质无需 ETL** | — |
| 相关性评分本身 | `web-keyword-extend` 的 `confirmRelevance` 实测 **0.0% 填充** | 🔴 需自算或 seed |

**最大的设计问题：相关性评分无源。**
原站的「筛查」核心就是给每个拓出来的词打相关性分，而这个字段实测填充率 0%。
两条路：
- **A. 自己算**（推荐）：用词根重合度 + 品类一致性 + 搜索量量级做启发式打分，
  在 service 层现算，不落库。优点是有业务含义且可解释；缺点是与原站算法不同。
- **B. seed 造分**：造一列随机分。优点是零成本；缺点是这页的核心价值就是这个分，造假分等于这页没用。

**⚠️ 本节已被审计解决，按修订表执行（AUDIT §8c 判 12）**：原站的相关性不是 NLP，
而是**自然位前 4/8/16/32/48 占位率 + 用户设阈值**，纯数据计算。
Looom 直接自算占位率，阈值 `{high, mid, low}` 可调，页面如实展示「自然位前 N 占位率」原始列。
**上面 A/B 两条的「A=词根重合度」旧方案作废**——A 的精神（自算、可解释）保留，算法换成占位率。

数据已有（Doris 实测，2026-09-21）：
- `fact_keyword_rank_history` **117,740 行** —— 占位率的计算源
- `rel_keyword_top_asin` **56,795 行**（top 46,451 + conv 10,344）——
  「自然流量 Top 5 产品」列的图片源。⚠️ 用 `asin_role='top'` 筛，
  conv 那 10,344 行里只有 430 行带 `rank_position`/`title`

⚠️ **不要写「先读源 relevance，读不到才自算」的 fallback**。
审计 §11.6 核对 `docs/audit/fixtures/root-extend-travel-gifts.json`：
词根拓词响应里 `relevance` 和 `confirmRelevance` 字段虽然存在，
但 22 个词**全部为 null**，`cpc` 的 6 个键也全是空数组。
源侧拿不到任何相关性值，fallback 分支永远走不到，写了只是死代码。

#### 数据库改动

Doris 目前**无拓词落点**（`ETL_GAP_ANALYSIS.md:360` 注明「词扩展（Doris 无对应表）」）。新建 3 张：

1. **`fact_keyword_expand`** —— 拓词结果
   `UNIQUE KEY(seed_keyword, country, expand_keyword)`，
   列含 `est_searches_num` / `relevance_score`（自算）/ `source_type`（word/asin/category）
2. **`rel_keyword_root`** —— 词根关系（以词拓词的中间产物）
   `UNIQUE KEY(word, country, keyword)`，复用已有 `dim_word`(33 行 seed)
3. **`dim_niche_category`** —— 细分品类（品类拓词用，纯 seed）
   `UNIQUE KEY(category_id, country)`，列含 `category_name` / `parent_id` / `keyword_cnt`

⚠️ 现有 `rel_keyword_group`（用户词库分组）是空壳，`ETL_GAP_ANALYSIS.md:284` 提
`amazon.keyword_items`(112,035 行) 可作替代源，但**语义是「种子词扩展」不是「用户词库」**——
别把它当 M15 的词库用，它其实更适合喂本模块的拓词。这是一个值得在实现时验证的机会点。

#### 后端

`apps/api/src/business/expand.service.ts` + 7 个接口（或 4 个接口 + mode 参数）。

**建议合并**：7 个页面本质是「拓词源」× 「是否筛查」的组合，
接口设计成 `GET business/expand?source=word|asin|category|import&screen=true|false`
比 7 个独立路由更少重复。前端仍是 7 个页面，各自传固定参数。

批量导入筛查需要 `POST`（上传关键词列表），是本计划里唯一的写接口：
`POST business/expand/screen`，body 是 `{ keywords: string[], country }`，上限 500 个词。
⚠️ 这个接口**不落库**，纯计算后返回——避免用户上传的词污染 `dim_keyword`。

#### 前端

7 个页面，新增「拓词 & 筛查」导航分组。
共用一个 `ExpandResultTable.vue` 组件（拓词结果表格 + 相关性分列 + 批量选中导出），
各页面只在输入区不同（词输入 / ASIN 输入 / 品类树选择 / textarea 批量粘贴）。

批量导入页需要 `el-textarea` + 换行分割 + 前端去重 + 数量提示（「已识别 N 个词，上限 500」）。

#### ETL

`scripts/etl_module12_keyword_expand.py`。先解析 2 个未结构化 endpoint：
`web-keyword-extend`、`web-compete-keyword`。

⚠️ 这是本计划里**唯一需要从零解析 endpoint** 的模块，工作量最大。
先用 `sif_schema_probe.py` 探出响应结构，`sif_gen_schema_doc.py` 生成字段文档，再写 ETL。

#### 验收

- 7 页可用，相关性分有业务含义（同义词高分、无关词低分，人工抽检 20 个词）
- 批量导入 500 词能在 3 秒内返回
- 品类拓词页标注模拟数据

---

### M15 · 产品库 / 词库（第 6 期，2 页，零 ETL）

原站路由：`/product`（产品库-我的关注）、`/words`（关键词库-我的关注）。

#### 数据现状

**表已建，是空壳，且不需要 ETL** —— 这是用户自产数据。

`user_favorites` 表（`db/schema-01-system.sql`）是「关注/监控/订阅」三态合表，
DDL 注释说明依据是 `asinKeywordList` 响应里 `isFocus` / `isMonitor` / `isSubscribe` 三标志并存。

**当前后端零支持**：`users.controller.ts` 的 8 个接口里**没有任何 favorite / watchlist 接口**（实查确认）。

#### 数据库改动

无新表。但需确认 `user_favorites` 的主键能否支撑两类实体（ASIN 和关键词）：
若当前是 `UNIQUE KEY(id)` 而非 `(user_id, entity_type, entity_key)`，
会出现同一用户重复关注同一 ASIN 的脏数据（Doris 无唯一约束，只有主键去重）。
**实现前必须核对这张表的 DDL 并按需重建主键。**

#### 后端

新建 `apps/api/src/users/favorites.service.ts`（放 users 模块而非 business——这是用户资产不是业务查询）。

接口：
- `GET users/me/favorites?type=asin|keyword` → 游标分页
- `POST users/me/favorites` → 加关注，body `{ type, key, country }`
- `DELETE users/me/favorites/:id` → 取消关注
- `PATCH users/me/favorites/:id` → 改监控/订阅状态

⚠️ **积分**：关注操作不扣分（当前全仓只有 `ai_analysis` 扣分，见 `credits.controller.ts:34-52`
明确记录「业务查询接口一个都不扣费」）。不要给这个功能加计费，会让 `/pricing` 界面说谎。

#### 前端

`ProductLibraryView.vue` / `WordLibraryView.vue`。

**需要跨页改动**：关注按钮要出现在所有列表页（销量/流量词/排名等）。
建议做 `FavoriteToggle.vue` 组件（一个星标按钮，props `type` + `key`，内部调 API + 乐观更新），
插到现有各 `el-table` 的操作列。这会触及 M1~M14 的多个已有页面，
**放在最后一期正是为了避免中途反复改动这些页面**。

状态管理：关注列表适合进 Pinia（跨页共享，需要知道「当前这行是否已关注」）。
新建 `stores/favorites.ts`，照 `stores/credits.ts` 的 setup store 风格。
这是本计划里唯一进 store 的数据。

#### 验收

- 加/取消关注在任意列表页生效，刷新后保持
- 两个库页面能分页、能批量取消
- 同一 ASIN 重复关注不产生脏行（验证主键设计）
- 关注操作不扣积分

---

## 4. 横切事项

### 4.1 新增表汇总

> ⚠️ 下表为**编写时的原方案**，已被审计修订。修订后的清单：
>
> | 表 | 模块 | 主键 | 数据来源 | 变化 |
> |---|---|---|---|---|
> | `fact_keyword_bid_estimate` | M13 竞价 | `(keyword, country, category_id, match_type, bid_strategy, stat_month)` | 🔴 seed | **重建**（加类目维），DDL 注明「建议竞价与品类强相关」 |
> | `fact_keyword_acos_estimate` | M13 转化率 | `(keyword, country, stat_week, match_type, bid_strategy)` | 🟢 真实 33,019 行 | **由 `fact_keyword_bid_estimate` 改名 + 拆维**：原 `match_type` 存 `autoForSales_broad` 拼接值，已拆成 `match_type(broad/phrase/exact)` × `bid_strategy(auto/legacy)` 与竞价表对齐 |
> | `rel_keyword_asin_traffic_share` | M13 /compete | `(keyword, country, asin)` | 🔵 待探源 | **新增**。页面 6 个流量位列，但响应有 8 个 `*ScoreRatio`（多出的 er/tr 存疑，建列但标注待定，见 AUDIT §11.2） |
> | `rank_monitor` | M14 任务 | `(id)` 应用层雪花 | — 用户自产 | **新增**（granularity/period/pages/duration/status/integral_cost） |
> | `fact_keyword_rank_hourly` | M14 | `(keyword, country, asin, stat_hour)` | 🔴 seed | 不变 |
> | `fact_keyword_slot_snapshot` | M14 | `(keyword, country, stat_date, slot_position)` | 🔴 seed | 不变 |
> | `fact_keyword_expand` | M12 词根 | `(seed_keyword, country, expand_keyword)` | 🟡 部分真实 | 加列 `match_types`（含 DropDownBox）、`translate_keyword` |
> | `fact_keyword_category_expand` | M12 品类 | `(category_id, country, keyword)` | 🔴 seed | **新增**（品类拓词与词根拓词字段不同构，判 17） |
> | `rel_keyword_root` / `dim_niche_category` | M12 | 同原案 | 🟡/🔴 | 不变 |
> | ~~`fact_asin_listing_daily`~~ | ~~M11~~ | — | — | **取消**（产品时光机=关键词→历史畅销榜，无需大表） |
>
> 以下原表保留备查（M11 行已作废、cpc 行已拆分）：

| 表 | 模块 | 主键 | 分区 | 数据来源 |
|---|---|---|---|---|
| `fact_keyword_cpc_bid` | M13 | `(keyword, country, stat_date, match_type)` | 按月 | 🔴 seed |
| `fact_keyword_rank_hourly` | M14 | `(keyword, country, asin, stat_hour)` | 按天 | 🔴 seed |
| `fact_keyword_slot_snapshot` | M14 | `(keyword, country, stat_date, slot_position)` | 按月 | 🔴 seed |
| `fact_asin_listing_daily` | M11 | `(asin, country, stat_date)` | 按月 | 🟢 真实 |
| `fact_keyword_expand` | M12 | `(seed_keyword, country, expand_keyword)` | 无 | 🟡 部分真实 |
| `rel_keyword_root` | M12 | `(word, country, keyword)` | 无 | 🟡 |
| `dim_niche_category` | M12 | `(category_id, country)` | 无 | 🔴 seed |

（7 行，M12 有 3 张）

全部遵守既有 Doris 约定（`db/schema-04` 是最新范本）：
- Unique Key 模型 + `enable_unique_key_merge_on_write = true`
- 显式 `DISTRIBUTED BY HASH(主键首列) BUCKETS N`
- 关键词列 `VARCHAR(128)`（实测全库最大 128，平均 23）+ `INDEX ... USING INVERTED`
- `country VARCHAR(8)` **必须进主键**（实测 keyword_id 跨站点不唯一）
- 所有 ID 应用层雪花生成，`BIGINT`
- 表/列 COMMENT 写实测值域和填充率，seed 表必须写明「数据为模拟」

新建文件：`db/schema-06-unbuilt-modules.sql`（按模块分节，用 `CREATE TABLE IF NOT EXISTS`）。
⚠️ 同步改 4 处：`setup-doris.sh` 的 glob 会自动带上；
`init-db.mjs:40-44` 的 `FILES` 要手加；`Dockerfile` 的 COPY 要覆盖；
两个生成器（`gen-business-schema.mjs` / `gen-seed.mjs`）**已与 schema-04 脱节**，
本期不回写生成器（见 §9），新表直接手写 DDL。

### 4.2 seed 数据生成

现有 `db/gen-seed.mjs`（1058 行）产出 `db/seed.sql`。
⚠️ **它还是旧 keyword_id 主键版本**，重跑会回退设计、seed 插不进 schema-04 的表。

**本期策略**：不动 `gen-seed.mjs`，新建 `db/gen-seed-unbuilt.mjs` 产出 `db/seed-unbuilt.sql`，
只负责 6 张新表 + M13 的 cpc 表。两个 seed 文件并存，执行顺序在 schema 之后。

seed 数据量级参照现有（每表几十到几千行，够填满一页表格和一张图）：
- cpc / slot / hourly：50 个关键词 × 30 天
- niche_category：3 级品类树共 100 个节点

seed 数据必须用 **`B0SEED` 前缀 ASIN**（现有约定，便于一眼区分真假数据）。

### 4.3 前端共用组件（4 个新建）

按出现顺序，每个都被 2+ 模块使用，值得抽：

| 组件 | 首次需要 | 复用方 | 职责 |
|---|---|---|---|
| `KeywordSearchBar.vue` | M13 | M12, M14 | 关键词输入（现有 `AsinSearchBar` 只校验 ASIN 格式） |
| `AsinMultiInput.vue` | M10 | 现有 CompetitorsView | ASIN 多选 + 上限校验 + URL 同步（把第 4 份复制消灭掉） |
| `ExpandResultTable.vue` | M12 | M12 内 7 页 | 拓词结果表 + 相关性分 + 批量选中 |
| `FavoriteToggle.vue` | M15 | 所有列表页 | 星标关注按钮 + 乐观更新 |

现有可直接复用（无需改动）：`AsinSearchBar` / `QuerySkeleton` / `BaseChart` / `AiAnalysisCard`。

⚠️ **前端无 `utils/` `composables/` `types/` 目录**，工具函数和常量目前都内联在各 view 里
（如 `TrafficView.vue:108` 的 `CHANNEL_META`、`SalesView.vue:240` 的 `PALETTE`）。
本计划新增 20 个页面，若继续内联会产生大量重复。**建议在第 1 期就建 `src/constants/` 和 `src/composables/`**，
把图表调色板、时间区间预设、游标分页 hook 抽出来。这是小投入、大回报的一次性整理。

`Page<T>` 类型是 `api/user.ts:65` 的**非导出**局部接口，M13 开始所有分页接口都要用，
第 1 期顺手改成 `export`。

### 4.4 导航结构调整

现有 `MainLayout.vue:21` 的 `navGroups` 是 5 组 13 项。本计划加 20 项，会变成 33 项——
**一个平铺侧栏放不下**。原站用的是顶部多级菜单（见截图）。

三个选项：
- **A. 侧栏加二级折叠**（Element Plus `el-sub-menu`）—— 改动集中在 MainLayout，推荐
- **B. 改顶部多级菜单** —— 更像原站，但要重做布局
- **C. 侧栏分组更多、不折叠** —— 33 项会需要滚动，体验差

**建议 A**，新分组规划（9 组）：
```
概览 / 商品分析 / 关键词 / 选词(M13) / 排名监控(M14) / 多产品对比(M10)
/ 拓词筛查(M12) / 我的资产(M15) / 其他
```
产品时光机(M11) 归入「商品分析」，与运营时光机并列。

⚠️ 这个改动影响所有现有页面的导航体验，**建议在第 1 期做**，避免后面每期都动 MainLayout。

### 4.5 AI 插入点扩展

现有 6 个（`ai/prompts/index.ts:203` 的 `PROMPTS` 注册表）。本计划加 2 个：

| 新增 | 模块 | 说明 |
|---|---|---|
| 选词建议 `wordpickV1` | M13 | 转化率 + 竞争格局 + 竞品数量 → 值不值得投 |
| 时光机解读 `timemachineV1` | M11 | 价格/BSR/评分突变点识别与归因 |

M10 复用现有 `diagnosisV1` 加对比语境变体，不算新插入点。

扩展方式：在 `prompts/index.ts` 加 `PromptTemplate` 常量 + 注册到 `PROMPTS`，
前端复用 `AiAnalysisCard`（SSE 流式已封装）。
⚠️ AI 分析**是全仓唯一扣积分的操作**（`ai.service.ts:97` 调 `credits.spend(userId, 'ai_analysis')`），
计费规则在 Doris `system_configs` 表，key 格式 `credit.cost.<bizType>`。
新插入点若要独立计价，需往 `system_configs` 加行并更新 `/pricing` 下发列表；
**若沿用 `ai_analysis` 则零改动**——建议沿用。

### 4.6 积分与权限

- **业务查询接口一律不扣分**（保持现状）。`track()` 埋点恒传 `creditsCost = 0`。
- 新接口都要走 `JwtAuthGuard` + `PermissionsGuard`（`@Controller('business')` 已在类级声明，新方法自动继承）
- M15 的 favorites 接口挂在 users 模块，需确认该模块的 guard 声明方式与 business 一致

### 4.7 测试

**现状：后端有测试框架、前端零测试**（`apps/web/package.json:7-12` 只有 dev/build/preview/typecheck，
devDependencies 无 vitest / @vue/test-utils）。

本计划的测试策略（务实，不追求覆盖率）：
- **后端**：每个新 service 的分页逻辑写单测（游标编解码 + hasMore 判定最容易错）
- **ETL**：每个脚本跑完打印行数 + 填充率，人工比对文档里的预期值。不写自动化测试。
- **前端**：本期**不引入测试框架**。改为在每期验收时人工过一遍 checklist（各模块 §验收）。
  引入 vitest 是独立的技术债项，不塞进本计划。

---

## 5. 分期执行流程

每一期都走同一套流程，顺序不可颠倒：

```
1. 探源      跑 sif_schema_probe.py 确认字段名/填充率（不凭文档推测列名）
2. 建表      写 DDL → setup-doris.sh 验证 → 核对 init-db.mjs/Dockerfile
3. seed      写生成器 → 灌数 → SELECT 验证行数
4. ETL       写脚本 → 跑 → 比对行数与填充率（仅有真实源的模块）
5. 后端      service + DTO + controller → 手测接口（curl/Apifox）
6. 前端      页面 + api 方法 + 路由 + 导航 4 处注册 → 浏览器验证
7. AI        prompt 注册 + 前端 AiAnalysisCard 接入（若该期有插入点）
8. 验收      过该模块的 §验收 checklist
9. 文档      回写 MODULE_DATA_FLOW.md / DATA_DICTIONARY.md / ROUTES_TITLES.md
```

⚠️ **第 1 步不可跳过**。`ETL_GAP_ANALYSIS.md` 里的字段名来自采样，
多次出现「文档写的列名与实际响应不符」的情况（§9 列了 3 处已知不一致）。

### 期次依赖

> ⚠️ 下图为编写时的旧分期，**现行分期见顶部修订表**（0.5 返工 → 1 M13 → 2 M14 → 3 M15a → 4 M10 → 5 M12 → 6 M11 → 7 M15b；M15a 提前到 M10/M12 之前）。

```
前置修复(§1) ──┬─> 第1期 M13 ──> 第2期 M14 ──> 第3期 M11 ──> 第5期 M12 ──> 第6期 M15
               └─> 第4期 M10（零 ETL，可与 1-3 任意并行）
```

第 1 期额外背三件横切工作（都是「越早做越省」的）：
导航二级折叠(§4.4)、`src/constants` + `src/composables` 落地(§4.3)、`Page<T>` 改 export。

---

## 6. 工作量估算

> ⚠️ 下表为编写时的旧估算（基于旧分期/旧页面数），**修订后估算见顶部修订表的「修订后估算」：
> ≈52 人日，×1.3 缓冲 ≈68 人日**。M16/M17 已裁决不做，本就不在此表内，砍掉不影响总量。

按「一个页面 = 前端 1 + 后端 0.5」的粗口径，单位：人日。

| 期次 | 模块 | 建表/seed | ETL | 后端 | 前端 | 横切 | 小计 |
|---|---|---:|---:|---:|---:|---:|---:|
| 0 | 前置修复 §1 | 1 | — | — | — | — | **1** |
| 1 | M13 选词 4 页 | 2 | 2 | 2 | 4 | 3 | **13** |
| 2 | M14 排名 3 页 | 2 | 2 | 1.5 | 3 | — | **8.5** |
| 3 | M11 时光机 1 页 | 1 | 1.5 | 0.5 | 2 | — | **5** |
| 4 | M10 对比 3 页 | 0 | 0 | 1.5 | 3 | 1 | **5.5** |
| 5 | M12 拓词 7 页 | 2 | 4 | 3 | 5 | 1 | **15** |
| 6 | M15 产品库 2 页 | 0.5 | 0 | 1 | 2 | 2 | **5.5** |
| | | | | | | **合计** | **≈ 53.5** |

M12 最重（7 页 + 从零解析 2 个 endpoint + 自算相关性算法），M11 最轻。
第 1 期含 3 人日横切工作，实际功能开发 10 人日。

**这是乐观估算**，不含：真实数据到位后的 ETL 返工、原站交互细节的反复对齐、
无源模块的 seed 数据形态调整。建议按 1.3 倍留缓冲，即 **≈ 70 人日**。

---

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **seed 数据形态与真实响应不符** | 5 个无源功能的表结构可能白建，真实数据到位要重建表 | 建表前先看原站页面截图/DOM 推断字段，不凭想象。COMMENT 里标注「结构未经真实响应验证」 |
| **M12 相关性算法无源** | 拓词筛查的核心价值缺失 | 选自算方案(§M12)，页面标注算法来源，不假装是原站数据 |
| **导航 33 项的信息架构** | 用户找不到功能 | 第 1 期先落地二级折叠，每期加菜单时人工走一遍「能否 3 次点击内到达」 |
| **schema-04 的 DROP 语义** | 误删真实数据 | §1.2 的守卫必须在第 1 期前完成，且写进 setup-doris.sh 的 usage |
| **大表分区改造** | 改晚了代价递增 | §1.4 只对 stat_date 型两表下手，VARCHAR 型留到用到时 |
| **生成器与 DDL 脱节** | 有人重跑生成器导致设计回退 | §9 建议在两个生成器顶部加醒目警告注释 |
| **前端零测试 + 20 个新页面** | 回归全靠人工 | 每模块 §验收 checklist 必须执行并记录；引入 vitest 作为独立债项排期 |
| **31 个未解析 endpoint 清单缺失** | M12/M14 可能漏掉可用源 | §8 第 1 项，开工前先落实清单 |

---

## 8. 开工前待办（4 项，需在第 1 期前完成）

1. **列出 31 个未解析 endpoint 的确切清单** + **确认 8 个关键端点的 PG 日志覆盖**
   文档只点名 13 个（`ETL_GAP_ANALYSIS.md:349-364`），剩 18 个归为「其余」未列名。
   做法：用 `scripts/sif_gen_schema_doc.py:30-74` 的 44 项 META 字典，减去 9 张结构化表的源 endpoint。
   跑一条 PG SQL 落实，结果补进 `ETL_GAP_ANALYSIS.md`。
   **同一批 SQL 顺带确认**（修订表「开工前探源待办」）：
   `competePattern`（M13 /compete）、`multiAsinKeywords`/`compareMyKeywords`/`asinMagic`/`asinSummary`（M10）、
   `keywordExtendKeyword`/`keywordByCategory`（M12）在 `sif_api_log` 是否有 ok 日志。
   有→真实 ETL；无→按 §0 裁决 seed。

2. **确认「同站一词两 ID 合并」的业务语义**
   `KEYWORD_ID_SCHEMA_PROPOSAL.md:203-214` 唯一悬而未决项，影响 2 个词。
   文档已给出「应合并」的判断，但明确要求人工确认。

3. **核对 `user_favorites` 表的主键设计**（M15a 前置，但越早确认越好）
   若主键是 `(id)` 而非 `(user_id, entity_type, entity_key)`，需重建。见 §M15。

4. **M13 数据层返工的迁移顺序**（0.5 期第一步）
   `fact_keyword_bid_estimate` 改名前先备份 DDL 与 33,019 行；schema-06 同步改；
   `etl_module13_wordpick.py` 的 `run_bid` 目标表名同步改；
   最后连跑两次 `setup-doris.sh` 验证守卫不回退（沿用 §1.2 的验证方法）。

---

## 9. 需回写的文档（实现过程中同步）

实测发现 6 处文档与代码脱节，本计划执行时一并修：

| 文档 | 位置 | 问题 | 处理 |
|---|---|---|---|
| `ER_BUSINESS.md` | `:22`, `:175` | 仍写 keyword_id 全局唯一 | 改为文本键（schema-04 已实施） |
| `NAMING.md` | `:66-82` | 同上 | 同上 |
| `DATA_DICTIONARY.md` | `:469` | 把已建已灌的 `fact_keyword_conversion_funnel` 列为「本期不建」 | 更正 |
| `ER_BUSINESS.md` | `:6` | 43 张表的分组计数与 DDL 实查的 58 张不符 | 按 DDL 重新统计 |
| `DATA_DICTIONARY.md` | `:591` | 遗留问题「compare-structure/traffic 做不了」已不成立（M10 从自己的表拼） | 关闭该项 |
| `sif_load_to_doris.mjs` vs `ETL_GAP_ANALYSIS.md` | `:90-105` vs `:119-121` | `bought_label` 口径不一致：代码用 BUCKETS 阈值反推，文档说留 NULL | 二选一，建议补文档说明代码走了第三条路 |

另建议在 `db/gen-business-schema.mjs` 和 `db/gen-seed.mjs` 顶部加警告：
「⚠️ 本生成器未同步 schema-04 的文本键改造，重跑会回退设计。修改 schema 请直接改 SQL 文件。」

---

## 10. 待确认事项

写这份计划时做了 6 个技术选择，实现前请确认（默认按推荐项执行）：

| # | 议题 | 推荐 | 备选 |
|---|---|---|---|
| 1 | schema-04 防清空 | **A. setup-doris.sh 加执行守卫** | B. 改 IF NOT EXISTS |
| 2 | 大表分区范围 | **只对 stat_date 型 2 表** | 4 表全做（需先解决 VARCHAR 分区键） |
| 3 | M12 相关性评分 | **A. 自算 + 页面标注算法** | B. seed 造随机分 |
| 4 | 导航信息架构 | **A. 侧栏二级折叠** | B. 改顶部多级菜单 |
| 5 | 新 AI 插入点计价 | **沿用 `ai_analysis`（零改动）** | 独立定价（需改 system_configs + /pricing） |
| 6 | 前端测试 | **本期不引入，靠验收 checklist** | 第 1 期引入 vitest（+3 人日） |

另有 §8 的 3 项开工前待办需要执行（第 1 项需要跑 SQL，第 2 项需要你的业务判断）。

---

**文档结束。** 确认后按 §5 的流程从「前置修复 §1」开始执行。





# 数据字典：查推荐专栏 / 竞品对比

遵循 `docs/NAMING.md`：前缀 `dim_`/`fact_`/`rel_`/`dict_`；字段 snake_case；
所有 `dim_`/`fact_`/`rel_` 表带 `country VARCHAR(8)` 且进主键；占比字段保持 0-1 存储。

---

# 一、核心裁决：推荐专栏是「动态实体」不是「固定枚举」

**结论：`dim_recommend_column`（动态实体）胜出，`dict_recommend_column` 应废弃。**

## 实测证据（决定性）

### 证据 1：前端硬编码只有 8 个，且明确留了 `other` 兜底

`chunks/26,27,28,...,39` 共 20+ 个 chunk 里存在**完全一致**的短码映射表：

```js
P = { Media:"Seen on social media", "4Star":"4 stars and above",
      fView:"Customers frequently viewed", KOL:"Picks from Amazon Influencers",
      rBuy:"Recently bought and rated", Trend:"Trending now",
      New:"New arrivals", tDeal:"Today's deals" }
L = {...P, other:""}            // ← 显式 other 兜底项
O = 反查表（英文标题.toLowerCase() → 短码）
B = function(e) {
      var a = O[e.toLocaleLowerCase()];
      return { recSimpleName: a || (t ? "其它" : ""),          // ← 查不到就显示「其它」
               backgroundColor: a ? 颜色表[e.toLowerCase()] : "#C8B2B7" }  // ← 兜底灰色
    }
```

**前端自己就假定后端会下发未知标题**，否则不需要 `other` + 「其它」+ 兜底灰 `#C8B2B7`。

### 证据 2：实测标题数远超硬编码表（9 个 ASIN 抽样，17 个不同标题）

调 `/api/search/rec/trends` 抽样 US 站 9 个 ASIN，收集 `recTrends` 的 key：

| 英文标题（后端下发原文） | 出现 ASIN 数 | 在硬编码表中? |
|---|---|---|
| `4 stars and above` | 5 | ✅ `4Star` |
| `Highly rated` | 4 | ❌ 未收录 |
| `Rated 4+ stars by customers` | 4 | ❌ 未收录 |
| `4+ star picks` | 3 | ❌ 未收录 |
| `Customers frequently viewed` | 3 | ✅ `fView` |
| `Customers mention` | 3 | ❌ 未收录 |
| `From frequently shopped brands` | 3 | ❌ 未收录 |
| `Today's deals` | 3 | ✅ `tDeal` |
| `Explore Amazon Influencer picks` | 2 | ❌ 未收录 |
| `Picks from Amazon Influencers` | 2 | ✅ `KOL` |
| `Recently bought and rated` | 2 | ✅ `rBuy` |
| `Shop by positive mentions` | 2 | ❌ 未收录 |
| `Shoppers also explored` | 2 | ❌ 未收录 |
| `Black Friday deals` | 1 | ❌ 未收录 |
| `Seen on social media` | 1 | ✅ `Media` |
| `Today's deals from Amazon Devices` | 1 | ❌ 未收录 |
| `Trending now` | 1 | ✅ `Trend` |

**9 个 ASIN 就挖出 17 个标题，其中 10 个（59%）不在硬编码表里**，
且**每加一个新 ASIN 就冒出新标题**（4 个 ASIN 时 14 个 → 9 个 ASIN 时 17 个），
说明标题空间**尚未收敛**。

### 证据 3：语义高度重复，印证是亚马逊原文抓取而非产品定义的枚举

`4 stars and above` / `Highly rated` / `Rated 4+ stars by customers` / `4+ star picks`
——**4 个标题同一含义**。`Picks from Amazon Influencers` / `Explore Amazon Influencer picks`
同义。`Customers mention` / `Shop by positive mentions` 同义。
`Today's deals` / `Today's deals from Amazon Devices` / `Black Friday deals` 同族。

这是**亚马逊 A/B 测试不同文案措辞**的典型特征。亚马逊改一次文案，就多一个「专栏」。
固定枚举表无法承载。

### 证据 4：接口把标题当业务主键传递（string 而非 code）

- `recView/keywords` / `recView/campaigns` 的**必填参数是 `recTitle`**（英文标题原文），
  不是短码，也不是数字 ID。空 body 报错：`recTitle不能为空`。
- `recTrends` / `keywordView.recTitles` / `campaignView.recTitles` 全部**以标题字符串为 key**。

后端自己就没有 code 体系 —— **标题字符串就是主键**。

### 关于「已知部分」清单的核实结果

任务给的 7 个已知专栏，核实如下：

| 任务给出的名称 | 核实结果 |
|---|---|
| Customers frequently viewed | ✅ 实测确认（硬编码 `fView` + 实测数据） |
| Trending now | ✅ 实测确认（硬编码 `Trend` + 实测数据） |
| Picks from Amazon Influencers | ✅ 实测确认（硬编码 `KOL` + 实测数据） |
| Seen on social media | ✅ 实测确认（硬编码 `Media` + 实测数据） |
| **Amazon Choice** | ❌ **未在硬编码表、也未在任何实测响应中出现**。不确认存在 |
| **Editorial Recommendation** | ❌ **同上，不确认存在**（chunk 里搜 `Editorial` 无结果） |
| **Top Rated** | ❌ **未出现**。疑似与 `Highly rated` 混淆 |

补充：硬编码表还有 3 个任务清单里没有的 —— `4 stars and above`、`New arrivals`、`Today's deals`。

## 裁决建议

**建 `dim_recommend_column` 动态实体表**（新标题按 upsert 落库），
**不建 `dict_recommend_column`**。中文名映射降级为**可选装饰属性**（只有 8 个有值）。

代价与好处：亚马逊新增文案时只加数据不改表；但无法用外键约束保证取值合法性
（本来也保证不了，因为取值来自第三方）。

---

# 二、基础实体（dim_）

## `dim_recommend_column` —— 推荐专栏

用途：推荐专栏主体档案。**动态实体**，新标题随抓取自动新增。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `rec_title` | VARCHAR(128) | **专栏英文标题原文，业务主键**。接口直接以此为参数/key | `recTitle` |
| `country` | VARCHAR(8) | 站点。同一标题可跨站出现，但文案随站点语言变化 | 拦截器 `country` |
| `rec_code` | VARCHAR(16) NULL | 前端短码（`fView`/`KOL`/`4Star`…）。**仅 8 个已知标题有值，其余 NULL** | chunk 硬编码表 `P` |
| `rec_name_cn` | VARCHAR(64) NULL | 中文展示名。**素材未覆盖**（chunk 里 `P` 只有英文，中文 fallback 统一「其它」） | — |
| `bg_color` | VARCHAR(16) NULL | 前端标签底色；未知标题统一 `#C8B2B7` | chunk 函数 `B` |
| `first_seen_at` | DATETIME | 首次抓取到该标题的时间 | 自建 |
| `created_at` / `updated_at` | DATETIME | 记录时间戳 | 自建 |

主键 `(rec_title, country)`。

> ⚠️ `rec_name_cn` 建议留空列不填 —— 原站英文站点（`isEn`）才走短码映射，
> 中文名在素材里没有实际取值（映射函数返回的是短码 `a` 或字面「其它」）。
> 是否补齐中文翻译需产品决策，见 spec 不确定清单 11。

关系：被 `fact_asin_rec_column_snapshot`、`fact_asin_rec_keyword_snapshot`、
`fact_asin_rec_campaign_snapshot` 引用。

## `dim_ad_campaign` —— 广告活动

用途：亚马逊广告 campaign 档案。**新实体，其他域未提出。**

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `campaign_id` | VARCHAR(32) | 亚马逊 campaign ID（实测 20 位，如 `A09505632OVRRRNQVKWIU`） | `campaignId` |
| `country` | VARCHAR(8) | 站点 | 拦截器 |
| `mask_campaign_id` | VARCHAR(8) | 脱敏 ID（实测为末 4 位 `KWIU`），未授权账号只见此值 | `maskCampaignId` |
| `campaign_name` | VARCHAR(255) NULL | 名称。⚠️ **实测恒 null**，需绑定广告账号授权 | `campaignName` |
| `campaign_color` | VARCHAR(16) NULL | 前端标色。⚠️ 实测恒 null | `campaignColor` |
| `campaign_product_type` | VARCHAR(32) NULL | 产品类型。⚠️ 实测恒 null | `campaignProductType` |
| `campaign_type` | VARCHAR(32) NULL | 投放类型（受 `campaignTypeEnable` 权限位控制）。⚠️ 实测恒 null | `campaignType` |
| `created_at` / `updated_at` | DATETIME | | 自建 |

主键 `(campaign_id, country)`。

> ⚠️ 4 个 null 字段的类型按 string 推断（当前账号无广告授权，实测覆盖不到）。
> `campaign_type` 可能有独立枚举（自动/手动），但取值实测不到 —— 不脑补建 dict 表。
> `manualRatio`/`autoRatio` 字段暗示至少有「手动/自动」两类。

关系：`rel_rec_column_campaign_keyword` 的一端。

## 复用现有实体（不新建）

| 实体 | 复用说明 |
|---|---|
| `dim_asin` | 推荐专栏与对比页的 ASIN 主体，字段与 sales/traffic 域一致（`title`/`img`/`price`/`star`/`rating_num`）|
| `dim_keyword` | 关键词主体。⚠️ **本域接口不返回 `keywordId`**，只有 `keyword` + `translateKeyword`，需按 `(keyword, country)` 关联，见裁决问题 |
| `dim_asin_feature` | `compare/bought/multiAsin` 的 `features[{code,feature,value}]` 落此表，比 sales 域的字符串数组更规整（多了 `code` 列）|

---

# 三、时序快照（fact_）

## `fact_asin_rec_column_snapshot` —— ASIN×专栏 日快照

用途：`rec/recView` 的落地表。**核心事实表。**

> **粒度决策**：接口传 `timePieceType=month` 但返回 **`dates` 逐日数组**（31 天），
> 且 `campaignCntTrends`/`keywordCntTrends` 与之等长。按 NAMING.md 的方案 A
> （按粒度拆表），这是**日粒度表**，用 `stat_date`。
> **趋势数组极度稀疏**（31 天里仅 1 天有值）—— 只存非 null 天，不要造 31 行空记录。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `asin` | VARCHAR(16) | ASIN | 请求 `asin` |
| `country` | VARCHAR(8) | 站点 | 拦截器 |
| `rec_title` | VARCHAR(128) | 专栏标题 | `recTitle` |
| `stat_date` | DATE | 统计日（来自 `dates[i]`） | `dates[]` |
| `campaign_cnt` | INT NULL | 当日 campaign 数 | `campaignCntTrends[i]` |
| `keyword_cnt` | INT NULL | 当日关键词数 | `keywordCntTrends[i]` |
| `created_at` | DATETIME | | 自建 |

主键 `(asin, country, rec_title, stat_date)`。

## `fact_asin_rec_column_period` —— ASIN×专栏 月度汇总

用途：`rec/recView` 的行级汇总（非趋势数组部分）+ `rec/trends` 的月度指标。合并存储。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `asin` | VARCHAR(16) | | 请求 |
| `country` | VARCHAR(8) | | 拦截器 |
| `rec_title` | VARCHAR(128) | | `recTitle` |
| `time_piece_type` | VARCHAR(8) | 固定 `month`（week 全站不可用） | 请求 |
| `time_piece_value` | VARCHAR(24) | `YYYY-MM` | 请求 |
| `ratio` | DECIMAL(12,8) NULL | 该专栏占比，0-1 | `ratio` |
| `manual_ratio` | DECIMAL(12,8) NULL | 手动投放占比，0-1 | `manualRatio` |
| `auto_ratio` | DECIMAL(12,8) NULL | 自动投放占比，0-1 | `autoRatio` |
| `campaign_cnt` | INT NULL | campaign 数（月汇总） | `campaignCnt` |
| `keyword_cnt` | INT NULL | 关键词数（月汇总） | `keywordCnt` |
| `last_campaign_cnt` | INT NULL | 末次有值的 campaign 数 | `lastCampaignCnt` |
| `last_keyword_cnt` | INT NULL | 末次有值的关键词数 | `lastKeywordCnt` |
| `score` | DOUBLE NULL | 流量得分（实测 `77.34`） | `trends.score` |
| `score_change_pre` | DOUBLE NULL | 环比得分变化，**可负**（实测 `-77.34`） | `trends.scoreChangePre` |
| `ratio_change_pre` | DECIMAL(12,8) NULL | 环比占比变化 | `trends.ratioChangePre` |
| `change_contri` | DECIMAL(12,8) NULL | 变化贡献度，**可负** | `trends.changeContri` |
| `created_at` | DATETIME | | 自建 |

主键 `(asin, country, rec_title, time_piece_type, time_piece_value)`。

> `trends` 的 `dates` 返回 `2026-03-01` 形态（月初日期）表示 `2026-03`，
> 入库需转成 `time_piece_value = '2026-03'` 统一。

## `fact_asin_rec_keyword_snapshot` —— ASIN×专栏×关键词

用途：`rec/keywordView` + `rec/recView/keywords` 落地。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `asin` | VARCHAR(16) | | 请求 |
| `country` | VARCHAR(8) | | 拦截器 |
| `rec_title` | VARCHAR(128) | 专栏标题 | `recDetail[].recTitle` |
| `keyword` | VARCHAR(255) | 关键词原文 | `keyword` |
| `time_piece_type` | VARCHAR(8) | `month` | 请求 |
| `time_piece_value` | VARCHAR(24) | `YYYY-MM` | 请求 |
| `ratio` | DECIMAL(12,8) NULL | 该词在该专栏内占比，0-1（实测 `0.44100084`） | `ratio` |
| `appear_days` | INT NULL | 出现天数（实测 `1`） | `appearDays` |
| `total_days` | INT NULL | 周期总天数（实测 `31`） | `totalDays` |
| `campaign_cnt` | INT NULL | 关联 campaign 数 | `campaignCnt` |
| `created_at` | DATETIME | | 自建 |

主键 `(asin, country, rec_title, keyword, time_piece_type, time_piece_value)`。

> 行级的 `recCnt`（该词命中几个专栏）是**跨专栏聚合值**，不入本表（可由本表 count 得出）。
> `translateKeyword` 归 `dim_keyword`，不在此重复存。
> ⚠️ `appearDays/totalDays` 是「出现天数/总天数」，**与 `ratio` 不是同一口径**
> （实测 1/31 ≈ 0.032 ≠ ratio 0.441），ratio 是流量占比不是天数占比。

## `fact_asin_rec_campaign_snapshot` —— ASIN×专栏×campaign

用途：`rec/campaignView` + `rec/recView/campaigns` 落地。与上表对偶。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `asin` | VARCHAR(16) | | 请求 |
| `country` | VARCHAR(8) | | 拦截器 |
| `rec_title` | VARCHAR(128) | | `recDetail[].recTitle` |
| `campaign_id` | VARCHAR(32) | campaign ID | `campaignId` |
| `time_piece_type` | VARCHAR(8) | `month` | 请求 |
| `time_piece_value` | VARCHAR(24) | `YYYY-MM` | 请求 |
| `ratio` | DECIMAL(12,8) NULL | 占比 0-1（实测 `0.77098869`） | `ratio` |
| `appear_days` | INT NULL | 出现天数 | `appearDays` |
| `total_days` | INT NULL | 总天数 | `totalDays` |
| `keyword_cnt` | INT NULL | 关联词数 | `keywordCnt` |
| `created_at` | DATETIME | | 自建 |

主键 `(asin, country, rec_title, campaign_id, time_piece_type, time_piece_value)`。

## `fact_keyword_searches_snapshot` —— 关键词搜索量月度序列

用途：`compare/estSearchesNumHistory` 落地。⚠️ **可能与 keywords 域重复，见裁决问题。**

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `keyword` | VARCHAR(255) | 关键词 | 请求 `keywords[]` |
| `country` | VARCHAR(8) | | 拦截器 |
| `time_piece_type` | VARCHAR(8) | `month` | `timeDim` |
| `time_piece_value` | VARCHAR(24) | `YYYY-MM`（实测区间 `2020-07`~`2026-07`，**73 个月**） | `date[]` |
| `est_searches_num` | BIGINT NULL | 预估搜索量（实测 `1691`） | `estSearchesNum[i]` |
| `searches_rank` | BIGINT NULL | 搜索排名，**值越大排名越靠后**（实测 `932704`） | `searchesRank[i]` |
| `searches_num_change_ratio` | DECIMAL(12,8) NULL | 搜索量环比。⚠️ 实测返回空数组，类型按 number 推断 | `searchesNumChangeRatio[i]` |
| `searches_rank_change_ratio` | DECIMAL(12,8) NULL | 排名环比。⚠️ 同上 | `searchesRankChangeRatio[i]` |
| `created_at` | DATETIME | | 自建 |

主键 `(keyword, country, time_piece_type, time_piece_value)`。

> **历史深度不一致的重要记录**：本接口 73 个月（2020-07 起），
> 销量域 `boughtHistoryDates` 只有 40 个月（2023-05 起）。**seed 不能统一长度。**

---

# 四、关系表（rel_）

## `rel_rec_column_campaign_keyword` —— 专栏×campaign×关键词 三元关系

用途：承载 `recDetail[].campaignDetails[]` / `recDetail[].keywordDetails[]` 的嵌套明细。
这是推荐专栏页「三层钻取」的关系底座。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `asin` | VARCHAR(16) | | 请求 |
| `country` | VARCHAR(8) | | 拦截器 |
| `rec_title` | VARCHAR(128) | 专栏 | `recTitle` |
| `campaign_id` | VARCHAR(32) | campaign | `campaignDetails[].campaignId` |
| `keyword` | VARCHAR(255) | 关键词 | `keywordDetails[].keyword` |
| `time_piece_type` | VARCHAR(8) | `month` | 请求 |
| `time_piece_value` | VARCHAR(24) | `YYYY-MM` | 请求 |
| `ratio_by_keyword` | DECIMAL(12,8) NULL | **词视角归一化占比**（实测 `1`，词→campaign 方向） | `keywordView` 路径 `ratio` |
| `ratio_by_campaign` | DECIMAL(12,8) NULL | **campaign 视角归一化占比**（实测 `0.57199392`，campaign→词 方向） | `campaignView` 路径 `ratio` |
| `appear_days` | INT NULL | 出现天数 | `appearDays` |
| `total_days` | INT NULL | 总天数 | `totalDays` |
| `created_at` | DATETIME | | 自建 |

主键 `(asin, country, rec_title, campaign_id, keyword, time_piece_type, time_piece_value)`。

> **关键设计点**：同一「专栏+campaign+词」三元组，从两个入口进来的 `ratio` **值不同**
> （实测 `recView/keywords` 下 `ratio:1` vs `recView/campaigns` 下 `ratio:0.571`），
> 因为各自在不同维度内归一化。**必须存成两列**，不能合成一列。

## 复用 `rel_asin_variant`

`asinMagic` 的 `before[]`→`affter[]` 映射本质是「变体归组」，
与 traffic/sales 域的 `rel_asin_variant` 同源。**不新建表**，
`asinMagic` 是查询期用变体关系算出来的建议，不是新事实。

---

# 五、枚举字典（dict_）

## `dict_festival` —— 节日字典（新增，值得独立）

用途：`estSearchesNumHistory.festivals` 的落地。趋势图打点用。
**与 ASIN/关键词无关，是纯日历维度，跨全站可复用。**

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `code` | VARCHAR(32) | 节日码（自建，如 `mothers_day`、`prime_day`） | 自建 |
| `name_cn` | VARCHAR(64) | **中文节日名**（原站直接下发中文） | `festivals[].name` |
| `start_date` | DATE | 起始日（实测 `2026-05-09`） | `festivals[].startDate` |
| `end_date` | DATE | 结束日（Prime Day 实测跨 4 天 `2026-06-23`~`2026-06-26`） | `festivals[].endDate` |

主键 `(code, start_date)` —— 同一节日每年一条。

实测到的取值（US 站，仅 3 个，样本不足）：

| name_cn | 实测日期 | 说明 |
|---|---|---|
| 母亲节 | 2026-05-09 单日 | |
| 父亲节 | 2026-06-20 单日 | |
| Prime Day会员日 | 2026-06-23 ~ 2026-06-26 | **跨 4 天，唯一实测到的多日节日** |

> ⚠️ 只抽了 1 个关键词的 73 个月序列，`festivals` 大部分月份为 `null`。
> 黑五/网一/圣诞等大促未在样本中出现，但 `rec/trends` 实测到专栏标题
> `Black Friday deals`，说明黑五数据存在。**完整节日清单需更多抽样，当前样本不足。**
> 按 NAMING.md 例外条款，`dict_` 表不带 `country` —— 但节日**明显与站点相关**
> （母亲节各国日期不同），见裁决问题。

## 复用 `dict_time_piece`

`timePieceType` 取值 `month`（✅ 可用）/ `week`（❌ 全站报服务异常）。
本域另有 `timeDim` 参数名（`rec/trends`、`estSearchesNumHistory` 用），
取值同为 `month` —— **同一概念两个参数名**，字典表可复用，接口层需按端点区分参数名。

## 不建议建表的两项

| 候选 | 判断 |
|---|---|
| `dict_recommend_column` | ❌ **废弃**。见第一节裁决，实测 17+ 取值且未收敛 |
| `dict_campaign_type` | ❌ 不建。`campaignType` 实测恒 null（无广告授权），取值不可知，不脑补 |

---

# 六、竞品对比是否需要独立业务表 —— 结论：**不需要新建业务表，但需一个「对比组」系统表**

## 逐字段拆解（实测依据）

`/api/compare/bought/multiAsin` 与 `/api/search/compare/asinSummary` 返回的字段分三类：

### 类 1：完全可从现有表拼出（无需新表）

| 字段 | 归属现有表 |
|---|---|
| `asin`, `title`, `img`, `price`, `star`, `score`, `ratingNum`, `brand` | `dim_asin` |
| `features[{code,feature,value}]` | `dim_asin_feature` |
| `boughtInPastMonth`, `boughtHistory`, `boughtHistoryDates` | sales 域的销量快照表 |
| `isParentAsin`, `pasins`, `vaiantsNum` | `rel_asin_variant` |

### 类 2：查询期计算的「组内相对」标记（**不可持久化**）

| 字段 | 为何不能建表 |
|---|---|
| `ratingNumBest` | `*Best` = 「本次对比组内最优」。换一组对比对象，同一 ASIN 的值就变 |
| `priceBest` | 同上 |
| `scoreBest` | 同上 |
| `boughtInPastMonthBest` | 同上 |

**这是决定性论据**：`*Best` 不是 ASIN 的固有属性，是 `MAX() OVER (对比组)` 的结果。
建表存它会导致「同一 ASIN 在不同对比组里需要不同的行」—— 语义崩坏。
**应在查询层用窗口函数算，不落库。**

### 类 3：`asinMagic` 的归一化建议（不可持久化）

`isChanged` / `before` / `affter` / `beforeNum` / `affterNum` 都是**基于变体关系
+ 关键词计数实时算出的建议**，可由 `rel_asin_variant` + 关键词计数推导。不落库。

## 明确结论

1. **无「对比得分」「差异度」类独有业务指标** —— 实测响应里没有这类字段。
   对比页的全部业务数据都是**把已有的单 ASIN 指标横向并列**，
   唯一的「对比专属」产出就是 `*Best` 标记，而它是查询期计算。
2. **不需要 `fact_asin_compare_*` 业务表。** 复用 `dim_asin` + `dim_asin_feature`
   + sales 域销量表 + traffic 域流量表即可。
3. **但需要一个系统表存「用户保存的对比组」** —— 对比页要支持用户保存/复用一组 ASIN。
   按 NAMING.md，用户自建数据属系统表（无前缀）：

### `asin_compare_groups`（系统表，无前缀）

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `id` | BIGINT | 主键 | 自建 |
| `user_id` | BIGINT | 归属用户 | 自建 |
| `country` | VARCHAR(8) | 站点 | 拦截器 |
| `name` | VARCHAR(128) | 组名 | 自建 |
| `asins` | VARCHAR(255) | ASIN 列表，**最多 10 个**（实测服务端硬校验，11 报参数错误） | 请求 `asins[]` |
| `created_at` / `updated_at` | DATETIME | | 自建 |

> ⚠️ 「保存对比组」功能本身**素材未覆盖** —— 我未在实测端点里找到
> 保存/读取对比组的接口（`compareMyKeywords` 疑似相关但 `服务异常` 打不通）。
> 此表是**基于「对比页需要重复使用同一组 ASIN」的推断**，非实测。**需主 Agent 裁决是否要。**

---

# 七、待主 Agent 裁决的问题

1. **`dim_recommend_column` vs `dict_recommend_column`** —— 我给出明确结论：
   **动态实体（`dim_`）**，`dict_` 应废弃。证据见第一节（4 条实测证据）。
   NAMING.md 第 30-34 行的待裁决项可据此关闭。
2. **`dim_keyword` 关联键** —— 本域接口（`keywordView`/`recView/keywords`）
   **不返回 `keywordId`**，只有 `keyword` + `translateKeyword`。
   NAMING.md 已裁定 `dim_keyword` 主键为 `(keyword_id)`，本域无法用。
   建议给 `dim_keyword` 加 `(keyword, country)` 唯一索引作备用关联键。
3. **`dict_festival` 是否需要 `country`** —— NAMING.md 规定 `dict_` 不带 `country`，
   但节日明显与站点相关（母亲节各国日期不同）。建议此表**破例带 `country`**，
   或主键改 `(code, country, start_date)`。
4. **`fact_keyword_searches_snapshot` 是否与 keywords 域重复** ——
   `estSearchesNumHistory` 的 `estSearchesNum`/`searchesRank` 看着就是 keywords 域
   的核心指标。若已有表，本域直接复用，不新建。
5. **`asin_compare_groups` 系统表要不要** —— 见上，属推断非实测。
6. **`/api/compare/*` 6 端点全线 `服务异常`，是否仍复刻** ——
   直接影响 `/compare-sales` `/compare-traffic` `/compare-structure` 三个路由。
   若不复刻，这三页无数据来源。
7. **`/compete` 页面契约不完整** —— `competePattern`/`competeAsinAssay` 参数未破解
   （只返回笼统 `参数错误`，不列缺失字段）。是否需要用浏览器实际访问 `/compete` 页面
   抓取真实请求体来补全？（本次未做，因页面路由可能需要额外权限）
8. **`*Best` 字段的查询层实现** —— 我判定不落库、用窗口函数算。
   若主 Agent 决定落库（如为了查询性能），需为「对比组」建维度，代价较大。
9. **推荐专栏的混合粒度** —— 请求传 `month` 但返回逐日 `dates`。
   我按 NAMING.md 方案 A 拆成 `fact_asin_rec_column_snapshot`（日）
   + `fact_asin_rec_column_period`（月）两表。若主 Agent 选方案 B 需合表。
10. **专栏中文名是否补齐** —— 实测 17+ 标题只有 8 个有前端短码，**均无中文名**
    （原站 fallback 显示「其它」）。复刻是否自建翻译？属产品决策。

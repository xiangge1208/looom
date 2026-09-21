# 爬虫数据 → Doris 业务表 ETL 缺口分析

> **目标**：把 `data-collection` 爬虫落在 PG（`120.76.216.136:15432/amazon_data`）的数据，ETL 灌进 `looom` 的 Doris 业务表（见 [docs/ER_BUSINESS.md](ER_BUSINESS.md) 43 张表）。
> **本文档是 ETL 开发依据**：逐表逐字段标注「有数据 / 缺数据 / 需推导」，并给出缺口的具体成因与补数方案。
>
> **核查方法**：所有结论均来自生产库实测（字段填充率 `count(col)/count(*)`、JSON 路径递归展开、跨表 JOIN 命中率），不是读代码推测。JSON 字段一律展开到叶子节点核对。
> **数据快照时间**：2026-09-18。PG 数据覆盖 2023-01-01 ~ 2026-09-18。

---

## ⚠️ 命名约定（先读，否则会把 endpoint 当成表名）

文档里两类东西都用等宽字体，但含义完全不同：

| 写法 | 是什么 | 数量 |
|---|---|---|
| **`sif_` 前缀**（`sif_asin_meta`、`sif_asin_keyword` …） | **PG 真实表** | 9 张已结构化表 + 3 张运维表 |
| **含连字符 `-`**（`web-sales-keyword`、`asin-keyword-list` …） | **不是表**，是 `sif_api_log.endpoint` 列的**取值** | 41 个 |

PG 里**只有 `sif_api_log` 一张表存原始响应**，41 个接口的数据全在这张表里，靠 `endpoint` 列区分。
所以「源 = `web-sales-keyword` → `data.asins[].brand`」的实际 SQL 是：

```sql
SELECT l.site AS country, el->>'asin' AS asin, el->>'brand' AS brand
FROM sif_api_log l
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(l.resp->'data'->'asins') = 'array'
       THEN l.resp->'data'->'asins' ELSE '[]'::jsonb END) el
WHERE l.endpoint = 'web-sales-keyword'   -- ← 筛选条件，不是表名
  AND l.ok;
```

`jsonb_typeof` 守卫必须保留，否则遇到非数组行会报 `cannot extract elements from a scalar`。

---

## 0. 结论摘要

| 维度 | 数量 | 说明 |
|---|---|---|
| Doris 业务表总数 | 43 | dim_ 8 / fact_ 18 / rel_ 6 / dict_ 11 |
| **可直接 ETL（≥80% 字段有数据）** | **9** | 见 §2 绿灯表 |
| **可部分 ETL（有主干、缺关键列）** | **10** | 见 §3 黄灯表 |
| **完全无数据源** | **13** | 见 §4 红灯表 |
| 字典表（需人工初始化，非 ETL） | 11 | 见 §5 |

PG 侧数据资产：
- `sif_*` 共 **9 张结构化表**（另有 3 张运维表），由 11 个 endpoint 解析而来
- `sif_api_log` **55,516 条原始响应**，覆盖 **41 个 endpoint**——**其中 31 个 endpoint 的响应从未被结构化解析**，是最大的一块待挖增量
- `amazon` 域另有 `products` / `variation_items` 等表，能补 `sif_*` 的部分空洞（见 §6）

### 三个必须先决策的阻断项

按影响面排序，这三项不定，ETL 无法动工：

1. **`keyword_id` 只覆盖 14.9%**，而 Doris 所有关键词表都拿它当主键 → §1.1
2. **`keyword_id` 跨站点不唯一**，与 `dim_keyword` 主键设计（不带 country）冲突，已抓到实证反例 → §1.2
3. **销量分档串丢失**，`fact_asin_bought_monthly.bought_label` 无源 → §1.3

---

## 1. 阻断项详述

### 1.1 `keyword_id` 覆盖率仅 14.9%（最高优先级）

Doris 的 `dim_keyword`、`fact_asin_keyword_snapshot`、`fact_keyword_metric_snapshot` 等 **9 张表**都用 `keyword_id BIGINT` 作主键。但 PG 侧只有 `sif_asin_keyword` 一张表带 `keyword_id`，其余关键词表**只有 keyword 文本**。

用 `sif_asin_keyword` 做 keyword→id 字典去反查，实测命中率：

| PG 表 | distinct keyword | 能匹配到 ID | 命中率 | 缺 ID 词数 |
|---|---:|---:|---:|---:|
| `sif_keyword_overview` | 20,770 | 3,095 | **14.9%** | 17,675 |
| `sif_keyword_aba_trend` | 3,775 | 1,730 | 45.8% | 2,045 |
| `sif_asin_keyword_diagnose` | 88,210 | 2,933 | **3.3%** | 85,277 |
| `sif_asin_traffic_change` | 7,872 | 735 | 9.3% | 7,137 |

> `sif_asin_keyword` 自身 17,527 行 **100% 有 keyword_id**（distinct 12,054 个），它是唯一的 ID 来源。

**三个可选方案**（需用户裁决）：

| 方案 | 做法 | 代价 |
|---|---|---|
| A. 改 Doris 主键（推荐） | 关键词表主键改为 `(keyword_text, country)`，`keyword_id` 降级为普通列 | 要改 schema + ER 图；但与数据现状一致，且天然解决 §1.2 |
| B. 补抓 | 对缺 ID 的词调 `web-keywords-basic-info` / `asin-keyword-list` 补 ID | 8.5 万词 × 1.2s 限速 ≈ **28 小时**，且不保证都能拿到 |
| C. 自建代理 ID | ETL 层对 `(keyword, country)` 生成 hash 代理键填 `keyword_id` | 与原站 ID 割裂，日后接原站数据会冲突 |

### 1.2 `keyword_id` 跨站点不唯一（ER 文档假设不成立）

`dim_keyword` 的注释写着「实测 keywordId 全局唯一（US/UK/DE 三站 ID 段不重叠），故主键不带 country」。**这个假设在当前数据下不成立**：

实测各站点 ID 段**大面积重叠**：

| site | ID 最小值 | ID 最大值 | distinct ID |
|---|---:|---:|---:|
| US | 161 | 19,163,538 | 11,650 |
| DE | 3,645 | 6,823,750 | 338 |
| UK | 2,627 | 2,647,554 | 24 |
| FR | 36,190 | 1,136,593 | 32 |

并抓到**确凿反例**：`keyword_id = 1120764` 同时存在于两个站点，是两个完全不同的词——

- FR：`pastille lave glace`（玻璃水泡腾片）
- US：`halloween trays for food`

按现有 `dim_keyword` 主键 `UNIQUE KEY(keyword_id)` 灌数，这两条会**互相覆盖，丢数据**。

> 补充：同一站点内还存在**一词两 ID**（`christmas tree toppers` → 3846971 / 14844774；`teacher valentine gifts` → 635708 / 14844099），说明上游 ID 本身也不稳定，可能有新旧两套。

**建议**：`dim_keyword` 主键改为 `(keyword_id, country)`，或直接采纳 §1.1 方案 A 用文本做键。

### 1.3 销量分档串丢失，`bought_label` 无源

`fact_asin_bought_monthly` 设计了双列并存：
- `bought_lower_bound BIGINT` — 分档下界，用于排序计算
- `bought_label VARCHAR(16)` — 原始分档串（`"200+"` / `"<50"`），用于展示

但 PG 的 `sif_asin_sales_monthly.bought_num` 是 **integer 列**。实测上游 `boughtHistory[]` 数组元素类型就是 `number`/`null`，**历史月份本来就只给整数**，分档串 `"200+"`/`"<50"` 只在「当月」字段里出现（`boughtInPastMonth`，实测取值 `'800+' '50+' '200+' '<50' '6,000+' ...`）。

**结论**：`bought_label` 对**历史月份不可还原**，只有最新一个月能填。

**建议**：ETL 时 `bought_lower_bound = bought_num` 直填；`bought_label` 历史月留 NULL，仅当月从 `sif_asin_meta.bought_past_month` 回填——注意该列实测存的是 `'4000'`/`'60000'` 这类**纯数字串**（已被清洗过），与 `'<50'` 格式不同，需确认展示层能否接受。

---

## 2. 绿灯：可直接 ETL（9 张）

| Doris 表 | PG 数据源 | PG 行数 | 字段覆盖 | 备注 |
|---|---|---:|---|---|
| `fact_asin_traffic_channel` | `sif_asin_traffic_daily` | 1,449,263 | 高 | 需宽表转长表，见 §2.1 |
| `fact_asin_listing_snapshot` | `sif_asin_traffic_daily` | 同上 | 高 | price/star/review/bsr 直取 |
| `fact_asin_subbsr_snapshot` | `sif_asin_traffic_daily.sub_bsr` | 1,285,876 非空 | 完整 | JSONB `{类目:排名}` 拆行 |
| `fact_asin_bought_monthly` | `sif_asin_sales_monthly` | 768,319 | 缺 `bought_label` | 见 §1.3 |
| `fact_keyword_search_trend` | `sif_keyword_aba_trend` | 121,957 | 高 | 缺 `is_prev_period`，见下 |
| `fact_keyword_metric_snapshot` | `sif_keyword_overview` + `aba_trend` | 20,781 | 中高 | 缺 `cpc_bid`、`click_purchase_ratio` |
| `dim_asin` | `sif_asin_meta` + `products` | 6,497 | **中**（多列 0%） | 见 §3.1，靠 amazon 域补 |
| `dim_asin_feature` | `sif_asin_sales_monthly.features` | 623,725 非空 | 完整 | 见 §2.2，比 ER 文档描述的简单 |
| `dim_keyword` | `sif_asin_keyword` | 12,054 ID | 受 §1.1/§1.2 阻断 | 主键待裁决 |

### 2.1 渠道宽表 → 长表映射

`sif_asin_traffic_daily` 是 7 列宽表，Doris `fact_asin_traffic_channel` 是长表（channel 进主键）。映射关系：

| PG 列 | → Doris `channel` 值 | 非空行数 | 占比 |
|---|---|---:|---:|
| `total_score` | `total` | 977,912 | 67.1% |
| `nf_score` | `nf` | 948,295 | 65.1% |
| `ad_score` | `ad` | 591,773 | 40.6% |
| `sp_score` | `sp` | 463,843 | 31.8% |
| `rec_sp_score` | **`spRec`** | — | — |
| `sb_score` | `sb` | — | — |
| `sbv_score` | `sbv` | — | — |

> ⚠️ **渠道名归一**：PG 列名是 `rec_sp_score`，上游 JSON key 是 `recSpScore`，而 Doris `dict_traffic_channel` 的规范值是 **`spRec`**。ETL 必须做这一步映射，否则渠道对不上。
> ⚠️ Doris 定义了 9 个渠道（`total/nf/ad/allSp/sp/spRec/allSb/sb/sbv`），PG 只有 7 个——**`allSp` / `allSb` 两个聚合渠道无数据**，需 ETL 层自行汇总或留空。

**粒度差异**：PG 是**日粒度**（`stat_date`），Doris `fact_asin_traffic_channel` 主键是 `time_piece_type + time_piece_value`（month/week）。ETL 需聚合，且要确认聚合口径（sum 还是 avg）——得分类指标通常不能简单相加，建议**先落 `time_piece_type='day'`** 保真，月/周汇总另建。

### 2.2 变体属性：比 ER 文档描述的简单

ER 文档 `dim_asin_feature` 注释写着「父体 features 是维度名 `["Size","Color"]`，子体是对应下标取值，入库需按下标 zip 对齐」。

**实测 PG 数据已经是 zip 好的结构**，无需下标对齐：

```json
[{"code": "Size",  "value": "Set of 2", "feature": "Size",  "boughtInPastMonthBest": null},
 {"code": "Color", "value": "Black",    "feature": "Color", "boughtInPastMonthBest": null}]
```

直接 `feature_name ← code`、`feature_value ← value` 即可。623,725 行非空，覆盖充分。

---

## 3. 黄灯：可部分 ETL（10 张）

### 3.1 `dim_asin` — 6 个字段全库 0%

实测 `sif_asin_meta`（6,497 行）与上游原始响应的填充率：

| Doris 列 | PG 列 | 填充率 | 判定 |
|---|---|---:|---|
| `title` | `title` | 93.9% | ✅ |
| `img` | `img` | 93.9% | ✅ |
| `price` | `price` | 93.9% | ✅ |
| `score` | `score` | 89.2% | ✅ |
| `star` | `star` | 89.2% | ✅ |
| `rating_num` | `rating_num` | 89.2% | ✅ |
| **`brand`** | `brand`（恒空） | 0.0% | 🟡 **改判**：`web-sales-keyword` 有，41.0% |
| **`brand_href`** | — | 0.0% | 🟡 **改判**：同上 `.brandHref`，40.6% |
| **`first_available_day`** | — | 0.0% | 🟡 **改判**：同上 `.firstAvailableDay`，40.8% |
| **`seller`** | — | — | 🟡 **改判**：`sif_asin_traffic_daily.buybox_seller`，86.2% |
| **`is_best_seller`** | `is_best_seller`（恒空） | 0.0% | 🟡 **改判**：`web-asin-variants.data.variants[].isBestSeller` 非空 86.0% |
| **`is_parent_asin`** | — | — | ⚠️ `web-sales-asin.data.isParentAsin`，639 条响应仅 4 条 true |
| **`parent_asin`** | — | — | ⚙️ 由 `rel_asin_variant` 反查，见 §3.2 |
| `data_updated_at` | `updated_at` | 100% | 🟡 语义不同；真值取 `web-sales-keyword.snapshotUpdateTime`（41.1%） |

> ⚠️ **本节结论已于 2026-09-20 两轮复核修正**。原判断「这不是解析遗漏，是上游真不给」**已全部不成立**——
> 深挖 JSON 后，`brand`/`brand_href`/`first_available_day`/`seller`/`is_best_seller` **五列都找到了源**，
> 无一是真正的「上游不给」。根因是原判断只查了 2 个接口，且用单条抽样。
>
> 原结论的取证范围有误：只查了 `web-sales-asin`（8,620 条）与 `asin-basic-info`（5,597 条）两个接口，
> 这两个接口确实全 0。但**漏查了 `web-sales-keyword`**——它的 `data.asins[]` 有 **48,975 行**，实测：
>
> | 字段 | 填充率 | 样例 |
> |---|---|---|
> | `brand` | **41.0%**（14,768 distinct ASIN） | `10 Strawberry Street`、`1OAK`、`1step2dream` |
> | `brandHref` | 40.6% | `https://www.amazon.com/stores/10StrawberryStreet/page/...` |
> | `firstAvailableDay` | 40.8% | `1999-11-07`、`2000-05-15`（已是标准日期格式） |
> | `snapshotUpdateTime` | 41.1% | — |
>
> 都是真实值，不是占位符。**`web-sales-keyword` 是 31 个未解析 endpoint 里信息量最大的一个**，应提到 P0。

**补数方案**（两条路可叠加）：
1. **解析 `web-sales-keyword`**（推荐）：能覆盖 14,768 个 ASIN 的 brand。但与 `sif_asin_meta` 交集仅 302 个——它的价值是**扩充 ASIN 池**，而非补全现有 ASIN。
2. `amazon` 域 `products` 表：`brand` 填充 96.3%，与 `sif_asin_meta` 交集 1,386 个（21.3%）。用于补全现有 ASIN 更有效。详见 §6。

### 3.2 `rel_asin_variant` — 父子关系有源但需拼装

| 数据源 | 可用性 |
|---|---|
| `web-asin-variants` 响应 | 379 条 ok，`variants[]` 共 **11,941 行**非空 asin（distinct 10,182）——**但只有子体列表，父体 ASIN 要从请求参数 `params.asin` 取** |
| `sif_asin_sales_monthly.variant_key` | 19,087 个 distinct，是变体值串（`Black`/`White`），**不含父子指向** |
| `amazon.variation_items` | 27,110 行，**有完整 `parent_asin` + `asin` 对**，但与 sif 侧交集仅 481 个 ASIN |

Doris `rel_asin_variant` 需要 `parent_asin + child_asin + display_order + ratio`：
- `display_order` ← `variants[].order` ✅
- `ratio` ← `variants[].ratio` ✅
- `parent_asin` ← **必须从 `sif_api_log.params->>'asin'` 反查**，这是 ETL 要特别处理的点

### 3.3 其余黄灯表

| Doris 表 | PG 源 | 有什么 | 缺什么 |
|---|---|---|---|
| `fact_asin_keyword_snapshot` | `sif_asin_keyword` (17,489) | score/ratio/nf_rank/sp_rank/exposure_positions/sp_campaign_id(33%) | `keyword_id` 仅部分；**无 `time_piece_*`**（PG 是当前快照无周期列，见下）；`is_core`/`is_target` 缺；`est_searches_num` 缺 |
| `fact_asin_keyword_score` | `sif_asin_keyword.scoreInfo` | 总分 score/scoreRatio | **分渠道 9 个 `*ScoreInfo` 未解析**，`sif_api_log.resp` 里可能有，需展开 `raw` 列 |
| `fact_keyword_rank_history` | `sif_api_log` (`web-asin-core/head-keywords`) | `allRankHistory.{date,nfRank,spRank,sbRank,sbvRank,recRanks}` 逐日数组 | **未结构化**，需从 raw JSON 打平；`page_no` 需从 `rankStr`（`"p1,12/12"`）解析 |
| `fact_asin_keyword_overview` | `sif_api_log` (`web-asin-keyword-overview`, 422 ok) | 9 个渠道 × `{total,prev,in,out}` 完整 | **未结构化**；Doris 只有 `keyword_cnt` 一列，装不下 `in/out/prev` 三个维度 |
| `fact_asin_op_event` | `sif_asin_traffic_daily` | `title_img`(15,214)、`campaign_id`(22,192)、价格列 | 需**自行做变化点 diff**——PG 存的是逐日快照，不是事件；`event_type`/`event_detail` 要 ETL 层算 |
| `fact_asin_multinf_daily` | `sif_api_log` (`web-asin-day-trend`, 26 ok) | dates/asinCntList/keywordCntList/extraScoreList/listingAsinCnt | **样本极少（26 条）**，几乎等于没有 |
| `fact_asin_keyword_inout` | `sif_asin_traffic_change` (kind=nf_in/nf_out) | 8,608 行（in 5,221 / out 3,387） | `change_type` 可由 `kind` 映射 ✅；缺 `keyword_id` |
| `dim_recommend_column` | `sif_api_log.changeReasons[].recTitle` | **18 个 distinct 专栏名**（见 §7） | 未结构化；`short_code`/`display_name_cn` 需人工映射 |

> **`fact_asin_keyword_snapshot` 的周期列问题**：PG `sif_asin_keyword` 主键是 `(site, asin, keyword)`，**没有时间列**，每次抓取覆盖旧值——它是「当前快照」而非时序表。而 Doris 主键含 `time_piece_type + time_piece_value`。ETL 只能用 `fetched_at` 折算一个周期值灌进去，**历史周期不可回溯**。

---

## 4. 红灯：完全无数据源（13 张）

### 4.1 广告域 4 张表 —— 数据量严重不足

| Doris 表 | 状态 |
|---|---|
| `dim_ad_campaign` | ⚠️ 仅有 ID，无任何属性 |
| `dim_ad_product_ad` | ⚠️ 仅有 ID |
| `rel_ad_campaign_product_ad` | ⚠️ 极少 |
| `fact_ad_search_term_exposure` | ❌ 无 |

实测能拿到的广告 ID：

| 来源 | distinct campaignId | distinct adId |
|---|---:|---:|
| `web-variant-ad-keywords`（13 条 ok 响应，1,106 个 keyword 行） | 40 | 82 |
| `sif_asin_keyword.sp_campaign_id`（33.2% 填充） | 3,478 | — |
| `sif_asin_traffic_daily.campaign_id`（1.53% 填充） | 34 | — |
| `core/head-keywords` 的 `allRankHistory.spRank[].campaignId` | **239** | — |

**关键缺失**：
- `dim_ad_campaign` 需要 `ad_type` / `strategy` / `asin_num` / `ad_num` / `campaign_created_at` 等属性——**全部无源**。只有 `web-variant-ad-keywords` 一个接口带广告结构，而它 **110 次调用只成功 13 次（成功率 11.8%）**
- `fake_campaign_id`（前台 4 位短码）✅ **有源**：`spRank[].maskCampaignId`，实测形如 `LGL8`、`5J1D`、`SNP7`
- `fact_ad_search_term_exposure` 需要 `encrypt_ad_id + keyword_id + variant_asin + stat_date` 四元组——现有数据凑不齐

> **广告域基本等于空白**，要做必须先大幅提升 `web-variant-ad-keywords` 的成功率（当前 88% 失败）。

### 4.2 其余红灯表

| Doris 表 | 缺失原因 |
|---|---|
| `dim_word` | 词频接口从未成功抓取，全库仅 13 条响应含 `etyma` 字样 |
| `fact_word_frequency` | 同上。`scope_type=keyword_group` 分支完全无源 |
| `fact_asin_rec_column_period` | 有 18 个专栏名（§7），但**无逐日 `ratio`/`campaign_cnt`/`keyword_cnt` 数据** |
| `rel_rec_column_campaign_keyword` | 三层钻取关系无源 |
| `fact_asin_multinf_keyword` | 多变体区间聚合无源 |
| `fact_asin_multinf_keyword_variant` | 变体级排名明细无源 |
| `rel_asin_keyword_variant_exposure` | 同上 |
| `rel_keyword_group` | sif 域无词库分组。⚠️ `amazon.keyword_items`（112,035 行 / 6,049 seed）**可作替代源**，但语义是「种子词扩展」不是「用户词库」 |
| `rel_keyword_top_asin` | 无源。`keyword-overview` 只给统计数不给 ASIN 列表 |
| `dim_supplier` | `cbu_offer` **仅 4 行**、`cbu_supplier` 72 行。本期设计上就是占位，不阻塞 |

---

## 5. 字典表（11 张）——人工初始化，非 ETL

`dict_*` 全部是枚举字典，**不从爬虫数据 ETL**，应由人工/脚本一次性初始化：

| 字典表 | 取值来源 | 可从数据反推？ |
|---|---|---|
| `dict_traffic_channel` | 9 个渠道码 | ✅ 但 PG 只有 7 个（缺 `allSp`/`allSb`） |
| `dict_time_piece` | day/week/month | ✅ 实测 `aba_trend` 有 week/month |
| `dict_ad_type` | 1=SP 2=SB 3=SBV 4=SBBV | ❌ 硬编码 |
| `dict_op_event_type` | titleImg/campaignId/价格活动 | ⚠️ 需先实现 §3.3 的事件 diff |
| `dict_bought_bucket` | `<50`/`50+`/`200+`/... | ✅ 可从 `boughtInPastMonth` 枚举 |
| `dict_variant_role` / `dict_dimension` / `dict_keyword_tag` / `dict_match_type` / `dict_sort_field` | — | ❌ 硬编码 |

> ⚠️ 实测 `sif_asin_keyword_diagnose.granularity` 存在**脏值**：除 `month`(191,777) / `day`(8,569) 外，还有 `day30`(5) 和 **`latelyDa`(5)**——后者明显是 `latelyDay` 被 `varchar(8)` 截断。ETL 时需过滤或修正，别把脏值带进 Doris。

---

## 6. 跨域补数：`amazon` 表能补什么

`amazon_data` 库里除 `sif_*` 外还有一套 amazon 直采表，可补 sif 域空洞：

| Doris 缺口 | amazon 表 | 填充率 | 与 sif 的 ASIN 交集 | 可补比例 |
|---|---|---:|---:|---|
| `dim_asin.brand` | `products.brand` | 96.3% | 1,386 / 6,499 | **21.3%** |
| `dim_asin` 类目 | `products.bsr_category` | 87.4% | 同上 | 21.3% |
| `dim_asin` BSR | `products.bsr_rank` | 87.4% | 同上 | 21.3% |
| `rel_asin_variant` | `variation_items`（27,110 行，1,187 父体） | 完整 | 481 ASIN | **7.4%** |
| `dim_asin_feature` | `variation_items.dimension_values` | 完整 | 481 | 7.4% |
| `rel_keyword_group` | `keyword_items`（112,035 行） | 完整 | 语义不同 | 需确认 |
| BSR 榜单 | `ranklist_items`（12,657 行 / 222 节点） | 完整 | 未核 | — |

> **交集率偏低是主要限制**——两套爬虫抓的 ASIN 池重合度只有 7%~21%，补数覆盖面有限。若要提高，需让 amazon 爬虫按 sif 的 ASIN 清单补抓。

---

## 7. 已探明的 18 个推荐专栏

从 `changeReasons[].recTitle` 提取（`web-asin-core-keywords` / `web-asin-head-keywords`），可直接初始化 `dim_recommend_column.rec_title`：

```
4 stars and above        Picks from Amazon Influencers
Browse Portable Solutions       Recently bought and rated
Customers frequently viewed            Seen on social media
Explore Facial Care Essentials         Shop Party Beauty Essentials
Explore Sleeveless Styles       Shop sweater tank tops by style
Find Wedding Home Goods         Today's deals
Inspired by similar searches    Today's deals from Amazon Devices
New arrivals      Trending now
Other items to consider         Trending styles
```

> 印证了 ER 文档「前端硬编码 8 个短码但实测 17 个标题且未收敛」的判断——现在是 **18 个**，确实在增长，`dim_recommend_column` 按动态实体 upsert 的设计是对的。

---

## 8. 31 个未结构化 endpoint（最大增量池）

这些 endpoint 的响应**只躺在 `sif_api_log.resp` 里**，从未解析入表。按对 Doris 的价值排序：

| 优先级 | endpoint | ok 数 | 可填充的 Doris 表 |
|---|---|---:|---|
| **P0** | `web-asin-keyword-overview` | 422 | `fact_asin_keyword_overview`（9 渠道计数完整） |
| **P0** | `web-asin-core-keywords` | 270 | `fact_keyword_rank_history`、`dim_recommend_column`、广告 ID |
| **P0** | `web-asin-head-keywords` | 235 | 同上 |
| **P0** | `web-asin-variants` | 379 | `rel_asin_variant`（11,941 行变体） |
| P1 | `listing-summary` | 358 | `fact_asin_keyword_overview` 补充 |
| P1 | `web-asin-flow-overview` | 88 | 渠道占比（overview/ad 嵌套） |
| P1 | `asin-bs-exposure` | 63 | 销量历史 + 关键词数分渠道 |
| P1 | `web-variant-ad-keywords` | 13 | **广告域唯一源**，但成功率仅 11.8% |
| P2 | `web-asin-day-trend` | 26 | `fact_asin_multinf_daily` |
| P2 | `web-keyword-extend` | 473 | 词扩展（Doris 无对应表） |
| P2 | `web-compete-keyword` | 361 | 竞品分析（Doris 无对应表） |
| P2 | `web-keyword-conversion` | 449 | 转化漏斗（Doris 无对应表） |
| P2 | `web-est-searches-history` | 382 | `fact_keyword_search_trend` 补充 |
| P3 | 其余 18 个 | — | 无对应 Doris 表或价值低 |

---

## 9. 建议的 ETL 实施顺序

**第 0 步（阻断，必须先做）**：裁决 §1.1 `keyword_id` 主键方案、§1.2 跨站点唯一性、§1.3 `bought_label` 取舍。这三项定不下来，关键词域 9 张表全部无法动工。

**第 1 批（绿灯，可立即开工）**
1. `dim_asin` ← `sif_asin_meta`（接受 brand 等 6 列为空）
2. `dim_asin_feature` ← `sif_asin_sales_monthly.features`
3. `fact_asin_bought_monthly` ← `sif_asin_sales_monthly`
4. `fact_asin_traffic_channel` ← `sif_asin_traffic_daily` 宽转长（注意 `recSp→spRec` 归一）
5. `fact_asin_listing_snapshot` / `fact_asin_subbsr_snapshot` ← 同表

**第 2 批（解析 raw JSON，P0 四个 endpoint）**
6. `rel_asin_variant` ← `sif_api_log`[ep=`web-asin-variants`]（父体从 `params->>'asin'` 取）
7. `fact_asin_keyword_overview` ← `sif_api_log`[ep=`web-asin-keyword-overview`]
8. `fact_keyword_rank_history` ← `core/head-keywords` 的 `allRankHistory`
9. `dim_recommend_column` ← 18 个 recTitle（§7）

**第 3 批（需补抓或加工）**
10. 关键词域各表（待 §1 裁决）
11. `fact_asin_op_event`（需实现变化点 diff）
12. 广告域 4 张表（需先修复 `web-variant-ad-keywords` 成功率）

**暂不做**：`dim_supplier`、词频 2 张表、多变体 3 张表——无数据源，建 空表即可。

---

## 附录：核查口径

- 填充率 = `count(col) / count(*)`，JSON 字段用 `jsonb_array_elements` + `LATERAL` 展开到叶子后统计
- JSON 结构用递归 CTE 遍历到 depth=6，取最近一条 ok 响应为样本，再用全量 count 复核关键字段
- 跨表可补性用 `JOIN ... ON asin` 实测交集，不按理论假设
- 所有「0%」结论均基于 ≥5,000 条样本，排除抽样偶然

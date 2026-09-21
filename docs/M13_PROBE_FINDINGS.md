# M13 探源实测结论（2026-09-21）

> 执行 `ROADMAP_UNBUILT_MODULES.md §5` 流程第 1 步的产出。
> 方法：`python scripts/sif_schema_probe.py --endpoint <ep> --limit 200`，各采样 200 条响应。
> **本文档的字段名和填充率是建表依据，优先于 ETL_GAP_ANALYSIS.md 里的采样结论。**

---

## 0. 三项计划外发现（改变 M13 的就绪度判定）

计划里把「查关键词竞价」标为 🔴 纯 seed（理由：原站 `/api/search/cpc/*` 10 个接口全未爬）。
实测发现 **`web-keyword-conversion` 这一个 endpoint 里就带着竞价所需的核心数据**：

| 发现 | 内容 | 填充率 | 影响 |
|---|---|---|---|
| **ACOS 分档预估** | 6 种投放类型 × start/median/end | 91~92% | 「查关键词竞价」🔴 → 🟢 |
| **CPA 分档预估** | 同上，6 × 3 | 91~92% | 同上 |
| `topAsins[]` | 每词 8~10 个头部 ASIN（asin/title/img/price） | 100% | 竞争格局页可显示实际占位商品 |
| `asinsClickPurchaseRatio[]` | 分 ASIN 的点击转化率（0~3 个） | 100% | 转化率页可下钻到 ASIN |

6 种投放类型的键名：`autoForSales_broad` / `autoForSales_phrase` / `autoForSales_exact` /
`legacyForSales_broad` / `legacyForSales_phrase` / `legacyForSales_exact`
（`auto` = 自动投放，`legacy` = 手动投放；`broad/phrase/exact` = 广泛/词组/精准匹配）

⚠️ `profitRate` 的 6 个键**全部是空数组**（len 0~0），无数据。
⚠️ 每档的 `categoryName` / `categoryid` **100% 为 NULL**，所以分档不区分类目。

---

## 1. `web-compete-keyword` —— 流量位竞品数量 + 竞争格局

采样 200 条 → 65 字段，`data.keywords[]` 508 个元素。

### 竞品数量列（8 个 `*AsinNum`）

| 字段 | 类型 | 填充率 | 值域 | 建列？ |
|---|---|---|---|---|
| `nfAsinNum` | int | **100%** | 47 ~ 440 | ✅ 自然位竞品数 |
| `ppcAsinNum` | int | **100%** | 16 ~ 365 | ✅ 广告位竞品数 |
| `spAsinNum` | int | **100%** | 0 ~ 179 | ✅ SP 竞品数 |
| `spRecommendedAsinNum` | int | **100%** | 0 ~ 270 | ✅ SP 推荐位竞品数 |
| `recommendedAsinNum` | int | **100%** | 0 ~ 145 | ✅ 推荐位竞品数 |
| `brandAsinNum` | int | **100%** | 0 ~ 179 | ✅ 品牌位竞品数 |
| `acAsinNum` | int | 100% | **恒 0** | ⚠️ 建但标注无区分度 |
| `erAsinNum` | null | **0%** | — | ❌ 不建 |
| `trAsinNum` | null | **0%** | — | ❌ 不建 |

**结论**：计划里写「给 `fact_keyword_metric_snapshot` 加 9 列」，实际应加 **7 列**
（6 个有效 + `acAsinNum` 保留观察），`erAsinNum`/`trAsinNum` 不建。

### 其他可用列

| 字段 | 填充率 | 值域 | 说明 |
|---|---|---|---|
| `keyword` | 100% | — | 主键 |
| `saleNum` | 100% | 0 ~ 424,204 | 关键词带来的总销量 |
| `estSearchesNum` | 79.7% | 126 ~ 749,533 | 预估搜索量 |
| `searchesRank` | 79.7% | 229 ~ 2,638,677 | 搜索量排名 |
| `clickShared` | 81.3% | 0 ~ 0.6396 | 点击份额 |
| `conversionShared` | 81.3% | 0 ~ 0.75 | 转化份额 |
| `isFocus` | 100% | — | 关注标志（M15 用） |

### 搜索量历史（计划外，M13 图表可直接用）

`estSearchesNumHistory` 是并行数组结构（非对象数组），4 条等长数组按下标对齐：

```
estSearchesNumHistory.date[]                   100%   8~37 个月    e.g. 2026-01
estSearchesNumHistory.estSearchesNum[]         66.4%  126 ~ 6,524,393
estSearchesNumHistory.searchesRank[]           66.4%  4 ~ 3,256,099
estSearchesNumHistory.searchesNumChangeRatio[] 64.8%  -1.0 ~ 12.44
estSearchesNumHistory.searchesRankChangeRatio[] 64.8% -85.36 ~ 1.0
estSearchesNumHistory.festivals[][]            39.7%  节假日标注
```

`estSearchesNumHistoryPrev` 是同去年同期对比，结构相同，12~53 个月。
⚠️ 它的 `searchesNumChangeRatio` / `searchesRankChangeRatio` 是**空数组**（len 0~0）。

`festivals[][]` 每个元素有 `name` / `startDate` / `endDate`，
实测值 `情人节` / `妇女节` / `春季大促` / `Prime秋季大促会员日` / `万圣节` / `黑五网一`——
与已建的 `dim_festival`（156 行真实数据）语义一致，可 JOIN 而不必重复存。

⚠️ ETL 注意：并行数组必须按**下标对齐**展开，不能各自独立展开。
`date[]` 是 100% 填充但 `estSearchesNum[]` 只有 66.4%，说明有月份缺值，
展开时要保留 NULL 而不是跳过（否则下标错位）。

---

## 2. `web-keyword-conversion` —— 关键词转化率 + ACOS/CPA

采样 200 条 → **176 字段**，`data.keywords[]` 4,392 个元素。

### 已建表 `fact_keyword_conversion_funnel` 的列核对

`db/schema-03-gap-tables.sql:25-44` 的列名与实际响应**全部对得上**，值域也吻合：

| 表列 | 响应字段 | 填充率 | 实测值域 | DDL 里写的值域 | 一致？ |
|---|---|---|---|---|---|
| `search_volume` | `searchVolume` | 100% | 61 ~ 717,552 | 61 ~ 717,552 | ✅ |
| `click_volume` | `clickVolume` | 100% | 45 ~ 182,920 | 45 ~ 182,920 | ✅ |
| `purchase_volume` | `purchaseVolume` | 100% | 0 ~ 5,929 | 0 ~ 7,867 | ⚠️ 采样差异，无碍 |
| `search_click_ratio` | `searchClickRatio` | 100% | 0.0391 ~ 0.7949 | 0.0138 ~ 0.7979 | ✅ |
| `search_purchase_ratio` | `searchPurchaseRatio` | 100% | 0 ~ 0.2121 | 0 ~ 0.2838 | ✅ |
| `click_shared` | `clickShared` | 100% | 0.0392 ~ 0.8 | 0.0242 ~ 0.9194 | ✅ |
| `conversion_shared` | `conversionShared` | **81.5%** | 0.0058 ~ 1.0 | 0.0021 ~ 1.0（79.9%） | ✅ 仍是唯一非 100% |
| `avg_kw_price` | `avgKwPrice` | 100% | 6.86 ~ 137.6 | 6.74 ~ 793.70 | ✅ |
| `source` | `source` | 100% | 恒 `mix` | 恒 `mix` | ✅ |

**新发现一个未建的列**：`clickPurchaseRatio`（100%，0 ~ 0.2877）——
点击购买率，与 `searchPurchaseRatio` 不同（分母是点击不是搜索）。应加列。

`max_kw_price` / `min_kw_price` 两列在本次采样的 176 字段里**没出现**。
DDL 注释说实测 9.99 ~ 35,690.36，可能来自另一个 endpoint 或更大样本。
**待确认**：这两列的源，或标注为无源。

### 时间维度

| 字段 | 填充率 | 说明 |
|---|---|---|
| `data.weekDate` | 100% | ABA 周起始日，e.g. `2026-08-30` |
| `data.weekNumber` | 100% | 周序号，采样内恒 88 |
| `keywords[].updateTime` | 100% | 数据更新时间，精确到秒 |
| `data.total` | 100% | 0 ~ 20,047，总词数（分页用） |
| `data.noConvRateDataCount` | 18% | 无转化率数据的词数 |

### ACOS / CPA 分档（新建表的依据）

结构：`keywords[].acos.<投放类型>[0].{start,median,end}`，数组长度恒 1。

| 投放类型 | acos 填充率 | cpa 填充率 |
|---|---|---|
| `autoForSales_broad` | 92.0% | 92.0% |
| `autoForSales_phrase` | 92.0% | 92.0% |
| `autoForSales_exact` | 92.0% | 92.0% |
| `legacyForSales_broad` | 91.0% | 91.0% |
| `legacyForSales_phrase` | 91.0% | 91.0% |
| `legacyForSales_exact` | 91.0% | 91.0% |

实测值域（以 `autoForSales_broad` 为例）：
- acos：start 0.0947~39.87 / median 0.034~9.19 / end 0.0017~4.17
- cpa：start 0.846~220.0 / median 1.067~293.3 / end 1.333~366.7

⚠️ **start > end 且 median 在中间偏上** —— 这不是「区间下界到上界」，
而是「悲观值 / 中位值 / 乐观值」的三档预估。建列时用 `pessimistic/median/optimistic` 语义命名
会比 `start/end` 更准，但为了与源对齐，**仍用 start/median/end 并在 COMMENT 里写明含义**。

### topAsins（新建表的依据）

`keywords[].topAsins[]`，每词 8~10 个，43,916 个元素，全部 100% 填充：
`asin` / `title` / `img` / `price`（0 ~ 1,665.5）

### asinsClickPurchaseRatio

`keywords[].asinsClickPurchaseRatio[]`，每词 0~3 个，7,519 个元素，全部 100%：
`asin` / `clickPurchaseRatio`（0 ~ 1.3746）/ `img` / `price`

⚠️ 与 `topAsins` 有重叠（都含 asin/img/price），但语义不同：
前者是「有转化率数据的 ASIN」，后者是「头部 ASIN」。可以合成一张表用 `role` 列区分，
也可以分两张。**建议合成一张 `rel_keyword_top_asin`（该表已存在于 schema-02，当前空壳）**，
加 `role` 列（top / conv）和 `click_purchase_ratio` 列。

---

## 3. 对建表方案的修正

相对 `ROADMAP_UNBUILT_MODULES.md §M13` 的调整：

| 计划 | 修正 |
|---|---|
| `fact_keyword_metric_snapshot` 加 9 列 | **加 7 列**（`erAsinNum`/`trAsinNum` 全 NULL 不建） |
| `fact_keyword_cpc_bid` 纯 seed | **改为真实数据表**，源 `web-keyword-conversion` 的 acos/cpa |
| — | `fact_keyword_conversion_funnel` **加 1 列** `click_purchase_ratio` |
| — | **新增**：搜索量历史表（`fact_keyword_search_trend` 已存在，需核对列） |
| — | **新增**：`rel_keyword_top_asin` 加 `role` + `click_purchase_ratio` 列（表已存在） |

**净效果：M13 需要真 seed 的只剩「坑位」概念，其余 4 页全部有真实数据源。**

---

## 4. 待确认

1. `max_kw_price` / `min_kw_price` 的源 —— 本次 176 字段里没有，是否来自 `web-compete-keyword`
   的更大样本或别的 endpoint？
2. `acAsinNum` 恒 0 —— 是 AC（Amazon's Choice）位确实无竞品，还是字段废弃？
3. ACOS 的 start/median/end 语义确认（当前按「悲观/中位/乐观」理解）。

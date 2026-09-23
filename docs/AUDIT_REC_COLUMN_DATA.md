# 「查推荐专栏」数据可支撑性核查

核查日 2026-09-22。目标：判断 Doris(`looom`) 现有表与字段能否支撑
`PLAN_REC_COLUMN.md` 规划的 5 个接口。

**结论：不能。当前不具备实现条件。**

核查方式：`mysql` 直连 `120.24.248.175:9030`，逐表 DESC + 逐字段验值。
以下每个数字都可用文末 SQL 复现。

---

## 一、一句话结论

两条硬阻断，任何一条都足以让页面做出来是空的或假的：

| # | 阻断 | 实测 |
|---|---|---|
| 1 | `fact_asin_rec_column_period` **零条真实数据** | 64 行全部是 `B0SEED*` seed |
| 2 | `rel_rec_column_campaign_keyword` 词覆盖**远低于可用线** | 2036 个 ASIN，**平均 2.2 词，最大 8 词** |

第 2 条比计划里写的更严重。计划说"词覆盖只有原站 1/5"，实测是：
**没有任何一个 ASIN 的词数达到 10**，而原站单个专栏就有 32 词。

---

## 二、三张表的实际状态

```
dim_recommend_column              143 行   ✅ 够用（专栏字典）
rel_rec_column_campaign_keyword  9144 行   ⚠️ 只有关系，没有度量
fact_asin_rec_column_period        64 行   ❌ 全部 seed
```

### 2.1 `dim_recommend_column` ✅

```
rec_title varchar(255) │ country varchar(8) │ short_code varchar(16)
display_name_cn varchar(255) │ first_seen_at datetime │ last_seen_at datetime
```

143 个专栏名，覆盖原站 22 个枚举。**这张表没问题。**

### 2.2 `rel_rec_column_campaign_keyword` ⚠️

```
asin varchar(16) │ country varchar(8) │ rec_title varchar(255)
keyword varchar(128) │ encrypt_campaign_id varchar(64)
keyword_id bigint │ mask_campaign_id varchar(16) │ created_at datetime
```

**缺** `ratio` / `stat_date` / `appear_days` / `total_days` / `keyword_cnt` /
`campaign_cnt`。即三层钻取的"谁连着谁"有了，"占多少、哪天出现、出现几天"全没有。

总量看着够：

```
2036 ASIN │ 115 专栏 │ 3449 活动 │ 3572 词
```

**但逐 ASIN 分布不可用**：

```
词数 ≥30 的 ASIN:    0
词数 ≥10 的 ASIN:    0
词数 <10 的 ASIN: 2036      ← 全部
平均词数:          2.2
最大词数:            8
```

目标 ASIN `B07N7GDB6Q` 的全部 7 行（**3 个 distinct 词**，不是 7）：

```
rec_title                          keyword                mask_campaign_id
Customers frequently viewed        12 x 20 pillow insert  FI2T
Customers frequently viewed        12x20 pillow insert    FI2T
Explore Decorative Home Accents    20x12 pillow insert    4AKG
Picks from Amazon Influencers      12 x 20 pillow insert  FI2T
Picks from Amazon Influencers      12x20 pillow insert    FI2T
Picks from Amazon Influencers      20x12 pillow insert    4AKG
Seen on social media               20x12 pillow insert    4AKG
```

对比原站同 ASIN 同窗口：

| | 专栏 | 活动 | 词 |
|---|---|---|---|
| 原站 | 5 | 3 | **35** |
| 我们库 | 4 | 2 | **3** |

> 计划里写"我们库 4 专栏 3 活动 7 词"。7 是**行数**，distinct 词是 3；
> distinct 活动是 2 不是 3。计划这处数字偏乐观。

### 2.3 `fact_asin_rec_column_period` ❌

```
asin │ country │ rec_title │ stat_date date
ratio double │ campaign_cnt int │ keyword_cnt int │ created_at
```

字段齐全，**但没有一行真实数据**：

```
seed_rows = 64      real_rows = 0
distinct asin = 8   （B0SEEDHD01..05, B0SEEDSS01..03）
distinct stat_date = 2   （2026-08-05 / 2026-08-17）
```

值本身非空非零（`ratio` ∈ [0.00143, 0.14992]），所以**不能靠"值是否为 null"
判断这张表有没有数据**——得看 ASIN 是不是 `B0SEED*`。这是个容易误判的陷阱。

---

## 三、逐接口核查

| 原站接口 | 所需字段 | 可支撑? | 卡在哪 |
|---|---|---|---|
| `rec/overview` | recCnt / campaignCnt / keywordCnt | ⚠️ 可算但数字偏小 | `rel_` COUNT DISTINCT 可得，但词数只有原站 1/10 |
| `rec/trends` | dates[144] + 22 专栏 × score/ratio | ❌ | 无按天 ratio，无 144 周时间轴 |
| `rec/recView` | ratio / manualRatio / autoRatio / *CntTrends / last*Cnt | ❌ | ratio 无真实值；按天趋势无数据源 |
| `rec/campaignView` | 三层嵌套 + appearDays/totalDays + recTrends | ❌ | 嵌套关系有，度量与日期轴全无 |
| `rec/keywordView` | 同上 + estSearchesNum + 搜索量历史 + festivals | ❌ | 见下，join 断裂 |

### 3.1 `ratio`（流量占比）—— 源头不在 Doris

计划提到"214 对 (asin,recTitle) 有 ratio"。核查：Doris 里**找不到**这批数据。
`fact_asin_traffic_channel` 只有渠道级，无推荐专栏维度：

```
channel 取值: total(43319) nf(41187) ad(24246) sp(18827)
              spRec(14942) sbv(5219) sb(4141) allSb(18) allSp(18)
```

`spRec` 是"SP 推荐位"渠道**汇总**，不拆到具体专栏。
所以那 214 对在 PG 源侧，Doris 未落。

### 3.2 周搜索趋势 —— keyword join 断裂

`keywordView` 的 `estSearchesNum` / 搜索量历史需要把 `rel_` 的词 join 到
`fact_keyword_metric_snapshot` / `fact_keyword_search_trend`。实测命中率：

```
rel_ distinct 词        3572
  └ 命中 metric_snapshot  1006   (28%)
  └ 命中 search_trend      645   (18%)
```

目标 ASIN 的 3 个词，在两张表里**命中 0 个**。
即这一列对具体 ASIN 大概率是空的。

`dim_festival` 有 156 行，节假日标注**可支撑** ✅（这是唯一现成的）。

### 3.3 按天维度能否从源里算出

计划步骤 1 的依据是
`sif_asin_keyword.raw->'allRankHistory'->'recRanks'` 是逐日数组。

**本次无法验证**：该表在 PG(`amazon_data`)，不在 Doris；
且 `.env` 里没有 `PG_PASSWORD`（`scripts/_dsn.py` 要求此变量，无默认值）。

所以"扩 ETL 就能补出 appearDays / 按天趋势"这个前提**仍是未验证的推断**。
在拿到 PG 凭据并确认 `recRanks` 结构前，不应把它当作既定事实排期。

---

## 四、能做与不能做

### 现在就能做（不依赖新数据）

| 能力 | 依据 |
|---|---|
| 专栏字典、名称翻译 | `dim_recommend_column` 143 行 |
| 三层钻取的**关系**（专栏↔活动↔词） | `rel_` 9144 行三元组 |
| 计数卡三个数 | `rel_` COUNT DISTINCT（**须标注偏小**） |
| 节假日标注 | `dim_festival` 156 行 |

### 必须补数据才能做

| 能力 | 缺什么 | 补在哪 |
|---|---|---|
| 流量占比 ratio | 按 (asin, recTitle, date) 的占比 | PG 源侧，Doris 未落 |
| 144 周趋势图 | 同上 + 长周期时间轴 | 同上 |
| 出现天数 appearDays/totalDays | 按天出现记录 | 待验证 `recRanks` |
| 按天迷你趋势 | 按天 campaign_cnt/keyword_cnt | 待验证 `recRanks` |
| 词覆盖达到可用量 | 采集侧补词 | 采集侧 |
| 手动/自动占比 | 浏览器插件同步后台活动 | **原站也没有**，照原站显示占位文案即可 |

---

## 五、建议

**不要现在实现这个页面。** 按现有数据做出来会是：计数卡数字只有原站
1/10、占比列大面积空白、趋势图无数据、搜索量列全空。这正是
`PROJECT_AUDIT_REPORT.md` 里反复出现的缺陷模式——用户无法分辨
"真的是 0"和"我们没数据"。

按依赖顺序，三件事排在页面之前：

1. **拿到 `PG_PASSWORD`**，验证 `allRankHistory.recRanks` 是否真是逐日数组。
   这决定按天度量能不能做，是计划步骤 1 的前提。
2. **确认 PG 侧那 214 对 ratio 的实际形态**（有无日期维度）。
   决定占比列是照抄原站语义，还是换口径（计划第六节的 A/B/C 之选）。
3. **评估采集侧补词的成本**。词覆盖 2.2/ASIN 是页面最大的硬伤，
   补 ETL 不会改善它——那是采集抓的词本身少。

这三项有结论后，`PLAN_REC_COLUMN.md` 的步骤 1→4 才是可执行的。

另：`RecommendationsView.vue` + `GET /business/recommendations`
（`InsightsService.getRecommendColumns`）已存在且标题也叫「查推荐专栏」。
新页面上线前需先定它与旧页是替换还是共存——同一导航组两个同名页会让人困惑。

---

## 六、复现 SQL

```sql
-- 1. 三表行数
SELECT 'dim_recommend_column' t, COUNT(*) n FROM dim_recommend_column
UNION ALL SELECT 'rel_rec_column_campaign_keyword', COUNT(*) FROM rel_rec_column_campaign_keyword
UNION ALL SELECT 'fact_asin_rec_column_period', COUNT(*) FROM fact_asin_rec_column_period;

-- 2. fact 表是否全 seed（real_rows 应为 0）
SELECT SUM(CASE WHEN asin LIKE 'B0SEED%' THEN 1 ELSE 0 END) seed_rows,
       SUM(CASE WHEN asin NOT LIKE 'B0SEED%' THEN 1 ELSE 0 END) real_rows
FROM fact_asin_rec_column_period;

-- 3. 逐 ASIN 词数分布（ge10 应为 0）
SELECT SUM(CASE WHEN kws>=30 THEN 1 ELSE 0 END) ge30,
       SUM(CASE WHEN kws>=10 THEN 1 ELSE 0 END) ge10,
       SUM(CASE WHEN kws<10  THEN 1 ELSE 0 END) lt10,
       ROUND(AVG(kws),1) avg_kw, MAX(kws) max_kw
FROM (SELECT asin, COUNT(DISTINCT keyword) kws
      FROM rel_rec_column_campaign_keyword GROUP BY asin) t;

-- 4. 目标 ASIN 明细
SELECT rec_title, keyword, mask_campaign_id
FROM rel_rec_column_campaign_keyword WHERE asin='B07N7GDB6Q' ORDER BY rec_title;

-- 5. 推荐专栏维度是否存在于渠道表（应只见 spRec 汇总）
SELECT channel, COUNT(*) n FROM fact_asin_traffic_channel GROUP BY channel ORDER BY n DESC;

-- 6. keyword join 命中率
SELECT COUNT(DISTINCT r.keyword) rel_total,
       COUNT(DISTINCT CASE WHEN m.keyword IS NOT NULL THEN r.keyword END) hit_metric
FROM (SELECT DISTINCT keyword, country FROM rel_rec_column_campaign_keyword) r
LEFT JOIN (SELECT DISTINCT keyword, country FROM fact_keyword_metric_snapshot) m
  ON m.keyword=r.keyword AND m.country=r.country;
```

连接方式（凭据从 `.env` 读，勿硬编码）：

```bash
set -a && . ./.env && set +a
mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASSWORD" -D"$DB_NAME" -e "<SQL>"
```

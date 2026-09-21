# Looom Doris 数据库设计 v2（目标态）

> 日期：2026-09-21 ｜ 状态：**权威设计文档**（0.5 期已落库，见 §12 校订）
>
> ⚠️ **本文档撰写于 0.5 期执行之前**。0.5 期（`db/schema-07-m13-rework.sql`）已对 Doris 执行完毕，
> 执行时有 **9 处**偏离本文档原设计（§12.1~§12.8），
> 其中 **3 处是本文档的设计错误**，照建会出问题：
> §12.2（重复列）、§12.4（推断值进主键）、§12.5b（JOIN 取属性会 75% 空白）。
> **§12 是校订记录，与正文冲突处以 §12 为准。**
>
> 依据：Doris 实况全量快照（59 张表 DDL + 行数，存 [audit/doris-ddl-snapshot.sql](audit/doris-ddl-snapshot.sql)）、
> 表结构差距分析（[DORIS_SCHEMA_GAP_ANALYSIS.md](DORIS_SCHEMA_GAP_ANALYSIS.md)）、
> 修订版实现计划（[ROADMAP_UNBUILT_MODULES.md](ROADMAP_UNBUILT_MODULES.md) 顶部修订表）。
>
> **定位**：本文档描述 M10~M15 全部落地后的**目标态**（69 张表），并给出从现状到目标态的完整变更清单。
> 实施顺序遵循 ROADMAP 分期；本文档不管排期。
> **取代** `ER_BUSINESS.md` 的表分组与主键描述（该文档仍写 keyword_id 主键，已过期）；
> 列级值域细节以各表 COMMENT 和 `DATA_DICTIONARY.md` 为准。

---

## 0. 总览

| 域 | 现状 | 目标态 | 变化 |
|---|---:|---:|---|
| 用户与权限（users/roles/user_roles/refresh_tokens/api_keys） | 5 | 5 | — |
| 积分（credit_*） | 2 | 2 | — |
| AI（ai_*） | 2 | 2 | — |
| 字典（dict_* ×10 + dim_recommend_column） | 11 | 11 | +1 行 `rec` 渠道 |
| 商品域（dim_asin 族 + 销量/快照/事件/多变体） | 11 | 11 | — |
| 流量/反查/广告/推荐域 | 13 | 13 | — |
| 关键词域（dim_keyword 族 + 指标/趋势/排名/拓词 + dim_word/词频 + rel_keyword_group） | 11 | **16** | +6 新建 −1 删 group（另有 1 张改名） |
| 排名监控域（M14 新设） | 0 | **2** | +rank_monitor、+fact_keyword_rank_hourly |
| 用户资产（favorites/ad_note/query_logs/configs + 库体系） | 4 | **7** | favorites 重建键，+库三表 |
| **合计** | **59** | **69** | **+11 新建、−1 删除、5 张改造** |

---

## 1. 全库统一约定（从 schema-04 起生效，新表必须遵守）

1. **Unique Key 模型 + `enable_unique_key_merge_on_write = true`**。
   主键重复 INSERT = 整行覆盖（**不是部分更新**）——ETL 合并列时必须先读旧行、合并、写全行。
2. **关键词域一律文本主键 `(keyword, country)`**。`keyword VARCHAR(128)`（实测全库最大 128）+
   `country VARCHAR(8)` 必进主键（实测 keyword_id 跨站点不唯一）。`keyword_id` 降级为普通对账列。
3. **country 全表携带**（dict_* 除外），站点枚举：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR。
4. **ID 类主键**（用户资产/任务表）用应用层雪花 `BIGINT`，Doris 无自增、无外键，唯一性靠
   复合主键（强）或应用层（弱，仅 users.email 等历史遗留沿用）。
5. **倒排索引**：主键首列之外的高频过滤列加 `INDEX ... USING INVERTED`（如 keyword、user_id、email）。
6. **COMMENT 必须写实测量**：值域、填充率、源字段名；seed 表必须写明「数据为模拟，B0SEED 前缀」。
7. **分区**：有 `stat_date` 的明细大表用 `AUTO PARTITION BY RANGE (date_trunc(stat_date,'month'))`；
   VARCHAR 月份列（`stat_month`）的表不分区（Doris RANGE 分区要 DATE/INT，改造收益低）。
8. **分桶**：`DISTRIBUTED BY HASH(主键首列) BUCKETS N`，N 按数据量 1/2/4/8（≤10 万行 2 桶，
   百万级 8 桶）。
9. **ETL 键归一**：关键词 `btrim(lower())`；上游拼写错误要映射（`vedio`→`vedio` 保留原文但列名
   用正确拼写并注释；`recSp`→规范 `spRec`）。

---

## 2. 用户与权限 / 积分 / AI（10 张，全部不变）

| 表 | 主键 | 行数 | 说明 |
|---|---|---:|---|
| `users` | id | 6 | email 唯一性应用层保证 |
| `roles` / `user_roles` | id | 2/2 | 权限点 JSON 在 roles.permissions |
| `refresh_tokens` | id | 80 | token 只存 SHA-256 |
| `api_keys` | id | 0 | 明文只返回一次 |
| `credit_accounts` | user_id | 6 | 余额权威值在 Redis，本表快照；有 `integral_limit` 字段备用 |
| `credit_transactions` | id | 3 | biz_type 枚举已含 query/export 等 |
| `ai_tasks` | id | 1 | insert_point 六个插入点；input_hash 缓存防重复扣费 |
| `ai_analyses` | id | 1 | Markdown 结论 |

> M16（AI 工具）已裁决不做——ai_tasks 不需要扩 insert_point 枚举。

---

## 3. 字典表（11 张，1 处增量）

`dict_ad_type / dict_bought_bucket / dict_dimension / dict_keyword_tag / dict_match_type /
dict_op_event_type / dict_sort_field / dict_time_piece / dict_variant_role / dict_traffic_channel /
dict_recommend_column(实为动态维度，143 行)`。

统一结构：`UNIQUE KEY(code)` + name_cn/name_en/sort_order/extra。

**唯一增量**：`dict_traffic_channel` 加一行 —— 现有 11 个 code
（total/nf/ad/allSp/sp/spRec/allSb/sb/sbv/ac/deal/bs）缺 **`rec`（推荐位）**。
M10 对比流量结构页 rec 计数实测非零（142），且与 `spRec`（SP 推荐位）是两个不同渠道。

```sql
INSERT INTO dict_traffic_channel (code, name_cn, name_en, sort_order) VALUES
('rec', '推荐位流量', 'rec', 50);
-- 对应 fact_asin_traffic_channel 需由 ETL 补 rec 渠道行
```

---

## 4. 商品域（10 张，全部不变）

| 表 | 主键 | 行数 | 服务于 |
|---|---|---:|---|
| `dim_asin` | (asin, country) | 59,912 | 全域商品主档（图/价/评/上架日/BS 标/父子体） |
| `dim_asin_feature` | (asin, country, feature_name) | 43,729 | M10 对比销量「属性」列 |
| `rel_asin_variant` | (parent_asin, child_asin, country) | 12,745 | 变体组、流量占比 |
| `fact_asin_bought_monthly` | (asin, country, stat_month) | 809,591 | M10 对比销量：40 个月（2023-05 起）逐月序列；`bought_lower_bound`(排序用)+`bought_label`(展示用) 双列 |
| `fact_asin_listing_snapshot` | (asin, country, stat_month) | 51,880 | Listing 月度指标快照 |
| `fact_asin_subbsr_snapshot` | (asin, country, cat_name, stat_date) | 1,654,767 | 子类目 BSR，**按月自动分区**（全库最大表） |
| `fact_asin_op_event` | (asin, country, stat_date, event_type) | 73,607 | 运营时光机事件流 |
| `fact_asin_keyword_inout` | (asin, country, keyword, stat_date, change_type) | 8,912 | 进出前 3 页事件 |
| `fact_asin_multinf_daily` | (asin, country, stat_date) | 10,911 | 多变体自然位日聚合 |
| `fact_asin_multinf_keyword` / `_variant` | 见快照 | 4,453/14,935 | 多变体×关键词明细（M4 已用） |

## 5. 流量 / 反查 / 广告 / 推荐域（17 张，全部不变）

`fact_asin_traffic_channel`(149,460)、`fact_asin_keyword_overview`(3,713)、
`fact_asin_keyword_snapshot`(19,095，反查主表)、`fact_asin_keyword_score`(19,095，M10 动态列源)、
`rel_asin_keyword_variant_exposure`(0)、`dim_ad_campaign`(5,897)、`dim_ad_product_ad`(313)、
`rel_ad_campaign_product_ad`(123)、`fact_ad_search_term_exposure`(0)、
`rel_rec_column_campaign_keyword`(9,086)、`fact_asin_rec_column_period`(64)、
`dim_recommend_column`(143，M10 flowResources 同一实体)、`dim_festival`(156)、
`dim_supplier`(50)、`dim_word`(33)、`fact_word_frequency`(0)。

> M10 判断「零 ETL 零建表」成立：对比三 Tab 全部从上表现有表组合（§4+§5），
> 动态列/组内最优均为查询层现算。唯一数据缺口是 `rec` 渠道行（§3）。

---

## 6. 关键词域（9 → 15 张，本计划主战场）

### 6.1 现状保留（7 张）

| 表 | 主键 | 行数 | 说明 |
|---|---|---:|---|
| `dim_keyword` | (keyword, country) | 13,070 | translate/est_searches_num |
| `fact_keyword_search_trend` | (keyword, country, granularity, stat_date, **is_prev_period**) | 178,046 | M11/M12 的本期+去年同期双序列 ✓ |
| `fact_keyword_rank_history` | (asin, country, keyword, rank_type, stat_date) | 117,740 | M14 每日排名；nf/sp/sb/sbv；按月分区；⚠️ 仅 2026-07-29 起 |
| `rel_keyword_top_asin` | (keyword, country, asin) | 56,795 | M12「Top5 产品」列；asin_role=top/conv |
| `fact_keyword_conversion_funnel` | (keyword, country, stat_week) | 5,875 | M13 转化率页 ✓ |
| `fact_keyword_competition_snapshot` | (keyword, country, stat_week) | 21,328 | /amount 补充列（global_keyword_num 等） |
| `fact_keyword_metric_snapshot` | (keyword, country, granularity, stat_date) | 22,320 | /amount 主表（⚠️ 改造见 6.2） |

### 6.2 改造（0.5 期）

**a) `fact_keyword_bid_estimate` → RENAME `fact_keyword_acos_estimate`**
（数据 33,019 行原样有效，仅名字与注释纠正：内容是 ACOS/CPA，ACOS 三档**递减**、
CPA 三档**递增**，源 `web-keyword-conversion`）

> ⚠️ **实际执行时多做了一步拆维**（§12.1）。不是「数据原样」：
> 原 `match_type` 列存 `autoForSales_broad` 这种源键拼接值，已拆成
> `match_type(broad/phrase/exact)` × `bid_strategy(auto/legacy)` 两列 ——
> 因为 §6.3 ① 的新竞价表主键本来就是两维分开的，不拆则 service 要写两套解析。
> 新主键：`(keyword, country, stat_week, match_type, bid_strategy)`。

**b) `fact_keyword_metric_snapshot` 加列**

```sql
ALTER TABLE fact_keyword_metric_snapshot ADD COLUMN video_asin_num INT NULL COMMENT "SBV 产品数。源 videoAsinNum";
-- sale_num 的 COMMENT 同步改写为「在售产品数（源 saleNum）。审计判明非销量语义」
```

> ⛔ **原设计的 `top3_click_shared` / `top3_conversion_shared` 两列已取消，不要建**（§12.2）。
> 这两个值**已经在表里**，就是 `click_shared` / `conversion_shared`（schema-06 建的，落表 264 行）。
> 当时按源字段名 `clickShared`/`conversionShared` 理解成「份额」，所以看到页面的
> 「ABA Top3 集中度」以为是另一回事。PG 实查对上了：
> `gag gifts for men → clickShared 0.1907 / conversionShared 0.1547`，
> 量级与页面「点击 8.6% / 转化 3.9%」一致。**建了就是两组列存同一数据。**
> schema-07 已把这两列 COMMENT 改正为「ABA Top3 点击/转化集中度（非份额）」。
>
> ⚠️ 也**不是**「无源则 seed」—— 源一直有，只是我们认错了字段。
> 至于 `market_get_keyword_history` 那个 MCP 接口（313 周序列），用途是给这两列
> **补历史序列**做趋势图，不是新建当期列。

> ⚠️ `video_asin_num` 的值域注释不要写「实测 100% 填充，0~179」——
> 那是源侧采样值。落表填充率取决于 ETL 覆盖面（同表其他竞品数列只有 318/22,320 行），
> 值域等 ETL 灌完再回填。§12.3 说明这类注释的通用规则。

### 6.3 新建（6 张）

**① `fact_keyword_bid_estimate`（新语义重建，M13 /cpc-browsetree，🔴 seed）**

```sql
CREATE TABLE IF NOT EXISTS fact_keyword_bid_estimate (
  keyword        VARCHAR(128) NOT NULL COMMENT "关键词原文，btrim(lower()) 归一",
  country        VARCHAR(8)   NOT NULL,
  category_id    VARCHAR(32)  NOT NULL COMMENT "亚马逊浏览节点 ID（源 categorys[].categoryId）",
  category_name  VARCHAR(255) NULL     COMMENT "类目名（源 categorys[].category）",
  match_type     VARCHAR(16)  NOT NULL COMMENT "exact/phrase/broad（源 matchTypes 三键）",
  bid_strategy   VARCHAR(16)  NOT NULL COMMENT "upDown=提升与降低 / downFixed=仅降低/固定（原站合并口径）",
  stat_month     VARCHAR(7)   NOT NULL COMMENT "YYYY-MM。竞价每月更新（官方口径）",
  bid_start      DECIMAL(10,2) NULL COMMENT "建议竞价区间下界。实测 0.33~，递增序",
  bid_median     DECIMAL(10,2) NULL COMMENT "区间中位",
  bid_end        DECIMAL(10,2) NULL COMMENT "区间上界",
  product_cnt    BIGINT NULL COMMENT "该类目下关键词收录的产品数（源 productNum）",
  created_at     DATETIME NOT NULL,
  INDEX idx_bid2_kw (keyword) USING INVERTED
) ENGINE=OLAP UNIQUE KEY(keyword, country, category_id, match_type, bid_strategy, stat_month)
COMMENT "关键词建议竞价。⚠️ seed 模拟（原站 search/cpc/category 未采集）。与品类强相关、与产品无关（官方口径）；start<median<end 递增，与 ACOS 的递减相反（但与 CPA 同向——CPA 实测也是递增，见 §12.6）"
DISTRIBUTED BY HASH(keyword) BUCKETS 2;
```

**② `rel_keyword_asin_traffic_share`（M13 /compete，🟡 真实源但覆盖极窄）**

> ⚠️ **两处已在落库时改掉**（§12.4、§12.5），下方 SQL 是原设计，**不要照它建**：
> 1. **`stat_week` 不进主键** —— 源响应确实无周维度（`data` 顶层只有
>    `total`/`boughtMonth`/`dutyFinishDate`），「取抓取周起始日」是推断值。
>    把推断值放进主键，等于让主键随抓取时间漂移；`run_compete` 已经踩过这个坑
>    （按 `fetched_at` 推断周次匹配，命中率 14/796）。实际主键 `(keyword, country, asin)`，
>    `stat_date` 降为普通列，语义写明「最近一次抓取的格局，非某周的」。
> 2. **就绪度不是 🟢** —— 82 是 `ok=true` 计数，其中 **60 条 `asins` 为 null**，
>    只有 22 条真有数据，合计 1,637 行 / **9 个去重关键词**。字段结构与设计吻合，
>    可以真实 ETL，但要配 seed 补覆盖，靠 `source` 列区分。

```sql
CREATE TABLE IF NOT EXISTS rel_keyword_asin_traffic_share (
  keyword       VARCHAR(128) NOT NULL COMMENT "关键词原文",
  country       VARCHAR(8)   NOT NULL,
  asin          VARCHAR(16)  NOT NULL COMMENT "占位 ASIN",
  -- ⛔ 原设计这里是 `stat_week DATE NOT NULL`（进主键）。已改：源响应无周维度，
  --    推断值不能进主键（§12.4）。实际建成普通列 stat_date：
  stat_date     DATE NULL COMMENT "抓取日。⚠️ 普通列不进主键：源响应无周维度，语义是「最近一次抓取的格局」不是「某周的」",
  source        VARCHAR(32) NULL COMMENT "real=web-compete-pattern 真实数据 / seed=生成器造。前端据此显示「模拟数据」标记",
  share_rank    INT NULL COMMENT "按自然份额的展示排序",
  nf_score_ratio    DOUBLE NULL COMMENT "自然位份额。源 nfScoreRatio",
  sp_score_ratio    DOUBLE NULL COMMENT "SP 广告位份额。源 spScoreRatio",
  sprec_score_ratio DOUBLE NULL COMMENT "SP 推荐位份额。源 spRecScoreRatio",
  sbv_score_ratio   DOUBLE NULL COMMENT "SBV 视频位份额。源 vedioAdScoreRatio（上游拼写 vedio）",
  sb_score_ratio    DOUBLE NULL COMMENT "SB 品牌位份额。源 brandAdScoreRatio",
  ac_score_ratio    DOUBLE NULL COMMENT "AC 位份额。源 acScoreRatio",
  er_score_ratio    DOUBLE NULL COMMENT "ER 位份额。源 erScoreRatio",
  tr_score_ratio    DOUBLE NULL COMMENT "TR 位份额。源 trScoreRatio",
  -- ⚠️ 实际还建了 7 列 ASIN 属性冗余：title/img/price/rating_num/star/score/
  --    bought_in_past_month，外加 has_variants/is_focus/ac。
  --    原设计说「JOIN dim_asin 取」，但这批 ASIN 有 75% 不在 dim_asin 里（§12.5b）。
  created_at    DATETIME NOT NULL,
  INDEX idx_kats_kw (keyword) USING INVERTED
) ENGINE=OLAP UNIQUE KEY(keyword, country, asin)   -- ⛔ 原设计含 stat_week，已去掉（§12.4）
COMMENT "关键词下 ASIN×流量位份额矩阵（/compete 页）。源 web-compete-pattern：82 条 ok 里仅 22 条有数据，实际可灌 1,637 行 / 9 个去重关键词（非原估的 82 词×100 ASIN），需配 seed 补覆盖。ASIN 属性（图/价/评论/月销）JOIN dim_asin + fact_asin_bought_monthly 取"
DISTRIBUTED BY HASH(keyword) BUCKETS 2;
```

**③ `fact_keyword_expand`（M12 以词拓词，🟢 真实源 `web-keyword-extend` 625 条 ok）**

```sql
CREATE TABLE IF NOT EXISTS fact_keyword_expand (
  seed_keyword      VARCHAR(128) NOT NULL COMMENT "词根（输入词）",
  country           VARCHAR(8)   NOT NULL,
  expand_keyword    VARCHAR(128) NOT NULL COMMENT "拓出的关键词",
  keyword_id        BIGINT NULL COMMENT "对账列",
  translate_keyword VARCHAR(512) NULL,
  match_types       VARCHAR(64) NULL COMMENT "收录面逗号串：Exact/DropDownBox/Phrase/AllMatch",
  est_searches_num  BIGINT NULL,
  searches_rank     BIGINT NULL,
  created_at        DATETIME NOT NULL,
  INDEX idx_fke_seed (seed_keyword) USING INVERTED,
  INDEX idx_fke_kw (expand_keyword) USING INVERTED
) ENGINE=OLAP UNIQUE KEY(seed_keyword, country, expand_keyword)
COMMENT "词根拓词结果。源 web-keyword-extend。趋势序列进 fact_keyword_search_trend（含 is_prev_period 同比），Top 产品进 rel_keyword_top_asin，不重复存"
DISTRIBUTED BY HASH(seed_keyword) BUCKETS 2;
```

**④ `fact_keyword_category_expand`（M12 品类拓词，🔴 seed）**

```sql
CREATE TABLE IF NOT EXISTS fact_keyword_category_expand (
  category_id       VARCHAR(32)  NOT NULL,
  country           VARCHAR(8)   NOT NULL,
  keyword           VARCHAR(128) NOT NULL,
  translate_keyword VARCHAR(512) NULL,
  est_searches_num  BIGINT NULL,
  searches_rank     BIGINT NULL,
  created_at        DATETIME NOT NULL,
  INDEX idx_fce_cat (category_id) USING INVERTED
) ENGINE=OLAP UNIQUE KEY(category_id, country, keyword)
COMMENT "品类拓词结果。⚠️ seed 模拟（keywordByCategory 未采集）。与词根拓词字段不同构（无 match_types/cpc/点击转化），故分表不共用"
DISTRIBUTED BY HASH(category_id) BUCKETS 2;
```

**⑤ `dim_niche_category`（M12 类目树，🔴 seed）**

```sql
CREATE TABLE IF NOT EXISTS dim_niche_category (
  category_id   VARCHAR(32) NOT NULL COMMENT "浏览节点 ID",
  country       VARCHAR(8)  NOT NULL,
  category_name VARCHAR(255) NOT NULL,
  parent_id     VARCHAR(32) NULL COMMENT "上级节点，根为 NULL",
  level         TINYINT NULL COMMENT "树深度 1~4",
  keyword_cnt   BIGINT NULL COMMENT "该类目词数（拓词页展示）",
  created_at    DATETIME NOT NULL
) ENGINE=OLAP UNIQUE KEY(category_id, country)
COMMENT "细分品类树（品类拓词的联想选择）。⚠️ seed 模拟（category/suggestion 未采集），seed 造 3 级约 100 节点"
DISTRIBUTED BY HASH(category_id) BUCKETS 1;
```

**⑥ `fact_keyword_period_product`（M11 产品时光机，🔴 seed）**

```sql
CREATE TABLE IF NOT EXISTS fact_keyword_period_product (
  keyword      VARCHAR(128) NOT NULL,
  country      VARCHAR(8)   NOT NULL,
  period_type  VARCHAR(8)   NOT NULL COMMENT "week/month（页面三档：最近7天/选周/选月）",
  period_value VARCHAR(32)  NOT NULL COMMENT "week=YYYY-MM-DD(周日)；month=YYYY-MM",
  asin         VARCHAR(16)  NOT NULL,
  traffic_rank INT NULL COMMENT "该时段此词下的自然流量排名（页面主排序）",
  img          VARCHAR(512) NULL COMMENT "以下四列为商品属性快照（seed 直接造；真实源到位后可改为 JOIN dim_asin）",
  title        VARCHAR(1024) NULL,
  price        DECIMAL(12,2) NULL,
  bought_label VARCHAR(16) NULL COMMENT "近30天销量分档（同 dict_bought_bucket 口径）",
  created_at   DATETIME NOT NULL,
  INDEX idx_fkpp_kw (keyword) USING INVERTED
) ENGINE=OLAP UNIQUE KEY(keyword, country, period_type, period_value, asin)
COMMENT "关键词×时间段→历史畅销产品榜（产品时光机页面主体，100 行/时段，可回溯 720 天口径）。⚠️ seed 模拟（summaryKeyword 端点无日志）"
DISTRIBUTED BY HASH(keyword) BUCKETS 2;
```

---

## 7. 排名监控域（M14，2 张新建 + 既有 rank_history）

**① `rank_monitor`（任务表，用户自产，三页共用）**

```sql
CREATE TABLE IF NOT EXISTS rank_monitor (
  id             BIGINT NOT NULL COMMENT "雪花 ID",
  user_id        BIGINT NOT NULL,
  country        VARCHAR(8) NOT NULL,
  asin           VARCHAR(16) NULL COMMENT "每日排名可空（纯关键词订阅）；小时排名/快照必填",
  keyword        VARCHAR(128) NOT NULL,
  granularity    VARCHAR(8) NOT NULL COMMENT "hour=小时排名 / day=每日排名 / snapshot=坑位快照",
  period_hours   TINYINT NULL COMMENT "抓取间隔小时：1/2/3/6/12（hour 用；snapshot 固定 1）",
  pages          TINYINT NULL COMMENT "每次抓取页数：3/7（day 不适用）",
  duration_days  SMALLINT NULL COMMENT "持续天数：7/14/28（snapshot 固定 15）",
  is_auto_proceed BOOLEAN NULL DEFAULT FALSE COMMENT "到期自动续费",
  integral_cost  INT NULL COMMENT "积分成本展示值（快照 42；小时=线性公式 20×(pages/3)×(period/1)×(days/7)）。⚠️ 仅展示不扣费",
  status         VARCHAR(16) NOT NULL COMMENT "monitoring/stopped/expired",
  expire_at      DATETIME NULL,
  created_at     DATETIME NOT NULL,
  updated_at     DATETIME NULL,
  INDEX idx_rm_user (user_id) USING INVERTED,
  INDEX idx_rm_kw (keyword) USING INVERTED
) ENGINE=OLAP UNIQUE KEY(id)
COMMENT "排名监控任务。三页一体的任务中枢：参数枚举与计价公式来自 sif 实测（audit/subscribe-family.md）。Loom 无积分体系，integral_cost 只记录展示"
DISTRIBUTED BY HASH(id) BUCKETS 2;
```

**② `fact_keyword_rank_hourly`（小时粒度排名，🔴 seed；坑位快照复用本表）**

```sql
CREATE TABLE IF NOT EXISTS fact_keyword_rank_hourly (
  asin         VARCHAR(16)  NOT NULL,
  country      VARCHAR(8)   NOT NULL,
  keyword      VARCHAR(128) NOT NULL,
  rank_type    VARCHAR(16)  NOT NULL COMMENT "nf/sp/sb/sbv/rec（快照页含 5 种广告位）",
  stat_hour    DATETIME NOT NULL COMMENT "整点切片（源 searchTime 精确到小时）",
  rank_position DOUBLE NULL COMMENT "全局排名（sb/sbv 带小数编码版位，同 rank_history 的 DOUBLE 先例）",
  page_no      INT NULL,
  page_size    INT NULL,
  slot         VARCHAR(16) NULL COMMENT "top/middle/bottom/tail",
  asin_order   INT NULL,
  campaign_id  VARCHAR(64) NULL,
  created_at   DATETIME NOT NULL,
  INDEX idx_fkrh_kw (keyword) USING INVERTED
) ENGINE=OLAP UNIQUE KEY(asin, country, keyword, rank_type, stat_hour)
COMMENT "小时粒度排名。⚠️ seed 模拟。坑位快照=固定参数(1h×3页×15天)的特例视图，同表不另建 slot_snapshot。flag 三态（抓取中/未监控/超范围）由应用层按任务状态推导"
AUTO PARTITION BY RANGE (date_trunc(stat_hour, 'month'))
DISTRIBUTED BY HASH(asin) BUCKETS 2;
```

> 每日排名（granularity=day）**不建新表**——直接查既有 `fact_keyword_rank_history`
> （nf/sp 日粒度 117,740 行）。`rankStr`（"p2,3/16" 坑位表达）由 page_no/page_size 现算。

---

## 8. 词库 / 用户资产域（M15a + M15b，改动最大的域）

### 8.1 `user_favorites` 重建（表空，零成本）

```sql
-- 重建：UNIQUE KEY(id) → 复合键，group_name → library_id
CREATE TABLE IF NOT EXISTS user_favorites_v2 (
  user_id        BIGINT NOT NULL,
  favorite_type  VARCHAR(16) NOT NULL COMMENT "focus/monitor/subscribe",
  target_type    VARCHAR(16) NOT NULL COMMENT "asin/keyword",
  country        VARCHAR(8) NOT NULL,
  target_value   VARCHAR(255) NOT NULL,
  library_id     BIGINT NULL COMMENT "归属库（替代旧 group_name 弱关联）",
  note           VARCHAR(512) NULL,
  notify_enabled TINYINT NULL DEFAULT "0",
  created_at     DATETIME NOT NULL
) ENGINE=OLAP UNIQUE KEY(user_id, favorite_type, target_type, country, target_value)
COMMENT "用户关注/监控/订阅。复合主键=DB 级幂等（并发重复点击不产生脏行）"
DISTRIBUTED BY HASH(user_id) BUCKETS 2;
-- 迁移后 RENAME 回 user_favorites
```

### 8.2 库体系三张新表（产品库/词库共用主表）

**① `user_library`（库主表）**

```sql
CREATE TABLE IF NOT EXISTS user_library (
  id            BIGINT NOT NULL COMMENT "雪花 ID",
  user_id       BIGINT NOT NULL,
  country       VARCHAR(8) NOT NULL COMMENT "库按站点隔离",
  library_type  VARCHAR(8) NOT NULL COMMENT "product=产品库 / word=词库",
  name          VARCHAR(64) NOT NULL,
  kind          VARCHAR(24) NOT NULL COMMENT "产品库：my/expand_competitor(拓词竞品)/benchmark(对标竞品)/targeting(ASIN定投)；词库一级：product；词库二级：stage_new/stage_growing/stage_mature/stage_decline",
  polarity      VARCHAR(8) NULL COMMENT "词库专用：valid=有效词库 / negative=否定词库（成对）",
  parent_id     BIGINT NULL COMMENT "两级结构：阶段词库挂产品词库",
  sort_order    INT NULL,
  created_at    DATETIME NOT NULL,
  INDEX idx_ul_user (user_id) USING INVERTED
) ENGINE=OLAP UNIQUE KEY(id)
COMMENT "用户库主表。产品库上限 500 个 ASIN、词库两级+正负配对，均应用层控。默认库 kind=my name=我的产品"
DISTRIBUTED BY HASH(id) BUCKETS 2;
```

**② `user_library_keyword`（词库成员，取代 rel_keyword_group）**

```sql
CREATE TABLE IF NOT EXISTS user_library_keyword (
  library_id      BIGINT NOT NULL,
  keyword         VARCHAR(128) NOT NULL,
  country         VARCHAR(8) NOT NULL,
  relevance_level VARCHAR(12) NULL COMMENT "high/mid/low/irrelevant——标记相关性的落点（继承添加时标记，可手动改）",
  tag_ids         VARCHAR(255) NULL COMMENT "自定义标签 ID 逗号串",
  added_at        DATETIME NOT NULL,
  INDEX idx_ulk_kw (keyword) USING INVERTED
) ENGINE=OLAP UNIQUE KEY(library_id, keyword, country)
COMMENT "词库成员。词的度量列（搜索趋势/转化率/竞价/竞品数/Top3/Top产品）全部现查既有关键词域表，本表只存归属与标记"
DISTRIBUTED BY HASH(library_id) BUCKETS 2;
```

**③ `user_keyword_tag`（自定义标签字典）**

```sql
CREATE TABLE IF NOT EXISTS user_keyword_tag (
  id         BIGINT NOT NULL COMMENT "雪花 ID",
  user_id    BIGINT NOT NULL,
  name       VARCHAR(32) NOT NULL,
  color      VARCHAR(16) NULL,
  created_at DATETIME NOT NULL,
  INDEX idx_ukt_user (user_id) USING INVERTED
) ENGINE=OLAP UNIQUE KEY(id)
COMMENT "词库自定义标签（词库页「自定义标签」列 + 管理对话框配置）"
DISTRIBUTED BY HASH(id) BUCKETS 1;
```

### 8.3 删除

`rel_keyword_group`（0 行空壳，语义被 `user_library_keyword` 完全覆盖）——M15a 上线后 DROP，
DROP 语句加存在性守卫（沿用 schema-05 的守卫模式）。

### 8.4 不变

`sys_user_ad_note`（0 行，M17 已砍，闲置保留）、`query_logs`、`system_configs`。

---

## 9. 变更总清单（现状 → 目标态）

| # | 动作 | 对象 | 期次 | 守卫要点 |
|---|---|---|---|---|
| 1 | RENAME **+ 拆维** | `fact_keyword_bid_estimate` → `fact_keyword_acos_estimate`，`match_type` 拆成 `match_type` × `bid_strategy` | 0.5 | ✅ **已执行**，33,019→33,019 无损 |
| 2 | CREATE | `fact_keyword_bid_estimate`（新语义，seed） | 0.5 | ✅ **已建**（空表待 seed） |
| 3 | ADD COLUMN ×**1** | `fact_keyword_metric_snapshot` 加 `video_asin_num` + **14 处** COMMENT 改正 | 0.5 | ✅ **已执行**。~~top3×2~~ 取消（§12.2 重复列） |
| 4 | INSERT | `dict_traffic_channel` 加 `rec` 行 | 0.5 | ✅ **已执行**，实查确认原 12 行只有 `spRec` |
| 5 | CREATE | `rel_keyword_asin_traffic_share`（主键**不含** stat_week） | 0.5 | ✅ **已建**（空表待 ETL）。ETL 待写，源仅 9 词需配 seed |
| 5b | 重建主键 | `user_favorites` → 复合主键 | ~~第 3 期~~ **0.5 提前** | ✅ **已执行**（表空且代码无引用，零成本，不必等 M15a） |
| 6 | CREATE ×2 | `rank_monitor`、`fact_keyword_rank_hourly` | 第 2 期 | seed 走 gen-seed-unbuilt.mjs |
| 7 | CREATE ×3 + DROP group | `user_library` 族（M15a）。~~重建 favorites~~ 已在 0.5 期做完（#5b） | 第 3 期 | ⚠️ `library_id` 列还没加，见 §12.7 |
| 8 | CREATE ×3 | `fact_keyword_expand`（ETL 625 ok）、`fact_keyword_category_expand`、`dim_niche_category` | 第 5 期 | ETL 用 fixture root-extend-travel-gifts.json 核对 |
| 9 | CREATE | `fact_keyword_period_product` | 第 6 期 | seed |

净变化：**+11 新建 −1 删除 = 59 → 69 张**（RENAME 不变数量）。

## 10. schema 文件组织与同步点

| 文件 | 内容 | 状态 |
|---|---|---|
| schema-01 ~ 06 | 既有（系统/业务/gap/文本键/分区/M13 第一版） | 已应用，不再改 |
| **schema-07-m13-rework.sql** | 变更 #1~#5b（改名拆维 + 新竞价表 + metric 加列 + rec 行 + 份额表 + favorites 重建） | ✅ 已写已执行（386 行） |
| **db/gen-seed-unbuilt.mjs** → `db/seed-unbuilt.sql` | M13 竞价页 seed（25,074 行）。新表的 seed 都走这里，**不改 gen-seed.mjs**（那个还是 schema-04 之前的 keyword_id 版本，重跑会回退设计） | ✅ 已写 |
| **schema-08-m14-rank-monitor.sql** | #6 | 第 2 期写 |
| **schema-09-m15-libraries.sql** | #7 | 第 3 期写 |
| **schema-10-m12-expand.sql** | #8 | 第 5 期写 |
| **schema-11-m11-timemachine.sql** | #9 | 第 6 期写 |

每个新 schema 文件必须：`CREATE TABLE IF NOT EXISTS`；DDL 变更（RENAME/ADD COLUMN/DROP）
写成「检查已应用则跳过」的守卫块（参照 schema-05 的分区迁移写法）。
**同步三处**：`scripts/setup-doris.sh`、`apps/api/scripts/init-db.mjs` 的 FILES 数组、
`apps/api/Dockerfile` 的 COPY。

> ✅ **三处已于 2026-09-21 同步完成**，并顺手修了一个既有缺陷：
> `init-db.mjs` 的 FILES **此前漏了 schema-05 和 schema-06**，
> 导致容器建出的库比 `setup-doris.sh` 手动建的少表 —— 正是本节警告要防的问题，
> 但之前已经发生了。现在三处的文件清单逐一核对一致。
>
> ⚠️ `setup-doris.sh` 的 glob 从 `schema-0[!45]-*.sql` 改成 `schema-0[!457]-*.sql`
> —— schema-07 非幂等（含 RENAME + INSERT SELECT），不能进 glob，
> 改为单独执行 + 探测 `fact_keyword_acos_estimate` 是否存在的守卫。
> `init-db.mjs` 里对应加了 `runReworkOnce()`，插在 schema-06 与 seed-unbuilt 之间
> （顺序敏感：seed-unbuilt 灌的是 schema-07 重建的那张表）。
旧生成器（gen-business-schema.mjs / gen-seed.mjs）已与 schema-04 脱节，不回写、加警示注释；
seed 统一走新的 `db/gen-seed-unbuilt.mjs` → `db/seed-unbuilt.sql`。

## 11. 数据来源映射（目标态全表）

| 来源 | 表 |
|---|---|
| 🟢 PG 结构化表 ETL | dim/fact/rel 既有的 31 张有数表（M1~M9 已建） |
| 🟢 PG `sif_api_log` JSON ETL | `rel_keyword_asin_traffic_share`（web-compete-pattern）、`fact_keyword_expand`（web-keyword-extend）、以及既有 conversion/competition/metric/top_asin/search_trend |
| 🔴 seed（B0SEED 前缀） | 新竞价表、`fact_keyword_category_expand`、`dim_niche_category`、`fact_keyword_rank_hourly`、`fact_keyword_period_product` |
| 👤 用户自产（应用层 CRUD） | `rank_monitor`、`user_library` 族、`user_favorites`、`sys_user_ad_note`、query_logs 等 |

---

## 12. 0.5 期落库校订（2026-09-21，执行后回写）

本文档写于 0.5 期执行之前。实际执行 `db/schema-07-m13-rework.sql` 时偏离原设计 **7 处**，
其中 **§12.2 / §12.4 是本文档的设计错误**（照建会出问题），其余是补充或提前。
**正文与本节冲突时以本节为准。**

校订依据：Doris 实测（`120.24.248.175:9030`）+ PG `sif_api_log` 实查。

### 12.1 ➕ ACOS 表改名时**顺手拆了维**

原设计 §6.2a 写「数据 33,019 行原样有效，仅名字与注释纠正」。实际多做一步：

```
原: match_type = 'autoForSales_broad'        ← 源 JSON 键拼接值
新: match_type = 'broad' + bid_strategy = 'auto'
```
主键 `(keyword, country, stat_week, match_type, bid_strategy)`。

理由：§6.3 ① 的新竞价表主键本来就是 `match_type` × `bid_strategy` 两维分开的，
ACOS 表留着拼接值则 service 要写两套解析。既然改名要动一次表，一并拆齐。
迁移无损：33,019 → 33,019 行，6 个组合行数逐一对应（`broad/phrase/exact` × `auto/legacy`）。

⚠️ 实测发现一个前端必须处理的数据特征：**不是每词都有 6 格**。

```
5,118 词  auto + legacy 齐全（6 行）
  409 词  只有 auto（3 行）
  362 词  只有 legacy（3 行）
```
按 2×3 矩阵渲染要容忍整行缺失。另有 **673 对（13%）auto 与 legacy 数值逐位相同** ——
这是源侧合并逻辑所致（官方口径「仅降低与固定合并」），不是 ETL bug，别去「修」。

### 12.2 ⛔ `top3_click_shared` / `top3_conversion_shared` 取消 —— 与既有列重复

原设计 §6.2b 要新建这两列，注明「字段名待探源确认，无源则 seed」。**两个判断都错**：

1. **源一直有**，不需要 seed
2. **数据已经在表里了** —— 就是 `click_shared` / `conversion_shared`（schema-06 建的，落表 264 行）

当时按源字段名 `clickShared`/`conversionShared` 理解成「份额」，所以看到 `/amount` 页的
「ABA Top3 集中度」列以为是另一个指标。PG 实查确认是同一个：

```
gag gifts for men                   clickShared 0.1907   conversionShared 0.1547
butterfly baby shower decorations   clickShared 0.2271   conversionShared 0.0455
christmas mugs                      clickShared 0.1276   conversionShared 0.0286
```
量级与页面显示的「点击 8.6% / 转化 3.9%」一致。建了就是两组列存同一数据。

schema-07 已把这两列 COMMENT 改正为「ABA Top3 点击/转化集中度（**非份额**）」。

⚠️ `DORIS_SCHEMA_GAP_ANALYSIS.md` §2.2 提到的 sif MCP 接口
`market_get_keyword_history`（返回 313 周 `top3_click_shares[]` 序列）**仍有价值** ——
但用途是给这两列**补历史序列**做趋势图，不是新建当期列。既有列只有单周值。

### 12.3 ⚠️ §1 第 6 条「COMMENT 必须写实测量」要区分「源侧」和「落表」

这不是执行偏离，是**约定本身需要补一句**，否则会持续产出误导性注释。

schema-06 的竞品数量列注释写「实测 100% 填充」—— 那是 200 条响应采样的**源侧**填充率。
注释挂在 Doris 列上，读者会理解成**表里**的填充率。实际差 70 倍：

| 列 | schema-06 写的 | Doris 实测落表 |
|---|---|---|
| `nf_asin_num` | 「100% 填充」 | **318/22,320 = 1.4%** |
| `sale_num` | 0~424,204 | **80~298,323** |
| `click_shared` | 81.3%，0~0.6396 | **264/318**，0~**0.5472** |
| `sp_recommended_asin_num` | 0~270 | **0~284** |
| `cpa_end` | 1.333~366.7 | **0.7136~6,290.91**（差 17 倍） |

落差有正当理由：`web-compete-keyword` 只覆盖 789 词，与 metric 表 22,320 行的词级交集 318。
但注释不写清楚，就会有人以为 22,320 行都查得到竞品数。

**约定补充**：填充率一律写「落表实际」，值域一律写「Doris 实测」；
源侧采样值域如有参考价值，另起一句注明「源侧采样」。schema-07 已按此改正 14 处。

### 12.4 ⛔ `rel_keyword_asin_traffic_share` 的 `stat_week` **不能进主键**

原设计 §6.3 ② 主键为 `(keyword, country, asin, stat_week)`，
`stat_week` 注释「源响应无周维，取抓取周起始日」——**自己点明了它是推断值，却把它放进了主键**。

PG 实查证实源响应确实无周维度：

```
data 顶层键: total, boughtMonth, dutyFinishDate     ← 没有周/日期字段
asin 内时间类字段: acDates[7], boughtHistoryDates[29], createdAt(null)
                   ← 都是 ASIN 自己的时间序列，不是数据周
```

把推断值放进主键的后果：同一个 `(keyword, asin)` 在不同抓取时间会生成**不同主键的重复行**，
而且无法判断哪行是最新。`run_compete` 已经栽在这上面 ——
第一版按 `aba_week_start(fetched_at)` 推断周次去匹配，命中率 **14/796**。

**实际建法**：主键 `(keyword, country, asin)`，`stat_date` 降为普通列，
COMMENT 写明「语义是最近一次抓取的竞争格局，不是某周的」。
与 `fact_keyword_metric_snapshot` 的竞品数量列同一处理方式（那里也是词级属性无周维）。

### 12.5 ⚠️ `/compete` 的源就绪度：🟢 → 🟡

原设计标「🟢 真实源 `web-compete-pattern` 82 条 ok」，表 COMMENT 里还写了
「82 词×约 100 ASIN」。**82 是 `ok=true` 的计数，不是有数据的计数**：

```
web-compete-pattern   753 条请求 / 82 ok
  其中 asins = null    60 条    ← 73% 的成功响应是空的
      asins = array    22 条    ← 1,637 行 ASIN，覆盖 9 个去重关键词
```

有数据那 22 条的字段结构与设计**完全吻合**，包括两处源侧拼写错误
（`vedioAdScoreRatio`、`hasVaiants`），所以可以真实 ETL。
但 9 个词的覆盖面只够验证 ETL 与前端渲染，演示时大量词查不到东西。

**结论：真实 ETL + seed 补覆盖**，靠 `source` 列（DDL 已有）区分 real/seed，
前端据此显示「模拟数据」标记。表 COMMENT 里「82 词×100 ASIN」的估算已改正。

⚠️ **通用教训**：判断 `sif_api_log` 的源就绪度不能只看 `SUM(ok)`，
要看目标数组的 `jsonb_typeof`。同样的方法复查 `web-keyword-extend`（§6.3 ③ 的源）：
625 条 ok **全部**是 array，合计 16,019 个词 —— 那个 🟢 是扎实的。

### 12.5b ⚠️ 份额表的 ASIN 属性**必须冗余存**，不能 JOIN `dim_asin` 取

原设计 §6.3 ② 的表 COMMENT 写「ASIN 属性（图/价/评论/月销）JOIN dim_asin +
fact_asin_bought_monthly 取」—— 思路对（避免属性漂移、不重复存），
但**这批 ASIN 大部分不在 `dim_asin` 里**：

```
web-compete-pattern 去重 ASIN   1,142
其中 dim_asin(US) 命中            283
缺失                              859  （75%）
```

原因：`dim_asin` 的 59,912 行来自我们已爬的 ASIN 域接口，
而 `/compete` 返回的是「该关键词下占位的竞品」—— 大量是我们从没单独查过的 ASIN。
JOIN 取属性会让 **75% 的行没有图片和标题**，而 `/compete` 页的图片列是核心内容
（用户靠图快速识别竞品）。

**实际建法：冗余存** `title` / `img` / `price` / `rating_num` / `star` / `score` /
`bought_in_past_month`，源响应里这些字段都自带。
代价是属性可能过时，但比 75% 空白好。真实 ETL 时可以顺手反哺 `dim_asin`
（把新见的 ASIN 补进主档），那样两边都改善 —— 但那属于额外工作，不在 0.5 期。

⚠️ `bought_in_past_month` 存 **VARCHAR** 不是数值 ——
源值是分档串 `"6,000+"`，照原样存，前端不要当数字算。

### 12.6 ⚠️ CPA 的方向与 ACOS 相反，别按「同表同向」渲染

§6.2a 原文只说「内容是 ACOS/CPA 三档**递减**」，把两个指标并成一句。实测两者方向不同：

```
ACOS  start > median > end    递减   33,019/33,019 行 100% 满足
CPA   start < median < end    递增   0.4541 → 0.5838 → 0.7136
```

同一行里两组列方向相反。共用一套渲染逻辑（比如统一「取 start 作上界」）会把 CPA 画反。
schema-07 的 COMMENT 已逐列写明方向。

顺带修正一处提法：新竞价表的 `start<median<end` 在原文里写作「**区间端点**」，
但 ACOS 那三档不是区间而是**悲观/中位/乐观三档预估**。
两张表的三档语义不同（一个是估值档位、一个是竞价区间），注释里要分开说，
否则前端会对 ACOS 做「区间条」渲染 —— 那是错的。

### 12.7 ➕ `user_favorites` 重建**提前到 0.5 期**，并补了 `library_id`

原设计 §8.1 把 favorites 重建排在第 3 期（M15a）随库体系一起做。
实际在 0.5 期就做了 —— 理由：表是空的（0 行）**且全仓代码无任何引用**
（`grep -rn "user_favorites" apps/` 无结果），现在改零成本；
等 M15a 时表里已有数据，就要写迁移脚本。

主键按原设计改为 `(user_id, favorite_type, target_type, target_value, country)`
（注意列序与原设计的 `...country, target_value` 略有不同，不影响唯一性与查询）。

原设计要用 `library_id` 取代 `group_name`，已补该列。但**两列暂时共存**：

```
library_id  BIGINT  NULL   → 关联 user_library.id，M15a 上线后才有值
group_name  VARCHAR NULL   → 旧的字符串分组，注释标「新代码不要写这列」
```
不直接删 `group_name` 是因为 `user_library` 表还没建（第 3 期），
现在删了 M15a 之前这张表就没有任何分组能力。M15a 上线时把值迁过去再废弃。

### 12.8 ➕ `dict_traffic_channel` 的 `rec` 行：`sort_order` 用 13 不是 50

原设计 §3 给的 `sort_order = 50`。实查字典现有 12 行（不是原文说的 11 个 code），
`sort_order` 是 1~12 连续的，插 50 会在前端图例里留一个大空档。改用 **13** 接在末尾。

另外 `name_en` 用 `recommend` 而非原设计的 `rec`（与 `spRecommend` 同风格），
并补了 `extra` 色值 `#8C6FE6`（该列存图例颜色，现有 12 行里 10 行有值）。

实查确认的现状（12 行，原文漏了一个）：
```
ac, ad, allSb, allSp, bs, deal, nf, sb, sbv, sp, spRec, total
```
确实缺 `rec`，原设计这个判断成立。

---

### 12.9 执行清单与验证

`db/schema-07-m13-rework.sql`（386 行）已对 Doris 执行，分三批（Doris 异步 SCHEMA_CHANGE 所限）：

| 动作 | 验证结果 |
|---|---|
| ACOS 表改名 + 拆维 | ✅ 33,019 → 33,019 行，6 组合行数逐一对应 |
| `metric_snapshot` 补 `video_asin_num` | ✅ |
| 14 处 COMMENT 按实测改正 | ✅ |
| 新建 `rel_keyword_asin_traffic_share` | ✅ 空表待 ETL |
| 新建 `fact_keyword_bid_estimate`（类目维） | ✅ 空表待 seed |
| `dict_traffic_channel` 补 `rec` | ✅ |
| `user_favorites` 重建主键 + 补 `library_id` | ✅ |
| `fact_keyword_acos_estimate_v1`、`user_favorites_old_pk` | ⏸ 旧表保留待确认后 DROP（DROP 语句已在 schema-07 里注释掉） |

代码侧同步：
- `scripts/etl_module13_wordpick.py` —— `run_bid` 改写新表名并拆维（`mt.split('ForSales_')`）；
  `run_compete` 加 `videoAsinNum`。dry-run 通过
- `apps/api/src/business/dto/query.dto.ts` —— `MATCH_TYPES` 从 6 个拼接值改为
  `['broad','phrase','exact']`，新增 `BID_STRATEGIES`；拆出 `AcosEstimateQueryDto`
  与 `BidEstimateQueryDto`（后者多 `categoryId` + `statMonth`）
- `apps/api/src/business/wordpick.service.ts` —— 表名与口径注释改正
- `tsc --noEmit` 通过

⚠️ **两处 Doris 踩坑**，写进 §1 约定备查：

1. **只改 COMMENT 不能带类型声明** ——
   `MODIFY COLUMN x INT NULL COMMENT '...'` 报 `Nothing is changed`，
   必须写 `MODIFY COLUMN x COMMENT '...'`（省略类型）。
2. **`ADD COLUMN` 是异步 SCHEMA_CHANGE** ——
   紧跟其后对同表的 ALTER 会报 `state(SCHEMA_CHANGE) is not NORMAL`。
   同表连续 ALTER 要分批执行，或先 `SHOW ALTER TABLE COLUMN` 等到 `FINISHED`。
   这一点影响 §10 要求的「守卫块」写法：守卫不只要判「是否已应用」，
   还要判「上一个变更是否已完成」。

### 12.10 §0 总览表的计数校订

原表「合计 59 → 69（+11 新建、−1 删除、5 张改造）」。0.5 期执行后：

```
59（起点）
 +1  fact_keyword_acos_estimate     （改名而来，但同时保留了 v1 旧表 → 实际 +2）
 +1  fact_keyword_bid_estimate      （新语义重建）
 +1  rel_keyword_asin_traffic_share
 +1  user_favorites                 （重建，旧表 user_favorites_old_pk 保留 → 实际 +2）
= 现状 63 张（含 2 张待删旧表）
```
⏸ 两张旧表 DROP 后为 **61 张**。目标态 69 张不变（剩余 8 张在第 2/3/5/6 期建）。

---

## 13. 第 1 期 M13 后端实施记录（2026-09-21）

0.5 期返工后紧接着做完了第 1 期的**数据层 + 后端**（前端未做）。

### 13.1 两张空表填上了

| 表 | 结果 | 方式 |
|---|---|---|
| `rel_keyword_asin_traffic_share` | **1,351 行 / 9 词** | 真实 ETL：`scripts/etl_module13_compete.py` |
| `fact_keyword_bid_estimate` | **25,074 行 / 200 词** | seed：`db/gen-seed-unbuilt.mjs` |

**compete ETL 的两个坑**（都写进脚本注释了）：

1. **源数据是分页的** —— 同一个词有多条日志（`pageNum` 1..N，每页 50~100 行）。
   只取最新一条会丢 90% 的 ASIN（`classroom caddy` 有 9 页共 417 行）。
   必须按 `fetched_at` 升序读全部页、在内存里按 `(词, 站点, ASIN)` 合并。
   实测 1,637 源行去重成 1,351 行，说明分页间确有重复 ASIN。
2. **60/82 条 ok 响应的 `asins` 是 null** —— `jsonb_typeof` 守卫必须保留，
   否则报 `cannot extract elements from a scalar`。

**seed 的设计取舍**：关键词挂**真实词**（从 `fact_keyword_conversion_funnel`
取搜索量 Top 200），只有类目和竞价数值是造的。理由：竞价页是「按词查」的，
挂 `B0SEED` 式假词会让用户查任何真实词都空白。靠 `source='seed'` 列区分，
响应里返回 `isSeed: true` 让前端打标记。

造数贴合三条官方口径，避免 UI 上一眼假：
- 类目有各自基准价（Electronics 1.64 > Home & Kitchen 0.82），体现「与品类强相关」
- `exact` > `phrase` > `broad`（精准匹配竞争最激烈）
- `legacy` 比 `auto` 高 5~20%（手动投放要出价更高才拿到位置）
- 三档**递增**，实测 25,074/25,074 行 100% 满足 `start < median < end`

### 13.2 ETL 补跑了 `videoAsinNum`

0.5 期只加了列没灌数据。重跑 `etl_module13_wordpick.py --only compete` 后
落表 321 行，实测值域 1~32，COMMENT 已回填。

⚠️ 顺带发现 0.5 期的一个盲点：加列后**必须重跑对应 ETL**，
否则接口返回该列恒为 null，看起来像 bug。

### 13.3 份额表的 er/tr/ac 三列实测结论

| 列 | 实测 | 处理 |
|---|---|---|
| `er_score_ratio` | 1,351 行**全为 0** | 列保留观察，接口**不返回**（页面表头也没这列） |
| `tr_score_ratio` | 同上全为 0 | 同上 |
| `ac_score_ratio` | **26 行非零，最大 1.0** | ✅ 有真实区分度，接口返回，页面「AC推荐流量」列要展示 |

`ac_score_ratio` 有值这点值得注意 —— 它与 `fact_keyword_metric_snapshot`
的 `ac_asin_num`（318 行恒 0）**不同**。同一个 AC 概念在两张表里一个有数据一个没有，
说明 §12.2 保留 AC 列的决定是对的（用户确认时的判断成立）。

### 13.4 后端：1 个 service + 5 条路由

`apps/api/src/business/wordpick.service.ts`（701 行）：

| 方法 | 页面 | 数据 |
|---|---|---|
| `listConversion` | /conversion-rate 转化率 | 真实 5,875 行 |
| `listAmount` | /amount 竞品数量 | 真实 22,320 行（竞品数量列 321） |
| `listCompetePattern` | /compete 竞争格局 | 真实 1,351 行 / 9 词 |
| `listAcosEstimate` | 转化率页的 ACOS/CPA 两列 | 真实 33,019 行 |
| `listBidEstimate` | /cpc-browsetree 竞价 | **seed** 25,074 行 |

路由挂在 `/api/business/wordpick/*`，五条全部实测通过（登录 → 查询 → 校验字段）。

### 13.5 实施中发现并修掉的 3 个问题

**a) `latestWeek()` 按全库最新周过滤会让大量词查不到数据**

ACOS 表 5,849 个词分布在 6 个周，21,369/33,019 行集中在最后一周，
但像 `yoga mat` 只在 `2026-08-16` 有数据。按全库最新周（`2026-08-30`）过滤，
查 `yoga mat` 返回空 —— 用户会以为没数据，实际是周次对不上。

修法：`latestWeek()` 加可选 `keyword` 参数，**传了词就取该词的最新周**。
三个调用点都传上。修复后查 `yoga mat` 自动落到 `2026-08-16`，返回 3 行。

**b) ACOS 表的游标 tie-break 用 keyword 会漏行**

主键是 `(keyword, country, stat_week, match_type, bid_strategy)`，
同一个词有最多 6 行、`keyword` 相同。游标只用 `keyword` 做 tie-break 时，
翻页会跳过同词的其余组合。改成用 `CONCAT(keyword,'|',match_type,'|',bid_strategy)`
三元组，游标存 4 个值。

**c) seed 灌库的语句切分吞掉了第一批 INSERT**

`--apply` 按 `;\n` 切分后用 `s.startsWith('--')` 过滤注释行 ——
但生成文件里注释与其后的 INSERT 之间只有换行没有分号，
切出来的第一块是「注释 + 第一条 INSERT」，整块被丢掉（少灌 200 行，
表现为 `halloween decorations` 这个词凭空消失）。
修法：**先按行剥注释再判空**，不按整块判断。

另外 Doris 会在批量写约 125 批后主动断开连接（`ECONNRESET`），
数据其实已写入但后续语句全失败。加了捕获 + 重连 + 重放当前批
（Unique Key 覆盖，重放安全）。

### 13.6 前端未做

第 1 期的 13 人日估算里前端占大部分，本次只完成数据层与后端。
四个页面的 Vue 视图、动态列渲染、ACOS 按毛利率实时算、类目分组展示等待后续。

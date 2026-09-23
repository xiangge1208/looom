# Looom Doris 数据库设计 v2（目标态）

> 日期：2026-09-22 ｜ 状态：**权威设计文档**
>
> ⚠️ **本文档正文描述的是「目标态」，不是当前库。当前库实况见 §14**（2026-09-22 全量重核）。
> 目标态 = M10~M15 全部落地后的样子；有些计划表**至今未建**，§14.2 列了清单。
>
> 两份旁证文档，冲突时以本文档 §12/§14 为准：
> - §12 = 0.5 期（`db/schema-07-m13-rework.sql`）执行后的校订，**9 处偏离原设计**，
>   其中 3 处是本文档原设计错误，照建会出问题：§12.2（重复列）、§12.4（推断值进主键）、
>   §12.5b（JOIN 取属性会 75% 空白）。
> - §14 = 2026-09-22 对 Doris 的**全量重核**，修正了此前所有版本的表数口径错误。
>
> 依据：Doris 实况全量快照（65 张物理表 DDL + 行数，存 [audit/doris-ddl-snapshot.sql](audit/doris-ddl-snapshot.sql)
> —— 该快照为 2026-09-21 的 59 张，**已过期**，重核结果见 §14）、
> 表结构差距分析（[DORIS_SCHEMA_GAP_ANALYSIS.md](DORIS_SCHEMA_GAP_ANALYSIS.md)）、
> 修订版实现计划（[ROADMAP_UNBUILT_MODULES.md](ROADMAP_UNBUILT_MODULES.md) 顶部修订表）。
>
> **定位**：本文档描述 M10~M15 全部落地后的**目标态**，并给出从现状到目标态的完整变更清单。
> 实施顺序遵循 ROADMAP 分期；本文档不管排期。
> **取代** `ER_BUSINESS.md` 的表分组与主键描述（该文档仍写 keyword_id 主键，已过期）；
> 列级值域细节以各表 COMMENT 和 `DATA_DICTIONARY.md` 为准。

---

## 0. 总览

> ⚠️ **本节于 2026-09-22 按实况重写**。原表写「现状 59 / 目标态 69」，两个数都不对：
> 实为 **65 张物理表 = 61 张逻辑表 + 4 张分区迁移残留**（§14.1）。
> 目标态重算为 **71 张**（§14.2）。
> **完整的逐表字段清单见 §15**（65 张全覆盖，程序化生成，非手工誊写）。

### 0.1 现状（实查，2026-09-22）

| 域 | 张数 | 说明 |
|---|---:|---|
| 用户与权限（users/roles/user_roles/refresh_tokens/api_keys） | 5 | — |
| 积分（credit_*） | 2 | — |
| AI（ai_tasks / ai_analyses） | 2 | — |
| 用户资产（query_logs/favorites/ad_note/system_configs） | 4 | — |
| 字典（dict_* ×10） | 10 | `dim_recommend_column` 不算在内（归推荐专栏） |
| 商品 / 流量 / 多变体 | 17 | dim_asin 族 + 销量/快照/事件/多变体 |
| 关键词 | 13 | dim_keyword 族 + 指标/趋势/排名/ACOS/竞价/份额 |
| 广告 | 4 | dim_ad_campaign / dim_ad_product_ad / 关系表 / 曝光表 |
| 推荐专栏 | 3 | 含 `dim_recommend_column`(143) |
| 供应商（占位） | 1 | `dim_supplier`，本期不接采集 |
| **逻辑表小计** | **61** | |
| ⚠️ 分区迁移残留（待删） | 4 | §14.1 末尾给了 DROP 命令 |
| **物理表合计** | **65** | |

### 0.2 目标态（M10~M15 全部落地）

| 域 | 现状 | 目标态 | 变化 |
|---|---:|---:|---|
| 用户与权限 | 5 | 5 | — |
| 积分 | 2 | 2 | — |
| AI | 2 | 2 | — |
| 用户资产 | 4 | **7** | +库体系三张（M15a）；favorites 已重建键 |
| 字典 | 10 | 10 | +1 **行** `rec` 渠道（已执行，不是加表） |
| 商品 / 流量 / 多变体 | 17 | 17 | — |
| 关键词 | 13 | **19** | +6 新建（拓词 2、品类拓词 1、周期产品 1、小时排名 1…）、−1 删 `rel_keyword_group` |
| 广告 | 4 | 4 | — |
| 推荐专栏 | 3 | 3 | — |
| 供应商 | 1 | 1 | — |
| 排名监控（M14 新设） | 0 | **2** | +`rank_monitor`、+`fact_keyword_rank_hourly` |
| **合计** | **61** | **71** | 详见 §14.2（未建表清单） |

> **未建表清单（11 张）与重算过程见 §14.2。** 其中 8 张属 M12/M14/M15a 的排期，
> 3 张（`fact_keyword_bid_estimate`、`rel_keyword_asin_traffic_share`、
> `fact_keyword_acos_estimate`）**已建成**，§14.2 已把这笔账算清。

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

## 2. 用户与权限 / 积分 / AI（**9 张**，全部不变）

> 原写「10 张」是计数错误：`roles` / `user_roles` 在表里占一行但实为两张表，
> 1+2+1+1（用户权限）+ 2（积分）+ 2（AI）= **9**。实查确认见 §15.2~§15.4。

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

## 3. 字典表（**10 张**，1 处增量）

> 原写「11 张」把 `dim_recommend_column` 算了进来。它虽是动态维度，
> 但主键是 `(rec_title, country)` 而非 `code`，结构不同且语义属推荐专栏域，
> **本表与 §15 都把它归推荐专栏**，故字典表实为 10 张。

`dict_ad_type / dict_bought_bucket / dict_dimension / dict_keyword_tag / dict_match_type /
dict_op_event_type / dict_sort_field / dict_time_piece / dict_variant_role / dict_traffic_channel`。

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

## 4. 商品域（**11 张**，全部不变）

> 原写「10 张」漏数 —— 末行 `fact_asin_multinf_keyword` / `_variant` 是**两张表**。
> 实查 11 张（§15.7）。
> ⚠️ 注意 §4~§6 是**设计期的域划分**，与 §15 的域划分不完全一致
> （如 `dim_festival` 本文档放 §5、§15 放商品/流量域）。**以 §15 为准**，
> 本节仅描述设计意图。

| 表 | 主键 | 行数 | 服务于 |
|---|---|---:|---|
| `dim_asin` | (asin, country) | 59,951 | 全域商品主档（图/价/评/上架日/BS 标/父子体） |
| `dim_asin_feature` | (asin, country, feature_name) | 43,796 | M10 对比销量「属性」列 |
| `rel_asin_variant` | (parent_asin, child_asin, country) | 12,779 | 变体组、流量占比 |
| `fact_asin_bought_monthly` | (asin, country, stat_month) | 810,751 | M10 对比销量：40 个月（2023-05 起）逐月序列；`bought_lower_bound`(排序用)+`bought_label`(展示用) 双列 |
| `fact_asin_listing_snapshot` | (asin, country, stat_month) | 52,600 | Listing 月度指标快照 |
| `fact_asin_subbsr_snapshot` | (asin, country, cat_name, stat_date) | 1,676,452 | 子类目 BSR，**按月自动分区**（全库最大表） |
| `fact_asin_op_event` | (asin, country, stat_date, event_type) | 74,013 | 运营时光机事件流 |
| `fact_asin_keyword_inout` | (asin, country, keyword, stat_date, change_type) | 8,912 | 进出前 3 页事件 |
| `fact_asin_multinf_daily` | (asin, country, stat_date) | 11,015 | 多变体自然位日聚合 |
| `fact_asin_multinf_keyword` | (asin, country, keyword, …) | 4,453 | 多变体×关键词区间聚合（M4 已用） |
| `fact_asin_multinf_keyword_variant` | (parent_asin, country, keyword, variant_asin, …) | 15,176 | 多变体×关键词×变体明细 |

## 5. 流量 / 反查 / 广告 / 推荐域（**16 张**）

> 原写「17 张」，实查本节列举 16 张。行数已按 2026-09-22 实况更新
> —— 其中两张**此前记作 0 的表已不再是空表**（见 §14.4）。

`fact_asin_traffic_channel`(151,917)、`fact_asin_keyword_overview`(3,745)、
`fact_asin_keyword_snapshot`(19,155，反查主表)、`fact_asin_keyword_score`(19,155，M10 动态列源)、
`rel_asin_keyword_variant_exposure`(**743**)、`dim_ad_campaign`(5,928)、`dim_ad_product_ad`(337)、
`rel_ad_campaign_product_ad`(174)、`fact_ad_search_term_exposure`(**1,887**)、
`rel_rec_column_campaign_keyword`(**9,144**)、`fact_asin_rec_column_period`(64)、
`dim_recommend_column`(143，M10 flowResources 同一实体)、`dim_festival`(156)、
`dim_supplier`(50)、`dim_word`(33)、`fact_word_frequency`(0)。

> M10 判断「零 ETL 零建表」成立：对比三 Tab 全部从上表现有表组合（§4+§5），
> 动态列/组内最优均为查询层现算。唯一数据缺口是 `rec` 渠道行（§3，已补）。

---

## 6. 关键词域（9 → 15 张，本计划主战场）

> ⚠️ 标题的「9 → 15」是撰写时口径，与 §15 实查的 **13 张**不一致
> （差在品类拓词/周期产品等计划表未建，且 `fact_asin_keyword_overview`
> 等被本文档算进了 §5）。**关键词域当前 13 张，见 §15.8。**

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

净变化：**+11 新建 −1 删除**（RENAME 不变数量）。

> ⛔ **本节的「59 → 69」两端都错**（2026-09-22 实查）：起点是 **61** 张逻辑表（不是 59），
> 终点是 **71**（不是 69，因 §14.2 发现 11 张未建而本节只列了 8 张 CREATE）。
> 而且到本文档更新时，清单里 **#2、#5、#5b 已执行完毕**，不应再算作「待做」。
> 逐条执行状态见 §14.2。

## 10. schema 文件组织与同步点

| 文件 | 内容 | 状态 |
|---|---|---|
| schema-01 ~ 06 | 既有（系统/业务/gap/文本键/分区/M13 第一版） | 已应用，不再改 |
| **schema-07-m13-rework.sql** | 变更 #1~#5b（改名拆维 + 新竞价表 + metric 加列 + rec 行 + 份额表 + favorites 重建） | ✅ 已写已执行（386 行） |
| **db/gen-seed-unbuilt.mjs** → `db/seed-unbuilt.sql` | M13 竞价页 seed（25,074 行）。新表的 seed 都走这里，**不改 gen-seed.mjs**（那个还是 schema-04 之前的 keyword_id 版本，重跑会回退设计） | ✅ 已写 |
| **schema-08-fix-garbled-comments.sql** | 修 6 个列 COMMENT 的编码损坏（GBK 误传，有损不可逆，按原文重建） | ✅ 已写已执行 |
| **schema-09-rec-column-trend.sql** | `fact_rec_column_trend` 推荐专栏按天活动数/词数 | ✅ 已写已执行 |
| **schema-10-daily-grain.sql** | 日粒度快照 + 流量归因 + 扩 ABA 趋势 + 两张待源空表（详见 §16） | ✅ 已写已执行 |
| **schema-11-m14-rank-monitor.sql** | #6 | 第 2 期写 |
| **schema-12-m15-libraries.sql** | #7 | 第 3 期写 |
| **schema-13-m12-expand.sql** | #8 | 第 5 期写 |
| **schema-14-m11-timemachine.sql** | #9 | 第 6 期写 |

> ⚠️ **编号预留表已于 2026-09-23 修正**。原先把 08/09/10/11 预留给了
> m14-rank-monitor / m15-libraries / m12-expand / m11-timemachine，
> 但实际落盘的 08/09/10 是 fix-garbled-comments / rec-column-trend / daily-grain
> —— 编号被插队占用而文档没回写。现按磁盘实况重排，未写的四个顺延到 11~14。
> 教训：**新建 schema 文件时先来这张表登记再动手**，不要凭预留编号直接命名。

每个新 schema 文件必须：`CREATE TABLE IF NOT EXISTS`；DDL 变更（RENAME/ADD COLUMN/DROP）
写成「检查已应用则跳过」的守卫块（参照 schema-05 的分区迁移写法）。
**同步三处**：`scripts/setup-doris.sh`、`apps/api/scripts/init-db.mjs` 的 FILES 数组、
`apps/api/Dockerfile` 的 COPY。

> 📋 **一张新表的完整落地链是四处，不是三处**（2026-09-23 补记，
> 起因是 `fact_rec_column_trend` 已被后端消费却在文档里一处未提）：
>
> 1. `db/schema-NN-xxx.sql` —— DDL
> 2. `scripts/<loader>.mjs` —— ETL
> 3. `apps/api/src/business/<domain>.service.ts` —— 查询，**注释里回指 schema 文件**
>    以便读到那边的口径警告（`insights.service.ts` 就是这么写的）
> 4. 上面那三个建库同步点
>
> 外加文档两处：本文件 §10 表 + §15 字段清单（生成），以及 `MODULE_DATA_FLOW.md`
> 对应模块的 `### <表名> ← <源>` 段。
>
> ⚠️ **`CREATE TABLE IF NOT EXISTS` 这条不是形式要求**。schema-09 当初写了
> `DROP TABLE IF EXISTS` + 裸 CREATE，那时它不在自动执行流里所以没出事；
> schema-10 这轮把 `setup-doris.sh` 改成显式数组后它被**无条件执行**，
> 再跑一次建库脚本就会删掉已灌的 357 行真实采集数据
> （而那份数据的采集要在已登录浏览器里现签 `_m` 参数，重采成本很高）。
> 已于 2026-09-23 改回 `IF NOT EXISTS` 并实测重跑后行数不变。

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

> ✅ **2026-09-23 第二轮同步（schema-10）**，并修掉了上一轮留下的两个隐患：
>
> 1. `setup-doris.sh` 的通配符 **已改成显式数组 `SCHEMA_FILES`**。
>    原 glob `schema-0[!457]-*.sql` 只能匹配 `schema-0x`，schema-10 起会被
>    **静默漏掉**（表建不出来但脚本 exit 0，是最难查的失败）。
>    上一轮注释里就预告了「将来有 schema-1x 需改成显式列表」，这次到期了。
>    文件不存在时现在会打印警告而不是静默 continue。
> 2. `init-db.mjs` 的 FILES 与 `Dockerfile` 的 COPY **此前都漏了 schema-08/09**
>    —— 又一次重演本节警告的问题。本次一并补上 08/09/10。
>
> 现状：三处都包含 01/02/03/06/08/09/10（04/05/07 按各自的守卫单独处理）。
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

> ⛔ **本节结论已于 2026-09-22 再次修正，见 §14.2/§14.3。**
> 下面的「现状 63 张（含 2 张待删旧表）」**只算了 `_old`，漏了两张 `_new`**，
> 且起点「59」本身是错的。**权威口径：65 张物理表 = 61 张逻辑表 + 4 张残留。**
> 保留原文仅作修订过程记录。

原表「合计 59 → 69（+11 新建、−1 删除、5 张改造）」。0.5 期执行后：

```
59（起点）
 +1  fact_keyword_acos_estimate     （改名而来，但同时保留了 v1 旧表 → 实际 +2）
 +1  fact_keyword_bid_estimate      （新语义重建）
 +1  rel_keyword_asin_traffic_share
 +1  user_favorites                 （重建，旧表 user_favorites_old_pk 保留 → 实际 +2）
= 撰写时结论：63 张（含 2 张待删旧表）
```

❌ 上面这段有两处错（2026-09-22 实查）：
1. **漏算 `_new` 残留** —— 分区迁移的 RENAME 链是「原表→`_old`、`_new`→正式名」，
   所以两组各留 **2 张**（`_old` + `_new`），不是 2 张而是 4 张。本节只数了 `_old`。
2. **`user_favorites_old_pk` / `fact_keyword_acos_estimate_v1` 早已被 DROP**，
   现在库中不存在 —— 那 2 张不该计入。

✅ 正确账目：

```
现状 65 张物理表
 − 4 张分区迁移残留（2 组 × _old/_new）
 = 61 张逻辑表
```
剩余 11 张计划表未建，全部落地后目标态 **71 张**。详见 §14.1 / §14.2。

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

---

## 14. 全量重核（2026-09-22）

> 触发原因：核对本 ASIN 落库时发现 §0 与 §12.10 的**表数口径互相矛盾且都不对**。
> 方法：`SHOW TABLES` + `information_schema.columns` + 逐表 `SHOW CREATE TABLE` + `COUNT(*)`，
> 全部 65 张表重跑一遍（不依赖此前任何文档的快照）。
> **本节是当前库的权威描述。与正文其他节冲突时以本节为准。**

### 14.1 当前库实况：65 张物理表 = 61 张逻辑表 + 4 张迁移残留

此前三个不同数字（§0 的 59、§12.10 的 63/61、快照的 59）**没有一个对上**。真实值：

**65 张物理表**，其中 **4 张是分区迁移的中间产物**（`db/schema-05-partitions.sql`
刻意保留待人工核对后手动 DROP），扣除后 **61 张逻辑表**。

| 域 | 张数 | 表（行数） |
|---|---:|---|
| 用户与权限 | 5 | `users`(6)、`roles`(2)、`user_roles`(2)、`refresh_tokens`(143)、`api_keys`(0) |
| 积分 | 2 | `credit_accounts`(6)、`credit_transactions`(6) |
| AI | 2 | `ai_tasks`(4)、`ai_analyses`(4) |
| 用户资产 | 4 | `query_logs`(372)、`user_favorites`(0)、`sys_user_ad_note`(0)、`system_configs`(7) |
| 字典 dict_ | 10 | `dict_ad_type`(4)、`dict_bought_bucket`(9)、`dict_dimension`(3)、`dict_keyword_tag`(3)、`dict_match_type`(3)、`dict_op_event_type`(6)、`dict_sort_field`(4)、`dict_time_piece`(3)、`dict_traffic_channel`(13)、`dict_variant_role`(3) |
| 商品/流量/多变体 | 17 | `dim_asin`(59,951)、`dim_asin_feature`(43,796)、`dim_festival`(156)、`rel_asin_variant`(12,779)、`fact_asin_bought_monthly`(810,751)、`fact_asin_listing_snapshot`(52,600)、`fact_asin_subbsr_snapshot`(1,676,452)、`fact_asin_op_event`(74,013)、`fact_asin_keyword_inout`(8,912)、`fact_asin_traffic_channel`(151,917)、`fact_asin_keyword_overview`(3,745)、`fact_asin_keyword_snapshot`(19,155)、`fact_asin_keyword_score`(19,155)、`rel_asin_keyword_variant_exposure`(743)、`fact_asin_multinf_daily`(11,015)、`fact_asin_multinf_keyword`(4,453)、`fact_asin_multinf_keyword_variant`(15,176) |
| 关键词 | 13 | `dim_keyword`(13,872)、`dim_word`(33)、`fact_word_frequency`(0)、`rel_keyword_group`(0)、`rel_keyword_top_asin`(56,795)、`fact_keyword_search_trend`(178,092)、`fact_keyword_metric_snapshot`(22,321)、`fact_keyword_rank_history`(119,670)、`fact_keyword_competition_snapshot`(21,329)、`fact_keyword_conversion_funnel`(5,875)、`fact_keyword_acos_estimate`(33,019)、`fact_keyword_bid_estimate`(25,074)、`rel_keyword_asin_traffic_share`(1,351) |
| 广告 | 4 | `dim_ad_campaign`(5,928)、`dim_ad_product_ad`(337)、`rel_ad_campaign_product_ad`(174)、`fact_ad_search_term_exposure`(1,887) |
| 推荐专栏 | 3 | `rel_rec_column_campaign_keyword`(9,144)、`fact_asin_rec_column_period`(64)、`dim_recommend_column`(143) |
| 供应商（占位） | 1 | `dim_supplier`(50) |
| **逻辑表小计** | **61** | |
| ⚠️ 分区迁移残留（**待删**） | 4 | `fact_asin_subbsr_snapshot_old`(1,654,767)、`fact_asin_subbsr_snapshot_new`(1,654,767)、`fact_keyword_rank_history_old`(117,740)、`fact_keyword_rank_history_new`(117,740) |
| **物理表合计** | **65** | |

> **`dim_recommend_column` 归域**：它按 §3 的口径与 `dict_*` 同列
> （动态维度，143 行），但结构并不相同（主键是 `(rec_title, country)` 而非 `code`），
> 且语义上属推荐专栏域。**本表与 §15 均归入「推荐专栏」，故该域 3 张、字典域 10 张。**

**4 张残留表的处置**：`schema-05` 的注释写明「旧表先留成 `_old`，人工核对行数后再手动 DROP」。
现在核对结论是**两组的行数已完全一致**（子类目 BSR 1,654,767 = 1,654,767；
排名历史 117,740 = 117,740），且**主表分区数正常**
（`fact_asin_subbsr_snapshot` 44 个分区、`fact_keyword_rank_history` 32 个分区，
而 `_old` 分别只剩 0/2 个 —— 说明 `_new` 的那份才是带分区的正式版）。
清理命令：

```sql
DROP TABLE looom.fact_asin_subbsr_snapshot_old;
DROP TABLE looom.fact_asin_subbsr_snapshot_new;   -- ⚠️ RENAME 后仍是中间名残留
DROP TABLE looom.fact_keyword_rank_history_old;
DROP TABLE looom.fact_keyword_rank_history_new;
```

> ⚠️ 删前务必先确认 `_new` 确实无用 —— `schema-05` 的 RENAME 链是
> `原表→_old`、`_new→正式名`，所以正式名的那张已是 `_new` 的数据，
> 剩余的 `_new` 是**空壳残留**（行数相同是因为 RENAME 是改名不是复制）。

### 14.2 目标态重算：69 这个数**偏高**

§9 的「59 → 69（+11 新建 −1 删除）」建立在错误起点上。按当前实况重算：

```
现状 61 张逻辑表
 − 0   （§9 计划删的 rel_keyword_group 仍在，0 行，未删）
 − 0   （user_favorites 已重建键，仍在，属改造不是删除）
= 61

目标态未建的表（§6.3 / §7 / §8 计划，实查全部不存在）：
  ❌ fact_keyword_expand               （§6.3 ③，M12）
  ❌ fact_keyword_category_expand      （§6.3 ④，M12）
  ❌ dim_niche_category                （M12）
  ❌ rank_monitor                      （§7，M14）
  ❌ fact_keyword_rank_hourly          （§7，M14）
  ❌ user_library / user_library_item / user_library_*（§8.2，M15a，三张）
  ❌ fact_keyword_period_product       （§9 #9，第 6 期）
= 11 张未建

若全部落地：61 + 11 − 1（删 rel_keyword_group）= 71 张
```

> **结论**：目标态不是 69 而是 **71**（若 `rel_keyword_group` 最终不删则 72）。
> 差异来源是 §9 的起点写错（59 而非 61）+ 未计入 `rel_keyword_asin_traffic_share`
> 与 `fact_keyword_acos_estimate` 的净增（它们已建成，§12.10 已提过这点）。

### 14.3 本次重核修正的文档错误

| # | 位置 | 原写法 | 更正 |
|---|---|---|---|
| 1 | §0 总览「现状 59」 | 59 | **65 物理 / 61 逻辑**（§14.1） |
| 2 | §0「目标态 69」 | 69 | **71**（§14.2 重算） |
| 3 | §12.10「现状 63 张（含 2 张待删旧表）」 | 63 / 待删 2 张 | **65 物理表，待删 4 张**（多出的 2 张是 `*_new` 残留，§12.10 只算了 `_old`） |
| 4 | §12.10「两张旧表 DROP 后为 61 张」 | 61 | **对上**（61 是逻辑表数，与本节一致） |
| 5 | 头部依据行「59 张表 DDL 快照」 | 59 | 快照为 2026-09-21 状态，**已过期**；实况见 §14.1 |

### 14.4 与本次 ASIN 落库相关的新增事实

2026-09-22 为 `B01NBNDC1T`（US）补齐数据时，有 **5 张此前为空的表被填充**，
其中 2 张的含义与 §5 的描述需要更新：

| 表 | §5/§11 原描述 | 实况 |
|---|---|---|
| `fact_ad_search_term_exposure` | 「(0)」—— 曾判为**建不起来**（主键在 `keyword_id` 上闭合不了） | **1,887 行**。改用 `(keyword, country)` 文本键即可闭合 —— 该表主键早已是文本键，原判断基于过时假设。`ads.service.ts` 已改回走此表，活动覆盖从 4 个升至 21 个 |
| `rel_asin_keyword_variant_exposure` | 「(0)」 | **743 行** |
| `fact_asin_multinf_keyword_variant` | 14,935 | 15,176（+241，来自逐变体采集） |
| `rel_rec_column_campaign_keyword` | 9,086 | 9,144（+58） |
| `fact_asin_keyword_snapshot` | 19,095 | 19,155（+60，来自 16 个变体各自的头部词） |

> ⚠️ **一条对 ETL 有普遍意义的结论**：`fact_ad_search_term_exposure` 曾被判定为
> 「恒空、无源」，理由是「上游 `web-variant-ad-keywords` 只给关键词文本不给 keywordId，
> 回查字典 835 词仅 15 个可解（1.8%）」。
> 但 schema-04 早已把关键词表主键改成 `(keyword, country)` 文本键 ——
> **按文本就能闭合，keywordId 缺失根本不影响建表**。
> 该结论（写在 `ads.service.ts` 注释与 `MODULE_DATA_FLOW.md` 模块 7-9 里）建立在过时假设上，
> 已随本次落库一并修正。**凡「因某个 ID 列缺失而判定无源」的结论，都要复查一遍。**

## 15. 全表字段清单（65 张，直接生成自 Doris 实况）

> 本节由 `.tmp/real-ddl.sql`（逐表 `SHOW CREATE TABLE` + `COUNT(*)`）**程序化生成**，
> 非手工誊写 —— 65 张表逐字段手抄必然出错。
>
> **65 张物理表 = 61 张逻辑表 + 4 张分区迁移残留**。
> 每张表给出：行数、表注释、主键、分桶、分区、倒排索引、逐列类型与说明。
> 行数是 2026-09-22 快照值 —— 数据在持续 ETL，**引用前请重查**。

### 15.1 分域速查

| 域 | 逻辑表数 | 物理表数 |
|---|---:|---:|
| 用户与权限 | 5 | 5 |
| 积分 | 2 | 2 |
| AI 任务 | 2 | 2 |
| 用户资产 | 4 | 4 |
| 字典表 dict_ | 10 | 10 |
| 商品 / 流量 / 多变体 | 17 | 17 |
| 关键词 | 13 | 13 |
| 广告 | 4 | 4 |
| 推荐专栏 | 3 | 3 |
| 供应商（占位） | 1 | 1 |
| 迁移残留 | 0 | 4 |
| **合计** | **61** | **65** |

### 15.2 用户与权限（5 张）

| 表 | 行数 | 主键 | 说明 |
|---|---:|---|---|
| [`api_keys`](#api_keys) | 0 | `id` | API Key。明文 key 绝不落库、不进日志 |
| [`refresh_tokens`](#refresh_tokens) | 145 | `id` | 刷新令牌。过期清理用定时任务批量 DELETE，不要逐条删 |
| [`roles`](#roles) | 2 | `id` | 角色表 |
| [`user_roles`](#user_roles) | 2 | `id` | 用户角色关联（应用层维护，无外键） |
| [`users`](#users) | 6 | `id` | 用户主表 |


#### api_keys

> API Key。明文 key 绝不落库、不进日志

- **行数** 0 ｜ **主键** `id` ｜ **分桶** `HASH(id)` × 1
- **倒排索引** `idx_ak_prefix`(key_prefix)

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `id` | `bigint` | 否 | 雪花 ID |
| `user_id` | `bigint` | 否 | 用户 ID |
| `name` | `varchar(64)` | 否 | 用户自定义名称 |
| `key_prefix` | `varchar(16)` | 否 | 明文前缀，列表页只展示这个 |
| `key_hash` | `varchar(128)` | 否 | 完整 key 的 SHA-256，明文只在创建时返回一次 |
| `scopes` | `varchar(255)` | 是 | 权限范围，逗号分隔 |
| `last_used_at` | `datetime` | 是 | 最后使用时间 |
| `expires_at` | `datetime` | 是 | 过期时间，NULL=永不过期 |
| `revoked_at` | `datetime` | 是 | 吊销时间，NULL=有效 |
| `created_at` | `datetime` | 否 | 创建时间 |

#### refresh_tokens

> 刷新令牌。过期清理用定时任务批量 DELETE，不要逐条删

- **行数** 145 ｜ **主键** `id` ｜ **分桶** `HASH(id)` × 2
- **倒排索引** `idx_rt_user`(user_id)

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `id` | `bigint` | 否 | 雪花 ID |
| `user_id` | `bigint` | 否 | 所属用户 |
| `token_hash` | `varchar(128)` | 否 | refresh token 的 SHA-256，不存明文 |
| `expires_at` | `datetime` | 否 | 过期时间（建议 30 天） |
| `revoked_at` | `datetime` | 是 | 主动吊销时间，NULL=有效 |
| `user_agent` | `varchar(512)` | 是 | 签发时 UA，用于登录设备管理 |
| `ip` | `varchar(64)` | 是 | 签发时 IP |
| `created_at` | `datetime` | 否 | 签发时间 |

#### roles

> 角色表

- **行数** 2 ｜ **主键** `id` ｜ **分桶** `HASH(id)` × 1

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `id` | `bigint` | 否 | 雪花 ID |
| `code` | `varchar(32)` | 否 | 角色码：admin / user |
| `name` | `varchar(64)` | 否 | 中文名 |
| `permissions` | `text` | 是 | JSON 数组，权限点列表 |
| `created_at` | `datetime` | 是 | 创建时间 |

#### user_roles

> 用户角色关联（应用层维护，无外键）

- **行数** 2 ｜ **主键** `id` ｜ **分桶** `HASH(id)` × 1
- **倒排索引** `idx_ur_user`(user_id)

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `id` | `bigint` | 否 | 雪花 ID |
| `user_id` | `bigint` | 否 | 用户 ID |
| `role_id` | `bigint` | 否 | 角色 ID |
| `created_at` | `datetime` | 是 | 创建时间 |

#### users

> 用户主表

- **行数** 6 ｜ **主键** `id` ｜ **分桶** `HASH(id)` × 2
- **倒排索引** `idx_users_email`(email)

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `id` | `bigint` | 否 | 雪花 ID（应用层生成） |
| `email` | `varchar(190)` | 否 | 登录邮箱，应用层保证唯一 |
| `password_hash` | `varchar(100)` | 否 | bcrypt 哈希，cost=10 |
| `nickname` | `varchar(64)` | 是 | 昵称 |
| `avatar_url` | `varchar(512)` | 是 | 头像地址，默认占位图 |
| `status` | `tinyint` | 是 | 1=正常 0=停用 2=封禁 |
| `default_country` | `varchar(8)` | 是 | 默认站点，对应原站 countryCode |
| `last_login_at` | `datetime` | 是 | 最后登录时间 |
| `last_login_ip` | `varchar(64)` | 是 | 最后登录 IP |
| `is_deleted` | `tinyint` | 是 | 软删除标记 |
| `created_at` | `datetime` | 否 | 创建时间 |
| `updated_at` | `datetime` | 是 | 更新时间 |

### 15.3 积分（2 张）

| 表 | 行数 | 主键 | 说明 |
|---|---:|---|---|
| [`credit_accounts`](#credit_accounts) | 6 | `user_id` | 积分账户。余额权威值在 Redis，本表为快照 |
| [`credit_transactions`](#credit_transactions) | 6 | `id` | 积分流水 |


#### credit_accounts

> 积分账户。余额权威值在 Redis，本表为快照

- **行数** 6 ｜ **主键** `user_id` ｜ **分桶** `HASH(user_id)` × 2

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `user_id` | `bigint` | 否 | 主键即 user_id，一人一账户 |
| `balance` | `decimal(16,4)` | 否 | 当前余额（实测原站为浮点） |
| `total_recharged` | `decimal(16,4)` | 是 | 累计充值 |
| `total_consumed` | `decimal(16,4)` | 是 | 累计消耗 |
| `frozen` | `decimal(16,4)` | 是 | 冻结中（AI 任务预扣，失败退还） |
| `channel` | `varchar(16)` | 是 | 账号渠道，实测原站返回 personal |
| `integral_limit` | `decimal(16,4)` | 是 | 积分上限，实测原站有此字段 |
| `version` | `bigint` | 是 | 乐观锁版本号 |
| `updated_at` | `datetime` | 是 | 更新时间 |

#### credit_transactions

> 积分流水

- **行数** 6 ｜ **主键** `id` ｜ **分桶** `HASH(id)` × 2
- **倒排索引** `idx_ct_user`(user_id)

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `id` | `bigint` | 否 | 雪花 ID |
| `user_id` | `bigint` | 否 | 用户 ID |
| `type` | `varchar(32)` | 否 | recharge/consume/refund/gift/expire |
| `amount` | `decimal(16,4)` | 否 | 变动值，正=增 负=减 |
| `balance_after` | `decimal(16,4)` | 否 | 变动后余额（冗余，便于对账） |
| `biz_type` | `varchar(32)` | 是 | query_asin/query_keyword/ai_analysis/export |
| `biz_id` | `varchar(64)` | 是 | 关联业务 ID |
| `remark` | `varchar(255)` | 是 | 备注 |
| `created_at` | `datetime` | 否 | 创建时间 |

### 15.4 AI 任务（2 张）

| 表 | 行数 | 主键 | 说明 |
|---|---:|---|---|
| [`ai_analyses`](#ai_analyses) | 4 | `id` | AI 分析结果 |
| [`ai_tasks`](#ai_tasks) | 4 | `id` | AI 任务。缓存命中查 (insert_point, prompt_version, input_hash) 且 status=success |


#### ai_analyses

> AI 分析结果

- **行数** 4 ｜ **主键** `id` ｜ **分桶** `HASH(id)` × 2
- **倒排索引** `idx_aa_task`(task_id)

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `id` | `bigint` | 否 | 雪花 ID |
| `task_id` | `bigint` | 否 | 关联 ai_tasks.id |
| `user_id` | `bigint` | 否 | 冗余，便于按用户查 |
| `insert_point` | `varchar(64)` | 否 | 冗余 |
| `content_md` | `text` | 否 | Markdown 结论，前端 markdown-it 渲染 |
| `prompt_tokens` | `int` | 是 | 输入 token 数 |
| `completion_tokens` | `int` | 是 | 输出 token 数 |
| `total_tokens` | `int` | 是 | 计费依据 |
| `created_at` | `datetime` | 否 | 创建时间 |

#### ai_tasks

> AI 任务。缓存命中查 (insert_point, prompt_version, input_hash) 且 status=success

- **行数** 4 ｜ **主键** `id` ｜ **分桶** `HASH(id)` × 2
- **倒排索引** `idx_at_hash`(input_hash)、`idx_at_user`(user_id)

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `id` | `bigint` | 否 | 雪花 ID |
| `user_id` | `bigint` | 否 | 用户 ID |
| `insert_point` | `varchar(64)` | 否 | 插入点：sales-trend/keyword-recommend/traffic-insight/supplier-evaluate/ad-optimize/diagnosis |
| `prompt_version` | `varchar(16)` | 否 | prompt 版本，如 v1 |
| `input_hash` | `varchar(64)` | 否 | 输入 SHA-256，命中缓存不重复扣费 |
| `input_payload` | `text` | 是 | 输入快照 JSON，便于复现 |
| `status` | `varchar(16)` | 否 | pending/running/success/failed/cancelled |
| `provider` | `varchar(32)` | 是 | openai-compatible / mock |
| `model` | `varchar(64)` | 是 | 实际使用的模型名 |
| `retry_count` | `tinyint` | 是 | 重试次数，上限 2 |
| `credits_frozen` | `decimal(16,4)` | 是 | 预扣积分，失败时退还 |
| `error_msg` | `varchar(1024)` | 是 | 错误信息 |
| `started_at` | `datetime` | 是 | 开始时间 |
| `finished_at` | `datetime` | 是 | 结束时间 |
| `created_at` | `datetime` | 否 | 创建时间 |

### 15.5 用户资产（4 张）

| 表 | 行数 | 主键 | 说明 |
|---|---:|---|---|
| [`query_logs`](#query_logs) | 372 | `id` | 查询审计。高频写入表，建议批量写 |
| [`sys_user_ad_note`](#sys_user_ad_note) | 0 | `id` | 用户广告备注（仅自己可见） |
| [`system_configs`](#system_configs) | 7 | `config_key` | 系统配置键值对 |
| [`user_favorites`](#user_favorites) | 0 | `user_id, favorite_type, target_type, target_value, country` | 用户关注/监控/订阅。主键即业务唯一键（原先靠应用层保证，M14/M15 高频写会漏）。重复收藏靠 Unique Key 覆盖天然幂等 |


#### query_logs

> 查询审计。高频写入表，建议批量写

- **行数** 372 ｜ **主键** `id` ｜ **分桶** `HASH(id)` × 2
- **倒排索引** `idx_ql_user`(user_id)、`idx_ql_value`(query_value)

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `id` | `bigint` | 否 | 雪花 ID |
| `user_id` | `bigint` | 否 | 用户 ID |
| `query_type` | `varchar(32)` | 否 | asin / keyword / supplier |
| `query_value` | `varchar(255)` | 否 | 查询的 ASIN 或关键词原文 |
| `country` | `varchar(8)` | 否 | 站点 |
| `page_route` | `varchar(64)` | 是 | 从哪个页面发起 |
| `credits_cost` | `int` | 是 | 本次扣分 |
| `result_count` | `int` | 是 | 返回结果数 |
| `duration_ms` | `int` | 是 | 耗时 |
| `status` | `tinyint` | 是 | 1=成功 0=失败 |
| `error_msg` | `varchar(512)` | 是 | 失败原因 |
| `ip` | `varchar(64)` | 是 | 来源 IP |
| `created_at` | `datetime` | 否 | 创建时间 |

#### sys_user_ad_note

> 用户广告备注（仅自己可见）

- **行数** 0 ｜ **主键** `id` ｜ **分桶** `HASH(id)` × 1
- **倒排索引** `idx_uan_user`(user_id)

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `id` | `bigint` | 否 | 雪花 ID |
| `user_id` | `bigint` | 否 | 用户 ID |
| `country` | `varchar(8)` | 否 | 站点 |
| `encrypt_campaign_id` | `varchar(64)` | 否 | 关联广告活动（Sif 内部加密 ID） |
| `campaign_id_a0` | `varchar(64)` | 是 | 用户录入的后台真实活动 ID |
| `campaign_name` | `varchar(255)` | 是 | 用户录入的活动名 |
| `campaign_color` | `varchar(16)` | 是 | 用户设置的标记色 |
| `note` | `varchar(1024)` | 是 | 备注内容 |
| `created_at` | `datetime` | 否 | 创建时间 |
| `updated_at` | `datetime` | 是 | 更新时间 |

#### system_configs

> 系统配置键值对

- **行数** 7 ｜ **主键** `config_key` ｜ **分桶** `HASH(config_key)` × 1

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `config_key` | `varchar(128)` | 否 | 主键，如 credit.cost.query_asin |
| `config_value` | `text` | 否 | 值（标量或 JSON） |
| `value_type` | `varchar(16)` | 是 | string/int/bool/json |
| `group_name` | `varchar(32)` | 是 | 分组：credit/ai/feature_flag/limit |
| `description` | `varchar(255)` | 是 | 中文说明 |
| `updated_at` | `datetime` | 是 | 更新时间 |

#### user_favorites

> 用户关注/监控/订阅。主键即业务唯一键（原先靠应用层保证，M14/M15 高频写会漏）。重复收藏靠 Unique Key 覆盖天然幂等

- **行数** 0 ｜ **主键** `user_id, favorite_type, target_type, target_value, country` ｜ **分桶** `HASH(user_id)` × 2
- **倒排索引** `idx_uf_user`(user_id)

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `user_id` | `bigint` | 否 | 用户 ID（主键） |
| `favorite_type` | `varchar(16)` | 否 | focus 关注 / monitor 监控 / subscribe 订阅（主键） |
| `target_type` | `varchar(16)` | 否 | asin / keyword（主键） |
| `target_value` | `varchar(255)` | 否 | ASIN 或关键词文本（主键）。关键词需 btrim(lower()) 归一 |
| `country` | `varchar(8)` | 否 | 站点（主键） |
| `id` | `bigint` | 是 | 雪花 ID。⚠️ 降为普通列：原先是唯一键，但业务唯一性是那 5 个字段 |
| `keyword_id` | `bigint` | 是 | 关键词时填，关联 dim_keyword。仅供对账，不做关联键 |
| `group_name` | `varchar(64)` | 是 | 用户自建分组。产品库/词库的分组靠这列 |
| `note` | `varchar(512)` | 是 | 备注 |
| `notify_enabled` | `tinyint` | 是 | 仅 subscribe 用：排名变动是否通知 |
| `created_at` | `datetime` | 否 | 创建时间 |
| `library_id` | `bigint` | 是 | 归属库 ID，关联 user_library.id（M15a 建）。替代 group_name 的弱字符串关联 —— 改库名不必改这里每一行。⚠️ M15a 上线前恒为 NULL，届时把 group_name 的值迁成 library_id 并废弃 group_name |

### 15.6 字典表 dict_（10 张）

| 表 | 行数 | 主键 | 说明 |
|---|---:|---|---|
| [`dict_ad_type`](#dict_ad_type) | 4 | `code` | 广告产品类型：1=SP 2=SB 3=SBV 4=SBBV |
| [`dict_bought_bucket`](#dict_bought_bucket) | 9 | `code` | 销量分档枚举 |
| [`dict_dimension`](#dict_dimension) | 3 | `code` | 变体维度切换：变体/Color/Size |
| [`dict_keyword_tag`](#dict_keyword_tag) | 3 | `code` | 关键词标签：isCore/isTarget/isAC 等 |
| [`dict_match_type`](#dict_match_type) | 3 | `code` | 广告匹配类型：Exact/Phrase/Broad |
| [`dict_op_event_type`](#dict_op_event_type) | 6 | `code` | 运营动作类型 |
| [`dict_sort_field`](#dict_sort_field) | 4 | `code` | 列表排序字段白名单 |
| [`dict_time_piece`](#dict_time_piece) | 3 | `code` | 时间粒度：day/month 可用，week 仅广告域可用 |
| [`dict_traffic_channel`](#dict_traffic_channel) | 13 | `code` | 流量渠道类型。⚠️ 原站同一渠道有 5 套字段名，本表是对齐后的规范值 |
| [`dict_variant_role`](#dict_variant_role) | 3 | `code` | 变体角色：父体/子体/兄弟 |


#### dict_ad_type

> 广告产品类型：1=SP 2=SB 3=SBV 4=SBBV

- **行数** 4 ｜ **主键** `code` ｜ **分桶** `HASH(code)` × 1

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `code` | `varchar(32)` | 否 | 枚举内部值 |
| `name_cn` | `varchar(64)` | 是 | 中文展示名 |
| `name_en` | `varchar(64)` | 是 | 英文名/原始值 |
| `sort_order` | `int` | 是 | 展示顺序 |
| `extra` | `varchar(255)` | 是 | 附加信息（颜色、别名等） |

#### dict_bought_bucket

> 销量分档枚举

- **行数** 9 ｜ **主键** `code` ｜ **分桶** `HASH(code)` × 1

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `code` | `varchar(32)` | 否 | 枚举内部值 |
| `name_cn` | `varchar(64)` | 是 | 中文展示名 |
| `name_en` | `varchar(64)` | 是 | 英文名/原始值 |
| `sort_order` | `int` | 是 | 展示顺序 |
| `extra` | `varchar(255)` | 是 | 附加信息（颜色、别名等） |

#### dict_dimension

> 变体维度切换：变体/Color/Size

- **行数** 3 ｜ **主键** `code` ｜ **分桶** `HASH(code)` × 1

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `code` | `varchar(32)` | 否 | 枚举内部值 |
| `name_cn` | `varchar(64)` | 是 | 中文展示名 |
| `name_en` | `varchar(64)` | 是 | 英文名/原始值 |
| `sort_order` | `int` | 是 | 展示顺序 |
| `extra` | `varchar(255)` | 是 | 附加信息（颜色、别名等） |

#### dict_keyword_tag

> 关键词标签：isCore/isTarget/isAC 等

- **行数** 3 ｜ **主键** `code` ｜ **分桶** `HASH(code)` × 1

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `code` | `varchar(32)` | 否 | 枚举内部值 |
| `name_cn` | `varchar(64)` | 是 | 中文展示名 |
| `name_en` | `varchar(64)` | 是 | 英文名/原始值 |
| `sort_order` | `int` | 是 | 展示顺序 |
| `extra` | `varchar(255)` | 是 | 附加信息（颜色、别名等） |

#### dict_match_type

> 广告匹配类型：Exact/Phrase/Broad

- **行数** 3 ｜ **主键** `code` ｜ **分桶** `HASH(code)` × 1

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `code` | `varchar(32)` | 否 | 枚举内部值 |
| `name_cn` | `varchar(64)` | 是 | 中文展示名 |
| `name_en` | `varchar(64)` | 是 | 英文名/原始值 |
| `sort_order` | `int` | 是 | 展示顺序 |
| `extra` | `varchar(255)` | 是 | 附加信息（颜色、别名等） |

#### dict_op_event_type

> 运营动作类型

- **行数** 6 ｜ **主键** `code` ｜ **分桶** `HASH(code)` × 1

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `code` | `varchar(32)` | 否 | 枚举内部值 |
| `name_cn` | `varchar(64)` | 是 | 中文展示名 |
| `name_en` | `varchar(64)` | 是 | 英文名/原始值 |
| `sort_order` | `int` | 是 | 展示顺序 |
| `extra` | `varchar(255)` | 是 | 附加信息（颜色、别名等） |

#### dict_sort_field

> 列表排序字段白名单

- **行数** 4 ｜ **主键** `code` ｜ **分桶** `HASH(code)` × 1

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `code` | `varchar(32)` | 否 | 枚举内部值 |
| `name_cn` | `varchar(64)` | 是 | 中文展示名 |
| `name_en` | `varchar(64)` | 是 | 英文名/原始值 |
| `sort_order` | `int` | 是 | 展示顺序 |
| `extra` | `varchar(255)` | 是 | 附加信息（颜色、别名等） |

#### dict_time_piece

> 时间粒度：day/month 可用，week 仅广告域可用

- **行数** 3 ｜ **主键** `code` ｜ **分桶** `HASH(code)` × 1

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `code` | `varchar(32)` | 否 | 枚举内部值 |
| `name_cn` | `varchar(64)` | 是 | 中文展示名 |
| `name_en` | `varchar(64)` | 是 | 英文名/原始值 |
| `sort_order` | `int` | 是 | 展示顺序 |
| `extra` | `varchar(255)` | 是 | 附加信息（颜色、别名等） |

#### dict_traffic_channel

> 流量渠道类型。⚠️ 原站同一渠道有 5 套字段名，本表是对齐后的规范值

- **行数** 13 ｜ **主键** `code` ｜ **分桶** `HASH(code)` × 1

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `code` | `varchar(32)` | 否 | 枚举内部值 |
| `name_cn` | `varchar(64)` | 是 | 中文展示名 |
| `name_en` | `varchar(64)` | 是 | 英文名/原始值 |
| `sort_order` | `int` | 是 | 展示顺序 |
| `extra` | `varchar(255)` | 是 | 附加信息（颜色、别名等） |

#### dict_variant_role

> 变体角色：父体/子体/兄弟

- **行数** 3 ｜ **主键** `code` ｜ **分桶** `HASH(code)` × 1

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `code` | `varchar(32)` | 否 | 枚举内部值 |
| `name_cn` | `varchar(64)` | 是 | 中文展示名 |
| `name_en` | `varchar(64)` | 是 | 英文名/原始值 |
| `sort_order` | `int` | 是 | 展示顺序 |
| `extra` | `varchar(255)` | 是 | 附加信息（颜色、别名等） |

### 15.7 商品 / 流量 / 多变体（17 张）

| 表 | 行数 | 主键 | 说明 |
|---|---:|---|---|
| [`dim_asin`](#dim_asin) | 59,951 | `asin, country` | ASIN 商品主档（4 个域共用） |
| [`dim_asin_feature`](#dim_asin_feature) | 43,796 | `asin, country, feature_name` | 变体属性。实测：父体 features 是维度名 [\"Size\",\"Color\"]，子体是对应下标取值 [\"Large\",\"Dark Moss\"]，入库需按下标… |
| [`dim_festival`](#dim_festival) | 156 | `festival_name, country, start_date` | 节假日日历（12 节日 × 站点 × 年度窗口，实测 156 行）。源 sif_keyword_aba_trend.festivals |
| [`fact_asin_bought_monthly`](#fact_asin_bought_monthly) | 810,751 | `asin, country, stat_month` | ASIN 月度销量。实测：序列固定 40 个月起点 2023-05；销量是字符串分档（\"200+\"/\"<50\"）故双列并存；父体无销量只存子体 |
| [`fact_asin_keyword_inout`](#fact_asin_keyword_inout) | 8,912 | `asin, country, keyword, stat_date, change_type` | ASIN 关键词进出前 3 页事件。change_type 已纳入主键（原设计遗漏，会静默覆盖） |
| [`fact_asin_keyword_overview`](#fact_asin_keyword_overview) | 3,745 | `asin, country, time_piece_type, time_piece_value, is_listing_search, channel` | ASIN 关键词概览聚合（各渠道的关键词计数） |
| [`fact_asin_keyword_score`](#fact_asin_keyword_score) | 19,155 | `asin, country, keyword, time_piece_type, time_piece_value, channel` | ASIN×关键词×渠道 流量得分长表 |
| [`fact_asin_keyword_snapshot`](#fact_asin_keyword_snapshot) | 19,155 | `asin, country, keyword, time_piece_type, time_piece_value, is_listing_search` | ASIN×关键词 流量与排名快照（反查流量词主表） |
| [`fact_asin_listing_snapshot`](#fact_asin_listing_snapshot) | 52,600 | `asin, country, stat_month` | Listing 指标月度快照（价格、评分、评价数等随时间变化的指标） |
| [`fact_asin_multinf_daily`](#fact_asin_multinf_daily) | 11,015 | `asin, country, stat_date` | 多变体自然位日快照。实测此接口无 timePiece 参数，直接返回逐日 dates 数组 |
| [`fact_asin_multinf_keyword`](#fact_asin_multinf_keyword) | 4,453 | `asin, country, keyword, time_piece_type, time_piece_value` | ASIN×关键词 多变体区间聚合。源 asin-keyword-list.multiNfInfo |
| [`fact_asin_multinf_keyword_variant`](#fact_asin_multinf_keyword_variant) | 15,176 | `parent_asin, country, keyword, variant_asin, time_piece_type, time_piece_value` | 关键词×变体 自然排名明细。源 multiNfInfo.dateAsins[].asins[]，76,469 行明细 |
| [`fact_asin_op_event`](#fact_asin_op_event) | 74,013 | `asin, country, stat_date, event_type` | 运营动作事件。实测是系统识别的变化点（非用户标注）。与流量快照拆表：粒度不同（事件按天离散）、稀疏、且只追加不覆盖 |
| [`fact_asin_subbsr_snapshot`](#fact_asin_subbsr_snapshot) | 1,676,452 | `asin, country, cat_name, stat_date` | ASIN 子类目 BSR 排名快照。⚠️ 原响应是动态 key 对象 {类目名:值}，入库须拆成行。按月自动分区 |
| [`fact_asin_traffic_channel`](#fact_asin_traffic_channel) | 151,917 | `asin, country, time_piece_type, time_piece_value, channel` | ASIN 分渠道流量（长表）。用户已裁决用长表：渠道是 9 个同构对象，宽表需 45 列且新增渠道要改表结构 |
| [`rel_asin_keyword_variant_exposure`](#rel_asin_keyword_variant_exposure) | 743 | `parent_asin, variant_asin, keyword, country, time_piece_type, time_piece_value` | ASIN×关键词×变体 曝光关系 |
| [`rel_asin_variant`](#rel_asin_variant) | 12,779 | `parent_asin, child_asin, country` | 父子体变体组关系 |


#### dim_asin

> ASIN 商品主档（4 个域共用）

- **行数** 59,951 ｜ **主键** `asin, country` ｜ **分桶** `HASH(asin)` × 2
- **倒排索引** `idx_dim_asin_brand`(brand)

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `asin` | `varchar(16)` | 否 | ASIN 编号 |
| `country` | `varchar(8)` | 否 | 站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR |
| `title` | `varchar(1024)` | 是 | 商品标题 |
| `img` | `varchar(512)` | 是 | 主图地址（亚马逊 CDN） |
| `price` | `decimal(12,2)` | 是 | 价格 |
| `brand` | `varchar(255)` | 是 | 品牌名 |
| `brand_href` | `varchar(512)` | 是 | 品牌链接 |
| `score` | `double` | 是 | 评分（真实值，如 4.8） |
| `star` | `double` | 是 | 半星展示值。实测 star = round(score*2)/2，100% 成立 |
| `rating_num` | `bigint` | 是 | 评价数 |
| `is_best_seller` | `boolean` | 是 | 是否 BestSeller |
| `is_parent_asin` | `boolean` | 是 | 是否父体。实测父体自身无销量数据 |
| `parent_asin` | `varchar(16)` | 是 | 父体 ASIN（子体填） |
| `first_available_day` | `date` | 是 | 上架日期 |
| `seller` | `varchar(255)` | 是 | 卖家名 |
| `data_updated_at` | `datetime` | 是 | 数据更新时间（原站毫秒时间戳转换而来） |
| `created_at` | `datetime` | 否 | 入库时间 |
| `updated_at` | `datetime` | 是 | 更新时间 |

#### dim_asin_feature

> 变体属性。实测：父体 features 是维度名 [\"Size\",\"Color\"]，子体是对应下标取值 [\"Large\",\"Dark Moss\"]，入库需按下标 zip 对齐

- **行数** 43,796 ｜ **主键** `asin, country, feature_name` ｜ **分桶** `HASH(asin)` × 2

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `asin` | `varchar(16)` | 否 | ASIN 编号 |
| `country` | `varchar(8)` | 否 | 站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR |
| `feature_name` | `varchar(64)` | 否 | 属性维度名，如 Size / Color（来自父体 features） |
| `feature_value` | `varchar(255)` | 是 | 属性取值，如 Large / Dark Moss（来自子体 features 同下标） |
| `created_at` | `datetime` | 否 | 入库时间 |

#### dim_festival

> 节假日日历（12 节日 × 站点 × 年度窗口，实测 156 行）。源 sif_keyword_aba_trend.festivals

- **行数** 156 ｜ **主键** `festival_name, country, start_date` ｜ **分桶** `HASH(festival_name)` × 1

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `festival_name` | `varchar(64)` | 否 | 节日名（中文）。实测 12 个闭合枚举，最大长度 12 |
| `country` | `varchar(8)` | 否 | 站点。⚠️ 必须进主键，同节日各站窗口不同 |
| `start_date` | `date` | 否 | 节日窗口起始日 |
| `end_date` | `date` | 是 | 节日窗口结束日。实测 (name,country,start) 唯一确定 end，故不进主键 |
| `created_at` | `datetime` | 否 | 入库时间 |

#### fact_asin_bought_monthly

> ASIN 月度销量。实测：序列固定 40 个月起点 2023-05；销量是字符串分档（\"200+\"/\"<50\"）故双列并存；父体无销量只存子体

- **行数** 810,751 ｜ **主键** `asin, country, stat_month` ｜ **分桶** `HASH(asin)` × 2

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `asin` | `varchar(16)` | 否 | ASIN 编号（只存子体，父体销量由应用层聚合） |
| `country` | `varchar(8)` | 否 | 站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR |
| `stat_month` | `varchar(7)` | 否 | 统计月份 YYYY-MM |
| `bought_lower_bound` | `bigint` | 是 | 分档下界整数，用于排序和计算 |
| `bought_label` | `varchar(16)` | 是 | 原始分档串，用于展示。\ |
| `created_at` | `datetime` | 否 | 入库时间 |

#### fact_asin_keyword_inout

> ASIN 关键词进出前 3 页事件。change_type 已纳入主键（原设计遗漏，会静默覆盖）

- **行数** 8,912 ｜ **主键** `asin, country, keyword, stat_date, change_type` ｜ **分桶** `HASH(asin)` × 2

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `asin` | `varchar(16)` | 否 | ASIN 编号 |
| `country` | `varchar(8)` | 否 | 站点 |
| `keyword` | `varchar(128)` | 否 | 关键词原文（主键） |
| `stat_date` | `date` | 否 | 统计日期（源列名 data_date） |
| `change_type` | `varchar(16)` | 否 | in=进入前3页 / out=跌出前3页。⚠️ 已进主键，防同日同词既 in 又 out 被覆盖 |
| `keyword_id` | `bigint` | 是 | 原站关键词 ID（普通列） |
| `created_at` | `datetime` | 否 | 入库时间 |

#### fact_asin_keyword_overview

> ASIN 关键词概览聚合（各渠道的关键词计数）

- **行数** 3,745 ｜ **主键** `asin, country, time_piece_type, time_piece_value, is_listing_search, channel` ｜ **分桶** `HASH(asin)` × 2

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `asin` | `varchar(16)` | 否 | ASIN 编号 |
| `country` | `varchar(8)` | 否 | 站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR |
| `time_piece_type` | `varchar(16)` | 否 | 时间粒度：month 可用 / week 仅广告域可用 |
| `time_piece_value` | `varchar(32)` | 否 | month 格式 YYYY-MM；week 格式 YYYY-MM-DD_YYYY-MM-DD |
| `is_listing_search` | `boolean` | 否 | Listing 维度还是单 ASIN 维度 |
| `channel` | `varchar(16)` | 否 | 渠道 code |
| `keyword_cnt` | `bigint` | 是 | 该渠道的关键词数 |
| `created_at` | `datetime` | 否 | 入库时间 |

#### fact_asin_keyword_score

> ASIN×关键词×渠道 流量得分长表

- **行数** 19,155 ｜ **主键** `asin, country, keyword, time_piece_type, time_piece_value, channel` ｜ **分桶** `HASH(asin)` × 4

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `asin` | `varchar(16)` | 否 | ASIN 编号 |
| `country` | `varchar(8)` | 否 | 站点 |
| `keyword` | `varchar(128)` | 否 | 关键词原文（主键） |
| `time_piece_type` | `varchar(16)` | 否 | 时间粒度 |
| `time_piece_value` | `varchar(32)` | 否 | 时间片值 |
| `channel` | `varchar(16)` | 否 | 渠道 code：nf/sp/spRec/sb/sbv 等，取值同 dict_traffic_channel |
| `keyword_id` | `bigint` | 是 | 原站关键词 ID（普通列） |
| `score` | `double` | 是 | 流量得分 |
| `score_ratio` | `double` | 是 | 占比，0-1 小数存储 |
| `score_change` | `double` | 是 | 得分变化量 |
| `score_change_ratio` | `double` | 是 | 得分变化率 |
| `contri_change_ratio` | `double` | 是 | 贡献度变化率 |
| `created_at` | `datetime` | 否 | 入库时间 |

#### fact_asin_keyword_snapshot

> ASIN×关键词 流量与排名快照（反查流量词主表）

- **行数** 19,155 ｜ **主键** `asin, country, keyword, time_piece_type, time_piece_value, is_listing_search` ｜ **分桶** `HASH(asin)` × 4
- **倒排索引** `idx_fakst_kw`(keyword)

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `asin` | `varchar(16)` | 否 | ASIN 编号 |
| `country` | `varchar(8)` | 否 | 站点 |
| `keyword` | `varchar(128)` | 否 | 关键词原文（主键） |
| `time_piece_type` | `varchar(16)` | 否 | 时间粒度：month/week/day。⚠️ PG 源覆盖率仅 1.39%，ETL 需按抓取批次赋常量 |
| `time_piece_value` | `varchar(32)` | 否 | month 格式 YYYY-MM；week 格式 YYYY-MM-DD_YYYY-MM-DD |
| `is_listing_search` | `boolean` | 否 | Listing 维度还是单 ASIN 维度。⚠️ PG 源覆盖率仅 0.76% |
| `keyword_id` | `bigint` | 是 | 原站关键词 ID（普通列） |
| `is_core` | `boolean` | 是 | 是否核心词。⚠️ 实测源值 100% 为 false，无区分度 |
| `is_target` | `boolean` | 是 | 是否目标词。⚠️ 同上 |
| `piece_max_time` | `date` | 是 | 该时间片的数据截止日 |
| `nf_last_rank` | `int` | 是 | 自然位最新排名 |
| `nf_last_rank_time` | `datetime` | 是 | 自然位排名时间。⚠️ 源是 epoch 毫秒，需转换 |
| `nf_last_rank_asin` | `varchar(16)` | 是 | 自然位命中的变体 ASIN |
| `sp_last_rank` | `int` | 是 | SP 广告位最新排名 |
| `sp_last_rank_time` | `datetime` | 是 | SP 排名时间（epoch 毫秒转换） |
| `sp_last_rank_asin` | `varchar(16)` | 是 | SP 命中的变体 ASIN |
| `sp_campaign_id` | `varchar(64)` | 是 | 关联广告活动（跨域，应用层维护） |
| `listing_score_ratio` | `double` | 是 | 该词在整个 Listing 中的占比。⚠️ 实测无源 |
| `exposure_positions` | `varchar(255)` | 是 | 曝光流量位，逗号分隔。⚠️ 源用 recSp，本库规范 spRec，ETL 需映射 |
| `est_searches_num` | `bigint` | 是 | 预估搜索量 |
| `created_at` | `datetime` | 否 | 入库时间 |

#### fact_asin_listing_snapshot

> Listing 指标月度快照（价格、评分、评价数等随时间变化的指标）

- **行数** 52,600 ｜ **主键** `asin, country, stat_month` ｜ **分桶** `HASH(asin)` × 2

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `asin` | `varchar(16)` | 否 | ASIN 编号 |
| `country` | `varchar(8)` | 否 | 站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR |
| `stat_month` | `varchar(7)` | 否 | 统计月份 YYYY-MM |
| `price` | `decimal(12,2)` | 是 | 当月价格 |
| `score` | `double` | 是 | 当月评分 |
| `rating_num` | `bigint` | 是 | 当月评价数 |
| `bsr` | `bigint` | 是 | 当月 BSR 排名 |
| `created_at` | `datetime` | 否 | 入库时间 |

#### fact_asin_multinf_daily

> 多变体自然位日快照。实测此接口无 timePiece 参数，直接返回逐日 dates 数组

- **行数** 11,015 ｜ **主键** `asin, country, stat_date` ｜ **分桶** `HASH(asin)` × 2

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `asin` | `varchar(16)` | 否 | ASIN 编号 |
| `country` | `varchar(8)` | 否 | 站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR |
| `stat_date` | `date` | 否 | 统计日期 |
| `asin_cnt` | `int` | 是 | 当日占位变体数 |
| `keyword_cnt` | `int` | 是 | 当日关键词数 |
| `score` | `double` | 是 | 自然位流量得分 |
| `extra_score` | `double` | 是 | 多变体额外获得的自然流量得分 |
| `listing_asin_cnt` | `int` | 是 | Listing 变体总数 |
| `created_at` | `datetime` | 否 | 入库时间 |

#### fact_asin_multinf_keyword

> ASIN×关键词 多变体区间聚合。源 asin-keyword-list.multiNfInfo

- **行数** 4,453 ｜ **主键** `asin, country, keyword, time_piece_type, time_piece_value` ｜ **分桶** `HASH(asin)` × 4

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `asin` | `varchar(16)` | 否 | ASIN 编号 |
| `country` | `varchar(8)` | 否 | 站点 |
| `keyword` | `varchar(128)` | 否 | 关键词原文（主键） |
| `time_piece_type` | `varchar(16)` | 否 | 时间粒度 |
| `time_piece_value` | `varchar(32)` | 否 | 时间片值 |
| `keyword_id` | `bigint` | 是 | 原站关键词 ID（普通列）。本表源 multiNfInfo 自带 ID，填充率高 |
| `avg_rank` | `double` | 是 | 区间平均自然位排名。⚠️ 源无此字段，需 ETL 聚合自算 |
| `appear_days` | `int` | 是 | 区间内出现天数。⚠️ 同上需自算 |
| `asin_cnt` | `int` | 是 | 同时占位的变体数。⚠️ 同上需自算 |
| `created_at` | `datetime` | 否 | 入库时间 |

#### fact_asin_multinf_keyword_variant

> 关键词×变体 自然排名明细。源 multiNfInfo.dateAsins[].asins[]，76,469 行明细

- **行数** 15,176 ｜ **主键** `parent_asin, country, keyword, variant_asin, time_piece_type, time_piece_value` ｜ **分桶** `HASH(parent_asin)` × 4

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `parent_asin` | `varchar(16)` | 否 | 父体/主查 ASIN |
| `country` | `varchar(8)` | 否 | 站点 |
| `keyword` | `varchar(128)` | 否 | 关键词原文（主键） |
| `variant_asin` | `varchar(16)` | 否 | 变体 ASIN |
| `time_piece_type` | `varchar(16)` | 否 | 时间粒度 |
| `time_piece_value` | `varchar(32)` | 否 | 时间片值 |
| `keyword_id` | `bigint` | 是 | 原站关键词 ID（普通列） |
| `rank_position` | `int` | 是 | 全局自然位排名（源 asins[].rank） |
| `page_num` | `int` | 是 | 页码（源 asins[].pageNum）。⚠️ 勿取上层 dateAsins[].pageNum，那层恒 NULL |
| `page_rank` | `int` | 是 | 页内位次（源 asins[].pageRank） |
| `page_size` | `int` | 是 | 页容量（源 asins[].pageSize） |
| `img` | `varchar(512)` | 是 | 变体主图（源 asins[].img） |
| `variant_role` | `varchar(16)` | 是 | 变体角色。⚠️ 实测无源，可按 rank 最小=主曝光变体推导 |
| `created_at` | `datetime` | 否 | 入库时间 |

#### fact_asin_op_event

> 运营动作事件。实测是系统识别的变化点（非用户标注）。与流量快照拆表：粒度不同（事件按天离散）、稀疏、且只追加不覆盖

- **行数** 74,013 ｜ **主键** `asin, country, stat_date, event_type` ｜ **分桶** `HASH(asin)` × 2

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `asin` | `varchar(16)` | 否 | ASIN 编号 |
| `country` | `varchar(8)` | 否 | 站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR |
| `stat_date` | `date` | 否 | 事件发生日期 |
| `event_type` | `varchar(32)` | 否 | 事件类型：titleImg 改标题图片 / campaignId 新增广告活动 / 价格活动等 |
| `event_detail` | `text` | 是 | 事件详情（如字符级 diff 区间、活动 ID） |
| `created_at` | `datetime` | 否 | 入库时间 |

#### fact_asin_subbsr_snapshot

> ASIN 子类目 BSR 排名快照。⚠️ 原响应是动态 key 对象 {类目名:值}，入库须拆成行。按月自动分区

- **行数** 1,676,452 ｜ **主键** `asin, country, cat_name, stat_date` ｜ **分桶** `HASH(asin)` × 8 ｜ **分区** AUTO（按月自动建分区）

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `asin` | `varchar(16)` | 否 | ASIN 编号 |
| `country` | `varchar(8)` | 否 | 站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR |
| `cat_name` | `varchar(255)` | 否 | 子类目名称（原为动态 key） |
| `stat_date` | `date` | 否 | 统计日期。⚠️ 分区列，AUTO PARTITION 按月 |
| `bsr` | `bigint` | 是 | BSR 排名 |
| `created_at` | `datetime` | 否 | 入库时间 |

#### fact_asin_traffic_channel

> ASIN 分渠道流量（长表）。用户已裁决用长表：渠道是 9 个同构对象，宽表需 45 列且新增渠道要改表结构

- **行数** 151,917 ｜ **主键** `asin, country, time_piece_type, time_piece_value, channel` ｜ **分桶** `HASH(asin)` × 2

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `asin` | `varchar(16)` | 否 | ASIN 编号 |
| `country` | `varchar(8)` | 否 | 站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR |
| `time_piece_type` | `varchar(16)` | 否 | 时间粒度：month 可用 / week 仅广告域可用 |
| `time_piece_value` | `varchar(32)` | 否 | month 格式 YYYY-MM；week 格式 YYYY-MM-DD_YYYY-MM-DD |
| `channel` | `varchar(16)` | 否 | 渠道：total/nf/ad/allSp/sp/spRec/allSb/sb/sbv。⚠️ 响应里的 recSp 须归一为 spRec |
| `score` | `double` | 是 | 流量得分（实测为浮点，如 2859.33） |
| `score_ratio` | `double` | 是 | 占比，0-1 小数存储（前端负责乘 100 展示） |
| `score_change` | `double` | 是 | 得分变化量 |
| `score_change_ratio` | `double` | 是 | 得分变化率，可为 NULL |
| `contri_change_ratio` | `double` | 是 | 贡献度变化率 |
| `created_at` | `datetime` | 否 | 入库时间 |

#### rel_asin_keyword_variant_exposure

> ASIN×关键词×变体 曝光关系

- **行数** 743 ｜ **主键** `parent_asin, variant_asin, keyword, country, time_piece_type, time_piece_value` ｜ **分桶** `HASH(parent_asin)` × 2

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `parent_asin` | `varchar(16)` | 否 | 父体/主查 ASIN |
| `variant_asin` | `varchar(16)` | 否 | 变体 ASIN |
| `keyword` | `varchar(128)` | 否 | 关键词原文（主键） |
| `country` | `varchar(8)` | 否 | 站点 |
| `time_piece_type` | `varchar(16)` | 否 | 时间粒度 |
| `time_piece_value` | `varchar(32)` | 否 | 时间片值 |
| `keyword_id` | `bigint` | 是 | 原站关键词 ID（普通列） |
| `score` | `double` | 是 | 该变体在该词上的曝光得分 |
| `created_at` | `datetime` | 否 | 入库时间 |

#### rel_asin_variant

> 父子体变体组关系

- **行数** 12,779 ｜ **主键** `parent_asin, child_asin, country` ｜ **分桶** `HASH(parent_asin)` × 2

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `parent_asin` | `varchar(16)` | 否 | 父体 ASIN |
| `child_asin` | `varchar(16)` | 否 | 子体 ASIN |
| `country` | `varchar(8)` | 否 | 站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR |
| `display_order` | `int` | 是 | 展示顺序（实测 order 字段，0=汇总行） |
| `ratio` | `double` | 是 | 该变体的流量占比 |
| `created_at` | `datetime` | 否 | 入库时间 |

### 15.8 关键词（13 张）

| 表 | 行数 | 主键 | 说明 |
|---|---:|---|---|
| [`dim_keyword`](#dim_keyword) | 13,872 | `keyword, country` | 关键词主档。主键 (keyword,country)——实测 keyword_id 跨站点不唯一，不可作单列主键 |
| [`dim_word`](#dim_word) | 33 | `word, country` | 单词/词根主档。⚠️ 词频接口只返回 word 文本，无 ID 字段，只能用文本作键 |
| [`fact_keyword_acos_estimate`](#fact_keyword_acos_estimate) | 33,019 | `keyword, country, stat_week, match_type, bid_strategy` | ACOS/CPA 三档预估（关键词×周×匹配×策略）。源 web-keyword-conversion。ACOS 递减、CPA 递增，非区间端点。原名 fact_keyword… |
| [`fact_keyword_bid_estimate`](#fact_keyword_bid_estimate) | 25,074 | `keyword, country, category_id, match_type, bid_strategy, stat_month` | 关键词建议竞价（关键词×类目×匹配×策略×月）。源 cpc/category，本期无真实数据走 seed。三档递增。与 fact_keyword_acos_estimate 是… |
| [`fact_keyword_competition_snapshot`](#fact_keyword_competition_snapshot) | 21,329 | `keyword, country, stat_week` | 关键词竞争格局快照。改文本键后可灌 21,276 行（原 3,244 行 = 15.2%） |
| [`fact_keyword_conversion_funnel`](#fact_keyword_conversion_funnel) | 5,875 | `keyword, country, stat_week` | 关键词 ABA 转化漏斗。改文本键后可灌 9,038 行（原 854 行 = 9.4%） |
| [`fact_keyword_metric_snapshot`](#fact_keyword_metric_snapshot) | 22,321 | `keyword, country, granularity, stat_date` | 关键词自身指标快照（搜索量、CPC、点击转化率等，与 ASIN 无关） |
| [`fact_keyword_rank_history`](#fact_keyword_rank_history) | 119,670 | `asin, country, keyword, rank_type, stat_date` | ASIN×关键词 排名历史（日粒度）。主源 sif_asin_keyword.raw->allRankHistory。按月自动分区 |
| [`fact_keyword_search_trend`](#fact_keyword_search_trend) | 178,092 | `keyword, country, granularity, stat_date, is_prev_period` | 关键词搜索量趋势。is_prev_period 区分本期与上期（用于环比） |
| [`fact_word_frequency`](#fact_word_frequency) | 0 | `scope_type, scope_key, country, time_piece_type, time_piece_value, word_model, word` | 词频聚合。scope_type/scope_key 区分 ASIN 维度还是词库分组维度（两接口共用一张表） |
| [`rel_keyword_asin_traffic_share`](#rel_keyword_asin_traffic_share) | 1,351 | `keyword, country, asin` | 关键词 × ASIN × 流量位份额（/compete 流量位竞争格局）。源 competePattern。默认按 nf_score_ratio 降序。⚠️ 无周维度，份额是最… |
| [`rel_keyword_group`](#rel_keyword_group) | 0 | `group_id, keyword, country` | 关键词分组（用户词库） |
| [`rel_keyword_top_asin`](#rel_keyword_top_asin) | 56,795 | `keyword, country, asin` | 关键词头部 ASIN。源 web-keyword-conversion.topAsins[]，90,374 个元素 |


#### dim_keyword

> 关键词主档。主键 (keyword,country)——实测 keyword_id 跨站点不唯一，不可作单列主键

- **行数** 13,872 ｜ **主键** `keyword, country` ｜ **分桶** `HASH(keyword)` × 4
- **倒排索引** `idx_dim_kw_text`(keyword)

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `keyword` | `varchar(128)` | 否 | 关键词原文（主键，实测最大 128 字符）。ETL 需 btrim(lower()) 归一 |
| `country` | `varchar(8)` | 否 | 站点。⚠️ 必须进主键：实测 keyword_id 跨站点不唯一 |
| `keyword_id` | `bigint` | 是 | 原站关键词 ID（降级为普通列）。实测仅 sif_asin_keyword 提供，覆盖率有限 |
| `translate_keyword` | `varchar(512)` | 是 | 中文翻译（原站自带） |
| `est_searches_num` | `bigint` | 是 | 预估搜索量 |
| `created_at` | `datetime` | 否 | 入库时间 |
| `updated_at` | `datetime` | 是 | 更新时间 |

#### dim_word

> 单词/词根主档。⚠️ 词频接口只返回 word 文本，无 ID 字段，只能用文本作键

- **行数** 33 ｜ **主键** `word, country` ｜ **分桶** `HASH(word)` × 1

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `word` | `varchar(128)` | 否 | 单词/词根 |
| `country` | `varchar(8)` | 否 | 站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR |
| `translate_word` | `varchar(255)` | 是 | 中文翻译 |
| `created_at` | `datetime` | 否 | 入库时间 |

#### fact_keyword_acos_estimate

> ACOS/CPA 三档预估（关键词×周×匹配×策略）。源 web-keyword-conversion。ACOS 递减、CPA 递增，非区间端点。原名 fact_keyword_bid_estimate（该名现留给真正的建议竞价表）

- **行数** 33,019 ｜ **主键** `keyword, country, stat_week, match_type, bid_strategy` ｜ **分桶** `HASH(keyword)` × 4
- **倒排索引** `idx_acos_kw`(keyword)

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `keyword` | `varchar(128)` | 否 | 关键词原文（主键）。ETL 需 btrim(lower()) 归一 |
| `country` | `varchar(8)` | 否 | 站点。⚠️ 必须进主键：keyword_id 跨站点不唯一 |
| `stat_week` | `date` | 否 | ABA 周起始日（周日）。源 data.weekDate，实测 6 个值 2026-07-26~2026-08-30 |
| `match_type` | `varchar(16)` | 否 | 匹配方式：broad=广泛 / phrase=词组 / exact=精准。由源键名 *ForSales_<x> 拆出 |
| `bid_strategy` | `varchar(16)` | 否 | 投放策略：auto=自动投放 / legacy=手动投放。由源键名前缀拆出。⚠️ 实测 13% 的词两者同值（源侧合并所致，非 ETL 问题） |
| `keyword_id` | `bigint` | 是 | 原站关键词 ID（普通列，仅供对账） |
| `acos_start` | `double` | 是 | ACOS 悲观档（三档中值最大）。实测 33,019 行满档，0.0847~1433.13 |
| `acos_median` | `double` | 是 | ACOS 中位档。实测 0.0154~232.07 |
| `acos_end` | `double` | 是 | ACOS 乐观档（三档中值最小）。实测 0.0003~76.25。⚠️ 100% 满足 start>median>end，按区间端点渲染会画反 |
| `cpa_start` | `decimal(12,4)` | 是 | CPA 悲观档。实测 0.4541~5145.45 |
| `cpa_median` | `decimal(12,4)` | 是 | CPA 中位档。实测 0.5838~5718.18 |
| `cpa_end` | `decimal(12,4)` | 是 | CPA 乐观档。实测 0.7136~6290.91。⚠️ CPA 方向与 ACOS 相反，是递增的 |
| `created_at` | `datetime` | 否 | 入库时间 |

#### fact_keyword_bid_estimate

> 关键词建议竞价（关键词×类目×匹配×策略×月）。源 cpc/category，本期无真实数据走 seed。三档递增。与 fact_keyword_acos_estimate 是两个不同指标

- **行数** 25,074 ｜ **主键** `keyword, country, category_id, match_type, bid_strategy, stat_month` ｜ **分桶** `HASH(keyword)` × 8
- **倒排索引** `idx_bid2_kw`(keyword)

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `keyword` | `varchar(128)` | 否 | 关键词原文（主键）。ETL 需 btrim(lower()) 归一 |
| `country` | `varchar(8)` | 否 | 站点。⚠️ 必须进主键 |
| `category_id` | `varchar(32)` | 否 | 类目 ID（主键）。源 categorys[].categoryId。⚠️ 竞价与品类强相关，无类目维则数据无意义（页面说明第 1 条） |
| `match_type` | `varchar(16)` | 否 | 匹配方式：broad / phrase / exact。源 matchTypes 的键名 |
| `bid_strategy` | `varchar(16)` | 否 | 投放策略。取值沿用**源 JSON 键名** auto / legacy（cpc/category 的 matchTypes.<match>.<strategy>），ETL 不做映射。对应页面 UI 的表述：auto=「提升与降低」/ legacy=「仅降低」与「固定」。⚠️ 原站已把「仅降低」与「固定」合并为一档（页面说明第 3 条），所以只有 2 个值；前端渲染时要按 UI 的表述映射 |
| `stat_month` | `varchar(7)` | 否 | 统计月 YYYY-MM（主键）。⚠️ 用月不用周：源以周 ABA 为输入但**每月只更新一次**（页面说明第 4 条） |
| `category_name` | `varchar(255)` | 是 | 类目名。源 categoryName |
| `category_href` | `varchar(512)` | 是 | 类目链接。源 categoryHref |
| `category_sale_num` | `bigint` | 是 | 该类目在售产品数。源 categorys[].saleNum。竞价大小与之相关（页面说明第 2 条） |
| `bid_start` | `decimal(12,4)` | 是 | 建议竞价低档（$）。⚠️ 三档**递增**（实测样例 0.37→0.49→0.61），与 ACOS 的递减方向相反 |
| `bid_median` | `decimal(12,4)` | 是 | 建议竞价中档（$） |
| `bid_end` | `decimal(12,4)` | 是 | 建议竞价高档（$） |
| `source` | `varchar(32)` | 是 | 数据来源：seed=生成器造（本期全部）/ real=cpc/category 真实数据。⚠️ 前端必须据此显示「模拟数据」标记 |
| `created_at` | `datetime` | 否 | 入库时间 |

#### fact_keyword_competition_snapshot

> 关键词竞争格局快照。改文本键后可灌 21,276 行（原 3,244 行 = 15.2%）

- **行数** 21,329 ｜ **主键** `keyword, country, stat_week` ｜ **分桶** `HASH(keyword)` × 4

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `keyword` | `varchar(128)` | 否 | 关键词原文（主键） |
| `country` | `varchar(8)` | 否 | 站点 |
| `stat_week` | `date` | 否 | ABA 周起始日（源 aba_date） |
| `stat_week_end` | `date` | 是 | ABA 周结束日（源 abaDateEnd，100% 填充） |
| `keyword_id` | `bigint` | 是 | 原站关键词 ID（普通列） |
| `nf_asin_num` | `int` | 是 | 自然位 ASIN 数。实测 max 573，非零率 52.5% |
| `sp_ad_asin_num` | `int` | 是 | SP 广告 ASIN 数。实测 max 205 |
| `brand_ad_asin_num` | `int` | 是 | 品牌广告 ASIN 数。实测 max 213 |
| `ppc_ad_asin_num` | `int` | 是 | PPC 广告 ASIN 数。实测 max 402 |
| `search_recommend_asin_num` | `int` | 是 | 搜索推荐 ASIN 数。实测 max 180 |
| `video_ad_asin_num` | `int` | 是 | 视频广告 ASIN 数。实测 max 38（上游拼写 vedio） |
| `sale_num` | `bigint` | 是 | 销量。实测 max 435,865 |
| `global_keyword_num` | `bigint` | 是 | 全局关键词数。实测 max 1,000,000，填充 100% |
| `created_at` | `datetime` | 否 | 入库时间 |

#### fact_keyword_conversion_funnel

> 关键词 ABA 转化漏斗。改文本键后可灌 9,038 行（原 854 行 = 9.4%）

- **行数** 5,875 ｜ **主键** `keyword, country, stat_week` ｜ **分桶** `HASH(keyword)` × 4

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `keyword` | `varchar(128)` | 否 | 关键词原文（主键）。实测最大长度 66 |
| `country` | `varchar(8)` | 否 | 站点 |
| `stat_week` | `date` | 否 | ABA 周起始日（源 period） |
| `keyword_id` | `bigint` | 是 | 原站关键词 ID（普通列）。⚠️ 源 web-keyword-conversion 不返回此字段 |
| `search_volume` | `bigint` | 是 | 搜索量。实测 61 ~ 717,552 |
| `click_volume` | `bigint` | 是 | 点击量。实测 45 ~ 182,920 |
| `purchase_volume` | `bigint` | 是 | 购买量。实测 0 ~ 7,867 |
| `search_click_ratio` | `double` | 是 | 搜索点击率。实测 0.0138 ~ 0.7979 |
| `search_purchase_ratio` | `double` | 是 | 搜索购买率。实测 0.0 ~ 0.2838 |
| `click_shared` | `double` | 是 | 点击份额。实测 0.0242 ~ 0.9194 |
| `conversion_shared` | `double` | 是 | 转化份额。实测 0.0021 ~ 1.0，填充 79.9% |
| `avg_kw_price` | `decimal(12,2)` | 是 | 关键词平均价。实测 6.74 ~ 793.70 |
| `max_kw_price` | `decimal(12,2)` | 是 | 该关键词下产品均价的最高档。落表 5,875 行（100%），实测最高 35,690.36 |
| `min_kw_price` | `decimal(12,2)` | 是 | 该关键词下产品均价的最低档。页面「产品均价」列三档之一。落表 5,875 行（100%），实测最低 0.87 |
| `source` | `varchar(16)` | 是 | 数据来源。实测恒为 mix |
| `created_at` | `datetime` | 否 | 入库时间 |
| `click_purchase_ratio` | `double` | 是 | 点击购买率（分母是点击数，区别于 search_purchase_ratio 的分母是搜索数）。源 clickPurchaseRatio，落表 5,875 行（100%），实测 0~0.3876 |

#### fact_keyword_metric_snapshot

> 关键词自身指标快照（搜索量、CPC、点击转化率等，与 ASIN 无关）

- **行数** 22,321 ｜ **主键** `keyword, country, granularity, stat_date` ｜ **分桶** `HASH(keyword)` × 4

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `keyword` | `varchar(128)` | 否 | 关键词原文（主键） |
| `country` | `varchar(8)` | 否 | 站点 |
| `granularity` | `varchar(16)` | 否 | 粒度：week/month。⚠️ 实测无 day 粒度数据 |
| `stat_date` | `date` | 否 | 统计日期（周月粒度取区间起始日） |
| `stat_date_end` | `date` | 是 | ABA 周结束日（源 abaDateEnd，100% 填充） |
| `keyword_id` | `bigint` | 是 | 原站关键词 ID（普通列） |
| `est_searches_num` | `bigint` | 是 | 预估搜索量 |
| `searches_rank` | `bigint` | 是 | ABA 搜索排名 |
| `cpc_bid` | `decimal(12,2)` | 是 | 建议竞价。⚠️ 源 cpc 是 6 种投放组合的对象，需选投影 |
| `click_purchase_ratio` | `double` | 是 | 点击转化率（源 clickPurchaseRatio） |
| `created_at` | `datetime` | 否 | 入库时间 |
| `nf_asin_num` | `int` | 是 | 自然位竞品数。源 nfAsinNum。⚠️ 落表仅 318/22,320 行（1.4%）——compete 源只覆盖 789 词，与本表词级交集 318。实测 47~440 |
| `ppc_asin_num` | `int` | 是 | 广告位竞品数（SP+SB+SBV 合计）。源 ppcAsinNum。落表 318 行，实测 21~365 |
| `sp_asin_num` | `int` | 是 | SP 广告竞品数。源 spAsinNum。落表 318 行，实测 0~179 |
| `sp_recommended_asin_num` | `int` | 是 | SP 推荐位竞品数。源 spRecommendedAsinNum。落表 318 行，实测 0~284 |
| `recommended_asin_num` | `int` | 是 | 推荐位竞品数。源 recommendedAsinNum。落表 318 行，实测 0~145 |
| `brand_asin_num` | `int` | 是 | SB（品牌）位竞品数。源 brandAsinNum。落表 318 行，实测 0~179 |
| `ac_asin_num` | `int` | 是 | AC（Amazon Choice）位竞品数。源 acAsinNum。落表 318 行但**实测 318 行全为 0**（AC 是稀缺标，当前样本无 AC 词）。保留该列：换品类/周后可能出现非 0，前端需区分「0」与「无数据」 |
| `sale_num` | `bigint` | 是 | ⚠️ 语义是「在售产品数」（该关键词下的在售商品数量），**不是销量**——schema-06 原注释写错，审计 §3 已纠正。源 saleNum，落表 318 行，实测 80~298,323 |
| `click_shared` | `double` | 是 | ABA Top3 点击集中度（非「份额」，审计 §3 纠正）。源 clickShared，落表 264/22,320 行，实测 0~0.5472。页面与 conversion_shared 合并显示为「点击 x% / 转化 y%」 |
| `conversion_shared` | `double` | 是 | ABA Top3 转化集中度（非「份额」）。源 conversionShared，落表 264 行，实测 0~0.75 |
| `video_asin_num` | `int` | 是 | SBV（视频广告）位竞品数。源 videoAsinNum，页面列名「SBV产品数」。落表 321 行，实测值域 1~32 |

#### fact_keyword_rank_history

> ASIN×关键词 排名历史（日粒度）。主源 sif_asin_keyword.raw->allRankHistory。按月自动分区

- **行数** 119,670 ｜ **主键** `asin, country, keyword, rank_type, stat_date` ｜ **分桶** `HASH(asin)` × 4 ｜ **分区** AUTO（按月自动建分区）
- **倒排索引** `idx_rank_kw`(keyword)

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `asin` | `varchar(16)` | 否 | ASIN 编号 |
| `country` | `varchar(8)` | 否 | 站点 |
| `keyword` | `varchar(128)` | 否 | 关键词原文（主键） |
| `rank_type` | `varchar(16)` | 否 | 排名类型：nf/sp/sb/sbv/recSp（原设计只有 nf/sp，漏 3 种） |
| `stat_date` | `date` | 否 | 统计日期（按 allRankHistory.date[] 下标对齐）。⚠️ 分区列 |
| `keyword_id` | `bigint` | 是 | 原站关键词 ID（普通列） |
| `rank_position` | `double` | 是 | 全局排名。⚠️ 改 DOUBLE：sb/sbv 的 rank 100% 带小数编码版位 |
| `page_no` | `int` | 是 | 页码，从 rankStr 的 ^p(d+) 解析。sb/sbv/recSp 无页码概念 |
| `page_size` | `int` | 是 | 页容量，从 rankStr 的 /(d+)$ 解析。实测非固定 48（还有 16/49/47/46/40） |
| `slot` | `varchar(16)` | 是 | 版位：top/middle/bottom/tail。仅 sb/sbv 有，来自 rankStr 第 3 段 |
| `asin_order` | `int` | 是 | 同位次内序号。实测 sb/sbv 100% 非空，nf/sp 100% NULL |
| `campaign_id` | `varchar(64)` | 是 | 广告活动 ID。实测 sp/sb/sbv 有值，nf 恒 NULL |
| `mask_campaign_id` | `varchar(16)` | 是 | 前台 4 位短码（源 maskCampaignId） |
| `created_at` | `datetime` | 否 | 入库时间 |

#### fact_keyword_search_trend

> 关键词搜索量趋势。is_prev_period 区分本期与上期（用于环比）

- **行数** 178,092 ｜ **主键** `keyword, country, granularity, stat_date, is_prev_period` ｜ **分桶** `HASH(keyword)` × 4

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `keyword` | `varchar(128)` | 否 | 关键词原文（主键） |
| `country` | `varchar(8)` | 否 | 站点 |
| `granularity` | `varchar(16)` | 否 | 粒度：week/month |
| `stat_date` | `date` | 否 | 统计日期。⚠️ month 源格式 YYYY-MM 需补 -01 |
| `is_prev_period` | `boolean` | 否 | false=本期 true=上期对照（源 estSearchesNumHistoryPrev） |
| `keyword_id` | `bigint` | 是 | 原站关键词 ID（普通列） |
| `searches_num` | `bigint` | 是 | 搜索量。⚠️ ext_search_volume 与 keyword_search_vol 语义不同，勿混用 |
| `created_at` | `datetime` | 否 | 入库时间 |

#### fact_word_frequency

> 词频聚合。scope_type/scope_key 区分 ASIN 维度还是词库分组维度（两接口共用一张表）

- **行数** 0 ｜ **主键** `scope_type, scope_key, country, time_piece_type, time_piece_value, word_model, word` ｜ **分桶** `HASH(scope_type)` × 2

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `scope_type` | `varchar(16)` | 否 | 范围类型：asin / keyword_group |
| `scope_key` | `varchar(64)` | 否 | 范围键：ASIN 编号或分组 ID |
| `country` | `varchar(8)` | 否 | 站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR |
| `time_piece_type` | `varchar(16)` | 否 | 时间粒度：month 可用 / week 仅广告域可用 |
| `time_piece_value` | `varchar(32)` | 否 | month 格式 YYYY-MM；week 格式 YYYY-MM-DD_YYYY-MM-DD |
| `word_model` | `varchar(16)` | 否 | 词频模型：搜索量加权 / 出现次数 |
| `word` | `varchar(128)` | 否 | 单词 |
| `frq` | `bigint` | 是 | 词频值 |
| `search_weight` | `double` | 是 | 搜索量权重 |
| `created_at` | `datetime` | 否 | 入库时间 |

#### rel_keyword_asin_traffic_share

> 关键词 × ASIN × 流量位份额（/compete 流量位竞争格局）。源 competePattern。默认按 nf_score_ratio 降序。⚠️ 无周维度，份额是最近一次抓取的快照

- **行数** 1,351 ｜ **主键** `keyword, country, asin` ｜ **分桶** `HASH(keyword)` × 8
- **倒排索引** `idx_tshare_kw`(keyword)

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `keyword` | `varchar(128)` | 否 | 关键词原文（主键）。ETL 需 btrim(lower()) 归一 |
| `country` | `varchar(8)` | 否 | 站点。⚠️ 必须进主键 |
| `asin` | `varchar(16)` | 否 | 占位的竞品 ASIN |
| `rank_position` | `int` | 是 | 在该词结果里的序号（页面「#」列）。默认按 nf_score_ratio 降序 |
| `title` | `varchar(512)` | 是 | 商品标题。源 title |
| `img` | `varchar(512)` | 是 | 主图 URL。源 img |
| `price` | `decimal(12,2)` | 是 | 价格。源 price |
| `rating_num` | `int` | 是 | 评论数。源 ratingNum |
| `star` | `decimal(3,1)` | 是 | 评分。源 star |
| `score` | `double` | 是 | 综合流量分。源 score |
| `bought_in_past_month` | `varchar(32)` | 是 | ⚠️ 月销量是**分档字符串**如「6,000+」，不是数值。源 boughtInPastMonth，照原样存，前端不要当数字算 |
| `nf_score_ratio` | `double` | 是 | 自然流量份额。源 nfScoreRatio。页面「自然流量」列，默认排序键 |
| `sp_score_ratio` | `double` | 是 | SP(常规)流量份额。源 spScoreRatio |
| `sp_rec_score_ratio` | `double` | 是 | SP(推荐)流量份额。源 spRecScoreRatio |
| `brand_ad_score_ratio` | `double` | 是 | SB(常规)流量份额。源 brandAdScoreRatio |
| `video_ad_score_ratio` | `double` | 是 | SBV 流量份额。⚠️ 源字段拼写是 vedioAdScoreRatio（video 误拼 vedio），ETL 取值时照抄源侧拼写 |
| `ac_score_ratio` | `double` | 是 | AC(Amazon Choice) 位份额。源 acScoreRatio。⚠️ 实测 26/1,351 行非零、最大值 1.0 —— 与 metric 表的 ac_asin_num（318 行恒 0）不同，本列有真实区分度，页面「AC推荐流量」列要展示 |
| `er_score_ratio` | `double` | 是 | 源 erScoreRatio。⚠️ 实测 1,351 行全为 0（/amount 页的同族字段 erAsinNum 也是 0% 填充）。列保留观察，接口不返回、前端不展示 —— 原站页面表头也只有 6 个流量位列，不含 ER/TR |
| `tr_score_ratio` | `double` | 是 | 源 trScoreRatio。⚠️ 同 er_score_ratio，实测全为 0 |
| `has_variants` | `boolean` | 是 | 是否有变体。⚠️ 源字段拼写是 hasVaiants（variants 误拼） |
| `is_focus` | `boolean` | 是 | 是否已收藏（源 isFocus）。⚠️ 这是**原站的用户态**，Loom 应从自己的产品库判断，ETL 不要灌这列 |
| `ac` | `varchar(64)` | 是 | AC 标类型。源 ac |
| `stat_date` | `date` | 是 | ⚠️ 普通列不进主键：源响应无周维度（同 metric 表的竞品数量列），只能记抓取日。语义是「最近一次抓取的竞争格局」，不是「某周的」 |
| `source` | `varchar(32)` | 是 | 数据来源：real=competePattern 真实数据 / seed=生成器造。前端据此决定是否显示「模拟数据」标记 |
| `created_at` | `datetime` | 否 | 入库时间 |

#### rel_keyword_group

> 关键词分组（用户词库）

- **行数** 0 ｜ **主键** `group_id, keyword, country` ｜ **分桶** `HASH(group_id)` × 1

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `group_id` | `bigint` | 否 | 分组 ID |
| `keyword` | `varchar(128)` | 否 | 关键词原文（主键） |
| `country` | `varchar(8)` | 否 | 站点 |
| `keyword_id` | `bigint` | 是 | 原站关键词 ID（普通列） |
| `created_at` | `datetime` | 否 | 入库时间 |

#### rel_keyword_top_asin

> 关键词头部 ASIN。源 web-keyword-conversion.topAsins[]，90,374 个元素

- **行数** 56,795 ｜ **主键** `keyword, country, asin` ｜ **分桶** `HASH(keyword)` × 4

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `keyword` | `varchar(128)` | 否 | 关键词原文（主键） |
| `country` | `varchar(8)` | 否 | 站点 |
| `asin` | `varchar(16)` | 否 | ASIN 编号 |
| `keyword_id` | `bigint` | 是 | 原站关键词 ID（普通列） |
| `rank_position` | `int` | 是 | 排名位置 |
| `img` | `varchar(512)` | 是 | 商品主图（源 topAsins[].img，100% 非空） |
| `title` | `varchar(1024)` | 是 | 商品标题（源 topAsins[].title，100% 非空） |
| `price` | `decimal(12,2)` | 是 | 价格（源 topAsins[].price，99.99% 非空） |
| `created_at` | `datetime` | 否 | 入库时间 |
| `asin_role` | `varchar(8)` | 是 | ASIN 角色：top=头部商品（源 topAsins[]）/ conv=有转化数据（源 asinsClickPurchaseRatio[]）。实测 top 46,451 行 + conv 10,344 行 = 56,795。⚠️ conv 行只有 430 行带 rank_position/title（主键不含 role，conv 覆盖同 ASIN 的 top 行时才继承） |
| `click_purchase_ratio` | `double` | 是 | 该 ASIN 在此关键词下的点击购买率。源 asinsClickPurchaseRatio[].clickPurchaseRatio，实测 0~1.3746。asin_role=top 的行为 NULL |

### 15.9 广告（4 张）

| 表 | 行数 | 主键 | 说明 |
|---|---:|---|---|
| [`dim_ad_campaign`](#dim_ad_campaign) | 5,928 | `encrypt_campaign_id, country` | 广告活动。⚠️ 三套 ID 并存：fake_campaign_id 前台 4 位短码 / encrypt_campaign_id 内部加密 / campaign_id_a0 用… |
| [`dim_ad_product_ad`](#dim_ad_product_ad) | 337 | `encrypt_ad_id, country` | 投放小组(Product Ad)。⚠️ 不是 Amazon AdGroup —— 层级为 Campaign→AdGroup→ProductAd→变体→搜索词，而 AdGroup… |
| [`fact_ad_search_term_exposure`](#fact_ad_search_term_exposure) | 1,887 | `encrypt_ad_id, country, keyword, variant_asin, stat_date` | 搜索词曝光快照。⚠️ 存的是买家搜索词不是投放词。源成功率仅 11.8%，数据量小 |
| [`rel_ad_campaign_product_ad`](#rel_ad_campaign_product_ad) | 174 | `encrypt_campaign_id, encrypt_ad_id, country, stat_date` | 广告活动→投放小组（时序关系表）。⚠️ 实测 campaigns[].ads 是按日期分组的对象，同一活动各周包含的投放小组会变，故主键必须带 stat_date |


#### dim_ad_campaign

> 广告活动。⚠️ 三套 ID 并存：fake_campaign_id 前台 4 位短码 / encrypt_campaign_id 内部加密 / campaign_id_a0 用户录入的后台真实 ID

- **行数** 5,928 ｜ **主键** `encrypt_campaign_id, country` ｜ **分桶** `HASH(encrypt_campaign_id)` × 2

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `encrypt_campaign_id` | `varchar(64)` | 否 | Sif 内部加密活动 ID（主键） |
| `country` | `varchar(8)` | 否 | 站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR |
| `fake_campaign_id` | `varchar(16)` | 是 | 前台短码，实测 4 位如 IW9V |
| `ad_type` | `tinyint` | 是 | 广告类型：1=SP 2=SB 3=SBV 4=SBBV |
| `product_type` | `varchar(32)` | 是 | 产品类型 |
| `strategy` | `varchar(255)` | 是 | 投放策略。实测是后端算好的中文串，如「多广告组，多变体」 |
| `asin_num` | `int` | 是 | 涉及 ASIN 数 |
| `ad_num` | `int` | 是 | 投放小组数 |
| `campaign_created_at` | `date` | 是 | 活动创建日期 |
| `last_ad_created_at` | `date` | 是 | 最近新增投放小组日期 |
| `created_at` | `datetime` | 否 | 入库时间 |
| `updated_at` | `datetime` | 是 | 更新时间 |

#### dim_ad_product_ad

> 投放小组(Product Ad)。⚠️ 不是 Amazon AdGroup —— 层级为 Campaign→AdGroup→ProductAd→变体→搜索词，而 AdGroup 层原站前端零字段故不建表

- **行数** 337 ｜ **主键** `encrypt_ad_id, country` ｜ **分桶** `HASH(encrypt_ad_id)` × 2

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `encrypt_ad_id` | `varchar(64)` | 否 | Sif 内部加密投放小组 ID（主键） |
| `country` | `varchar(8)` | 否 | 站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR |
| `fake_ad_id` | `varchar(16)` | 是 | 前台短码，实测 4 位如 FLDB |
| `ad_created_at` | `date` | 是 | 投放小组创建日期 |
| `created_at` | `datetime` | 否 | 入库时间 |

#### fact_ad_search_term_exposure

> 搜索词曝光快照。⚠️ 存的是买家搜索词不是投放词。源成功率仅 11.8%，数据量小

- **行数** 1,887 ｜ **主键** `encrypt_ad_id, country, keyword, variant_asin, stat_date` ｜ **分桶** `HASH(encrypt_ad_id)` × 2

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `encrypt_ad_id` | `varchar(64)` | 否 | 投放小组 ID |
| `country` | `varchar(8)` | 否 | 站点 |
| `keyword` | `varchar(128)` | 否 | 买家搜索词原文（主键）。改文本键后不再受 1.8% 反查率限制 |
| `variant_asin` | `varchar(16)` | 否 | 投放的变体 ASIN |
| `stat_date` | `date` | 否 | 统计日期 |
| `keyword_id` | `bigint` | 是 | 原站关键词 ID（普通列）。⚠️ 源 web-variant-ad-keywords 不返回此字段 |
| `encrypt_campaign_id` | `varchar(64)` | 是 | 所属广告活动（冗余便于聚合） |
| `ad_type` | `tinyint` | 是 | 广告类型 1=SP 2=SB 3=SBV 4=SBBV。⚠️ 实测无源 |
| `traffic_type` | `varchar(16)` | 是 | 流量位类型：sp/spRec/sb/sbv |
| `score` | `double` | 是 | 流量得分 |
| `rank_position` | `int` | 是 | 广告位排名 |
| `created_at` | `datetime` | 否 | 入库时间 |

#### rel_ad_campaign_product_ad

> 广告活动→投放小组（时序关系表）。⚠️ 实测 campaigns[].ads 是按日期分组的对象，同一活动各周包含的投放小组会变，故主键必须带 stat_date

- **行数** 174 ｜ **主键** `encrypt_campaign_id, encrypt_ad_id, country, stat_date` ｜ **分桶** `HASH(encrypt_campaign_id)` × 2

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `encrypt_campaign_id` | `varchar(64)` | 否 | 广告活动 ID |
| `encrypt_ad_id` | `varchar(64)` | 否 | 投放小组 ID |
| `country` | `varchar(8)` | 否 | 站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR |
| `stat_date` | `date` | 否 | 该关系成立的日期（周起始日） |
| `created_at` | `datetime` | 否 | 入库时间 |

### 15.10 推荐专栏（3 张）

| 表 | 行数 | 主键 | 说明 |
|---|---:|---|---|
| [`dim_recommend_column`](#dim_recommend_column) | 143 | `rec_title, country` | 推荐专栏。实测裁定为动态实体而非固定枚举：前端硬编码仅 8 个短码但实测出 17 个标题且未收敛，新标题运行时 upsert 入库 |
| [`fact_asin_rec_column_period`](#fact_asin_rec_column_period) | 64 | `asin, country, rec_title, stat_date` | ASIN×推荐专栏 曝光。⚠️ 混合粒度：实测传 month 但返回逐日 dates，且极度稀疏（31 天仅 1 天有值）→ 只存非 null 的天 |
| [`rel_rec_column_campaign_keyword`](#rel_rec_column_campaign_keyword) | 9,144 | `asin, country, rec_title, keyword, encrypt_campaign_id` | 推荐专栏→广告活动→关键词 三层钻取关系。源 recRanks[]，可落 1,002 行 |


#### dim_recommend_column

> 推荐专栏。实测裁定为动态实体而非固定枚举：前端硬编码仅 8 个短码但实测出 17 个标题且未收敛，新标题运行时 upsert 入库

- **行数** 143 ｜ **主键** `rec_title, country` ｜ **分桶** `HASH(rec_title)` × 1

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `rec_title` | `varchar(255)` | 否 | 专栏英文原文（后端就用它做请求参数） |
| `country` | `varchar(8)` | 否 | 站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR |
| `short_code` | `varchar(16)` | 是 | 前端硬编码短码：Media/4Star/fView/KOL/rBuy/Trend/New/tDeal/other |
| `display_name_cn` | `varchar(255)` | 是 | 中文展示名（原站无，需我们自造） |
| `first_seen_at` | `datetime` | 是 | 首次观测到的时间 |
| `last_seen_at` | `datetime` | 是 | 最近观测到的时间 |

#### fact_asin_rec_column_period

> ASIN×推荐专栏 曝光。⚠️ 混合粒度：实测传 month 但返回逐日 dates，且极度稀疏（31 天仅 1 天有值）→ 只存非 null 的天

- **行数** 64 ｜ **主键** `asin, country, rec_title, stat_date` ｜ **分桶** `HASH(asin)` × 2

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `asin` | `varchar(16)` | 否 | ASIN 编号 |
| `country` | `varchar(8)` | 否 | 站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR |
| `rec_title` | `varchar(255)` | 否 | 推荐专栏英文原文 |
| `stat_date` | `date` | 否 | 统计日期（只存有值的天） |
| `ratio` | `double` | 是 | 流量贡献占比 |
| `campaign_cnt` | `int` | 是 | 该专栏位的广告活动数 |
| `keyword_cnt` | `int` | 是 | 该专栏位的关键词数 |
| `created_at` | `datetime` | 否 | 入库时间 |

#### rel_rec_column_campaign_keyword

> 推荐专栏→广告活动→关键词 三层钻取关系。源 recRanks[]，可落 1,002 行

- **行数** 9,144 ｜ **主键** `asin, country, rec_title, keyword, encrypt_campaign_id` ｜ **分桶** `HASH(asin)` × 2

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `asin` | `varchar(16)` | 否 | ASIN 编号 |
| `country` | `varchar(8)` | 否 | 站点 |
| `rec_title` | `varchar(255)` | 否 | 推荐专栏英文原文 |
| `keyword` | `varchar(128)` | 否 | 关键词原文（主键） |
| `encrypt_campaign_id` | `varchar(64)` | 否 | 广告活动 ID |
| `keyword_id` | `bigint` | 是 | 原站关键词 ID（普通列）。本表源自带 ID，填充率 100% |
| `mask_campaign_id` | `varchar(16)` | 是 | 前台 4 位短码（源同元素的 maskCampaignId） |
| `created_at` | `datetime` | 否 | 入库时间 |

### 15.11 供应商（占位）（1 张）

| 表 | 行数 | 主键 | 说明 |
|---|---:|---|---|
| [`dim_supplier`](#dim_supplier) | 50 | `id` | 供应商（1688 货源）。本期仅占位 UI + 表结构，不做任何采集/爬虫/对接 |


#### dim_supplier

> 供应商（1688 货源）。本期仅占位 UI + 表结构，不做任何采集/爬虫/对接

- **行数** 50 ｜ **主键** `id` ｜ **分桶** `HASH(id)` × 1
- **倒排索引** `idx_supplier_name`(supplier_name)

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `id` | `bigint` | 否 | 雪花 ID |
| `supplier_name` | `varchar(255)` | 是 | 供应商名称 |
| `offer_id` | `varchar(64)` | 是 | 1688 货源 ID |
| `title` | `varchar(1024)` | 是 | 货源标题 |
| `img` | `varchar(512)` | 是 | 主图 |
| `price` | `decimal(12,2)` | 是 | 价格 |
| `min_order` | `int` | 是 | 起订量 |
| `location` | `varchar(128)` | 是 | 地区 |
| `created_at` | `datetime` | 否 | 入库时间 |

### 15.12 迁移残留（4 张）

| 表 | 行数 | 主键 | 说明 |
|---|---:|---|---|
| [`fact_asin_subbsr_snapshot_new`](#fact_asin_subbsr_snapshot_new) | 1,654,767 | `asin, country, cat_name, stat_date` | ASIN 子类目 BSR 排名快照。⚠️ 原响应是动态 key 对象 {类目名:值}，入库须拆成行。按月自动分区 |
| [`fact_asin_subbsr_snapshot_old`](#fact_asin_subbsr_snapshot_old) | 1,654,767 | `asin, country, cat_name, stat_date` | ASIN 子类目 BSR 排名快照。⚠️ 原响应是动态 key 对象 {类目名:值}，入库须拆成行。按月自动分区 |
| [`fact_keyword_rank_history_new`](#fact_keyword_rank_history_new) | 117,740 | `asin, country, keyword, rank_type, stat_date` | ASIN×关键词 排名历史（日粒度）。主源 sif_asin_keyword.raw->allRankHistory。按月自动分区 |
| [`fact_keyword_rank_history_old`](#fact_keyword_rank_history_old) | 117,740 | `asin, country, keyword, rank_type, stat_date` | ASIN×关键词 排名历史（日粒度）。主源 sif_asin_keyword.raw->allRankHistory。按月自动分区 |


#### fact_asin_subbsr_snapshot_new

> ASIN 子类目 BSR 排名快照。⚠️ 原响应是动态 key 对象 {类目名:值}，入库须拆成行。按月自动分区

- **行数** 1,654,767 ｜ **主键** `asin, country, cat_name, stat_date` ｜ **分桶** `HASH(asin)` × 8 ｜ **分区** AUTO（按月自动建分区）

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `asin` | `varchar(16)` | 否 | ASIN 编号 |
| `country` | `varchar(8)` | 否 | 站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR |
| `cat_name` | `varchar(255)` | 否 | 子类目名称（原为动态 key） |
| `stat_date` | `date` | 否 | 统计日期。⚠️ 分区列，AUTO PARTITION 按月 |
| `bsr` | `bigint` | 是 | BSR 排名 |
| `created_at` | `datetime` | 否 | 入库时间 |

#### fact_asin_subbsr_snapshot_old

> ASIN 子类目 BSR 排名快照。⚠️ 原响应是动态 key 对象 {类目名:值}，入库须拆成行。按月自动分区

- **行数** 1,654,767 ｜ **主键** `asin, country, cat_name, stat_date` ｜ **分桶** `HASH(asin)` × 8 ｜ **分区** AUTO（按月自动建分区）

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `asin` | `varchar(16)` | 否 | ASIN 编号 |
| `country` | `varchar(8)` | 否 | 站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR |
| `cat_name` | `varchar(255)` | 否 | 子类目名称（原为动态 key） |
| `stat_date` | `date` | 否 | 统计日期。⚠️ 分区列，AUTO PARTITION 按月 |
| `bsr` | `bigint` | 是 | BSR 排名 |
| `created_at` | `datetime` | 否 | 入库时间 |

#### fact_keyword_rank_history_new

> ASIN×关键词 排名历史（日粒度）。主源 sif_asin_keyword.raw->allRankHistory。按月自动分区

- **行数** 117,740 ｜ **主键** `asin, country, keyword, rank_type, stat_date` ｜ **分桶** `HASH(asin)` × 4 ｜ **分区** AUTO（按月自动建分区）
- **倒排索引** `idx_rank_kw`(keyword)

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `asin` | `varchar(16)` | 否 | ASIN 编号 |
| `country` | `varchar(8)` | 否 | 站点 |
| `keyword` | `varchar(128)` | 否 | 关键词原文（主键） |
| `rank_type` | `varchar(16)` | 否 | 排名类型：nf/sp/sb/sbv/recSp（原设计只有 nf/sp，漏 3 种） |
| `stat_date` | `date` | 否 | 统计日期（按 allRankHistory.date[] 下标对齐）。⚠️ 分区列 |
| `keyword_id` | `bigint` | 是 | 原站关键词 ID（普通列） |
| `rank_position` | `double` | 是 | 全局排名。⚠️ 改 DOUBLE：sb/sbv 的 rank 100% 带小数编码版位 |
| `page_no` | `int` | 是 | 页码，从 rankStr 的 ^p(d+) 解析。sb/sbv/recSp 无页码概念 |
| `page_size` | `int` | 是 | 页容量，从 rankStr 的 /(d+)$ 解析。实测非固定 48（还有 16/49/47/46/40） |
| `slot` | `varchar(16)` | 是 | 版位：top/middle/bottom/tail。仅 sb/sbv 有，来自 rankStr 第 3 段 |
| `asin_order` | `int` | 是 | 同位次内序号。实测 sb/sbv 100% 非空，nf/sp 100% NULL |
| `campaign_id` | `varchar(64)` | 是 | 广告活动 ID。实测 sp/sb/sbv 有值，nf 恒 NULL |
| `mask_campaign_id` | `varchar(16)` | 是 | 前台 4 位短码（源 maskCampaignId） |
| `created_at` | `datetime` | 否 | 入库时间 |

#### fact_keyword_rank_history_old

> ASIN×关键词 排名历史（日粒度）。主源 sif_asin_keyword.raw->allRankHistory。按月自动分区

- **行数** 117,740 ｜ **主键** `asin, country, keyword, rank_type, stat_date` ｜ **分桶** `HASH(asin)` × 4 ｜ **分区** AUTO（按月自动建分区）
- **倒排索引** `idx_rank_kw`(keyword)

| 列 | 类型 | 可空 | 说明 |
|---|---|:-:|---|
| `asin` | `varchar(16)` | 否 | ASIN 编号 |
| `country` | `varchar(8)` | 否 | 站点 |
| `keyword` | `varchar(128)` | 否 | 关键词原文（主键） |
| `rank_type` | `varchar(16)` | 否 | 排名类型：nf/sp/sb/sbv/recSp（原设计只有 nf/sp，漏 3 种） |
| `stat_date` | `date` | 否 | 统计日期（按 allRankHistory.date[] 下标对齐）。⚠️ 分区列 |
| `keyword_id` | `bigint` | 是 | 原站关键词 ID（普通列） |
| `rank_position` | `double` | 是 | 全局排名。⚠️ 改 DOUBLE：sb/sbv 的 rank 100% 带小数编码版位 |
| `page_no` | `int` | 是 | 页码，从 rankStr 的 ^p(d+) 解析。sb/sbv/recSp 无页码概念 |
| `page_size` | `int` | 是 | 页容量，从 rankStr 的 /(d+)$ 解析。实测非固定 48（还有 16/49/47/46/40） |
| `slot` | `varchar(16)` | 是 | 版位：top/middle/bottom/tail。仅 sb/sbv 有，来自 rankStr 第 3 段 |
| `asin_order` | `int` | 是 | 同位次内序号。实测 sb/sbv 100% 非空，nf/sp 100% NULL |
| `campaign_id` | `varchar(64)` | 是 | 广告活动 ID。实测 sp/sb/sbv 有值，nf 恒 NULL |
| `mask_campaign_id` | `varchar(16)` | 是 | 前台 4 位短码（源 maskCampaignId） |
| `created_at` | `datetime` | 否 | 入库时间 |

---

> 共列 **65 张表 / 65 张**。字段以 Doris 实况为准；
> 若与 `db/schema-0*.sql` 不一致，说明有手工 ALTER 未回写建表文件（已知存在，见 §14.3）。
>
> ⚠️ 本节未含 schema-09 建的 `fact_rec_column_trend` 与 schema-10 建的 4 张表
> （见 §16）。§15 是**程序化生成**的（源自 `.tmp/real-ddl.sql`），
> 补进来要重跑生成流程，不要手写；当前表总数实况为 **70 张**。

---

## 16. 日粒度补表（2026-09-23，schema-10）

### 16.1 起因

用 `B01NBNDC1T` 逐页对照原站规格，发现三个图表做不出来，**根因都在数据层缺日粒度，不是表设计错**：

| 页面 | 缺什么 | 现有表为什么不够 |
|---|---|---|
| 查流量结构 · 60 天价格/BSR/流量复合图 | 日粒度价格 + 流量 + 大类 BSR | `fact_asin_traffic_channel` 只有 month（day 粒度实测 0 行）；`fact_asin_subbsr_snapshot` 有日粒度但**只存小类** |
| 运营时光机 · 83 天因果图 | 日粒度多指标并列 | `fact_asin_listing_snapshot` 是 `stat_month VARCHAR(7)`，且只有 price/score/rating_num/bsr 四列 |
| 查流量结构 · 流量变化归因表 | 「为什么变」 | `fact_asin_keyword_inout` 只有 in/out 两态，没有原因；且该 ASIN 实测 0 行 |

换源 `sif-cli` 后确认拿得到：`traffic-trend --granularity day` 一次返回 **356 天 × 37 字段**，
`rvs` / `diag` 给归因，`keyword-aba-trend` 给 103 周 ABA 趋势。

### 16.2 落地的表

| 表 | 行数（B01NBNDC1T） | 主键 | 说明 |
|---|---:|---|---|
| `fact_asin_daily_snapshot` | 356 | `asin, country, stat_date` | 日粒度全要素（价格/流量/排名/口碑/事件），**一张表同时供 60 天图与 83 天图**——两者同一份数据只是窗口不同 |
| `fact_asin_keyword_attribution` | 310 | `asin, country, keyword, stat_date, granularity` | 流量变化归因。month 来自 diag（300 词，源总计 3,079），day 来自 rvs（10 词） |
| `fact_keyword_search_trend` | +309 | （既有表）加 `ext_searches_num` / `searches_rank` 两列 | ABA 双轴图所需的词根综合搜索量与排名 |
| `fact_keyword_nf_share` | **0** | `keyword, country, asin, stat_date` | 自然位占位率，**只建表未灌数**，见 16.4 |
| `fact_keyword_slot_hourly` | **0** | `keyword, country, stat_hour, slot` | 小时级坑位，**只建表未灌数**，见 16.4。全库第一张小时粒度表 |

### 16.3 三个踩过的坑（写 ETL 前必读）

1. **`ldPrice` 不是数字，是复合串**。实测 `"14.99_0_当日19:35-次日07:35"`（价格_标志_时段）。
   第一次灌数按数值解析，356 行 `ld_price` 全 NULL 而源里有 36 天有值 —— 而且
   「NULL 计数 > 0」的校验**照样通过**，没报错。所以拆成 `ld_price` + `ld_raw` 两列，
   并把回读校验改成「打印非空天数对照源」而不是只看 NULL 多不多。
2. **`bsr` 是大类、`subBsr` 是小类**。实测 `bsr[]` 对应 `catName="Home & Kitchen"`（9~122），
   `subBsr` 是 `{"Pillow Inserts": [...]}`（恒 1~2）。此前 `fact_asin_subbsr_snapshot`
   只存了小类，**大类整个丢了**。`subBsr` 的键是动态类目名，ETL 要遍历取不能硬编码。
3. **`titleImg` 是整数标志位不是文本**（实测值 2）。

### 16.4 两张空表：为什么本期拿不到数据

不是 ETL 漏了，是**源侧的确定性限制**，各表 COMMENT 里也写了：

- `fact_keyword_nf_share`（占位率）：已核 `sif-cli list` 全部 41 个 endpoint
  （meta/keyword/asin/compete/monitor/webapp 六组），**没有返回 topN 占位率的接口**。
  `asin-keyword-detail` 给的是该 ASIN 自己的逐日排名，不是「前 N 名里的占位数」，算不出分子。
  **下一步条件**：找到能返回某词自然位 Top48 完整 ASIN 列表的源，就能自行聚合。
- `fact_keyword_slot_hourly`（小时级坑位）：`monitor-keyword-query` 是只读接口，
  只返回「**已开启监控的词**」的快照，当前账号没开任何监控词，返回空 list。
  **下一步条件**：在 SIF 前台对目标词开启坑位监控并等其积累小时快照 ——
  这是**账号侧操作**，不是代码能绕过的。

### 16.5 顺手修掉的三个既有缺陷

1. **推荐专栏占比合计 1000%**（`traffic.service.ts`）。`ratio` 是每个 ASIN 各自的份额
   （逐个 SUM 都是 1.0），按父体查时跨 10 个变体直接相加 → 页面显示「顾客常看 633%」。
   改为按变体流量得分**加权平均**，且**分母用组内全部变体权重和这个常数**
   —— 按专栏分别取各自权重做分母会因专栏集合稀疏（实测同一天 10 个变体分别只有
   2/4/5/5/5/5/6/6/6/7 个专栏）而再次超过 1（实测 1.34）。修后合计 = 1.0。
2. **流量词占比合计 664%**（`keywords.service.ts`）。同类错误。
   `listing_score_ratio` 的真实分母**只能反解**：同一 ASIN 内 `score / ratio`
   对每个词都得到同一常数（实测 372,061.8 / 124,754.1 / 53,259.3），
   是源侧的 Listing 全量词总分 —— 既不等于 `traffic_channel` 的 total（46,334.5），
   也不等于已存词合计（145,330.7，因为只落了各变体头部 4 个词）。
   用错分母会把占比系统性放大约 2 倍。修后 top50 合计 0.425（覆盖 38%~56% 流量，合理）。
   顺带修了同一函数里 `channels[].ratio` 的相同错误，两条路径现在数值完全一致。
   **副作用**：加权后分子量级从 0.45 升到 3000，Doris 分布式 `SUM` 的浮点非确定性
   被放大到 1e-12，游标翻页出现重复行（实测一个词在第 3/4 页各出现一次）。
   排序键与游标一并 `ROUND(..., 4)` 后，limit=10/7 两种页长都 50 行不重不漏。
3. **广告页「涉及 ASIN」恒显示 0**（`ads.service.ts`）。`dim_ad_campaign.asin_num`
   实测 5,925/5,928 行为 NULL，而代码写 `Number(r.asin_num ?? 0)`。
   改为回落到同一查询已算出的 `variant_cnt`，并用 `asinNumSource` 标注来源
   （`derived` 时前端加「≥」前缀），都没有时给 null 让前端显示「—」。

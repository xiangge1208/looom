# Doris 表结构差距分析（对照 M10~M15 修订计划）

> 日期：2026-09-21（**表数口径已于 2026-09-22 重核，见下方修订行**）。
> 方法：直连 Doris 全量 DDL + 行数（快照存 `docs/audit/doris-ddl-snapshot.sql`，**已刷新为 65 张**）
> + PG `sif_api_log` 端点覆盖实查。对照依据：ROADMAP 修订表 + SIF_UI_AUDIT §8b~§8e。
> **本文档回答一个问题：当前表结构哪些不能满足 M10~M15，哪些要改、哪些要新建。**
>
> ⚠️ **2026-09-22 修订**：本文撰写时记「59 张表」，实为
> **65 张物理表 = 61 张逻辑表 + 4 张分区迁移残留**。文中所有行数也已过期（数据在持续 ETL）。
> 权威实况见 [DORIS_SCHEMA_DESIGN.md §14](DORIS_SCHEMA_DESIGN.md)，本节 §0 表格已同步。
> **§1 各表的「行数」列保留撰写时值，仅供横向比较量级，不要当现值引用。**

---

## 0. 结论速览

> 修订（2026-09-22）：下表「数量」为撰写时判断，**执行结果**见括号内。

| 动作 | 数量 | 明细 |
|---|---:|---|
| ✅ 现有表直接可用 | 12 张 | 见 §1 |
| 🔧 需改表（改注释/加列/改名/重建键） | 5 张 | 见 §2（**4 张已执行**：改名拆维、metric 加列、dict 加 rec 行、favorites 重建键；`rel_keyword_group` 尚未 DROP，仍 0 行） |
| ➕ 需新建 | 11 张 | 见 §3（**实查仅 3 张已建**：`fact_keyword_bid_estimate`、`rel_keyword_asin_traffic_share`、`fact_keyword_acos_estimate`；其余 8 张未建，清单见 §14.2） |
| ❌ 原计划新建但建议取消 | 2 张（另 1 张被合并语义） | 见 §4 |
| 🟢 探源升级（seed→真实 ETL） | 2 项 | 见 §5 |

---

## 1. 现有表直接可用（不动）

| 表 | 行数 | 服务于 | 满足点 |
|---|---:|---|---|
| `fact_asin_bought_monthly` | 809,591 | M10 对比销量 | **40 个月**（2023-05→2026-08）逐月序列，页面要 31 个月，够 |
| `dim_asin` | 59,912 | M10/M11/M12/M13 | 标题/图/价/评分/评价数/上架日/BestSeller 标，全齐 |
| `dim_asin_feature` | 43,729 | M10 对比销量「属性」列 | Color/Size 键值已按下标 zip 对齐 |
| `fact_asin_keyword_score` | 19,095 | M10 对比流量词动态列 | ASIN×关键词×渠道得分长表，动态列查询层拼 |
| `fact_keyword_conversion_funnel` | 5,875 | M13 转化率页 | 搜索/点击/购买/份额/均价全列 ✓ |
| `fact_keyword_metric_snapshot` | 22,320 | M13 /amount | 7 个竞品数列已灌（缺 video，见 §2） |
| `fact_keyword_competition_snapshot` | 21,328 | M13 /amount | `global_keyword_num`/`stat_week_end` 独有列，保留 |
| `fact_keyword_rank_history` | 117,740 | M14 每日排名 | nf/sp/sb/sbv 四类型日粒度，已按月分区 |
| `fact_keyword_search_trend` | 178,046 | M11 + M12 同比 | `is_prev_period` 双序列 ✓（本期+去年同期都有） |
| `rel_keyword_top_asin` | 56,795 | M12 「自然流量Top5产品」列 | 6,710 词的 Top 图/标题/价 ✓ |
| `dim_recommend_column` | 143 | M10 `flowResources` 命名位 | 实测同一实体（"4 stars and above"…） |
| `fact_asin_rec_column_period` | 64 | M10 推荐位明细 | 稀疏但结构在 |

⚠️ 注意 `fact_keyword_rank_history` 日期范围只有 **2026-07-29 → 09-19（约 53 天）**。
每日排名页默认 7 天区间没问题，但原站 `minDay` 能回溯一年多——我们 UI 要如实标注可查范围。

---

## 2. 需要改的表（5 张）

### 2.1 `fact_keyword_bid_estimate` —— 改名 **+ 拆维**（0.5 期第 1 步）

> ✅ **已执行**（`db/schema-07-m13-rework.sql` §1）。
> ⚠️ 实际做法比本节写的多一步：不只是改名「数据不动」，还**拆了维**。
> 原 `match_type` 列存 `autoForSales_broad` 这种源 JSON 拼接值，
> 已拆成 `match_type(broad/phrase/exact)` × `bid_strategy(auto/legacy)` 两列 ——
> 因为新竞价表主键就是两维分开的（见 §3 的表），不拆则 service 要写两套解析。
> 迁移无损：33,019 → 33,019 行，6 个组合行数逐一对应。
> 旧表存为 `fact_keyword_acos_estimate_v1` 待人工确认后 DROP。

33,019 行装的是 **ACOS/CPA**（源 `web-keyword-conversion`），不是竞价。表名撒谎。

- `ALTER TABLE fact_keyword_bid_estimate RENAME fact_keyword_acos_estimate`
- COMMENT 同步改：源、口径（start/median/end 为悲观/中位/乐观**递减**）
- 同步改：`schema-06` DDL、`etl_module13_wordpick.py` 的 `run_bid` 目标表、
  `wordpick.service.ts`（若已引用）
- 数据**不迁移**（33,019 行原样有效），只换名字

### 2.2 `fact_keyword_metric_snapshot` —— 加 2~3 列

- `video_asin_num INT` —— 源 `videoAsinNum`（SBV 产品数，/amount 页有此列，建表时漏了）
- `sale_num` COMMENT 改为「在售产品数（源 saleNum）」——审计判明它不是销量
- ⛔ ~~`top3_click_shared` / `top3_conversion_shared DOUBLE`~~ —— **不要建，会与既有列重复**。
  这两个值**已经在表里了**，就是 `click_shared` / `conversion_shared`
  （schema-06 建的，落表 264 行）。原以为它们是「份额」所以当成另一回事，
  审计 §3 + PG 实查确认：源字段 `clickShared`/`conversionShared` 正是 /amount 页
  「ABA Top3 集中度」列的数据（页面显示「点击 8.6% / 转化 3.9%」）。
  PG 实测样例 `gag gifts for men → 0.1907 / 0.1547`，量级与页面百分比吻合。
  **schema-07 已把这两列的 COMMENT 改正为「ABA Top3 点击/转化集中度（非份额）」。**
  下面这段 MCP 取数方案仍有价值 —— 但用途是**补历史序列**（既有列只有单周值），
  不是新建当期列：

  ✅ **历史序列源已确认（2026-09-21，sif MCP 实测）**：`market_get_keyword_history` 返回
  `top3_click_shares[]` / `top3_conversion_shares[]`（"travel gifts" 实测 313 周完整序列，
  另带 `latest.top3_asins`）。取数方式二选一，随 0.5 期定：
  a) ETL 从 MCP 拉平落库（推荐，与既有列同表同口径、查询零外部依赖）；
  b) service 现调 MCP（省 ETL 但接口延迟/可用性外泄到页面）。
  接入档案见 `SIF_MCP_SETUP.md`。

### 2.3 `dict_traffic_channel` —— 加 `rec` 渠道 code

对比流量结构页 10 类计数里 **`rec`（推荐位）计数 142 非零**，而现有字典/数据只有
`spRec`（SP 推荐）没有 `rec`。加字典行 + `fact_asin_traffic_channel` 的 ETL 补 rec 渠道。
（`brand`→`sb`、`brandVedio`→`sbv`、`vedio`/`ac`/`er`/`tr` 可暂不进——实测计数为 0 或可映射。）

### 2.4 `user_favorites` —— 重建主键（表是空的，现在改零成本）

现 `UNIQUE KEY(id)`，唯一性靠应用层。M15 关注体系 + M14 每日排名订阅都会高频写这张表，
应用层去重在并发下会出脏行。重建为：

```
UNIQUE KEY(user_id, favorite_type, target_type, country, target_value)
```

同时**加列 `library_id BIGINT`**（指向 §3.4 的库主表，替代现在的 `group_name VARCHAR` 弱关联）。

### 2.5 `rel_keyword_group` —— 被 §3.5 取代后 DROP（表空）

现结构 `(group_id, keyword, country)` 无库语义（正/负词库、阶段、相关性标记、加入时间都放不下）。
新建 `user_library_keyword`（§3.5）后删除此空壳，避免两套并存。

---

## 3. 需要新建的表（11 张）

### M13（0.5 期）

| 表 | 主键 | 数据来源 | 说明 |
|---|---|---|---|
| `fact_keyword_bid_estimate`（新语义重建） | `(keyword, country, category_id, match_type, bid_strategy, stat_month)` | 🔴 seed（`search/cpc/category` 未爬） | 建议竞价：**与品类强相关**；start/median/end 是**区间下/中/上界（递增）**，与 ACOS 方向相反。`bid_strategy` 两档：提升与降低 / 仅降低与固定（原站合并口径） |
| `rel_keyword_asin_traffic_share` | `(keyword, country, asin)` ⚠️ **不含 stat_week** | 🟡 **`web-compete-pattern` 有真实源但覆盖极窄**：82 条 ok 里仅 **22 条真有 `asins`**（60 条是 null），合计 1,637 行 / **9 个去重关键词**。详见 [AUDIT §11.8](SIF_UI_AUDIT_2026-09-21.md) | /compete 页：ASIN× 流量位份额矩阵。⚠️ 响应有 **8 个** scoreRatio 但页面只展示 6 列（er/tr 存疑）；源响应**无周维度**，故 `stat_date` 只能是普通列不进主键 |

### M14（第 2 期）

| 表 | 主键 | 数据来源 | 说明 |
|---|---|---|---|
| `rank_monitor` | `(id)` 雪花 | 用户自产 | 监控任务：`granularity(hour/day/snapshot)`、`period_hours(1/2/3/6/12)`、`pages(3/7)`、`duration_days(7/14/28)`、`is_auto_proceed`、`status(monitoring/stopped/expired)`、`expire_at`、`integral_cost`（仅记录展示，不扣费）。三页共用 |
| `fact_keyword_rank_hourly` | `(asin, country, keyword, rank_type, stat_hour)` | 🔴 seed | 小时粒度排名。**坑位快照复用此表**（快照=固定参数 1h×3页×15天 的特例），原计划的 `fact_keyword_slot_snapshot` 不再单建。列对齐 `fact_keyword_rank_history`（rank_position/page_no/slot/asin_order/campaign_id），按天分区 |

### M15a（第 3 期，提前）

| 表 | 主键 | 数据来源 | 说明 |
|---|---|---|---|
| `user_library` | `(id)` 雪花 | 用户自产 | 库主表，产品库/词库共用：`library_type(product/word)`、`kind`（产品库：my/expand_competitor/benchmark/targeting；词库：product/stage_new/stage_growing/stage_mature/stage_decline）、`polarity(valid/negative)`（词库正负配对）、`parent_id`（两级结构）、`sort_order`、上限 500 由应用层控 |
| `user_library_keyword` | `(library_id, keyword, country)` | 用户自产 | 词库成员：`relevance_level(high/mid/low/irrelevant)`（相关性标记，继承添加时标记可改）、`added_at`。**取代 `rel_keyword_group`** |
| `user_keyword_tag` | `(id)` 雪花 + 关联列进 `user_library_keyword.tag_ids` | 用户自产 | 自定义标签（词库页「自定义标签」列 + 管理对话框配置） |

### M12（第 5 期）

| 表 | 主键 | 数据来源 | 说明 |
|---|---|---|---|
| `fact_keyword_expand` | `(seed_keyword, country, expand_keyword)` | 🟢 **`web-keyword-extend` 625 条 ok —— 有真实源！** | 词根拓词：`translate_keyword`、`match_types`（Exact/DropDownBox/Phrase/AllMatch 逗号串）、`est_searches_num`、`searches_rank`。趋势序列进既有 `fact_keyword_search_trend`，Top 产品进既有 `rel_keyword_top_asin`，不重复建 |
| `fact_keyword_category_expand` | `(category_id, country, keyword)` | 🔴 seed（`keywordByCategory` 未爬） | 品类拓词（字段比词根拓词少 4 组，**不同构分表**） |
| `dim_niche_category` | `(category_id, country)` | 🔴 seed（`category/suggestion` 未爬） | 类目树（联想选择用） |

### M11（第 6 期）

| 表 | 主键 | 数据来源 | 说明 |
|---|---|---|---|
| `fact_keyword_period_product` | `(keyword, country, period_type, period_value, asin)` | 🔴 seed（`summaryKeyword` 端点无日志） | 关键词×时间段→历史畅销产品榜（页面主体，100 行/时段） |

### 日粒度补表（2026-09-23 已执行，schema-10）

本轮不在原计划内 —— 是用 `B01NBNDC1T` 逐页对照原站规格后新发现的缺口。
完整记录见 `DORIS_SCHEMA_DESIGN.md` §16。

| 表 | 主键 | 数据来源 | 状态 |
|---|---|---|---|
| `fact_asin_daily_snapshot` | `(asin, country, stat_date)` | 🟢 `sif-cli traffic-trend[granularity=day]`，一次 356 天 × 37 字段 | ✅ **已建已灌**（356 行）。同时供 60 天复合图与 83 天因果图 |
| `fact_asin_keyword_attribution` | `(asin, country, keyword, stat_date, granularity)` | 🟢 `sif-cli rvs`（日）+ `diag`（月） | ✅ **已建已灌**（310 行） |
| `fact_keyword_search_trend` 加 2 列 | （既有表） | 🟢 `sif-cli keyword-aba-trend`，103 周 | ✅ **已加已灌**（+309 行）。补 `ext_searches_num` / `searches_rank` |
| `fact_keyword_nf_share` | `(keyword, country, asin, stat_date)` | ⬜ **无源** | ⚠️ **表已建、数据待源**，见下 |
| `fact_keyword_slot_hourly` | `(keyword, country, stat_hour, slot)` | ⬜ **源需账号侧操作** | ⚠️ **表已建、数据待源**，见下。全库第一张小时粒度表 |

**两张空表取不到数的确定性结论**（不是 ETL 漏了）：

- `fact_keyword_nf_share`（占位率，支撑「拓词&筛查」页）：
  已核 `sif-cli list` 全部 **41 个 endpoint**（meta/keyword/asin/compete/monitor/webapp 六组），
  **没有返回 topN 占位率的接口**。`asin-keyword-detail` 给的是该 ASIN 自己的逐日排名，
  不是「前 N 名里的占位数」，**算不出分子**。
  → **下一步条件**：找到能返回某词自然位 Top48 **完整 ASIN 列表**的源，即可自行聚合
  （分子 = 列表里属于本 Listing 的变体数）。
- `fact_keyword_slot_hourly`（小时级坑位，支撑「查坑位/推排名」页 24h×7d 网格）：
  `monitor-keyword-query` 是**只读**接口，只返回「已开启监控的词」的快照，
  当前 SIF 账号未开任何监控词，返回空 list。
  → **下一步条件**：在 SIF 前台对目标词（如 `lumbar pillow`）**开启坑位监控**，
  等其积累出小时级快照后再灌。这是**账号侧操作，代码绕不过**。

---

## 4. 原计划新建、建议取消的表（2 张）

| 表 | 原计划 | 取消理由 |
|---|---|---|
| `fact_asin_listing_daily` | M11 日粒度快照（157 万行） | 审计判 7：产品时光机=关键词→历史畅销榜，不需要按 ASIN 的日快照 |
| `fact_keyword_slot_snapshot` | M14 坑位快照独立表 | 与小时排名同构（keyword×ASIN×rank_type×时刻），合并进 `fact_keyword_rank_hourly`，快照只是参数固定的特例 |
| `rel_keyword_root` | M12 词根关系表 | `fact_keyword_expand.seed_keyword` 已表达同一关系，单建冗余 |

（表虽 3 行，「取消的表」共 2 张 + 1 张被合并语义。）

---

## 5. 探源升级：原计划 seed、实际有真实源（2 项）

| 功能 | 原计划 | 实测 | 影响 |
|---|---|---|---|
| M13 /compete ASIN×份额 | 「待探源，无则 seed」 | `web-compete-pattern` 82 ok，但**仅 22 条有数据 / 9 个词** | 真实 ETL **+ seed 补覆盖**，靠 `source` 列区分 |
| M12 词根拓词 | 「需从零解析 endpoint」 | `web-keyword-extend` **625 条 ok**（此前文档记 473，又涨了） | 真实 ETL；解析工作量保留但不用等爬数 |

同时确认**无源**（维持 seed）：`keywordByCategory`、`category/suggestion`、`multiAsinKeywords`/`compareMyKeywords`/`asinMagic`/`asinSummary`（M10 聚合端点——但 M10 本就零 ETL 从既有表组合，无影响）、`summaryKeyword`（M11）。

---

## 6. 执行顺序建议（并入 ROADMAP 0.5 期）

1. **改名** `fact_keyword_bid_estimate` → `fact_keyword_acos_estimate`（数据不动）
2. **重建** 新语义 `fact_keyword_bid_estimate`（类目维，seed）
3. `fact_keyword_metric_snapshot` **加列**（video_asin_num + top3 两列；top3 源已确认为 sif MCP，落库或现调随 0.5 期定）
4. `dict_traffic_channel` **加 rec 行**
5. ✅ **已建** `rel_keyword_asin_traffic_share`（`db/schema-07-m13-rework.sql` §4，空表待 ETL）。
   ⚠️ 行数估算修正：实际可灌 **1,637 行 / 9 个词**（22 条有效响应 × ~74 ASIN），
   不是原估的 8,000 行 / 82 词 —— 82 是 `ok=true` 计数，其中 60 条 `asins` 为 null。
   **判断就绪度要看目标数组的 `jsonb_typeof`，不能只看 `SUM(ok)`。**
6. M15a/M14/M12/M11 的表**各随其期次建**，不提前
7. `user_favorites` 重建键 + `user_library` 三表随 M15a（第 3 期）落地；
   `rel_keyword_group` 在 M15a 完成后 DROP

建表全部进 `db/schema-06-m13-wordpick.sql` 之后的分模块 schema 文件（沿用现有
`schema-07-*.sql` 命名），同步 `setup-doris.sh` glob / `init-db.mjs` FILES / Dockerfile COPY 三处。

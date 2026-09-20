# 业务表合并映射（主 Agent 裁定）

5 个域共提出 **90+ 张表**，其中大量指向同一实体。本文件记录统一后的表名与原名映射，
是 `DATA_DICTIONARY.md` B 部分「合并日志」的依据。

命名规范见 `NAMING.md`。

## 一、基础实体（dim_）

| 统一表名 | 各域原名 | 冲突处理 |
|---|---|---|
| `dim_asin` | sales `dim_asin`、traffic `dim_asin`、keywords `dim_asin`、timemachine `sif_asin` | **4 域同实体**，字段取并集。主键 `(asin, country)` |
| `dim_keyword` | keywords `dim_keyword`、timemachine `sif_keyword` | 2 域同实体。主键 `(keyword_id)`（实测裁定，不带 country） |
| `dim_word` | keywords `dim_word` | 单词级（词根）实体。⚠️ 无 ID 字段，主键 `(word, country)` |
| `dim_asin_feature` | sales `dim_asin_feature` | 变体属性名+值。**实测确认 features 有两个层级**，此表存「属性名→属性值」 |
| `dim_recommend_column` | traffic `dim_recommend_column` + `dict_recommend_column`、keywords `dict_rec_column`、recommendations 域 `dim_recommend_column` | ✅ **已裁定：动态实体，用 `dim_` 不用 `dict_`**（证据见下） |

### 裁定：推荐专栏是「动态实体」而非「固定枚举」

recommendations-compare 域给出 4 条实测证据，**我采纳**（这推翻了我先前把它列为 `dict_` 的初判）：

1. 前端硬编码只有 **8 个短码**，且显式留了 `other` + 「其它」+ 兜底灰色 `#C8B2B7`
2. 9 个 ASIN 抽出 **17 个不同标题**，其中 10 个不在硬编码表里，
   **且每加一个 ASIN 还在冒新标题（未收敛）**
3. 语义高度重复 —— 4 个标题都是「4 星以上」的不同措辞
   （`4 stars and above` / `Highly rated` / `Rated 4+ stars by customers` / `4+ star picks`），
   这是**亚马逊 A/B 测试文案**的典型特征
4. 接口必填参数就是 **`recTitle` 英文原文字符串**，后端根本没有 code 体系

> **建表方案**：`dim_recommend_column(id, rec_title, country, short_code, first_seen_at, last_seen_at)`
> - `rec_title` 是**英文原文字符串**，业务主键（后端就用它做参数）
> - `short_code` 存前端硬编码的 8 个短码之一或 `other`（可空）
> - 新标题**运行时自动入库**（upsert），不预置固定枚举
> - ⚠️ 中文名：硬编码表里**全部无中文名**，需我们自造（goal.md 要求自造中文文案，正好一致）

已确证的 8 个短码映射：

| 短码 | 英文原名 |
|---|---|
| `Media` | Seen on social media |
| `4Star` | 4 stars and above |
| `fView` | Customers frequently viewed |
| `KOL` | Picks from Amazon Influencers |
| `rBuy` | Recently bought and rated |
| `Trend` | Trending now |
| `New` | New arrivals |
| `tDeal` | Today's deals |
| `other` | （兜底空串 → 显示「其它」） |

⚠️ **goal.md 提到的 3 个专栏未能证实存在**：`Amazon Choice`、`Editorial Recommendation`、
`Top Rated` —— 硬编码表和所有实测响应里都没有。goal.md 的「站点定位」章节据此需修正。

## 二、变体关系（rel_）

| 统一表名 | 各域原名 | 冲突处理 |
|---|---|---|
| `rel_asin_variant` | sales `dim_asin_variant_group`、traffic `dim_asin_variant` + `rel_listing_variant` | 3 处指向同一「父子体变体组」关系。合并为一张 |
| `rel_user_asin_focus` | sales `rel_user_asin_focus` | 用户收藏（产品库）。**属系统表范畴**，并入 A11 `user_favorites` |
| `rel_user_search_record` | sales `rel_user_search_record` | 用户搜索历史。**属系统表范畴**，并入 A6 `query_logs` |

## 三、时序快照（fact_）—— 按粒度分组，禁止跨粒度合并

### 3.1 月粒度（timePieceType=month）

| 统一表名 | 各域原名 | 主键 |
|---|---|---|
| `fact_asin_bought_monthly` | sales `fact_asin_bought_monthly` | `(asin, country, stat_month)` |
| `fact_asin_listing_snapshot` | sales `fact_asin_listing_snapshot` | `(asin, country, stat_month)` |
| `fact_asin_traffic_summary` | traffic `fact_asin_traffic_summary`、timemachine `sif_asin_traffic_snapshot` | ⚠️ **需仲裁**：两域都描述「ASIN 流量快照」，但字段集差异大 |
| `fact_asin_keyword_snapshot` | keywords `fact_asin_keyword_snapshot`、timemachine `sif_asin_keyword_traffic_snapshot` | `(asin, country, keyword_id, time_piece_type, time_piece_value, ...)` ⚠️ 需仲裁 |
| `fact_asin_traffic_channel` | traffic `fact_asin_traffic_agg` + `fact_asin_flow_overview` + `fact_listing_score_chart`、keywords 的 traffic_type 长表 | **长表设计**，主键含 `channel`。多域指向同一结构 |
| `fact_asin_keyword_overview` | keywords `fact_asin_keyword_overview` | 概览聚合 |
| `fact_word_frequency` | keywords `fact_word_frequency` | 词频聚合 |

### 3.2 日粒度（无 timePiece 参数）

| 统一表名 | 各域原名 | 主键 |
|---|---|---|
| `fact_asin_multinf_daily` | timemachine `sif_asin_multinf_daily` | `(asin, country, stat_date)` |
| `fact_keyword_rank_history` | keywords `fact_keyword_rank_history`、`keyword_search_trend` | ⚠️ 需确认粒度 |
| `fact_asin_subbsr_snapshot` | timemachine `sif_asin_subbsr_snapshot` | BSR 排名快照 |

### 3.3 区间聚合（非标准粒度）

| 统一表名 | 各域原名 | 说明 |
|---|---|---|
| `fact_asin_multinf_keyword` | timemachine `sif_asin_multinf_keyword` | ASIN×关键词 区间聚合 |
| `fact_asin_multinf_keyword_variant` | timemachine `sif_asin_multinf_keyword_variant` | 关键词×变体 排名明细 |
| `fact_asin_keyword_inout` | timemachine `sif_asin_keyword_inout_snapshot` | 前3页进出快照 |

## 三补、广告域表（ads 域，含三条认知纠正）

ads 域推翻了三个「常识性」假设，**建表必须按纠正后的结构**，否则整个广告模块会错：

### 纠正 1：Product Ad ≠ Amazon AdGroup，是 5 层结构

代码内权威定义（`chunks/30 @481008`）：
> 投放小组(Product Ad)是亚马逊根据每个广告组(AdGroup)中投放变体的数量创建的更小的广告单位

实际层级：`Campaign → AdGroup → Product Ad → 变体 → 搜索词`（**5 层**）

**关键**：AdGroup 这一层 Sif 前端**完全没有字段，一个 id 都没有**。
`/adxray-adgroup` 页面标题叫「查广告组」，但内部字段全是 `adShowId` / `fakeAdId`（即 Product Ad）。

> ❌ **不要建 `ad_group` 表** —— 素材不支持，凭常识建会造出一张永远空着的表。
> Sif 的流量归因落在 **Product Ad** 层。

### 纠正 2：查广告词页存「买家搜索词」，不是「投放词」

模板明确标注 `搜索词( 不是投放词 )`。投放词只能靠气泡图「推测投放词和匹配模式」。

> ❌ **不要建投放词（targeting keyword）表** —— 素材不支持。
> 只建 `fact_ad_search_term_exposure`（买家搜索词曝光快照）。

### 纠正 3：`adType` 与 `trafficType` 是两套正交枚举

这纠正了主 Agent 先前的理解（曾以为 SP常规/SP推荐 属同一枚举）：

| 枚举 | 类型 | 取值 |
|---|---|---|
| `adType` | int | `1:"SP"` / `2:"SB"` / `3:"SBV"` / `4:"SBBV"`（UI 把 SB+SBV 合并显示） |
| `trafficType` | string | SP常规=`"sp"` / SP推荐=`"spRec"` / SB常规=`"sb"` / SBV=`"sbv"` |

> 建 **两张独立枚举表**：`dict_ad_type`（广告产品类型）+ 复用 `dict_traffic_channel`（流量位类型）。
> 注意 `trafficType` 的 `spRec` 与 keywords 域实测的 `spRec` 是同一套，可复用。

### 广告域统一表名

| 统一表名 | ads 域原名 | 主键 | 说明 |
|---|---|---|---|
| `dim_ad_campaign` | `ad_campaign` | `(encrypt_campaign_id, country)` | ⚠️ **三套 ID 并存**：`fakeCampaignId`（前台数字）/ `encryptCampaignId`（内部加密）/ `campaignIdA0`（用户录入的后台真实 ID） |
| `dim_ad_product_ad` | `ad_product_ad` | `(encrypt_ad_id, country)` | 投放小组。✅ **已实测裁定**：只需 `encrypt_ad_id` + `fake_ad_id`（4 位短码）。`adShowId` 是前端变量名、**不是接口字段**，不建列 |
| `fact_ad_search_term_exposure` | `ad_search_term_exposure_snapshot` | `(encrypt_ad_id, keyword_id, variant_asin, country, stat_date)` | 最细事实表。⚠️ 广告域用 `granularity` 而非 `timePieceType`，时间键改 `stat_date` |
| `rel_ad_campaign_product_ad` | — | **`(encrypt_campaign_id, encrypt_ad_id, country, stat_date)`** | ✅ **已实测修正**：`campaigns[].ads` 是**按日期分组的对象**，同一 campaign 各周包含的投放小组集合会变 → 这是**时序关系表**，必须带 `stat_date` |
| `dict_ad_type` | `adType` 枚举 | `(code)` | 1=SP / 2=SB / 3=SBV / 4=SBBV |
| **`sys_user_ad_note`** | `adNote` 系列 | `(id)` | **归系统表**，见下 |

### adNote 归属裁定：系统表（采纳 ads 域五条证据）

1. 路径前缀 `/api/user/` 而非 `/api/search/`
2. UI 文案明写「仅自己可见」
3. 内容是用户**手工录入**的前后台 ID 对应（Sif 爬不到卖家后台数据）
4. 有完整 CRUD
5. 有独立分页管理页

→ 归入系统表 `sys_user_ad_note`。业务表里出现的 `campaignName` / `campaignColor`
是 JOIN 出来的展示字段，**不入业务表**。

### cpc 系列（10 个端点）：独立子功能

查亚马逊建议竞价（Suggested Bid），**异步任务型**，与三个广告页**无数据关联**。
核心是 6 列竞价矩阵（legacy/auto × Exact/Phrase/Broad）。

> goal.md 页面清单未包含竞价查询页（`/cpc-realtime`、`/cpc-browsetree`）
> → **本期不做**，表结构不建。

### `/adxray-variation` 是未实现空壳

chunk 124 仅 **375 字节** + 一个写死的 div。goal.md 也未要求 → 跳过。

## 四、待仲裁的重复表（不自行合并，交用户裁决）

goal.md 明确要求：「发现两个子 Agent 的结论矛盾，不要自己选一个，两份都保留，标 ⚠️ 交给我裁决」。

| # | 冲突项 | traffic 域主张 | timemachine 域主张 | 我的初判 |
|---|---|---|---|---|
| 1 | ASIN 流量快照 | `fact_asin_traffic_summary`（按 block/channel 长表） | `sif_asin_traffic_snapshot`（宽表，含运营事件字段） | 倾向长表，但 timemachine 的运营事件字段需单独成表 |
| 2 | ASIN×关键词流量 | — | `sif_asin_keyword_traffic_snapshot` | keywords 域的 `fact_asin_keyword_snapshot` 更完整，以其为主 |
| 3 | 流量渠道枚举 | `dict_traffic_channel`（13 值，含 Deal/BS） | `dict_traffic_type` | **以 traffic 域为准**（它做了 5 套映射对齐） |
| 4 | 推荐专栏 | `dim_` + `dict_` 两版并存 | — | 待 recommendations 域产出后定 |

## 五、枚举字典去重（dict_）

各域共提出 **30+ 个 dict 表**，大量重复。统一为：

| 统一表名 | 各域原名 | 说明 |
|---|---|---|
| `dict_time_piece` | sales `enum_time_piece`、traffic `dict_time_piece_type`、keywords `dict_time_piece`、timemachine `dict_granularity` + `dict_time_piece` + `dict_last_months` | **4 域 6 表指向同一概念**。合并为一张，取值 `day`/`week`/`month`（week 标注实测不可用） |
| `dict_traffic_channel` | traffic `dict_traffic_channel`、keywords `dict_traffic_type`、timemachine `dict_traffic_type` + `dict_traffic_scope` | **以 traffic 域 13 值版为准**，其余作为别名映射记录 |
| `dict_sort_field` | sales `enum_sort_field` | 排序字段白名单（sales 域实测穷举验证过） |
| `dict_bought_bucket` | sales `enum_bought_bucket` | 销量分档（14 个观测值） |
| `dict_dimension` | traffic `dict_dimension`、sales `enum_sales_dimension` | 变体/Color/Size 维度切换 |
| `dict_keyword_tag` | keywords `dict_keyword_tag` | 关键词标签（isCore/isTarget/isAC 等） |
| `dict_match_type` | keywords `dict_match_type` | 广告匹配类型 |
| `dict_op_event_type` | timemachine `dict_op_event_type` | 运营动作类型 |
| `dict_variant_role` | timemachine `dict_variant_role` | 变体角色（父体/子体/兄弟） |
| `dict_recommend_column` | traffic `dict_recommend_column`、keywords `dict_rec_column` | 推荐专栏类型 |

**降级为「前端常量」不建表**（仅 UI 状态，不参与数据关系）：
`dict_show_type`、`dict_view_mode`（分列/堆积图模式）、`dict_search_type`、
`enum_search_granularity`、`dict_count_dimension`、`dict_change_compared_type`、
`dict_flow_change_filter`、`dict_relevance`、`dict_cpc_strategy`、`dict_word_model`、
`enum_bought_source`、`dict_biz_code`、`dict_keyword_change_type`、`dict_multinf_change_type`

> 理由：这些是前端筛选器/视图开关的取值，不是业务数据的组成部分。
> 建表会引入无意义的 JOIN。若用户希望做成可配置项，可放入 `system_configs`。

**归入系统表**：`dict_vip_level`（traffic 域提出）→ 并入会员等级枚举，由 system 域定义。

## 六、跨域归属裁决（keywords 域提出的问题）

| 问题 | 裁决 |
|---|---|
| `keywordFunnel/list` 归属 | **不属 keywords 域**。它是 `/conversion-rate`（关键词转化率）页接口，输入 `keywords[]` 而非 asin。原站有独立页面，但 **goal.md 页面清单未包含转化率页** → 建议本期不做，表结构保留 `fact_keyword_conversion_funnel` 待用 |
| `/keywords/source` 无对位路由 | 确认原站无此路由。承担该语义的是 `/compete`（流量位竞争格局）+ `/amount`（关键词竞品数量）+ 反查页行内 Drawer。**建议**：goal.md 的 `/keywords/source` 实现为反查页的下钻抽屉，不单独建路由 |
| `asinKeywordsWordFrq` vs `keywordGroupWordFrq` | 同一套词频聚合，共用 `fact_word_frequency` 表 + `scope_type`/`scope_key` 区分。**采纳 keywords 域方案** |
| `conditions` 参数语义混杂 | ⚠️ 保留待确认。既承载计数维度筛选又承载词特征筛选，后端解析规则不明 |

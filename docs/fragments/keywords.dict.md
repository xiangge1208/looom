# 反查流量词 页面域 数据字典片段

> 素材：`docs/raw/_probe/chunks/26.79e84b23.js`（`/reverse`，主）、`41.f781c26c.js`（`/old_reverse`）、`40.a20352a7.js`（`/conversion-rate`）。
> **类型列绝大部分标 ⚠️**：webpack 压缩产物里没有类型信息，类型只能从格式化函数（`getPercentage`/`moneyFormat`/`format2Str`）反推。
> **未标 ⚠️ 的只有字段名本身**（直接从字符串字面量读到）。
> 命名遵循 `docs/NAMING.md`：表名前缀 `dim_`/`fact_`/`rel_`/`dict_`，站点字段统一 `country`，
> 占比保持 0-1 小数，毫秒时间戳转 DATETIME 并加 `_at` 后缀。

## 修订记录（主 Agent 实测反馈后）

1. **旧接口 `/api/search/asinKeywords` 已实测 404 下线** → 建模一律以新接口 `asinKeywordList` 为准；
   旧版字段命名（`nfRatio`/`nfRatioPersent`/`spRatioScoreAd`/`brandRatioScoreAd`/`vedioRatioScoreAd` 等）
   降级为**历史对照**，不作为建表依据。
2. **`keyword_id` 实测存在且全局唯一** → 所有以关键词为维度的主键从 `keyword` 字符串改为 `keyword_id`。
3. **`country_code` 全量改名 `country`**。
4. **表名加 `dim_`/`fact_`/`rel_` 前缀**。

---

## 0. 拆表判断（重点任务 2）

`asinKeywordList` 返回的一行同时混了三类数据，落库要拆开：

| 类别 | 判据 | 归属实体 |
|---|---|---|
| **关键词自身固有属性** | 不含 ASIN 维度，同一关键词在任何 ASIN 查询下都一样 | `dim_keyword`（基础实体） |
| **关键词的时序指标** | 随时间变，但不随 ASIN 变（搜索量、ABA 排名、CPC、点击转化率、Top10 产品） | `fact_keyword_metric_snapshot`（时序快照） |
| **ASIN × 关键词的时点快照** | 同时依赖 ASIN 和时间窗（流量得分、占比、排名、曝光位置） | `fact_asin_keyword_snapshot`（关系 + 时序） |

判据依据：

- **搜索量 / ABA 排名 / 搜索趋势** 属关键词自身。证据：词频弹窗（`26.js @402400`）里表头是 `关键词 / 搜索量排名 / 搜索量 / 搜索趋势`，行字段 `keyword / searchesRank / estSearchesNum / estSearchesNumHistory`，**该弹窗完全不含 ASIN 上下文**（只有 `word` 和 keyword）。同一批字段在主表也出现，说明是关键词维度带过来的。
- **点击转化率** 属关键词自身。证据：列头 tooltip 原文 `关键词转化率数据是关键词下所有产品的平均点击转化率，来源于后台商机探测器`（`26.js @244500`）——是关键词下**所有产品**的平均，与当前 ASIN 无关。
- **ABA Top3 集中度** 属关键词自身。证据：tooltip `ABA数据中Top3的产品的点击份额和转化份额`（`26.js @102900`）——Top3 是关键词维度的，不是当前 ASIN。
- **建议竞价 CPC** 属关键词自身。证据：列取值 `cpc.<strategy>`，strategy 是投放策略枚举，无 ASIN 维度。
- **最近7天自然流量 Top 10 产品** 属关键词自身。证据：列标签就是「最近7天自然流量Top 10产品」，取 `topAsins/top10Asins/imgs`，是关键词下的榜，与当前 ASIN 无关。
- **流量得分 / 占比 / 变化 / 排名 / 曝光位置 / 推荐位** 是 ASIN × 关键词 × 时间窗 的三元快照。证据：请求必带 `asin` + `timePieceType` + `timePieceValue`；字段名带 `Last`（`nfLastRank`）和 `prev`/`in`/`out` 语义；tooltip 原文 `该产品在该关键词下自然的排名位置`、`产品在该关键词下获得的所有有效曝光流量里...`。
- **词特征标签**（`isMainKw`/`isAccurateKw`/`isPurchaseKw`...）是 **ASIN × 关键词** 的判定，不是关键词固有。证据：徽标 tooltip 都是 `关键词{keyword}的...` 且定义文档链接叫「主要流量词、精准流量词、精准长尾词分别是怎么定义的？」，而这些定义天然相对某个产品；且它们同时作为 `conditions` 筛选项出现在 ASIN 查询里。

**结论：至少 4 张核心表** —— `dim_keyword`、`fact_keyword_metric_snapshot`、`fact_asin_keyword_snapshot`、`fact_word_frequency`，
外加 `fact_keyword_rank_history`（排名时间序列）、`fact_asin_keyword_overview`（总览聚合）、`rel_keyword_monitor`（监控订阅）、词库关系表若干。

### 0.1 关键词维度键：实测裁定用 `keyword_id`

主 Agent 实测 `POST /api/search/asinKeywordList`（body `{asin:'B01N5IB20Q',timePieceType:'month',timePieceValue:'2026-08',page:1,pageSize:5}`）
**响应行内含 `keywordId`（int）**，例 `keywordId: 4293091`。我分析的前端 chunk 里没有该字段
（压缩模板只渲染 `keyword` 文本，不渲染 ID，所以静态素材看不到它）——**以实测为准**。

同一 ASIN（`B01N5IB20Q`）跨三站点实测：

| 站点 | 关键词总数 | 样本（`keyword#keywordId`） |
|---|---|---|
| US | 123 | `hdd hard drive#4293091`、`ssd wd black#11666565` |
| UK | 15 | `laptop ssd#185899`、`ssd 2.5#344122` |
| DE | 20 | `ssd 128#615708`、`ssd 2,5#2240898` |

推论（与 `docs/NAMING.md` §4 一致）：

1. **`keyword_id` 全局唯一，各站点 ID 段不重叠** → `dim_keyword` 主键 `(keyword_id)`，**不带 `country`**
2. 关键词自带语言/地区特征（DE 站德语写法 `ssd 2,5` 用逗号）→ 一个 `keyword_id` 天然属某站点，不跨站复用；
   `dim_keyword` 仍保留 `country` 作**非主键标记列**，便于按站点筛词
3. **所有「ASIN × 关键词」关系/事实表主键仍必须带 `country`** —— 同一 ASIN 各站点词数差异巨大（123 / 15 / 20），
   漏了 `country` 会被 Unique Key 跨站合并覆盖
4. 关键词维度的连接键从 `keyword` 字符串改为 `keyword_id`（省空间、join 更快）；
   `keyword` 文本只留在 `dim_keyword` 一处，事实表不再冗余存文本

---

## 一、基础实体

### 1.1 `dim_keyword` — 关键词主表

用途：关键词实体，是本域一切数据的锚点。
**主键：`(keyword_id)`**（实测裁定，见 §0.1；不带 `country`）

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `keyword_id` | BIGINT | 关键词全局唯一 ID，**主键** | **实测** `asinKeywordList` 响应行 `keywordId: 4293091`（int）。跨站点验证 US/UK/DE 三站 ID 段不重叠（见 §0.1）。前端 chunk 未渲染此字段，静态素材看不到 |
| `keyword` | VARCHAR ⚠️ | 关键词文本，站点内唯一 | `26.js > label:"流量词"` 单元格渲染 `item.keyword`；实测样本 `hdd hard drive` / `ssd 2,5` |
| `country` | VARCHAR(8) ⚠️ | 站点，**非主键标记列**。一个 keyword_id 天然属某站点（DE 站德语写法 `ssd 2,5` 用逗号） | `app.js > query:function(){var e={country:this.currentSite}}`（axios 强制追加）；跨站实测 |
| `translate_keyword` | VARCHAR ⚠️ | 中文翻译，灰色副行显示 | `26.js @402100 t.translateKeyword`；表头 `翻译` |
| `key_length` | INT ⚠️ | 词长（单词数）。**前端派生**：`keyword.split(" ").length` | `41.js > t.keyLength=t.keyword?t.keyword.split(" ").length:0`。⚠️ 可派生，不必落库 |

关系：`1:N → fact_keyword_metric_snapshot`、`1:N → fact_asin_keyword_snapshot`、`N:M ↔ dim_asin`（通过 snapshot）、`N:M ↔ 词库分组`。

⚠️ 前端在若干处仍用 `keyword` 字符串做行匹配（`s.find(function(t){return t.keyword===e.keyword})`，
`26.js > getMonitorSnapshotInfo`；`monitorSnapshot` 请求也传 `keywords[]` 文本数组）。
说明**接口层的匹配键是文本，落库层用 `keyword_id`** —— 入库时需按 `(keyword, country)` 反查 `keyword_id`。

### 1.2 `dim_asin` — 被查询的产品（本域只引用，不拥有）

用途：反查的主体。本域只读，主表定义应归产品域。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `asin` | string ⚠️ | 10 位 ASIN，前端有格式校验 | `26.js > searchBtn` 里 `Object(Q.Q)(C)` 校验 |
| `pasin` | string ⚠️ | 父 ASIN；接口返回 `data.pasin` 时判定为父体查询 | `26.js > e.pasin=!(!h.data||!h.data.pasin)` |
| `isParentAsin` | bool ⚠️ | 是否父体 | `41.js > e.isParentAsin=n.data.isParentAsin` |
| `hasVaiants` | bool ⚠️ | 是否有变体（原文拼写错误，保留） | `41.js > e.hasVaiants=n.data.hasVaiants` |
| `hasValidVaiants` | bool ⚠️ | 是否有有效变体 | `41.js > e.hasValidVaiants=n.data.hasValidVaiants` |
| `title` / `img` / `price` / `brand` / `buyBox` / `ratingNum` / `asinScore` / `isBestSeller` / `features[]` | 混合 ⚠️ | 变体卡片展示字段 | `26.js @169369 childTableList` 默认结构 |

补充：本表也须带 `country` 进主键（`(asin, country)`，`NAMING.md` §4/§5），属产品域定义。

### 1.3 `dim_word` — 单词/词根（词频维度）

用途：关键词打散后的单词，词频统计的实体。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `word` | VARCHAR ⚠️ | 单词本身 | `26.js @407900 t.word`；`frqWord(e){...{word:e.word}}` |
| `country` | VARCHAR(8) ⚠️ | 站点 | axios 强制追加 |
| `translate_keyword` | VARCHAR ⚠️ | 单词翻译（接口复用同名字段 `translateKeyword`） | `26.js @407900 t.translateKeyword`；表头 `翻译` |

主键：`(word, country)`。⚠️ 单词侧**没有实测到 ID 字段**（词频接口只返回 `word` 文本），
与 `keyword_id` 不同，这里只能用文本做键。

关系：`N:M ↔ dim_keyword`（一个关键词含多个单词，一个单词出现在多个关键词里）。
反查入口：点单词 → 弹「包含词频{word}的关键词」列表，payload 为 `{...wordFrqParams, word}`。

---

## 二、时序快照

### 2.1 `fact_asin_keyword_snapshot` — ASIN × 关键词 × 时间窗 快照（本域最核心表）

用途：一个 ASIN 在某时间窗内、某关键词下获得的流量与排名。`asinKeywordList` 的 `data.list[]` 一行。

**主键：`(asin, keyword_id, country, time_piece_type, time_piece_value, is_listing_search)`**

改动说明：原稿用 `keyword` 字符串，现改为 `keyword_id`（实测存在且全局唯一，见 §0.1）；
`country_code` → `country`。`country` 必须保留在主键里 —— 同一 ASIN 各站点词数 123/15/20，
去掉会被 Unique Key 跨站合并覆盖。

#### 2.1.1 维度键

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `asin` | VARCHAR(16) ⚠️ | 查询主体 | 请求参数 `asin` |
| `keyword_id` | BIGINT | 关键词 ID，**join `dim_keyword` 的键** | **实测** 响应行 `keywordId`；跨站点唯一性验证见 §0.1 |
| `country` | VARCHAR(8) ⚠️ | 站点，**必须进主键** | axios 强制追加；跨站词数差异实测（123/15/20） |
| `time_piece_type` | VARCHAR ⚠️ | `latelyDay` / `week` / `month` | 请求 `timePieceType`，`getCommonParams`；实测 body 用 `timePieceType:'month'` |
| `time_piece_value` | VARCHAR ⚠️ | `"7"` / `"30"` / 周值 / 月值 | 请求 `timePieceValue`；实测 `timePieceValue:'2026-08'` |
| `is_listing_search` | BOOLEAN ⚠️ | 是否父体聚合视角 | 请求 `listingSearch` / `isListingSearch` |
| `piece_max_time_at` | DATETIME ⚠️ | 本时间窗的数据最大时间，用于判「是否本期新进」。原站 `pieceMaxTime`，按 `NAMING.md` §3 加 `_at` | `26.js @219535 new Date(o).getTime()==new Date(e.pieceMaxTime).getTime()` |
| `keyword`（冗余，可选） | VARCHAR ⚠️ | 接口层匹配键是文本，入库需按 `(keyword, country)` 反查 `keyword_id`；是否冗余留文本供排查由主 Agent 定 | `t.row.keyword` |

#### 2.1.2 流量得分 → 独立长表 `fact_asin_keyword_score`

响应里是**同构嵌套对象**，父键由流量类型决定（`26.js @130400` 的 `ue` 映射）：

`scoreInfo` / `nfScoreInfo` / `adScoreInfo` / `allSpScoreInfo` / `spScoreInfo` / `recSpScoreInfo` / `allSbScoreInfo` / `sbScoreInfo` / `sbvScoreInfo`

**与主 Agent 实测一致**：实测确认响应里是 7+ 个同构嵌套对象、每个内部相同 5 个指标。
我从前端 `ue` 映射静态读到的是 **9 个**（含 `scoreInfo` 全量口径 + 8 个渠道口径），是实测的超集 —— 见 §4.1 的完整清单与差异说明。

**建模裁定：拆长表**（与主 Agent 结论一致），不用 9×5=45 列宽表。
依据：前端取值方式就是 `row[tableTrafficFieldMapping[typeValue]].<指标>`，即「先按流量类型选对象，再取指标」，
长表与之同构；且渠道枚举可能扩展（旧版还有 `recommendRatio` 一类），宽表加列成本高。

**表：`fact_asin_keyword_score`**
**主键：`(asin, keyword_id, country, time_piece_type, time_piece_value, is_listing_search, traffic_type)`**

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `traffic_type` | VARCHAR ⚠️ | 流量类型，取值见 §4.1（9 值）。对应嵌套对象父键 | `26.js @130400 ue` 映射；实测确认同构嵌套对象存在 |
| `score` | DECIMAL ⚠️ | 流量得分（有效曝光流量得分） | `scoreFormat(row[field].score,{needSymbol:!1})`；变体卡 `Math.round(100*t.score)/100` → 两位小数 |
| `score_ratio` | DECIMAL ⚠️ | 流量占比 = 该词得分 / 该 ASIN 总得分。**0-1 小数存储不乘 100**（`NAMING.md` §3.5） | `getPercentage(row[field].scoreRatio)`；默认排序字段 `scoreInfo.scoreRatio` |
| `score_change` | DECIMAL ⚠️ | 相比上期的得分变化量（绝对值差） | `26.js @235000 scoreFormat(...scoreChange,{needSymbol:!0})` |
| `score_change_ratio` | DECIMAL ⚠️ | 相比上期的变化率，0-1 小数。公式（tooltip 原文）：`（本期流量得分-上期流量得分）/上期流量得分*100%` | `26.js @235000` |
| `contri_change_ratio` | DECIMAL ⚠️ | 变化贡献度，0-1 小数。公式（tooltip 原文）：`关键词本期变化量 / 全部关键词本期变化量绝对值之和` | `26.js @235400` |

原稿写「4 个指标」，实为 **5 个**（`scoreChange` 与 `scoreChangeRatio` 是两个独立字段，
前端在同一列的两行分别渲染：第一行变化率、第二行变化量）—— 已按实测的 5 指标口径修正。

#### 2.1.3 流量分布（扁平字段，与上面的 scoreInfo 并行存在）

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `keyword_nf_score_ratio` | DECIMAL ⚠️ | 自然流量占比，0-1 | `t.row.keywordNfScoreRatio` |
| `keyword_ad_score_ratio` | DECIMAL ⚠️ | 广告流量占比，0-1 | `t.row.keywordAdScoreRatio` |
| `keyword_sp_score_ratio` | DECIMAL ⚠️ | SP(常规) 占比，0-1 | `t.row.keywordSpScoreRatio` |
| `keyword_rec_sp_score_ratio` | DECIMAL ⚠️ | SP(推荐) 占比，0-1 | `t.row.keywordRecSpScoreRatio` |
| `keyword_sb_score_ratio` | DECIMAL ⚠️ | SB(常规) 占比，0-1 | `t.row.keywordSbScoreRatio` |
| `keyword_sbv_score_ratio` | DECIMAL ⚠️ | SBV 占比，0-1 | `t.row.keywordSbvScoreRatio` |

tooltip 原文：`产品在该关键词下获得的所有有效曝光流量里，自然流量-广告流量的得分和占比` / `...SP(常规)广告、SP(推荐)广告、SB(常规)广告、SBV广告的流量得分和占比`

⚠️ 这 6 个扁平字段与 §2.1.2 长表的 `score_ratio` **语义重叠**（都是渠道占比），
可能是同一数据的两种投影（长表按 traffic_type 取，扁平字段供「流量分布」列一次性画柱）。
是否只保留长表、扁平字段改为查询时 pivot，需主 Agent 裁决。

**旧版字段（`/api/search/asinKeywords` 已实测 404 下线）—— 仅作历史对照，不作建表依据**：
`nfRatio` / `nfRatioPersent` / `nfRatioScoreTotal`、`adRatio` / `adRatioPersent` / `adRatioScoreTotal`、
`spRatioScoreAd` / `spRatioScoreAdPersent`、`brandRatioScoreAd` / `brandRatioScoreAdPersent`、
`vedioRatioScoreAd` / `vedioRatioScoreAdPersent`（`vedio` 是 video 错拼，按 `NAMING.md` §3.2 统一用 `sbv`）、
`recommendRatio` / `recommendRatioPersent` / `recommendRatioScoreTotal`、
`ratio` / `ratioScore`、`listingRank` / `listingScoreRatio`

#### 2.1.4 自然排名快照

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `nf_last_rank` | INT ⚠️ | 最新自然排名（数值，可排序） | `prop:"nfLastRank"`；`Bn.nf.lastRank` |
| `nf_last_rank_str` | VARCHAR ⚠️ | 排名展示串，形如 `3(P1-3)`。tooltip：`"3(P1-3)"表示在第1页48个自然位中排名第3` | `Bn.nf.lastRankStr`；前端 `Object(Q.p)(i)` 解析成 `pageRankInfo` |
| `nf_last_rank_asin` | VARCHAR(16) ⚠️ | 取得该自然位的具体变体 ASIN | `Bn.nf.lastRankAsin` |
| `nf_last_rank_at` | DATETIME ⚠️ | 排名抓取时间（原站 `nfLastRankTime`，毫秒时间戳 → DATETIME） | `Bn.nf.lastRankTime` |
| `nf_last_rank_time_str` | VARCHAR ⚠️ | 排名时间串，与 `piece_max_time_at` 比较判「是否本期新进」 | `Bn.nf.rankTimeStr` |

#### 2.1.5 SP 广告排名快照

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `sp_last_rank` | INT ⚠️ | 最新 SP(常规) 排名。tooltip：`"3(P1-3)"表示在第1页12个SP广告中排名第3` | `prop:"spLastRank"`；`Bn.sp.lastRank` |
| `sp_last_rank_str` | VARCHAR ⚠️ | 排名展示串 | `Bn.sp.lastRankStr` |
| `sp_last_rank_asin` | VARCHAR(16) ⚠️ | 取得该广告位的变体 ASIN | `Bn.sp.lastRankAsin` |
| `sp_last_rank_at` | DATETIME ⚠️ | 抓取时间（原站 `spLastRankTime`） | `Bn.sp.lastRankTime` |
| `sp_last_rank_time_str` | VARCHAR ⚠️ | 排名时间串 | `Bn.sp.rankTimeStr` |
| `sp_campaign_id` | VARCHAR ⚠️ | 关联广告活动 ID（用于 join `campaignRemark`） | `getCampaignInfo(e){return{id:e.spCampaignId,...}}` |
| `sp_mask_campaign_id` | VARCHAR ⚠️ | 广告活动脱敏 ID（无备注名时显示） | `maskId:e.spMaskCampaignId` |

#### 2.1.6 其他快照字段

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `data_updated_at` | DATETIME ⚠️ | 数据更新时间（表格里带绿/灰色区分今天与否）。原站 `updateTime` 是毫秒时间戳 → DATETIME（`NAMING.md` §3.3） | `26.js @219074 n=e.updateTime`；`41.js` 派生 `updateTimeHm/updateTimeMd/updateTimeForCh/updateTimeForUs` |
| `exposure_positions` | ARRAY\<VARCHAR\> ⚠️ | 曝光位置数组，取值 `nf`/`sp`/`recSp`/`sb`/`sbv`（`isSource` 模式另加 `isLimitedTimeDeal`）。⚠️ 用 `recSp` 而非 `spRec`，入库需归一 | `t.row.exposurePositions`；`exposurePositions.includes("nf")` 等 |
| `rec_sp_score_list` | JSON/ARRAY ⚠️ | SP 推荐专栏位置与得分列表；元素含 `score`（用于排序）；配 `recSimpleName`/`backgroundColor` 渲染 | `recPosition props itemData.recSpScoreList`；`26.js @209300` 按 `score` 排序 |
| `keyword_tags` | ARRAY\<VARCHAR\> ⚠️ | 词特征标签数组（新版统一字段） | `arrayContainBoolean(e.item.keywordTags\|\|e.item.kwCharacters,"isMainKw")` |
| `kw_characters` | ARRAY\<VARCHAR\> ⚠️ | 词特征（回退字段）：`isMainKw`/`isAccurateKw`/`isAccurateTailKw` | 同上 |
| `conversion_characters` | ARRAY\<VARCHAR\> ⚠️ | 转化特征（回退字段）：`isPurchaseKw`/`isQualityKw`/`isStableKw`/`isLossKw`/`isInvalidKw` | `arrayContainBoolean(e.item.keywordTags\|\|e.item.conversionCharacters,"isPurchaseKw")` |
| `is_ac` | BOOLEAN ⚠️ | 是否 Amazon's Choice 推荐词。原站字段名就叫 `ac` | `e.item.ac` → 渲染徽标 `AC` |
| `ac_dates` | ARRAY\<DATE\> ⚠️ | AC 命中的日期列表（popover 内逐个展示） | `e._l(e.item.acDates,...)` |
| `multi_nf_info` | JSON ⚠️ | 多变体自然位信息，内含 `today`（bool，今日多自然位）+ `dateAsins[]` | `Mark props data:e.item.multiNfInfo`；`26.js @190738 e.data.dateAsins` |
| `is_monitor` | BOOLEAN ⚠️ | 是否已加排名监控。为真则不直接展示排名，需补拉 monitorSnapshot | `t.isMonitor&&g.push(t)`；`canShowRank:!t.isMonitor` |
| `is_subscribe` | BOOLEAN ⚠️ | 是否已订阅。**旧版字段，旧接口已 404，可能已废弃** | `41.js @150000 区域` |
| `groups` | JSON ⚠️ | 该词已加入的词库分组，元素 `{id, name, reverse}`。⚠️ 更宜落到 `rel_keyword_group`（§3.1）而非冗余在快照里 | `26.js > curName` 里 `a.groups=i.concat({id:e,name:t,reverse:n})` |

#### 2.1.7 纯前端派生字段（**不落库**）

| 字段名 | 说明 | 来源 |
|---|---|---|
| `polarRank` | 由 `allRankHistory` 计算的雷达/迷你图数据 | `polarRank:Object(sa.d)(t.allRankHistory,{},{campaignRemark:v,isPasin:...,recSpScoreList:t.recSpScoreList})` |
| `canShowRank` | `!isMonitor`，或 monitorSnapshot 回填后置 true | `canShowRank:!t.isMonitor` |
| `campaignName` / `campaignColor` | 从 `campaignRemark[spCampaignId]` merge 进来 | `var a=v[t.spCampaignId]\|\|{}` |
| `checked` / `levelList` / `isTarget` | UI 状态 | `(n.data.keywords\|\|[]).forEach(function(t){t.checked=!1})` |
| `rankTimeLog` / `rankTimeGrab` / `updateTimeHm` / `updateTimeMd` / `updateTimeForCh` / `updateTimeForUs` / `adRankTimeMd` / `adRankTimeToday` | 时间格式化派生 | `41.js @111500` 一带 |

关系：`N:1 → dim_keyword`（`keyword_id`）、`N:1 → dim_asin`（`asin`+`country`）、
`1:1 → rel_keyword_monitor`（当 `is_monitor`）、`N:1 → 广告活动`（通过 `sp_campaign_id`，属广告域）、
`1:N → fact_asin_keyword_score`（§2.1.2 长表）。

### 2.2 `fact_keyword_metric_snapshot` — 关键词自身的时序指标

用途：与 ASIN 无关的关键词市场指标。同一关键词在任何 ASIN 查询里这些值相同。

**主键：`(keyword_id, country, granularity, stat_date)`**（原稿 `(keyword, country_code, ...)` → 改用 `keyword_id` + `country`）

⚠️ `keyword_id` 已全局唯一，理论上 `country` 可省；但为与 `NAMING.md` §5「所有 `fact_` 表必须带 `country` 且进主键」
一致、且便于按站点分区裁剪，保留在主键中。是否精简由主 Agent 定。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `keyword_id` | BIGINT | 关键词 ID | **实测** 响应行 `keywordId` |
| `est_searches_num` | BIGINT ⚠️ | 预估搜索量。tooltip 原文：`结合ABA排名（Brand Analytics）和搜索词表现的"搜索查询数量"预估的搜索量` | `prop:"estSearchesNum"`，可排序；`t.row.estSearchesNum` |
| `searches_rank` | INT ⚠️ | ABA 搜索量排名（与 `est_searches_num` 二者切换展示） | `26.js @489226 this.keywordItem.searchesRank`；词频弹窗表头 `搜索量排名` |
| `click_purchase_ratio` | DECIMAL ⚠️ | 关键词点击转化率，0-1 小数。tooltip：`关键词下所有产品的平均点击转化率，来源于后台商机探测器` | `prop:"clickPurchaseRatio"`，可排序 |
| `click_shared` | DECIMAL ⚠️ | ABA Top3 点击份额，0-1。tooltip：`ABA数据中Top3的产品的点击份额和转化份额` | `AbaTop3 props.field default:"clickShared"`；`点击: getPercentage(t.row.clickShared)` |
| `cvr_shared` ⚠️ | DECIMAL ⚠️ | ABA Top3 转化份额，0-1。**字段名推断**：模板里 `转化: getPercentage(t.row.c...)` 被压缩截断 | `26.js @103764`（截断处）⚠️ 需实测确认真名 |
| `cpc` | JSON ⚠️ | 建议竞价，按投放策略取值：`cpc.legacyForSales_exact` 等 6 个 key（见 spec §7.4）。⚠️ 宜拆长表 `(keyword_id, country, strategy, bid)` | `tableCpc propField:"cpc."+e.cpcValue` |
| `granularity` | VARCHAR ⚠️ | 趋势粒度 `day`/`week`/`month`，默认 `week` | `v={day:"day",week:"week",month:"month"}`；`trendMode:"周",granularity:"week"` |
| `stat_date` | DATE ⚠️ | 统计日期（`NAMING.md` §3.3） | 由查询时间窗推导 ⚠️ |

关系：`N:1 → dim_keyword`。

### 2.3 `fact_keyword_search_trend` — 搜索量趋势序列

用途：搜索趋势迷你图与抽屉图的数据源。是 §2.2 的时间序列展开形式。

`estSearchesNumHistory` / `estSearchesNumHistoryPrev`（本期 / 同比上期）都是**列式对象**：

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `date` | ARRAY\<VARCHAR\> ⚠️ | 日期轴 | `SearchRangeTrend props default {date:[],estSearchesNum:[],festivals:[],searchesRank:[]}` |
| `estSearchesNum` | ARRAY\<INT\> ⚠️ | 搜索量序列。**哨兵值 `9999999` 表示缺失**，前端置 null | `26.js @687133 9999999==e&&(r.estSearchesNum[t]=null)` |
| `searchesRank` | ARRAY\<INT\> ⚠️ | ABA 排名序列，同样有 `9999999` 哨兵 | 同上 |
| `festivals` | ARRAY ⚠️ | 节日标记，与 date 同下标对齐 | `o=r.festivals` |

**落库行式化**：
`fact_keyword_search_trend(keyword_id, country, granularity, stat_date, est_searches_num, searches_rank, festival, is_prev_period)`
**主键：`(keyword_id, country, granularity, stat_date, is_prev_period)`**
（原稿 `(keyword, country_code, ...)` → `keyword_id` + `country`；`is_prev_period` 区分本期与同比上期序列）

入库时把 `9999999` 转 NULL（前端已如此处理）。

关系：`N:1 → dim_keyword`。

### 2.4 `fact_keyword_rank_history` — ASIN × 关键词 排名历史

用途：排名趋势列的迷你图、趋势抽屉。来自 `asinKeywordRankHistory` / 行内的 history 字段。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `allRankHistory` | object/array ⚠️ | 全类型排名历史（喂给 `polarRank` 计算） | `item.allRankHistory` |
| `nfHistory` | object/array ⚠️ | 自然排名历史 | `item.nfHistory` |
| `spHistorySelf` | object/array ⚠️ | 自身 SP 广告排名历史 | `item.spHistorySelf` |
| `rankHistoryDate` | array ⚠️ | 日期轴 | `item.rankHistoryDate` |
| `keywordLastRankHistory` | map ⚠️ | 对比模式：`{keyword: {date[], rank[]}}`（自然） | `compare/asinKeywords` 响应，`a="keywordLastRankHistory"` |
| `keywordAdLastRankHistory` | map ⚠️ | 对比模式：同上（SP 广告） | `2==e.selectValue&&(a="keywordAdLastRankHistory")` |

请求参数（`asinKeywordRankHistory`）：`{asin, keyword, isListingSearch, lastMonths}`。
`lastMonths` 逻辑：`"week"===timePieceType||"month"===timePieceType ? null : 1`。

排名趋势可选模式（列头 label）：`自然排名趋势`、`SP广告排名趋势`、`品牌广告趋势`、`视频广告趋势`、
`Amazon's Choice推荐趋势`、`Editorial Recommendation推荐趋势`、`Top Rated趋势`（`26.js` label 列表）。
共享模式默认 `sharedRankTrend:{mode:"nfsp"}`。

**主键：`(asin, keyword_id, country, rank_type, stat_date)`**（行式化后；`rank_type` 取 nf/sp/... 见 §4.1）

关系：`N:1 → fact_asin_keyword_snapshot`、`N:1 → dim_keyword`。

### 2.5 `fact_asin_keyword_overview` — 总览聚合（词数统计）

用途：总览条。`asinKeywordOverview` 的 `data`。是**按流量类型的词数计数**，不是得分。

**主键：`(asin, country, time_piece_type, time_piece_value, is_listing_search, traffic_type)`**
（`country_code` → `country`；本表无关键词维度，不涉及 `keyword_id`）

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `traffic_type` | VARCHAR ⚠️ | 计数维度，9 个计数字段名之一（见下）。可与 §4.1 的 `traffic_type` 归一 | `te` 枚举 |
| `total_cnt` | INT ⚠️ | 本期词数。原站键 `total` | `formatStringNum(tableOverviewData[t.field],"total")` |
| `prev_cnt` | INT ⚠️ | 上期词数（`pre_item` 区）。原站键 `prev` | `formatStringNum(tableOverviewData[t.field],"prev")` |
| `in_cnt` | INT ⚠️ | 本期新进词数（显示为 `+n`）。原站键 `in` | `formatStringNum(tableOverviewData[t.field],"in")` |
| `out_cnt` | INT ⚠️ | 本期流失词数（显示为 `-n`，旁边有导出按钮）。原站键 `out` | `formatStringNum(tableOverviewData[t.field],"out")` |
| `history_total_cnt` | INT ⚠️ | 历史累计词数，仅 `totalPeriod` 一格显示 `历史累计{n}` | `tableOverviewData.historyTotal` |

字段名加 `_cnt` 后缀的原因：`in` / `out` / `total` 是 SQL 保留字或过于泛化，直接做列名易冲突。

9 个计数字段名（`te`，同时是 `conditions` 前缀）：
`totalPeriod` / `nfKeywordCnt` / `adKeywordCnt` / `allSpKeywordCnt` / `spKeywordCnt` / `recSpKeywordCnt` / `allSbKeywordCnt` / `sbKeywordCnt` / `sbvKeywordCnt`

⚠️ 这张表可从 `fact_asin_keyword_snapshot` 聚合得出，但接口是独立的，可能后端预聚合。是否落库需裁决。

### 2.6 `fact_word_frequency` — 单词词频聚合（重点任务 3 的结论表）

用途：`asinKeywordsWordFrq` / `asinKeywordListWordFrq` / `keywordGroupWordFrq` 三个接口**共用同一结构**，
返回 `data.words[]`。这是「把关键词打散成单词后的词频统计」，与关键词行数据正交，**必须独立表**。

**主键：`(scope_type, scope_key, country, time_piece_type, time_piece_value, word_model, word)`**
（`country_code` → `country`；词频侧无 ID 字段，只能用 `word` 文本）

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `word` | VARCHAR ⚠️ | 单词/词组本身。表头列名「词频」 | `t.word`；`frqWord(e){...word:e.word}` |
| `country` | VARCHAR(8) ⚠️ | 站点 | axios 强制追加 |
| `translate_keyword` | VARCHAR ⚠️ | 翻译。表头「翻译」 | `t.translateKeyword` |
| `search_weight_by_amz_mode` | DECIMAL ⚠️ | **搜索量加权词频（亚马逊官方方法）**。算法 tooltip 原文：`将关键词打散为单词，然后将单词所在的关键词的搜索量排名取倒数并乘以100万，最后将得分相加，就得到每个单词经过搜索量加权之后的词频` | `26.js @408100` 表头 + tooltip；也是该接口的固定 `sortBy` |
| `frq` | INT ⚠️ | **出现次数词频**。表头「出现次数词频」 | `t.frq`；`41.js` 表头 `出现次数词频` |
| `scope_type` ⚠️ | VARCHAR ⚠️ | 聚合范围类型（**建模引入，非接口字段**）：`asin`（asinKeywordListWordFrq）/ `keyword_group`（keywordGroupWordFrq） | 由端点名 + 各自 payload 推断 ⚠️ |
| `scope_key` ⚠️ | VARCHAR ⚠️ | 范围键：ASIN 或词库分组 id（**建模引入**） | 同上 ⚠️ |
| `word_model` | VARCHAR ⚠️ | 单词数筛选：`one`/`two`/`three` | 请求 `wordModel`；`A=[{groupid:"one",groupName:"只看1个单词的词频"},...]` |

请求参数（`asinKeywordListWordFrq`，`26.js @290996` 原文）：
```
{asin, sortBy:"searchWeightByAmzMode", desc:!0, wordModel,
 timePieceType, timePieceValue, isListingSearch, conditions:[]}
```

反查视图（点单词 → 「包含词频{word}的关键词」）返回的是 keyword 列表，字段 `keyword / translateKeyword / searchesRank / estSearchesNum / estSearchesNumHistory / estSearchesNumHistoryPrev` —— 即 §1.1 + §2.2/§2.3 的投影，**不需要新表**，是 `word × keyword` 关系表的 join 结果。

⚠️ `keywordGroupWordFrq` 的 payload 在本域素材里**没有调用点**（只有封装），`scope` 参数名未知。

### 2.7 `fact_keyword_conversion_funnel` — 关键词转化漏斗（**不属本域**）

用途：`/api/search/keywordFunnel/list` 的返回。**归属 `/conversion-rate`（关键词转化率）页面**，不是本页。

请求（`40.a20352a7.js @126013 + @131513`）：
```
oe = {pageSize:100, pageNum:1, sortBy:"", customPrice:"", customProfitRate:"", desc:!0}
params = {...oe, strategy:cpcValue, matchTypes:[sortValue]|[], keywords:[...]}
```

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `keywords[]` | array ⚠️ | 关键词维度的结果行（内部字段本域素材未覆盖） | `s.data.keywords` |
| `total` | int ⚠️ | 总数 | `total:function(){return this.searchData.total}` |
| `weekDate` | date ⚠️ | 数据周，前端展示成 `周起~周止` | `updateDateTime:function(){var e=(this.searchData\|\|{}).weekDate;...}` |
| `topAsins` | array ⚠️ | 每行的 Top ASIN 列表 | `Object(y.c)(s.data.keywords,"topAsins")` |

**结论：这不是词频也不是词根聚合，是「按关键词列表查转化率漏斗」。** 输入是 `keywords[]` 而非 `asin`，
带 `strategy`（CPC 策略）与 `matchTypes`（匹配类型），还带 `customPrice`/`customProfitRate`（自定义售价/利润率做测算）。
`typeKey:"keywordConversion"` 也印证。**应移交给转化率域的勘察员**，本域只记录它的归属。

---

## 三、关系

### 3.1 `rel_keyword_group` — 关键词 ↔ 词库分组

用途：把反查出的词加入自己的词库（「筛查相关性并加入词库」）。

**主键：`(group_id, keyword_id, country)`**（原稿以 `keyword` 文本为键 → 改 `keyword_id`）

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `group_id` | VARCHAR ⚠️ | 词库分组 ID。原站键 `groupid` | `addWordApi(groupid, name)` → payload `{groupid, keywords[], relevance}` |
| `keyword_id` | BIGINT | 关键词 ID。**接口传的是 `keywords[]` 文本，入库需按 `(keyword, country)` 反查 ID** | **实测** `keywordId`；接口侧 `keywords:[n.item.keyword]` |
| `country` | VARCHAR(8) ⚠️ | 站点 | axios 强制追加 |
| `group_name` | VARCHAR ⚠️ | 分组名，成功 toast `标记成功，已加入词库"{name}"`。⚠️ 宜归 `dim_keyword_group`，此处冗余 | 同上 |
| `relevance` | VARCHAR ⚠️ | 相关性等级：`high`(高) / `middle`(中) / `low`(低) / `no`(不) | `relevance:n.level.relevance`；`levelList` |
| `is_reverse` | BOOLEAN ⚠️ | 是否反向（`relevance==="no"` 时为 true）。原站键 `reverse` | `this.$emit("curName",e,s,"no"===n.level.relevance)`；`groups` 元素含 `reverse` |

写接口：`POST /api/user/focusKeywordRelevance/add`，返回 `data.isSuccess`。
批量版：`/api/user/focusKeywordRelevance/batchAdd`、`/api/user/focusKeyword/relevanceBatchAdd`（payload 素材未覆盖）。
重分组：`/api/user/focusKeywordRelevance/regroup`。标签：`/api/user/focusKeywordTag/handle`。

关系：`N:M dim_keyword ↔ dim_keyword_group`，带 `relevance` 属性。

### 3.2 `rel_keyword_monitor` — 关键词排名监控订阅

用途：`asinKeywords/monitorSnapshot` 的 `data.list[]`。接口按 `keyword` **文本**与主表行匹配后回填。

**主键：`(asin, keyword_id, country)`**（接口层匹配用文本，落库用 `keyword_id`）

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `asin` | VARCHAR(16) ⚠️ | 被监控产品 | 请求 `asin` |
| `keyword_id` | BIGINT | 关键词 ID。**接口匹配键是 `keyword` 文本**，入库需反查 | `s.find(function(t){return t.keyword===e.keyword})`；请求传 `keywords[]` 文本数组 |
| `country` | VARCHAR(8) ⚠️ | 站点 | axios 强制追加 |
| `is_hour` | BOOLEAN ⚠️ | 是否小时级监控（决定趋势抽屉默认 `hour` 还是 `day`） | `this.switchHour=!!e.monitorSnapshot&&e.monitorSnapshot.isHour` |
| `crawler_status` | INT ⚠️ | 抓取状态；`0` 表示未抓/可申请抓取 | `e.monitorSnapshot&&(!e.monitorSnapshot\|\|0!==e.monitorSnapshot.crawlerStatus)` |
| `days` | INT ⚠️ | 已监控天数 | `monitorSnapshot.days` |
| `total_days` | INT ⚠️ | 监控总天数 | `monitorSnapshot.totalDays` |
| `left_days` | INT ⚠️ | 剩余天数 | `monitorSnapshot.leftDays` |
| `is_renew` | BOOLEAN ⚠️ | 是否已续期 | `monitorSnapshot.isRenew` |
| `history` | JSON ⚠️ | 监控历史（内部结构素材未覆盖） | `monitorSnapshot.history` |
| `all_rank_history` | JSON ⚠️ | 监控口径的排名历史 | `monitorSnapshot.allRankHistory` |
| `query_params` | JSON ⚠️ | 回查参数（内部结构素材未覆盖） | `monitorSnapshot.queryParams` |

申请小时级抓取：`grabHour` 提交 `{keyword, asin, type:1, ...}`（`26.js @434129`）。
页面文案：`申请9点前更新` / `停止9点前更新` / `查看每日排名` / `查坑位/推排名 - 每日排名`（旧版）。

关系：`1:1 → fact_asin_keyword_snapshot`（通过 `asin`+`keyword_id`+`country`）。

### 3.3 `rel_keyword_top_asin` — 关键词 Top10 自然流量产品

用途：「最近7天自然流量Top 10产品」列。属**关键词维度**（不随查询 ASIN 变）。

字段来源三个别名之一：`item.imgs || item.topAsins || item.top10Asins`（`26.js @63935`）

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `asin` ⚠️ | string ⚠️ | 产品 ASIN（推断，模板里点击跳亚马逊详情） | `linkAmz(t)` ⚠️ |
| `img` | string ⚠️ | 图片路径 | `t.img`；`getImgSrc(e,t)` |
| `showImg` | string/bool ⚠️ | 展示用图 | `t.showImg` |
| `title` | string ⚠️ | 标题 | `t.title` |
| `price` | decimal ⚠️ | 价格（配 `siteCurrency` 展示） | `t.price` |
| `rank` ⚠️ | int ⚠️ | 榜内序位（推断，由数组下标体现） | 数组顺序 ⚠️ |

**主键：`(keyword_id, country, asin)`**（原稿无显式主键 → 补齐，并用 `keyword_id`）

关系：`N:1 → dim_keyword`；`N:1 → dim_asin`。

### 3.4 `rel_asin_keyword_variant_exposure` — 获得曝光的变体

用途：`获得的曝光变体及流量占比(仅搜索父体时展示该项)` 列（组件 `ListingVariants`），
以及 `multiNfInfo`（同一关键词下多个变体获得自然位）。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
**主键：`(parent_asin, variant_asin, keyword_id, country, time_piece_type, time_piece_value)`**

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `variant_asin` | VARCHAR(16) ⚠️ | 变体 ASIN。原站键 `asin` | 变体卡 `childTableList[].asin` |
| `keyword_id` | BIGINT | 关键词 ID | **实测** `keywordId` |
| `country` | VARCHAR(8) ⚠️ | 站点 | axios 强制追加 |
| `score` | DECIMAL ⚠️ | 该变体流量得分 | `{title:"流量得分",num:moneyFormat(Math.round(100*t.score)/100),params:"score"}` |
| `ratio` | DECIMAL ⚠️ | 该变体流量占比，0-1 | `{title:"流量占比",num:ratioDisplay(t.ratio),params:"ratio"}` |
| `score_change_ratio` | DECIMAL ⚠️ | 相比上期，0-1 | `{title:"相比上期",...params:"scoreChangeRatio"}` |
| `contri_change_ratio` | DECIMAL ⚠️ | 影响父体（对父体流量的贡献变化），0-1 | `{title:"影响父体",...params:"contriChangeRatio"}` |
| `is_multi_nf_today` | BOOLEAN ⚠️ | 今日存在多变体自然位（`multiNfInfo.today`）。tooltip：`该标记代表今天在该关键词下存在多个变体自然位的情况` | `26.js @190738 e.data.today` |
| `date_asins` | JSON ⚠️ | 按日期的多自然位变体列表 | `e.data.dateAsins` |

请求来源：`26.js @93074` 的 `Object(b.Ab)({asin, pageNum, pageSize, isListingSearch, timePieceType, timePieceValue})` → 返回 `data.variants[]` + `data.total`。
`variants` 里 `asin` 为 null/空/`"parent"` 的那条是父体行。⚠️ 该端点路径本域素材未定位（在公共 chunk）。

关系：`N:1 → fact_asin_keyword_snapshot`；`N:1 → dim_asin`。
⚠️ 与 `NAMING.md` §2 的 `rel_asin_variant` 可能重叠，合并时需判断是否复用那张表加时间维度。

### 3.5 `dim_ad_campaign` 备注部分 — 广告活动备注（本域只读，属广告域）

`asinKeywordList` / `monitorSnapshot` 都返回与 list 平级的 `campaignRemark` map：

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `sp_campaign_id` | VARCHAR ⚠️ | map 的 key，即 `spCampaignId` | `var a=v[t.spCampaignId]\|\|{}` |
| `campaign_name` | VARCHAR ⚠️ | 活动名 | `campaignName:a.campaignName` |
| `campaign_color` | VARCHAR ⚠️ | 活动色标 | `campaignColor:a.campaignColor` |

popover 文案：`广告活动: {maskId}` / `Tip: 点击查看该广告活动的流量与打法`。
点击跳 `/adxray-structure` 或 `/adxray-adgroup`（属广告域）。

---

## 四、枚举字典

全部来自 `26.79e84b23.js @424502` 的 `WlAH` 模块与页面局部常量。**完整值域见 spec §7**，此处只列表结构。

### 4.1 `dict_traffic_type` — 流量类型（9 值，**已与实测核对**）

`traffic_type` 最终取值清单（`fact_asin_keyword_score` / `fact_asin_keyword_overview` 共用）：

| # | code | name | short_name | rank_name | score_info_field（嵌套对象父键） | count_field | 主 Agent 实测确认 |
|---|---|---|---|---|---|---|---|
| 1 | `total` | 全部流量 | 全部 | 全部广告排名 | `scoreInfo` | `totalPeriod` | ✅ `scoreInfo` |
| 2 | `nf` | 自然流量 | 自然 | 自然排名 | `nfScoreInfo` | `nfKeywordCnt` | ✅ `nfScoreInfo` |
| 3 | `ad` | 广告流量 | 广告 | 广告广告排名 | `adScoreInfo` | `adKeywordCnt` | ✅ `adScoreInfo` |
| 4 | `allSp` | SP广告流量 | SP广告 | SP广告广告排名 | `allSpScoreInfo` | `allSpKeywordCnt` | ✅ `allSpScoreInfo` |
| 5 | `sp` | SP(常规)流量 | SP(常规) | SP(常规)广告排名 | `spScoreInfo` | `spKeywordCnt` | ✅ `spScoreInfo` |
| 6 | `spRec` | SP(推荐)流量 | SP(推荐) | SP(推荐)广告排名 | `recSpScoreInfo` | `recSpKeywordCnt` | ✅ `recSpScoreInfo` |
| 7 | `allSb` | SB广告流量 | SB广告 | SB广告广告排名 | `allSbScoreInfo` | `allSbKeywordCnt` | ✅ `allSbScoreInfo` |
| 8 | `sb` | SB(常规)流量 | SB(常规) | SB(常规)广告排名 | `sbScoreInfo` | `sbKeywordCnt` | ✅ `sbScoreInfo` |
| 9 | `sbv` | SBV流量 | SBV | SBV广告排名 | `sbvScoreInfo` | `sbvKeywordCnt` | ⚠️ 实测清单以 `...` 结尾未列到，静态代码确证存在 |

**与实测的核对结论**：

- 主 Agent 实测列举 `scoreInfo / nfScoreInfo / adScoreInfo / allSpScoreInfo / spScoreInfo / recSpScoreInfo / allSbScoreInfo / sbScoreInfo...`（8 个 + 省略号），
  **与我从 `26.js @130400` 的 `ue` 映射静态读出的 9 个完全对齐**，实测省略号处即第 9 个 `sbvScoreInfo`。
- 主 Agent 提到的 traffic_type 取值 `nf/ad/allSp/sp/recSp/allSb/sb/sbv`（8 个渠道）**已全覆盖**，
  我的清单多一个 `total`（对应 `scoreInfo`，全量口径）—— 实测的对象清单里 `scoreInfo` 也在，只是它的 code 是 `total` 而非 `all`。
- ⚠️ **命名不一致要注意**：实测用的渠道名 `recSp` 与前端枚举 code `spRec` 指同一渠道
  （`ue` 映射：`u()(V,B.q.spRec,"recSpScoreInfo")` —— code 是 `spRec`，对象名是 `recSpScoreInfo`）。
  `exposurePositions` 数组里也用 `recSp`（前端做了转换 `var t="recSp"===e?"spRec":e`）。
  **建议 `dict_traffic_type.code` 统一取 `spRec`**，入库时把 `recSp` 归一过来。

来源：`WlAH > w/_/C/S/x`（名称三套）+ `26.js @130400 ue/le`（对象名与计数字段映射）+ 主 Agent 实测响应结构。

### 4.2 `dict_keyword_tag` — 词特征标签

| code | 徽标 | 归属数组 | 也是 conditions 筛选值 |
|---|---|---|---|
| `isMainKw` | 主要 | `kwCharacters` | 否（下拉里无） |
| `isAccurateKw` | 精准 | `kwCharacters` | 是（精准流量词） |
| `isAccurateTailKw` | 长尾 | `kwCharacters` | 是（精准长尾词） |
| `isPurchaseKw` | 出单 | `conversionCharacters` | 是（有效出单词） |
| `isQualityKw` | 优质 | `conversionCharacters` | 是（转化优质词） |
| `isStableKw` | 平稳 | `conversionCharacters` | 是（转化平稳词） |
| `isLossKw` | 流失 | `conversionCharacters` | 是（转化流失词） |
| `isInvalidKw` | ⚠️ 未截全 | `conversionCharacters` | 是（无效曝光词） |
| `isAC` | AC | `ac` + `acDates` | 是（AC推荐词） |
| `isMultiVariantKw` | — | `multiNfInfo` | 是（多变体自然位词） |
| `isSearchVolUpKw` | — | — | 是（搜索量同比增长词） |
| `isSearchVolDownKw` | — | — | 是（搜索量同比下降词） |
| `isER` | — | — | 仅旧版（Editorial Recommendation） |
| `isTR` | — | — | 仅旧版（Top Rated） |

### 4.3 `dict_time_piece` — 时间粒度

| groupid | groupName | timePieceType | timePieceValue |
|---|---|---|---|
| `latelyDay7` | 最近7天 | `latelyDay` | `"7"` |
| `latelyDay30` | 最近30天 | `latelyDay` | `"30"` |
| `week` | 选择某周 | `week` | 具体周值 ⚠️ |
| `month` | 选择某月 | `month` | 具体月值 ⚠️ |

来源：`WlAH > b`；`26.js > changeTime` 归一成埋点值 `7d/30d/week/month`。

### 4.4 `dict_cpc_strategy` — CPC 投放策略（6 值）

`legacyForSales_exact`(固定·精准) / `legacyForSales_phrase`(固定·词组) / `legacyForSales_broad`(固定·广泛) /
`autoForSales_exact`(提降·精准) / `autoForSales_phrase`(提降·词组) / `autoForSales_broad`(提降·广泛)
来源：`WlAH > g`。

### 4.5 `dict_rec_column` — 推荐专栏（8 值 + other）

`Media`(Seen on social media) / `4Star`(4 stars and above) / `fView`(Customers frequently viewed) /
`KOL`(Picks from Amazon Influencers) / `rBuy`(Recently bought and rated) / `Trend`(Trending now) /
`New`(New arrivals) / `tDeal`(Today's deals) / `other`(其它)
来源：`WlAH > j/E/B`。⚠️ 页面 tooltip 说共 11 个，枚举只 8+1。

### 4.6 `dict_relevance` — 相关性等级

`high`(高) / `middle`(中) / `low`(低) / `no`(不)。来源：`levelList`。

### 4.7 `dict_count_dimension` — 计数维度（conditions 后缀）

`total`(本期) / `prev`(上期) / `in`(新进) / `out`(流失)。来源：`ne={in:"in",out:"out",total:"total",prev:"prev"}`。

### 4.8 `dict_word_model` — 词频单词数

`one`(只看1个单词的词频) / `two` / `three`。来源：`WlAH > A`。

### 4.9 `dict_match_type` — 匹配类型（本页未用，筛查/拓词用）

`0`(全部) / `Exact`(精准匹配) / `Phrase`(词组匹配) / `AllMatch`(广泛匹配) / `sameNichId`(相同市场筛选)。来源：`WlAH > m`。

### 4.10 `dict_change_compared_type` / `dict_traffic_dist_type`

- `scoreChange`(流量变化) / `contribution`(变化贡献度) —— `fe`
- `nf_ad`(自然-广告) / `ad`(广告分布) —— `he={nfAd:"nf_ad",ad:"ad"}`（⚠️ 注意 key 与 value 不同）

### 4.11 `dict_biz_code` — 业务响应码

`1`(成功) / `1102`(词频统计不支持积分使用) / `1103`(权限限制，清查询参数) / `1104`(会员功能受限，弹会员弹窗)。
来源：`26.js > getTableInfo` / `wordCount`；`40.js @131513`。

---

## 五、实体关系总览

连接键：ASIN 侧用 `(asin, country)`，关键词侧用 `keyword_id`。

```
dim_asin ──1:N──┐
                ├──> fact_asin_keyword_snapshot <──N:1── dim_keyword
dim_keyword ─1:N┘         │  │  │  │  │            (keyword_id)
   │  (keyword_id)        │  │  │  │  └─1:N─> fact_asin_keyword_score
   │                      │  │  │  │           (+ traffic_type, 9 值)
   │                      │  │  │  └────1:1──> rel_keyword_monitor
   │                      │  │  └───────1:N──> fact_keyword_rank_history
   │                      │  └──────────1:N──> rel_asin_keyword_variant_exposure
   │                      └─────────────N:1──> dim_ad_campaign（广告域，via sp_campaign_id）
   ├──1:N──> fact_keyword_metric_snapshot
   ├──1:N──> fact_keyword_search_trend
   ├──1:N──> rel_keyword_top_asin ──N:1──> dim_asin
   ├──N:M──> dim_keyword_group（经 rel_keyword_group，带 relevance）
   └──N:M──> dim_word ──> fact_word_frequency（scope_type = asin | keyword_group）

dim_asin ──1:N──> fact_asin_keyword_overview（按 traffic_type 的词数聚合，可由 snapshot 派生）
```

主键一览（修订后）：

| 表 | 主键 |
|---|---|
| `dim_keyword` | `(keyword_id)` |
| `dim_asin` | `(asin, country)` |
| `dim_word` | `(word, country)` |
| `fact_asin_keyword_snapshot` | `(asin, keyword_id, country, time_piece_type, time_piece_value, is_listing_search)` |
| `fact_asin_keyword_score` | 上一行 + `traffic_type` |
| `fact_keyword_metric_snapshot` | `(keyword_id, country, granularity, stat_date)` |
| `fact_keyword_search_trend` | `(keyword_id, country, granularity, stat_date, is_prev_period)` |
| `fact_keyword_rank_history` | `(asin, keyword_id, country, rank_type, stat_date)` |
| `fact_asin_keyword_overview` | `(asin, country, time_piece_type, time_piece_value, is_listing_search, traffic_type)` |
| `fact_word_frequency` | `(scope_type, scope_key, country, time_piece_type, time_piece_value, word_model, word)` |
| `rel_keyword_group` | `(group_id, keyword_id, country)` |
| `rel_keyword_monitor` | `(asin, keyword_id, country)` |
| `rel_keyword_top_asin` | `(keyword_id, country, asin)` |
| `rel_asin_keyword_variant_exposure` | `(parent_asin, variant_asin, keyword_id, country, time_piece_type, time_piece_value)` |
| `dict_*` | `(code)`，不带 `country` |

---

## 六、本域数据字典的不确定清单

### 已由实测关闭的问题

| 原问题 | 结论 |
|---|---|
| ~~`keyword` 无独立主键，要不要发号~~ | **已关闭**：实测 `asinKeywordList` 返回 `keywordId`（int），全局唯一、跨站不重叠 → `dim_keyword` 主键 `(keyword_id)` |
| ~~新旧两代接口以哪版建模~~ | **已关闭**：旧接口 `/api/search/asinKeywords` 实测 404 下线 → 只按新版 `asinKeywordList` 建模，旧字段名降级为历史对照 |
| ~~`scoreInfo` 系列宽表还是长表~~ | **已关闭**：与主 Agent 独立得出同一结论 → 长表 + `traffic_type`，取值 9 值（§4.1） |
| ~~`country_code` 命名~~ | **已关闭**：按 `NAMING.md` 统一为 `country` |

### 仍待裁决/待实测

1. **`cvr_shared` 字段名是推断** ⚠️。ABA Top3 的「转化」值在压缩模板里被截断（`t.row.c...`）。**建议实测一次 `asinKeywordList` 并 grep 响应里 `Shared` 结尾的键**确认真名。
2. **`cpc` 对象内部值类型未知** ⚠️。只知按 strategy key 取，值是标量还是 `{min,max}` 无证据。宜实测确认后决定是否拆长表 `(keyword_id, country, strategy, bid)`。
3. **流量得分 `score` 的量纲/口径未知**。只知是小数（两位）、叫「有效曝光流量得分」，具体怎么算素材只给了 tooltip 里的比率公式。
4. **§2.1.3 的 6 个扁平占比字段与 §2.1.2 长表的 `score_ratio` 语义重叠**。是否只留长表、查询时 pivot 出扁平形态，需裁决。
5. **`fact_asin_keyword_overview` 可能纯派生**。接口独立但数值都能从 snapshot 聚合，是否落库需裁决。
6. **`fact_word_frequency` 的 `scope_type`/`scope_key` 是建模引入字段** ⚠️，接口本身没有，是为了让 `asinKeywordListWordFrq` 与 `keywordGroupWordFrq` 共用一张表。
7. **`keywordGroupWordFrq` 的 payload 未知**（本域只有封装无调用点），`scope` 参数名待实测。
8. **`dim_word` 侧没有 ID**。词频接口只返回 `word` 文本，与 `keyword_id` 不同，只能用 `(word, country)` 做键 ⚠️。
9. **`rel_keyword_top_asin` 的 `asin` 与 `rank` 是推断字段** ⚠️。模板只用到 `img/showImg/title/price`，ASIN 从 `linkAmz(t)` 推断存在，序位从数组下标推断。
10. **`monitorSnapshot.history` / `.allRankHistory` / `.queryParams` 内部结构完全未覆盖**。
11. **变体曝光的数据端点未定位**（`Object(b.Ab)` 在公共 chunk），只知 payload 与响应容器 `data.variants[]`。且 `rel_asin_keyword_variant_exposure` 与 `NAMING.md` §2 的 `rel_asin_variant` 可能重叠。
12. **`fact_keyword_conversion_funnel` 的行内字段未覆盖**。它不属本域（属 `/conversion-rate`），本域只确认了归属与顶层结构。
13. **`estSearchesNumHistory` 的哨兵值 `9999999`** 是确证的（`9999999==e&&(...=null)`），但含义是"缺失"还是"超上限"素材未说明 ⚠️。入库统一转 NULL。
14. **各 `_at` 字段的原始格式待确认**。前端用 `format2Str(...)` 和 `new Date(value).getTime()` 处理，`NAMING.md` §3.3 已给出「毫秒时间戳 → DATETIME」的约定（该域实测样本 `updateTime: 1789467685000` 佐证），但本域的每个时间字段是否都是毫秒戳未逐一验证 ⚠️。
15. **站点时差基准**：前端有 `siteTime` 偏移（`new Date(t.updateTime).getTime()-e.siteTime`）和「北京时间 vs 站点时间」双显示，落库时间基准需明确定义（建议统一存 UTC，展示层按 `country` 转换）⚠️。
16. **`fact_keyword_metric_snapshot` 主键是否需要 `country`**。`keyword_id` 已全局唯一，`country` 严格说冗余；保留是为了符合 `NAMING.md` §5 的强制约定并利于分区裁剪。需裁决是否例外。
17. **`stat_date` 的取值来源未确证** ⚠️。`fact_keyword_metric_snapshot` / `fact_keyword_search_trend` 的日期我从「时间窗 + 趋势序列的 date 轴」推导，接口没有直给单值 `stat_date`。

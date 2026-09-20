# 数据字典片段：运营时光机 / 查多变体自然位

> 素材同 `timemachine-variations.spec.md`。**字段名是直接看到的；类型列绝大多数是推断，一律标 ⚠️。**
> 目标库：Doris Unique Key 模型 → 主键决定能否按行更新，见 §4。
> 来源列格式：`文件 > 依据`。

---

## 0. 先给结论（主 Agent 最关心的三件事）

### 结论 1：时间粒度不一致，**不能合并成一张快照表**

| 页面 | 实体 | 粒度 | 判定依据（硬证据） |
|---|---|---|---|
| 运营时光机 | ASIN 运营/流量趋势 | **日 / 周 / 月 三档可切** | 四个请求参数对象均显式带 `granularity`，取值 `day`/`week`/`month`；UI `options:[{groupid:"day",groupName:"日趋势"},{groupid:"week",...},{groupid:"month",...}]` |
| 运营时光机 | ASIN×关键词 流量/进出 | **同上，三档可切**（跟随同一个 `granularity`） | `paramsDetail`/`paramsHistory` 也带 `granularity`，且 `searchBtn` 里四者被同步赋值 |
| 查多变体自然位 | ASIN 多变体日趋势 | **仅日，不可切** | 接口名 `dayTrend`；请求参数只有 `{asin, lastMonths:2}`，**根本没有 `granularity` 字段** |
| 查多变体自然位 | ASIN×关键词 多变体汇总 | **区间聚合值，不是逐日快照** | 参数是 `timePieceType`+`timePieceValue`（近7天/近30天/某周/某月），返回的是该区间的一个聚合行 |

**所以时光机的流量趋势和多变体的排名快照不是同一粒度。**
更要注意：多变体页面**内部就有两种粒度**——趋势图是日、关键词表是区间聚合，
`getCommonParams()`（含 `timePieceType/Value`）只合并进 `keywordList`，`getDailyTrendChart` 只合并 `{asin}`。

**建议：4 张独立快照表**（§2），不要硬合并。运营时光机的 3 档粒度用同一张表 + `granularity` 进主键
（因为字段集完全相同，只是聚合窗口不同，这是同一张表加维度；而多变体的字段集完全不同，是另一张表）。

### 结论 2：快照表业务主键

见 §4 完整推导，先给答案（均需加站点）：

| 表 | 业务主键 |
|---|---|
| `sif_asin_traffic_snapshot` | `site + asin + granularity + stat_date` |
| `sif_asin_keyword_traffic_snapshot` | `site + asin + granularity + stat_date + keyword_type + keyword` |
| `sif_asin_multinf_daily` | `site + asin + stat_date` |
| `sif_asin_multinf_keyword` | `site + asin + time_piece_type + time_piece_value + keyword` |
| `sif_asin_op_event` | `site + asin + event_date + event_type` ⚠️ 见 §5 唯一性风险 |

### 结论 3：「运营动作」是**系统识别的变化点**，不是用户标注

素材给的是一个**前端硬编码的固定枚举**，后端按天返回是否发生：

```
A = {finalPrice:"dealPrice", ldPrice:"ldPrice", couponPrice:"couponInfo", primePrice:"primePrice",
     buyboxPrice:"buyboxPrice", promotionPrice:"promotion", campaignId:"campaignId",
     titleOrImage:"titleImg", woot:"woot", ...流量/BSR/销量字段}
b = { dealPrice:"最终成交价格", ldPrice:"LD秒杀价格", couponInfo:"Coupon价格", primePrice:"Prime会员价格",
      buyboxPrice:"Buybox价格", promotion:"Promotion", campaignId:"新增广告活动",
      titleImg:"修改标题或图片", woot:"Woot", ... }
_ = { titleImg: {1:"修改标题", 2:"修改图片", 3:"修改标题和图片"} }
```

判定为「系统识别」的四条依据：

1. 这些动作是 `asinOpTrafficTrend` **趋势响应里的数组字段**（和 `bsr`、`boughtInPastMonth` 并列），
   按 `dates[]` 对齐，不是独立的用户笔记资源。素材里没有任何针对它们的写接口。
2. `titleImg` 取值是后端算出的**枚举码 1/2/3**（改标题/改图/都改），用户不会填这种码。
3. 详情接口 `/api/search/asinOpTrafficTrend/changeDetail` 返回 `lastChangeTime` / `nextChangeTime`，
   前端 `getNewTitle(text, ranges[], ...)` 按 `[start,end]` 区间高亮 diff 片段
   → 是**系统对抓取快照做的文本 diff**，用户标注不会产出字符区间。
4. UI 图例：「用绿色表示数据上升或**新出现运营动作**」——把运营动作和数据变化并列描述。

**用户手工标注体系确实存在，但不在这两个页面：** `app.js` 有完整 `adNote` CRUD
（`/api/user/adNote/upsert|delete|extraInfo|batchUpsert|id|list|batchUpdateColor|updateByid`，
`/api/user/` 前缀 = 用户私有数据，`batchUpdateColor` = 带颜色标签）。
但 `grep adNote docs/raw/_probe/chunks/*.js` → **chunk 27 和 31 都不命中**，只有 `app.js` 有。
对应页面是 `/ad-multiNotes-view` / `/ad-multiNotes-submit`（不在我的域）。

`/ltevent` 与运营动作无关，是「有奖征稿|Sif」，挂在用户中心菜单下。任务书这条线索是误判。

---

## 1. 基础实体

### 1.1 `sif_asin`（ASIN 商品主体）

用途：两个页面共用的商品维度。**本域只做补充**，主表应由商品域负责。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `asin` | ⚠️ varchar(10) | 子体 ASIN，业务主键之一 | 两页面全局请求参数 |
| `pasin` | ⚠️ varchar(10) | 父体 ASIN；为空表示自身即父体或无变体 | `27.6b4f3218.js > keepaData.pasin`、`{asin:"asin",dates:"dates",pasin:"pasin",...}` |
| `img` | ⚠️ varchar | 主图 URL 片段（前端 `getImgSrc(img, size)` 拼尺寸） | `31.d50bb1ff.js > asinInfo.img` |
| `price` | ⚠️ decimal | 当前价，渲染时前置站点货币符号 | `31 > isNotNullOrUndefined(t.price)?siteCurrency+t.price` |
| `features` | ⚠️ array<string> | 变体属性（颜色/尺码等），前端 `features.join(" \| ")` | `31 > t.features&&t.features.join(" \| ")` |
| `brandName` | ⚠️ varchar | 品牌 | `27 > sortEnum.brandName` |
| `firstAvailableDay` | ⚠️ date | 上架时间 | `27 > sortEnum.firstAvailableDay` |
| `is_variant` | ⚠️ boolean | 是否变体，UI 在 ASIN 后加「（变体）」 | `31 > itemData.isVaiant?"（变体）":""`（注意源码拼写就是 `isVaiant`，缺 r） |

关系：`sif_asin.pasin → sif_asin.asin`（自关联，父子变体）。

### 1.2 `sif_keyword`（关键词主体）

用途：两个页面的关键词维度。同样应由关键词域主导，本域补充。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `keyword` | ⚠️ varchar | 关键词文本，业务主键 | 两页面表格 `row.keyword` |
| `keywords_id` | ⚠️ bigint | 词库 ID（用户自定义词库关联用） | `31 > keywordsId`、`/api/user/keywords/getKeywordsid` |
| `est_searches_num` | ⚠️ bigint | 预估搜索量。**⚠️ 双口径**：`keywordDataType=search` 时是搜索量，`=aba` 时是 ABA 排名 | `27 > searchNumLabel`；`31 > estSearchesNum` |
| `searches_rank` | ⚠️ int | 关键词搜索排名 | 两页面 `searchesRank` |
| `click_purchase_ratio` | ⚠️ decimal | 点击转化率，表头「关键词的点击转化率」 | `31 > label:"关键词的点击转化率",prop:clickPurchaseRatio` |

⚠️ `est_searches_num`/`searches_rank` 本身是**随时间变的**（`estSearchesNumHistory`、`estSearchesNumHistoryPrev` 说明有历史序列），
严格说应该进快照表而非主表。素材未给出它们的独立时间维度接口 → 见 §6 待裁决 Q4。

---

## 2. 时序快照（本域核心产出）

### 2.1 `sif_asin_traffic_snapshot`（ASIN 运营/流量快照 · 运营时光机主表）

用途：一个 ASIN 在某天/周/月的流量得分、排名、销量、价格、运营动作标记。**这是运营时光机整张图的底表。**
来源接口：`/api/search/timeMachine/asinOpTrafficTrend`（图）+ `/asinOpTrafficTrend/list`（表）

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `site` | ⚠️ varchar | 站点 | axios 自动注入（`ignoreSetCountry` 反证），⚠️ 字段名未见 |
| `asin` | ⚠️ varchar(10) | ASIN | 请求参数 |
| `granularity` | ⚠️ varchar(8) | `day`/`week`/`month` | 请求参数 `granularity` |
| `stat_date` | ⚠️ date/varchar | 统计日期。日=`yyyy-MM-dd`，周=周起始日，月=`yyyy-MM` | 响应 `dates[]`；`endDay` 参数；周月格式见 spec §1.3 |
| `total_score` | ⚠️ decimal | 全部流量（分） | `27 > A.totalScore="totalScore"`, `b[totalScore]="全部流量"` |
| `nf_score` | ⚠️ decimal | 自然流量 | `nfScore` |
| `ad_score` | ⚠️ decimal | 广告流量 | `adScore` |
| `sp_score` | ⚠️ decimal | SP(常规)流量 | `spScore` |
| `rec_sp_score` | ⚠️ decimal | SP(推荐)流量 | `recSpScore` |
| `sb_score` | ⚠️ decimal | SB(常规)流量 | `sbScore` |
| `sbv_score` | ⚠️ decimal | SBV流量 | `sbvScore` |
| `bsr` | ⚠️ int | 大类 BSR，渲染 `#值` | `A.bsr="bsr"`, `b[bsr]="大类BSR"` |
| `bought_in_past_month` | ⚠️ int | 最近30天销量 | `A.salesNum="boughtInPastMonth"`, `b="最近30天销量"` |
| `star` | ⚠️ decimal | 评分 | `A.star="star"`, `b="评分"` |
| `review` | ⚠️ int | 评论数 | `A.reviewNum="review"`, `b="评论数"` |
| `seller` | ⚠️ int | 卖家数 | `A.seller="seller"`, `b="卖家数"` |
| `deal_price` | ⚠️ decimal | 最终成交价格 | `A.finalPrice="dealPrice"` |
| `ld_price` | ⚠️ varchar | LD秒杀价格。**⚠️ 复合串** `"价_?"`，前端 `split("_")[0]` | `A.ldPrice="ldPrice"` + 格式化函数 |
| `coupon_info` | ⚠️ varchar | Coupon价格。**⚠️ 复合串** `"价_?_省"`，渲染 `价(Save 省)` | `A.couponPrice="couponInfo"` + `split("_")` 取 3 段 |
| `prime_price` | ⚠️ decimal | Prime会员价格 | `A.primePrice="primePrice"` |
| `buybox_price` | ⚠️ decimal | Buybox价格 | `A.buyboxPrice="buyboxPrice"` |
| `promotion` | ⚠️ varchar | Promotion | `A.promotionPrice="promotion"` |
| `woot` | ⚠️ varchar | Woot 活动标记（不可点击） | `A.woot="woot"` |
| `campaign_id` | ⚠️ varchar | **新增广告活动**（运营动作，可点击下钻） | `A.campaignId="campaignId"`, `b="新增广告活动"` |
| `title_img` | ⚠️ tinyint | **修改标题或图片**（运营动作）：`1`改标题 `2`改图 `3`都改 | `A.titleOrImage="titleImg"`; `_={titleImg:{1:"修改标题",2:"修改图片",3:"修改标题和图片"}}` |
| `pasin` | ⚠️ varchar(10) | 父体（父体查询时返回） | `keepaData.pasin` |
| `listing_search` | ⚠️ boolean | 该行是否按父体聚合 | 请求参数 `listingSearch` |
| `cat_name` | ⚠️ varchar | 大类类目名（图表标题用 `大类BSR[类目名]`） | `27 > e.catName \|\| "无"` |
| `non_null_min_index` | ⚠️ int | 首个非空数据下标（前端裁剪空白区间用），**派生字段，不建议入库** | `nonNullMinIndex` |

⚠️ 表里另有 `totalScore.scoreChange` / `totalScore.scoreChangeRatio`（列表接口返回的是**嵌套对象**而非标量）
以及趋势 tooltip 的 `{value, ratio, change, changeRatio}`。
**这些「相比上期变化」是派生量，建议不入库，由 Doris 侧窗口函数算**。

**⚠️ 单独拆表：`subBsr` 是动态 key 对象**
响应 `subBsr = {类目名: 值 | {…}}`，前端手动拍平成 `[{keyName, value}]`。
→ 必须拆成 `sif_asin_subbsr_snapshot`：

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `site`/`asin`/`granularity`/`stat_date` | ⚠️ | 同上，外键 | — |
| `sub_cat_name` | ⚠️ varchar | 小类类目名（= 原对象的 key） | `keyName` |
| `sub_bsr` | ⚠️ int | 小类 BSR，渲染 `#值` | `value` |

主键：`site + asin + granularity + stat_date + sub_cat_name`。
⚠️ 类目名取值范围未知，图表侧只画前 6 个（颜色数组长度 6）。

### 2.2 `sif_asin_keyword_traffic_snapshot`（ASIN×关键词 流量快照 · 时光机下钻）

用途：某天某个 ASIN 的**每个关键词**贡献了多少流量、变化多少、变化原因。
来源接口：`/api/search/timeMachine/asinOpTrafficTrend/detail`

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `site`/`asin`/`granularity` | ⚠️ | 同上 | 请求参数 |
| `stat_date` | ⚠️ date | = 请求 `endDay` | `paramsDetail.endDay` |
| `traffic_type` | ⚠️ varchar | 流量大类：`all`/`nf`/`sp`（由 `radio` 3/6/9 映射） | `type = radio==3?"all":radio==6?"nf":"sp"` |
| `keyword_type` | ⚠️ varchar | 流量子类，见 §3.2 枚举 | `paramsDetail.keywordType`（`formatParams(中文名)` 转换） |
| `keyword` | ⚠️ varchar | 关键词 | 表格行 |
| `score` | ⚠️ decimal | 本期贡献总流量 | 表头「本期贡献总流量及占比」，`row.score` |
| `score_ratio` | ⚠️ decimal | 本期贡献流量占比 | `row.scoreRatio` |
| `diff_score` | ⚠️ decimal | 相比上期的流量变化（默认排序字段） | `row.diffScore`，`sortBy:"diffScore"` |
| `diff_score_ratio` | ⚠️ decimal | 相比上期变化百分比 | `row.diffScoreRatio` |
| `affect_whole_ratio` | ⚠️ decimal | 流量变化对整体流量的影响占比 | 表头「流量变化对整体流量的影响占比」，`row.affectWholeRatio` |
| `pchange_reason_nf_info` | ⚠️ varchar | 变化原因·自然位变化。**⚠️ 复合串 `"前_后"`** | `pchangeReason.nfInfo`，前端 `split("_")` 比大小 |
| `pchange_reason_sp_info` | ⚠️ varchar | 变化原因·SP位变化，同上 | `pchangeReason.spInfo` |
| `pchange_reason_sb_info` | ⚠️ varchar | 变化原因·SB位变化，同上 | `pchangeReason.sbInfo`（`sbMsg` 标记） |
| `pchange_reason_rec_sp_info` | ⚠️ varchar | 变化原因·SP推荐位变化，同上 | `pchangeReason.recSpInfo`（`recSpMsg`） |
| `vchange_reason` | ⚠️ varchar | 变化原因之关键词搜索量变化 | 表头「流量变化原因之关键词搜索量变化」，`row.vchangeReason` |
| `sif_nf_info` | ⚠️ varchar | Sif 自然位信息 | `row.sifNfInfo` |
| `sif_sp_info` | ⚠️ varchar | Sif SP 位信息 | `row.sifSpInfo` |

建议把 4 个 `pchange_reason_*` 拆成 `pos_before`/`pos_after` 两列（各 4 组），入库前 split。

**⚠️ 同一接口还返回 `extraData`（按 §3.2 的 `name1` 索引的汇总块）**：
`{totalScore:{isChanged,diffScore,score,diffScoreRatio}, nfScore:{...}, adScore:{...}, ...}`
这是**按流量类型的当日汇总**，与 2.1 的宽表字段重复（都是 `<type>Score`），
但多了 `isChanged`/`diffScore`/`diffScoreRatio`。→ 见 §6 待裁决 Q2。

### 2.3 `sif_asin_keyword_inout_snapshot`（ASIN×关键词 前3页进出快照 · 时光机）

用途：某天有哪些词**新进前3页 / 掉出前3页 / 保持在前3页**。
来源接口：`/api/search/timeMachine/asinKeywordTrend/list`
响应结构是三个并列数组：`inKeywords[]` / `outKeywords[]` / `noChangeKeywords[]` → 入库时打平成一列 `change_type`。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `site`/`asin`/`granularity` | ⚠️ | 同上 | 请求参数 |
| `stat_date` | ⚠️ date | = `endDay` | `paramsHistory.endDay` |
| `traffic_type` | ⚠️ varchar | `all`/`nf`/`sp` | 同 2.2 |
| `keyword_type` | ⚠️ varchar | 见 §3.2 | `paramsHistory.keywordType` |
| `keyword` | ⚠️ varchar | 关键词 | 表格行 |
| `change_type` | ⚠️ varchar | **`in` 新进前3页 / `out` 掉出前3页 / `no_change` 保持** | 请求参数 `changeType:"in"/"out"`；响应三数组 `inKeywords`/`outKeywords`/`noChangeKeywords` |
| `est_searches_num` | ⚠️ bigint | 关键词搜索量（默认排序字段） | 表头「关键词搜索量」，`sortBy:"estSearchesNum"` |
| `searches_rank` | ⚠️ int | 关键词搜索排名 | 表头「关键词搜索排名」 |
| `last_rank` | ⚠️ int | 自然排名（仅「自然流量词」列显示） | `row.lastRank` |
| `last_rank_str` | ⚠️ varchar | 自然排名展示串（含页/位？⚠️ 未证实） | `row.lastRankStr` |
| `rank_time` | ⚠️ datetime | 自然排名采集时间 | `row.rankTime` |
| `ad_last_rank` | ⚠️ int | 广告排名（仅「SP(常规)流量词」列显示） | `row.adLastRank` |
| `ad_last_rank_str` | ⚠️ varchar | 广告排名展示串 | `row.adLastRankStr` |
| `ad_rank_time` | ⚠️ datetime | 广告排名采集时间 | `row.adRankTime` |
| `first_time` | ⚠️ date | 首次出现时间 | `row.firstTime` |
| `hold_ratio` | ⚠️ decimal | 保持率 | `row.holdRatio` |
| `hold_days` | ⚠️ int | 保持天数 | `row.holdDays` |
| `total_days` | ⚠️ int | 统计总天数（UI 渲染 `(N天)`） | `row.totalDays` |

⚠️ `first_time`/`hold_*` 是**跨区间统计量**，放在逐日快照里会大量冗余 → 见 §6 待裁决 Q3。
同接口的 `extraData` 是按 §3.2 `name` 索引的 `{isChanged, inNum, outNum, noChangeNum}` 词数量汇总。

### 2.4 `sif_asin_multinf_daily`（ASIN 多变体自然位日快照 · 多变体主表）

用途：一个 Listing 每天「有多少变体拿到自然位、多少词出现多自然位、额外获得多少自然流量」。
来源接口：`/api/search/asinMultiNf/dayTrend`。**粒度固定为日，无 granularity 参数。**

响应是**列式数组**（`dates[]` + 各 `xxxList[]` 平行对齐），入库需转成行。
⚠️ 数组元素**不是标量而是对象** `{value, ratio, change, changeRatio}`
（依据：tooltip 里 `t[e.field][o]` 取到的 `n` 有 `n.value` / `n.ratio` / `n.change` / `n.changeRatio`；
且 series 取值函数 `$(e)= e.map(e=>e.value)`）。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `site` | ⚠️ varchar | 站点 | 自动注入 |
| `asin` | ⚠️ varchar(10) | 查询的 ASIN（父体或子体） | 请求参数 `asin` |
| `stat_date` | ⚠️ date | 日期 | 响应 `dates[]` |
| `asin_cnt` | ⚠️ int | **该关键词下有自然流量的变体数量** | series `variants`: `field:"asinCntList"`, `name:"该关键词下有自然流量的变体数量"` |
| `keyword_cnt` | ⚠️ int | **有多个自然位的关键词数量** | series `keywords`: `field:"keywordCntList"`, `name:"有多个自然位的关键词数量"` |
| `nf_main_score` | ⚠️ decimal | **主自然位的自然流量** | series `singleTraffic`: `field:"scoreList"`, `name:"主自然位的自然流量"`, `isScore:true` |
| `nf_extra_score` | ⚠️ decimal | **因多自然位额外获得的自然流量** | series `extraTraffic`: `field:"extraScoreList"`, `name:"因多自然位额外获得的自然流量"`, `decimalPlaces:2` |
| `nf_total_score` | ⚠️ decimal | 总自然流量（= 主 + 额外，tooltip 合成项） | `field:"totalScoreList"`, `name:"总自然流量"` |
| `listing_update_time` | ⚠️ datetime | Listing 数据更新时间（页面「更新时间」展示） | `31 > trendChartInfo.listingUpdateTime` |

配套 `*_ratio` / `*_change` / `*_change_ratio` 是**派生量，建议不入库**（Doris 侧算）。

### 2.5 `sif_asin_multinf_keyword`（ASIN×关键词 多变体区间聚合 · 多变体关键词表）

用途：在**所选时间区间**内，每个关键词下该 Listing 的多变体占位与流量贡献。
来源接口：`/api/search/asinMultiNf/keywordList`。
**⚠️ 这不是逐日快照，而是区间聚合行**，时间维度是 `timePieceType + timePieceValue` 二元组。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `site`/`asin` | ⚠️ | 同上 | 请求参数 |
| `time_piece_type` | ⚠️ varchar | `latelyDay`/`week`/`month` | `getCommonParams()` → `timePieceType` |
| `time_piece_value` | ⚠️ varchar | `7`/`30`/`yyyy-MM-dd`(周起)/`yyyy-MM` | `timePieceValue`（前端已剥掉 `latelyDay`/`周:`/`月:` 前缀） |
| `keyword` | ⚠️ varchar | 关键词 | `row.keyword` |
| `today_multi_nf` | ⚠️ boolean | 今天该词下存在多变体自然位 | `row.today`；tooltip「该标记代表今天在该关键词下存在多个变体自然位的情况」 |
| `nf_score` | ⚠️ decimal | 给 Listing 贡献的自然流量 | 表头「给Listing贡献的自然流量及占比」，`row.nfScore` |
| `nf_score_ratio` | ⚠️ decimal | 上述占比 | `row.nfScoreRatio` |
| `nf_extra_score` | ⚠️ decimal | 因多自然位额外获得的自然流量 | 表头「因多自然位额外获得的自然流量」，`row.nfExtraScore` |
| `nf_extra_score_ratio` | ⚠️ decimal | 上述占比 | `row.nfExtraScoreRatio` |
| `nf_score_ratio_on_kw_all` | ⚠️ decimal | 该 Listing 在该词全站自然流量中的份额 | 表头「单自然位→多自然位自然流量市场份额变化」，`row.nfScoreRatioOnKwAll` |
| `nf_main_score_ratio_on_kw_all` | ⚠️ decimal | 仅主自然位的份额 | `row.nfMainScoreRatioOnKwAll` |
| `nf_extra_score_ratio_on_kw_all` | ⚠️ decimal | 额外自然位带来的份额增量（排序字段） | `row.nfExtraScoreRatioOnKwAll`，`sortEnum` 成员 |
| `est_searches_num` | ⚠️ bigint | 周/月搜索量（表头随粒度变「周搜索趋势」/「月搜索趋势」） | `row.estSearchesNum` |
| `est_searches_num_history` | ⚠️ array/json | 搜索量历史序列（画迷你趋势图） | `row.estSearchesNumHistory` |
| `est_searches_num_history_prev` | ⚠️ array/json | 上一期搜索量历史序列（对比） | `row.estSearchesNumHistoryPrev` |
| `searches_rank` | ⚠️ int | 关键词搜索排名 | `row.searchesRank` |
| `click_purchase_ratio` | ⚠️ decimal | 关键词的点击转化率 | 表头「关键词的点击转化率」 |
| `keyword_cnt_list` | ⚠️ array/json | 行内趋势图数据（关键词数量序列） | `row.keywordCntList` + `row.dates` |

⚠️ `est_searches_num_history*` 和 `keyword_cnt_list` 是**内嵌数组**，
入 Doris 前应拆成独立时序表或存 JSON（见 §6 Q5）。

### 2.6 `sif_asin_multinf_keyword_variant`（关键词×变体 排名明细 · 多变体弹层）

用途：某关键词下，各变体各自占据的自然排名位置。**这是 goal.md `/variations` 最核心的那张表。**
来源：`keywordList` 行内弹层「获得多个自然位的变体及排名」（响应嵌套在 keywordList 行里）

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `site`/`asin`(父)/`time_piece_type`/`time_piece_value`/`keyword` | ⚠️ | 同 2.5，外键 | — |
| `variant_asin` | ⚠️ varchar(10) | 变体 ASIN | 弹层 `t.asin` |
| `rank` | ⚠️ int | **该变体在该词下的自然排名**（UI「自然排名：」+值） | `31 > _v("自然排名："+_s(t.rank))` |
| `price` | ⚠️ decimal | 变体价格 | 弹层 `t.price` |
| `features` | ⚠️ array | 变体属性 | `t.features.join(" \| ")` |
| `img` | ⚠️ varchar | 变体图 | `t.img` |

⚠️ **这张表的时间维度是继承自父行的区间，不是逐日**。
若要「看变体排名逐日变化」，素材里唯一的逐日入口是 2.4 的 `asinCntList`（只有数量，没有具体变体和排名）
和 2.7 的日变化抽屉。→ §6 Q6。

### 2.7 `sif_asin_multinf_keyword_change`（单/多自然位切换日明细 · 多变体抽屉）

用途：某一天，哪些词从「1个自然位」变成「≥2个自然位」（或反向）。
来源接口：`/api/search/asinMultiNf/dayTrend/keywordChange`

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `site`/`asin` | ⚠️ | 同上 | 请求参数 |
| `stat_date` | ⚠️ date | 请求参数 `day` | `{asin, day, dataType, searchKeyword}` |
| `data_type` | ⚠️ varchar | `oneTwo`（1个→≥2个）/ `twoOne`（≥2个→1个） | `dataType:this.isOneTwo?"oneTwo":"twoOne"`；UI「1个自然位 → ≥2个自然位」/「≥2个自然位 → 1个自然位」 |
| `keyword` | ⚠️ varchar | 关键词 | `resData.list[]` |
| ⚠️ 明细字段 | ⚠️ | **素材未覆盖**：`resData.list` 的行字段名没在渲染层解析出来（抽屉表格列定义与主表复用） | — |

同接口返回计数：`oneTwoCnt`（1→多的词数）、`twoOneCnt`（多→1的词数），
可作为 2.4 的补充度量列（`one_to_two_cnt` / `two_to_one_cnt`）。

### 2.8 `sif_asin_op_event`（ASIN 运营动作事件表 · 从 2.1 派生的建议表）

2.1 是宽表，把运营动作当列存。但运营动作语义上是**事件**（稀疏、可下钻详情），
且详情接口 `/api/search/asinOpTrafficTrend/changeDetail` 是按 `{asin, date}` 取的，
建议**额外抽一张事件表**便于时间轴查询：

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `site`/`asin` | ⚠️ | 同上 | — |
| `event_date` | ⚠️ date | 事件日期 | `changeDetail` 请求 `date` |
| `event_type` | ⚠️ varchar | 见 §3.1 运营动作枚举 | `A`/`b` 枚举 |
| `event_sub_code` | ⚠️ tinyint | 子类型码。仅 `titleImg` 有：1改标题/2改图/3都改 | `_={titleImg:{1:...,2:...,3:...}}` |
| `event_value` | ⚠️ varchar | 原始值（如 `campaignId` 的活动 ID、价格值、复合串） | 各 series 数据点 |
| `last_change_time` | ⚠️ date | 上一次变化的日期（详情接口返回，供「< 查看上一次变化」跳转） | `detailInfo.lastChangeTime` |
| `next_change_time` | ⚠️ date | 下一次变化的日期 | `detailInfo.nextChangeTime` |
| `listing_search` | ⚠️ boolean | 是否父体口径 | 请求参数 |
| ⚠️ diff 明细 | ⚠️ | **素材未覆盖字段名**。已知前端 `getNewTitle(text, ranges[[start,end],...])` 做区间高亮，说明返回**原文 + 变化区间数组** | `27 > getNewTitle` |

⚠️ `last_change_time`/`next_change_time` 是**链表指针语义**，可由 Doris 窗口函数（lag/lead）算出，
不建议物化——但要注意它们的取值域是「有变化的日期」，不是「所有日期」。

---

## 3. 枚举字典

### 3.1 `dict_op_event_type`（运营动作 / 图表 series 类型）
来源：`27.6b4f3218.js` 枚举对象 `A`（字段名）+ `b`（中文名）

| code（响应字段名） | 中文名 | 是否运营动作 | 可点击下钻 |
|---|---|---|---|
| `dealPrice` | 最终成交价格 | 价格类 | 否 |
| `ldPrice` | LD秒杀价格 | 活动类 | 否 |
| `couponInfo` | Coupon价格 | 活动类 | 否 |
| `primePrice` | Prime会员价格 | 价格类 | 否 |
| `buyboxPrice` | Buybox价格 | 价格类 | 否 |
| `promotion` | Promotion | 活动类 | 否 |
| `woot` | Woot | 活动类 | **否**（`clickChart` 显式 return） |
| `campaignId` | **新增广告活动** | ✅ 运营动作 | ✅ |
| `titleImg` | **修改标题或图片** | ✅ 运营动作 | ✅ |
| `totalScore` | 全部流量 | 度量 | 柱子可点 |
| `nfScore` | 自然流量 | 度量 | 柱子可点 |
| `adScore` | 广告流量 | 度量 | 柱子可点 |
| `spScore` | SP(常规)流量 | 度量 | 柱子可点 |
| `recSpScore` | SP(推荐)流量 | 度量 | 柱子可点 |
| `sbScore` | SB(常规)流量 | 度量 | 柱子可点 |
| `sbvScore` | SBV流量 | 度量 | 柱子可点 |
| `subBsr` | 小类BSR | 度量 | 否 |
| `bsr` | 大类BSR | 度量 | 否 |
| `boughtInPastMonth` | 最近30天销量 | 度量 | 否 |
| `star` | 评分 | 度量 | 否 |
| `review` | 评论数 | 度量 | 否 |
| `seller` | 卖家数 | 度量 | 否 |

`titleImg` 子码：`1`=修改标题，`2`=修改图片，`3`=修改标题和图片。

### 3.2 `dict_traffic_type`（流量类型 / 关键词类型）

素材里有**两套并存的 code**，必须区分：

**A. 时光机 `headList`（chunk 27）** — 决定 `keyword_type` 和 `extraData` 的 key：

| 中文（UI 加「词」后缀） | `name`（词数量口径） | `name1`（流量分口径） |
|---|---|---|
| 全部流量 | `allKeywords` | `totalScore` |
| 自然流量 | `nfKeywords` | `nfScore` |
| 广告流量 | `adKeywords` | `adScore` |
| SP(常规)流量 | `spKeywords` | `spScore` |
| SP(推荐)流量 | `recSpKeywords` | `recSpScore` |
| SB(常规)流量 | `sbKeywords` | `sbScore` |
| SBV流量 | `sbvKeywords` | `sbvScore` |

**B. 公共枚举 `w`/`S`（chunk 31，`WlAH` 模块）** — 更完整，含聚合层级：

| code | 中文名 |
|---|---|
| `total` | 全部流量 |
| `nf` | 自然流量 |
| `ad` | 广告流量 |
| `allSp` | SP广告流量 |
| `sp` | SP(常规)流量 |
| `spRec` | SP(推荐)流量 |
| `allSb` | SB广告流量 |
| `sb` | SB(常规)流量 |
| `sbv` | SBV流量 |

**⚠️ 两套之间还有一层错位映射**（chunk 27 共享模块 `c`）：
`{total:"total", natural:"nf", ad:"ad", spRec:"allSp", sp:"sp", rec:"spRec", brandVedio:"allSb", brand:"sb", vedio:"sbv"}`
注意 `spRec → allSp` 而 `rec → spRec`，**命名交叉**，建模时不要直接套用 `sortEnum` 的名字。

### 3.3 `dict_granularity`（时间粒度 · 仅运营时光机）

| code | 中文 |
|---|---|
| `day` | 日趋势 |
| `week` | 周趋势 |
| `month` | 月趋势 |

另有 chunk 31 的 `v={day:"day",week:"week",month:"month"}`。

### 3.4 `dict_time_piece`（时间区间选择器 · 两页共用）

| type | value 形态 | 中文 |
|---|---|---|
| `latelyDay` | `7` | 最近7天 |
| `latelyDay` | `30` | 最近30天 |
| `week` | `yyyy-MM-dd`（周起始日） | 选择某周 |
| `month` | `yyyy-MM` | 选择某月 |

派生规则：`granularityDesc = (type含month 或 value==="30") ? "月" : "周"`（chunk 31 函数 `o`）。

### 3.5 `dict_last_months`（回溯跨度 · 运营时光机）

| value | 中文 |
|---|---|
| `null` | 全部 |
| `3` | 最近3个月 |
| `6` | 最近6个月 |
| `12` | 最近1年 |
| `24` | 最近2年 |

另一处变体（`u` 数组，含 30 天与自定义月）：`all`/`d30`/`m3`/`m6`/`y1`/`y2`/`month`。
上限一致：**2 年 / 720 天**（「可回溯最近 2 年(720)天的数据」）。

### 3.6 `dict_keyword_change_type`（前3页进出 · 运营时光机）

| code | 中文 |
|---|---|
| `in` | 查看新进前3页的词 |
| `out` | 查看掉出前3页的词 |
| `no_change`（前端 `inValue=3`） | 查看保持在前3页的词 |

### 3.7 `dict_multinf_change_type`（单/多自然位切换 · 多变体）

| code | 中文 |
|---|---|
| `oneTwo` | 1个自然位 → ≥2个自然位 |
| `twoOne` | ≥2个自然位 → 1个自然位 |

### 3.8 `dict_flow_change_filter`（流量变化方向筛选 · 运营时光机，纯前端）

| value | 中文 |
|---|---|
| `1` | 查看全部变化 |
| `2` | 只看流量增加的变化 |
| `3` | 只看流量减少的变化 |

### 3.9 `dict_traffic_scope`（图表流量范围 · 运营时光机 `radio`）

| value | 中文 | 映射到请求 `type` |
|---|---|---|
| `3` | 全部流量 | `all` |
| `6` | 前三页自然流量 | `nf` |
| `9` | 前三页SP广告流量 | `sp` |

### 3.10 `dict_variant_role`（变体角色 · 多变体）

| code ⚠️（素材只有中文，无 code） | 中文 |
|---|---|
| ⚠️ main | 主曝光变体 |
| ⚠️ extra | 搭子 |
| — | 主曝光变体+搭子（表头） |
| `best`(boolean) | 最佳CP |

---

## 4. 快照表主键设计建议（Doris Unique Key）

### 4.1 `sif_asin_traffic_snapshot`
```
UNIQUE KEY(site, asin, granularity, stat_date)
```
- `granularity` **必须进主键**：同一个 `asin + 2024-06-03` 在 day / week / month 三种粒度下是三条不同的事实
  （week 的 `stat_date` 是周起始日，可能与某个 day 的日期相同）。漏了它会互相覆盖。
- `listing_search`（父体口径）⚠️ **是否要进主键待定**：父体查询和子体查询返回的是不同聚合口径的数据。
  如果后端对父体返回的 `asin` 字段就是父 ASIN，则不需要；如果返回子 ASIN + `listingSearch` 标记，则必须进主键。
  素材无法区分 → §6 Q1。

### 4.2 `sif_asin_subbsr_snapshot`
```
UNIQUE KEY(site, asin, granularity, stat_date, sub_cat_name)
```

### 4.3 `sif_asin_keyword_traffic_snapshot`
```
UNIQUE KEY(site, asin, granularity, stat_date, traffic_type, keyword_type, keyword)
```
- `traffic_type`(all/nf/sp) 和 `keyword_type`(allKeywords/nfKeywords/...) **都要进**：
  它们是请求里两个独立参数（`type` 与 `keywordType`），同一个词在不同组合下有不同的 `score`/`diffScore`。
- 如果后端其实只按 `keyword_type` 切分、`traffic_type` 只是筛选条件，则 `traffic_type` 可去掉 → §6 Q2。

### 4.4 `sif_asin_keyword_inout_snapshot`
```
UNIQUE KEY(site, asin, granularity, stat_date, traffic_type, keyword_type, keyword)
```
`change_type` **不进主键**：同一天同一个词只可能属于 in/out/no_change 之一（三个数组互斥），
它是这一行的属性而非维度。⚠️ 但这依赖「互斥」假设——素材里三数组同时返回，未见去重逻辑，
如果同一词能同时出现在两个数组（例如不同 keyword_type 下），主键已含 `keyword_type` 可覆盖。

### 4.5 `sif_asin_multinf_daily`
```
UNIQUE KEY(site, asin, stat_date)
```
- **不需要 `granularity`**：该接口无粒度参数，恒为日。
- **不需要 `time_piece_*`**：`lastMonths:2` 只影响返回的日期范围，不改变每行的语义
  （同一天的数据无论查 1 个月还是 2 个月都应该相同）。把它放进主键会造成同一事实多行。

### 4.6 `sif_asin_multinf_keyword`
```
UNIQUE KEY(site, asin, time_piece_type, time_piece_value, keyword)
```
- **`time_piece_type` + `time_piece_value` 必须都进主键**，且不能简化成单个 `stat_date`：
  这是区间聚合，「最近7天」「最近30天」「2024年第22周」「2024-06」是四个不同的聚合窗口，
  且 `latelyDay` 类型的窗口是**相对当天滚动的**（`7`/`30` 不是绝对日期）。
- ⚠️ **`latelyDay` 是滚动窗口，这是个真问题**：`time_piece_value='7'` 的行今天和明天含义不同，
  按此主键写入会被明天的数据覆盖，历史丢失。
  → **建议**：入库时把 `latelyDay` 换算成绝对区间，主键改为
  `(site, asin, period_start, period_end, keyword)`，并保留 `time_piece_type` 作为普通列标注原始口径。
  这样周/月/近7天/近30天四种口径统一到绝对区间上，可比可存。→ §6 Q7（需主 Agent 确认是否统一改造）
- `searchAsin`（变体筛选）**不进主键**：它是前端筛选参数，缩小结果集但不改变行语义。

### 4.7 `sif_asin_multinf_keyword_variant`
```
UNIQUE KEY(site, asin, period_start, period_end, keyword, variant_asin)
```
（继承 4.6 的区间处理方式）

### 4.8 `sif_asin_multinf_keyword_change`
```
UNIQUE KEY(site, asin, stat_date, data_type, keyword)
```
`data_type` 进主键：同一个词同一天理论上只可能是 oneTwo 或 twoOne 之一，但两者是两次独立请求返回的两个结果集，
且 `oneTwoCnt`/`twoOneCnt` 并列返回说明后端是分开统计的 → 保守起见进主键。

### 4.9 `sif_asin_op_event`
```
UNIQUE KEY(site, asin, event_date, event_type)
```
⚠️ **唯一性风险**：如果一天内同一类型发生多次（例如同日新增两个广告活动，两个不同 `campaignId`），
这个主键会丢数据。趋势图每天每 series 只有一个数据点，说明**前端视角是「当天是否发生」而非「发生几次」**，
但后端是否会返回多值未知。
→ 稳妥方案：主键加 `event_value`，即 `(site, asin, event_date, event_type, event_value)`。→ §6 Q8

### 4.10 分区与分桶（补充建议，非素材结论）
- 所有快照表按 `stat_date` / `period_start` 做 RANGE 分区（月分区）。
- 分桶键选 `asin`（查询模式全是「给定 ASIN 查时间序列」，两个页面都是先输 ASIN 再查）。
- `sif_asin_keyword_*` 数据量最大（ASIN × 日期 × 词），若单分区过大可用 `HASH(asin, keyword)`。

---

## 5. 实体关系

```
sif_asin (asin, pasin 自关联父子变体)
  │
  ├─1:N─> sif_asin_traffic_snapshot        (site, asin, granularity, stat_date)   ← 运营时光机主图/主表
  │          └─1:N─> sif_asin_subbsr_snapshot   (+ sub_cat_name)
  │          └─1:N─> sif_asin_op_event      (site, asin, event_date, event_type)  ← 运营动作事件（从宽表列抽出）
  │
  ├─1:N─> sif_asin_keyword_traffic_snapshot (+ traffic_type, keyword_type, keyword) ← 时光机流量变化下钻
  │          └─N:1─> sif_keyword (keyword)
  │
  ├─1:N─> sif_asin_keyword_inout_snapshot   (+ traffic_type, keyword_type, keyword) ← 时光机词进出
  │          └─N:1─> sif_keyword
  │
  ├─1:N─> sif_asin_multinf_daily            (site, asin, stat_date)               ← 多变体日趋势【日粒度】
  │          └─1:N─> sif_asin_multinf_keyword_change (+ data_type, keyword)
  │
  └─1:N─> sif_asin_multinf_keyword          (site, asin, period, keyword)         ← 多变体关键词【区间聚合】
             ├─N:1─> sif_keyword
             └─1:N─> sif_asin_multinf_keyword_variant (+ variant_asin, rank)      ← 变体自然排名
                        └─N:1─> sif_asin (variant_asin)
```

**跨域关系（供主 Agent 合并时注意）**：
- `sif_keyword` 应与关键词域的主表合并，本域只贡献 `est_searches_num`/`searches_rank`/`click_purchase_ratio` 三个度量，
  且它们**都是随时间变的**，很可能属于关键词域自己的快照表。
- `sif_asin` 应与商品域主表合并。
- `dict_traffic_type` 是全站公共枚举（定义在 `WlAH` 公共模块），必然与其他域重叠，**务必统一到一份**，
  并留意 §3.2 提到的两套 code 交叉映射问题。
- 用户手工标注 `adNote`（`/api/user/adNote/*`）属于 `/ad-multiNotes-*` 域，本域不建模但可能需要与
  `sif_asin_op_event` 在时间轴上叠加展示 → §6 Q9。

---

## 6. 待主 Agent 裁决 / 跨域问题

| # | 问题 | 我的倾向 |
|---|---|---|
| Q1 | `listing_search`（父体口径）是否进 `sif_asin_traffic_snapshot` 主键？取决于后端返回的 `asin` 是父还是子。 | 素材不足。倾向：若返回父 ASIN 则不进主键 |
| Q2 | `traffic_type`(all/nf/sp) 与 `keyword_type`(allKeywords/nfKeywords/...) 是否语义重复？`extraData` 又与 2.1 宽表的 `<type>Score` 重复。三者需要统一。 | 倾向：`keyword_type` 是真维度，`traffic_type` 是筛选；`extraData` 不单独建表，用宽表 + 窗口函数 |
| Q3 | `first_time`/`hold_ratio`/`hold_days`/`total_days`/`appear_days`/`avg_rank` 是跨区间统计量，放逐日快照会大量冗余。是否抽「ASIN×关键词 生命周期表」？ | 倾向：抽独立汇总表 |
| Q4 | `est_searches_num`/`searches_rank` 到底属于关键词域快照表还是本域快照表？两页面都返回它们，但它们只随「词+时间」变，与 ASIN 无关。 | 倾向：归关键词域时序表，本域快照只存外键 |
| Q5 | `est_searches_num_history` / `est_searches_num_history_prev` / `keyword_cnt_list` 是内嵌数组。拆表还是存 JSON？ | 倾向：拆到关键词域时序表；`keyword_cnt_list` 可由 `sif_asin_multinf_daily` 聚合得出，不存 |
| Q6 | 「变体在关键词下的自然排名」目前只有**区间聚合**一份（2.6）。goal.md 的 `/variations` 若要看逐日排名变化，素材里没有对应接口。是否需要另行确认？ | 需要产品确认。素材内确实没有 |
| Q7 | `latelyDay`（近7天/近30天）是**滚动窗口**，直接入 Unique Key 会被覆盖。是否统一换算为绝对 `period_start/period_end`？这会影响所有用 `timePieceType/Value` 的域。 | **强烈建议统一换算**，这是跨域一致性问题 |
| Q8 | `sif_asin_op_event` 主键是否要加 `event_value`（防同日同类型多次事件被覆盖）？ | 倾向：加 |
| Q9 | 用户手工标注 `adNote`（跨域）是否要与运营动作在同一条时间轴上建模？ | 倾向：独立表，展示层叠加，不混入系统识别的事件表 |
| Q10 | 全站 HTTP 方法（axios 封装 `a`/`b` 谁是 GET/POST）需统一裁定一次，我未验证。 | 需 `app.js` axios 封装的确切分析 |
| Q11 | 站点字段名未见（URL query 用 `country`，store 用 `countryCode`），需全站统一命名。 | 倾向：统一 `site_code` |
| Q12 | `*Ratio` 系列是 0~1 还是 0~100？影响所有比率字段的 decimal 精度定义。 | 素材无证据，需接口样例 |
| Q13 | 「流量得分」（`*Score`）的量纲/算法是 Sif 自算指标（UI 叫「流量(分)」），不是曝光量。是否需要在字典里显式声明为「平台自有派生指标」以免被误当真实流量？ | 倾向：显式声明 |

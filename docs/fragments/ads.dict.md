# 广告页面域数据字典片段

> 来源：`docs/raw/_probe/chunks/{30,36,42,52,62,63,83}.js` + `app.js`（webpack 压缩产物）。
> 目标库 Doris，**无外键约束，关系靠应用层维护**。
>
> **类型列纪律**：压缩代码里没有类型声明，所以⚠️ 标记的类型是我从字段名、
> 渲染方式（`toLocaleString()` / `ratioDisplay()` / 日期格式化）推断的，不是看到的。
> 字段名本身是直接看到的，不标记。

## 目录

- §1 广告层级实体（基础实体）
- §2 时序快照实体
- §3 关系实体
- §4 枚举字典
- §5 用户产生数据（系统表范畴）
- §6 静态属性 vs 时序快照的划分
- §7 未能定型的字段

## 0. 层级总览（先看这个，与常识不同）

代码里的权威定义（`chunks/30.e24ae056.js @481008`，模块 `hfXk` 导出 `a`）：

```
投放小组(Product Ad)是亚马逊根据每个广告组(AdGroup)中投放变体的数量创建的
更小的广告单位，亚马逊投放广告时以变体为单位进行流量的分配与展示
```

```
ad_campaign          广告活动 Campaign
   │  (⚠️ AdGroup 层：素材完全未覆盖，不建表)
   └ ad_product_ad    投放小组 Product Ad  ← Sif 里的 adId 是这一层
        └ ad_product_ad_variant  投放变体（ad × asin）
             └ ad_search_term    广告搜索词（买家搜的词，非投放词）
```

**三条必须记住的事：**

1. **Sif 的 `adId` = Product Ad（投放小组），不是 Amazon AdGroup。**
   `/adxray-adgroup` 页面标题叫“查广告组”，内部字段全是 `adShowId`/`encryptAdId`/`fakeAdId`。
   `chunks/42 @93209` 更直接：`{adIdTotalNum}个广告组` —— 用 adId 计数却叫“广告组”。
2. **`ad_search_term` 存的是买家搜索词，不是投放词。**
   `chunks/42 @91486` 明确标注 `搜索词( 不是投放词 )`。投放词（keyword/targeting）
   在 Sif 里**无法直接获得**，只能推测。所以**不要建 `ad_keyword`（投放词）表** ——
   素材不支持。
3. **没有商品定向（Product Targeting）实体。**
   `/adxray-productTarget`（chunk 52）是个**查询视角**（给 campaign 查它命中的 ASIN），
   不是一个新实体。它复用 `asinAdCampaignView/*` 全部端点，没有独立字段集。

## 1. 基础实体

### 1.1 ad_campaign — 广告活动

**用途**：Sif 从亚马逊前台搜索结果页反向识别出的广告活动。
一个 campaign 属于一个卖家、一个站点，跑一种广告类型。

**字段表**

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `encryptCampaignId` | string ⚠️ | Sif 内部加密 ID，**建议做主键**。全域用它做请求参数和 `delete` 载荷的 `id` | `chunks/30 @164180` `conditions.encryptCampaignId`；`@173553` `{ads:[{id:e.encryptCampaignId}]}` |
| `fakeCampaignId` | string ⚠️ | 前台纯数字 ID（亚马逊前台暴露的那个）。UI 显示为 `广告活动ID：{fakeCampaignId}` | `chunks/30 @248556` 模板；`chunks/62` 文案 `前台纯数字ID：` |
| `campaignIdA0` | string ⚠️ | 后台 A 开头 ID，格式 `/^A[0-9a-zA-Z]+$/` | `chunks/30 @176266` `curActid=e.campaignIdA0`；`chunks/83 @1461` 正则 |
| `encryptCampaignIdA0` | string ⚠️ | A0 ID 的加密形式，随 `adDetail`/`adHistory` 请求发出 | `chunks/30 @202938` |
| `encryptCampaignIdNum` | string ⚠️ | 纯数字 ID 的加密形式，同上 | `chunks/30 @202938` |
| `fakeCampaignIdOrg` | string ⚠️ | `fakeCampaignId` 的“原始值”？用途未见 ⚠️ | `chunks/36 @93384` |
| `adType` | tinyint ⚠️ | 广告类型 1/2/3/4，见 §4.1。⚠️ 后端 number/string 不稳定（switch 同时匹配两种） | `chunks/30 @189854` `funAdType`；`@248556` `addClassType` |
| `campaignCreatedAt` | date ⚠️ | 广告活动创建时间。抽屉默认定位日期用它兜底 | `chunks/30 @202938` `this.activeDate = n \|\| e.campaignCreatedAt` |
| `campaignSeq` | int ⚠️ | 广告活动序号，用于配色 `adxrayColorFun(campaignSeq)` 和 `max()` 求总数。⚠️ 是否跨请求稳定未知 | `chunks/36 @93384`；`chunks/42 @82726` |
| `asinNum` | int ⚠️ | 该活动下投放的 ASIN 数量 | `chunks/30 @202938` `selectName.asinNum` |
| `adNum` | int ⚠️ | 该活动下投放小组数量 | `chunks/30 @248556` 模板 `t.adNum` |
| `strategy` | string ⚠️ | 投放策略。备注弹窗里 `curLaunch=e.strategy`，语义未明 ⚠️ | `chunks/30 @176266` |
| `country` | string ⚠️ | 站点码（US/AE/SA/…） | `chunks/62 @37190` `params.country`；`chunks/83` `extraInfo` 响应 `countrys[]` |
| `adStatus` | string ⚠️ | 状态，见值 `"ENABLED"`；`null` = 全部 | `chunks/62 @37190` `params.adStatus:"ENABLED"`，选项 `查看进行中的广告活动` |

**⚠️ 标记汇总**：全部字段类型均无代码证据。`campaignSeq` 语义、
`strategy` 语义、`fakeCampaignIdOrg` 用途三项进不确定清单。

**关系**
- 1 : N → `ad_product_ad`（应用层用 `encryptCampaignId` 关联）
- 1 : 1 (可选) → `sys_user_ad_note`（备注，见 §5）
- N : 1 → 站点字典（`country`）

---

### 1.2 ad_product_ad — 投放小组（Product Ad）

**用途**：亚马逊在一个 AdGroup 内按变体数量自动切分出的最小投放单元。
Sif 的流量归因就落在这一层。

**字段表**

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `encryptAdId` | string ⚠️ | Sif 内部加密 ID，**建议主键**。`adDetail`/`adHistory` 的请求键 | `chunks/30 @140100` `clickAdGroup` 取 `e.encryptAdId`；`@214664` |
| `adShowId` | string ⚠️ | 展示用 ID。⚠️ **chunk 36 全程用它，chunk 30 全程用 `encryptAdId`**，是否同物未知 | `chunks/36 @77660` `params.adShowId` / `paramsDetail.adShowId` |
| `fakeAdId` | string ⚠️ | 前台可见的投放小组标识，UI 直接显示 `投放小组{fakeAdId}` | `chunks/36 @124321`；`chunks/30 @140100` |
| `fakeAdIdOrg` | string ⚠️ | `fakeAdId` 的“原始值”？用途未见 ⚠️ | `chunks/36 @93384` |
| `encryptCampaignId` | string ⚠️ | **外键 → ad_campaign**（应用层维护） | `chunks/30 @215588` `getTitleList(encryptCampaignId, adType)` |
| `fakeCampaignId` | string ⚠️ | 冗余的父级前台 ID，UI 显示 `属于广告活动{fakeCampaignId}` | `chunks/36 @124321` |
| `adType` | tinyint ⚠️ | 广告类型，与父 campaign 一致（冗余） | `chunks/36 @93384` `leftDays.push({adType:t.adType})` |
| `adCreatedAt` | date ⚠️ | 投放小组创建时间。排序枚举有“按投放小组时间正/倒序” | `chunks/30 @462xx` 字段扫描；排序项 `X.c` value 3/4 |
| `asin` | string(10) ⚠️ | **投放的变体 ASIN**。⚠️ 单值，说明「一个投放小组对应一个变体」 | `chunks/36 @124321` `投放{t.asin}` |
| `img` | string ⚠️ | 变体主图 URL | `chunks/36 @124321` |
| `campaignSeq` | int ⚠️ | 继承父活动序号，用于同色 | `chunks/36 @93384` |
| `asinNum` | int ⚠️ | ⚠️ 与 `asin` 单值矛盾 —— 可能是父活动的 ASIN 数冗余下来 | `chunks/30 @202938` |

**关键观察（进 §6 讨论）**：`asin` 是**单值**（`投放{t.asin}`），
但 `adDetail` 响应里的 `asinFeatures[]` 是数组（`chunks/30 @216476`
`t.asinFeatures.map(e=>e.asin)`），且模板里有 `t.asins && t.asins.length>1` 分支
（`chunks/30 @149738`）。所以**投放小组 → 变体可能是 1:N 而非 1:1**，
与 Product Ad 的官方定义（按变体切分，应为 1:1）冲突。⚠️ 进不确定清单。

**关系**
- N : 1 → `ad_campaign`（`encryptCampaignId`）
- 1 : N → `ad_product_ad_variant`（若确认 1:N）
- 1 : N → `ad_product_ad_flow_daily`（时序，§2.1）

---

### 1.3 ad_product_ad_variant — 投放变体（关系兼实体）

**用途**：投放小组实际曝光到的变体 ASIN。`chunks/30 @149738` 模板对
`t.asins` 数组渲染缩略图列表，>1 时用 popover 展开。

**字段表**

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `encryptAdId` | string ⚠️ | 外键 → `ad_product_ad` | 由 `adAsins` 嵌套结构推得（`chunks/30 @149738` `t.row.adAsins` → 每项含 `fakeAdId` + `asins[]`） |
| `asin` | string(10) ⚠️ | 变体 ASIN | `chunks/30 @149738` `t.asins[0].asin` |
| `img` | string ⚠️ | 变体图 URL | 同处 `t.asins[0].img` |
| `features` | array\<string\> ⚠️ | 变体属性文案（Color/Size 之类），UI 用 `-` 和 `,` 拼接 | `chunks/42 @99576` `t.features` 循环；`chunks/30` 字段扫描 |

⚠️ 这张表的字段集是从**模板渲染结构**反推的，没有直接的接口响应证据。
`features` 是字符串数组还是对象数组不确定（chunk 42 里 `e._v(e._s(t))` 直接渲染，
倾向字符串数组）。

**关系**
- N : 1 → `ad_product_ad`
- N : 1 → 商品/Listing 实体（`asin`，属别的域）

---

### 1.4 ad_search_term — 广告搜索词

**用途**：**买家在亚马逊实际搜索的词**，Sif 观察到该 Listing 的广告在这个词下有曝光。
`chunks/42 @91486` 明确：`搜索词( 不是投放词 )`。

**字段表**

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `keyword` | string ⚠️ | 搜索词文本。**建议与 asin+时间口径共同做唯一键** | `chunks/42 @82726` `adName=e.keyword`；`chunks/30 @216476` `detailList[].keyword` |
| `asin` | string(10) ⚠️ | 归属的 Listing（父 ASIN 或变体） | `chunks/42 @65227` `params.asin` |
| `spScoreRatio` | decimal ⚠️ | 该词为 Listing 贡献的 SP 广告流量占比。**0~1 小数**（`>=1e-4` 才显示，否则 `<0.01%`） | `chunks/42 @56712` 渲染逻辑 + tooltip `贡献的{SP}广告曝光流量占比` |
| `estSearchesNum` | bigint ⚠️ | 预估搜索量 | `chunks/42 @56128` 列 prop；`chunks/30 @216476` |
| `searchesRank` | int ⚠️ | 搜索量排名 | `chunks/30 @216476` `detailList[].searchesRank` |
| `clickPurchaseRatio` | decimal ⚠️ | 点击转化率。表头注 `关键词下所有产品的平均点击转化率`，说明是**市场均值不是本品** | `chunks/30 @216476`；`chunks/42 @56128` 表头 `关键词转化率数据是 市场平均` |
| `purchaseVolume` | int ⚠️ | 购买量 | `chunks/30 @216476` |
| `campaignIdNum` | int ⚠️ | 该词下有曝光的广告活动数 | `chunks/42 @56128` prop + tooltip `所选时间区间内有曝光的广告活动数量` |
| `adIdNum` | int ⚠️ | 该词下有曝光的**投放小组**数（UI 叫“广告组”） | 同处，tooltip `所选时间区间内有曝光的广告组数量` |
| `variantNum` | int ⚠️ | 该词下有曝光的变体数 | 同处，tooltip `所选时间区间内有曝光的变体数量` |

**⚠️ 重要**：`campaignIdNum` / `adIdNum` / `variantNum` 是**按查询时间区间聚合出来的计数**，
不是搜索词的静态属性。它们随 `timePieceType` 变化 → 应归时序快照或视为查询结果派生值，
**不要存进静态维表**。

**关系**
- N : N → `ad_campaign`（通过曝光事实）
- N : N → `ad_product_ad`
- N : N → `ad_product_ad_variant`
- 上述三个 N:N 的事实表就是 §2.2

## 2. 时序快照实体

Sif 的时间粒度是 **week / month**（`granularity`），部分页面用
`timePieceType` + `latelyDay(7|30)|week|month`。**没有看到 day 粒度的广告数据**
（常量 `v={day,week,month}` 存在，但广告页 UI 只给了按周/按月）。

⚠️ 首页有“7天活跃广告活动”口径，跳转时会提示口径不一致
（`chunks/30 @167110`），说明**存在第三套按天口径但不在本域素材内**。

---

### 2.1 ad_campaign_flow_snapshot — 广告活动流量快照

**用途**：每个广告活动在每个时间片（周/月）拿到的广告流量得分。
主表 `campaigns[].flows[]` 与 `dates[]` 按下标对齐（`chunks/30 @177773`
`e.flows.forEach((t,a)=>{ e.flowsData.push(t && t.score || null) })`）。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `encryptCampaignId` | string ⚠️ | 外键 → `ad_campaign` | `chunks/30 @203302` `tableData=a.data.campaigns` |
| `stat_date` | date ⚠️ | 时间片起点，来自 `dates[]` 同下标 | `chunks/30 @203302` `e.dates=a.data.dates` |
| `granularity` | string ⚠️ | `"week"` / `"month"` | `chunks/30 @164180` `params.granularity` |
| `score` | decimal ⚠️ | 流量得分。UI 标 `流量(分)` / `流量：` —— **是分值不是绝对曝光量** | `chunks/30 @177773` `t.score`；文案 `流量(分)` |
| `ratio` | decimal ⚠️ | 流量占比。文案 `本期贡献的流量及占比` / `流量占比:` | `chunks/30 @237814` 区域字段扫描 `t.ratio` |
| `diffScore` | decimal ⚠️ | 相比上期变动值。文案 `相比上期变化及变化率` / `相比上期波动及变化率` | `chunks/30` 字段扫描 `e.diffScore` |
| `diffRatio` | decimal ⚠️ | 相比上期变化率 | 同处 `e.diffRatio` |
| `spScoreRatio` | decimal ⚠️ | SP 流量占比（该活动内） | `chunks/30 @237814` `t.spScoreRatio` |

**⚠️ 单位问题**：`score` 到底是什么量纲，代码里只有中文 `流量(分)` 和
`每个单元格总和为100%`（后者指占比矩阵）。**不是曝光次数，是 Sif 自己的评分**。
不要当曝光量用。

**关系**：N : 1 → `ad_campaign`；按 `(encryptCampaignId, stat_date, granularity)` 唯一。

---

### 2.2 ad_search_term_exposure_snapshot — 搜索词曝光快照

**用途**：某个搜索词在某时间片、某投放小组/变体上的曝光与排名。
这是本域最细的事实表，承载 §1.4 的三个 N:N 关系。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `keyword` | string ⚠️ | 搜索词 | `chunks/42 @82726` `paramsDetail.keyword` |
| `asin` | string(10) ⚠️ | 变体 ASIN | `chunks/42 @82726` `detailData[].asin` |
| `encryptAdId` / `fakeAdId` | string ⚠️ | 投放小组 | `chunks/42 @82726` `detailData[].fakeAdId` |
| `campaignSeq` | int ⚠️ | 所属活动序号（用于上色） | `chunks/42 @82726` `e.color=adxrayColorFun(e.campaignSeq)` |
| `stat_date` | date ⚠️ | 来自 `spHistory.date[]` | `chunks/42 @82726` `e.spHistory.date` |
| `rank` | int ⚠️ | SP 广告排名 | `chunks/42 @82726` `spHistory[k][].rankStr`；`chunks/30` 字段 `rank`/`ranks`/`rankStr` |
| `rankStr` | string ⚠️ | 排名的字符串形式，`,` 会被前端替换成 `:` → **说明原值是 `页,位` 形式** | `chunks/42 @82726` `i.rankStr=i.rankStr.replace(",",":")` |
| `recRanks` | int ⚠️ | 推荐位排名（SP 推荐 = `spRec`）。`chunks/30 @73076` 里 `recRanks` 单独成 series | `chunks/30 @73076` `_filterOptions` 判 `"recRanks"===e.field` |
| `recSpScoreList` | array ⚠️ | SP 推荐位得分序列 | `chunks/30 @73076` |

**⚠️ `spHistory` 的结构很特殊**（`chunks/42 @82726`）：
```js
e.spHistory.date            // 时间轴
Object.keys(e.spHistory)    // 除 "date" 外，每个 key 是一个变体
  → e.spHistory[变体key]    // 该变体在各时间点的 [{rankStr,...}]
```
即**变体 ASIN 被当成动态 key**，不是数组元素。入库要拆平。
表头注 `该排名趋势是将Listing下的所有变体在这个搜索词下获得的SP排名综合之后展示的趋势，
不同的颜色代表不同的变体。`

---

### 2.3 ad_search_volume_snapshot — 搜索量时序

**用途**：搜索词的搜索量历史。作为 `adDetail` 响应内嵌对象出现。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `keyword` | string ⚠️ | 搜索词 | `chunks/30 @216476` |
| `date` | array\<date\> ⚠️ | 时间轴数组 | `chunks/30 @216476` `t.estSearchesNumHistory.date` |
| `estSearchesNum` | array\<bigint\> ⚠️ | 与 date 同下标的搜索量 | `chunks/30 @216476` 同结构 |
| （派生）`endDate` | date | 前端取 `date[date.length-1]` | `chunks/30 @216476` `t.endDate=...` |

另有 `estSearchesNumHistoryPrev` —— **上一期的同结构对象**，用于同比。
文案 `同比+` / `同比-`（`chunks/63`）。⚠️ “上一期”是上周/上月还是去年同期不明；
chunk 63 有 `今年`/`去年`/`往年` + 常量 `v={year:"#009f52",lastYear:"#FF8C00"}`，
倾向**去年同期**，但那是 cpc 页面的配色，不能直接套到这里。

---

### 2.4 ad_type_daily_count — 各广告类型活动数快照

**用途**：概览统计条的四个数字。`adOverview`/`chart` 响应顶层字段。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `asin` | string(10) ⚠️ | 查询主体 | 请求参数 |
| `stat_date` | date ⚠️ | 时间片 | `dates[]` |
| `spNum` | int ⚠️ | SP 广告活动数 | `chunks/30 @203302`；`chunks/36 @93384` |
| `sbNum` | int ⚠️ | SB 数 | 同处 |
| `sbvNum` | int ⚠️ | SBV 数 | 同处 |
| `sbSbvNum` | int ⚠️ | SB+SBV 数（adType=4） | `chunks/30 @203302`（chunk 36 **没有**这个字段 ⚠️） |
| `adNum` | int ⚠️ | 投放小组总数 | `chunks/30 @203302` |
| `adCount` | int ⚠️ | ⚠️ 与 `adNum` 并存于不同页面，chunk 36 用 `adCount`，chunk 30 用 `adNum`。是否同义未知 | `chunks/36 @93384` `e.adCount=n.data.adCount` |
| `campaignTotal` | int ⚠️ | 广告活动总数 | `chunks/36 @93384` |
| `total` | int ⚠️ | 分页总数（不是业务计数） | 两处 |

⚠️ 这几个数**是否按时间片切分不确定** —— 它们出现在响应**顶层**而不是
`dates[]` 平行的数组里，看起来是**整个查询区间的汇总值**，
那就不该建成按日快照表，而应是查询结果的聚合视图。
文案 `所选时间区间内有曝光的广告活动数量` 支持“区间聚合”解读。
**建议：不建这张表，改为查询时聚合。** 进不确定清单。

---

### 2.5 ad_trace_back_config — 数据回溯起点

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `country` | string ⚠️ | 站点 | 推断（回溯时间应按站点不同） ⚠️ |
| `spTraceBackTime` | date ⚠️ | SP 数据最早日期 | `chunks/30 @203302`；`chunks/36 @93384` |
| `sbTraceBackTime` | date ⚠️ | SB 系（含 SB/SBV/SB+SBV）最早日期 | 同处；文案 `chunks/36 @120375` |

⚠️ 它随每次查询响应返回，可能是配置也可能是实时算出来的。
另有硬编码全局下限 `2022-04-27`（`chunks/30 @164180` `disabledDate`）。
**是否按站点变化没有证据**，`country` 字段是我加的。

## 3. 关系实体（应用层维护，Doris 无外键）

### 3.1 外键关系清单

| 子表 | 子表字段 | 父表 | 父表字段 | 证据 |
|---|---|---|---|---|
| `ad_product_ad` | `encryptCampaignId` | `ad_campaign` | `encryptCampaignId` | `chunks/30 @215588` `getTitleList(encryptCampaignId, adType)` 返回 `data.list[].ads[]` —— **campaign→ad 的嵌套结构直接证明了归属** |
| `ad_product_ad_variant` | `encryptAdId` | `ad_product_ad` | `encryptAdId` | `chunks/30 @149738` `t.row.adAsins[]` 每项 `{fakeAdId, asins:[{asin,img}]}` |
| `ad_campaign_flow_snapshot` | `encryptCampaignId` | `ad_campaign` | `encryptCampaignId` | `campaigns[].flows[]` 内嵌 |
| `ad_search_term_exposure_snapshot` | `encryptAdId` | `ad_product_ad` | `encryptAdId` | `chunks/42 @82726` `detailData[].fakeAdId` |
| `ad_search_term_exposure_snapshot` | `asin` | `ad_product_ad_variant` | `asin` | `spHistory` 动态 key |
| `sys_user_ad_note` | `encryptCampaignId` | `ad_campaign` | `encryptCampaignId` | `chunks/30 @174521` `upsert({type:"campaign", id:adAncryptCampaignId})` |

### 3.2 campaign ↔ ad 的嵌套响应结构（`campaignBrief` 或 `getTitleList`）

`chunks/30 @215588` 揭示了层级响应的确切形状：

```js
Object(V.j)({encryptCampaignId, granularity, adType, asin, isAsinSearch})
  .then(res => {
    optionsGroup = res.data.list          // 一层：分组
    optionsGroup.forEach(group => {
      group.ads.forEach(ad => {           // 二层：投放小组
        // ad.fakeAdId / ad.img / ad.asin / ad.asinNum / ad.adType / ad.encryptAdId
      })
    })
  })
```

⚠️ `V.j` 映射到 `/api/search/asinAdCampaignView/adList`。
`data.list[]` 的外层是什么（是 campaign 还是别的分组维度）**没有字段名证据** ——
外层对象除了 `ads` 数组，前端没读任何其他属性。进不确定清单。

### 3.3 主表行的嵌套结构（`chart` 响应 `campaigns[]`）

从 `chunks/30 @177773` `allBig()` 反推：

```js
campaigns[i] = {
  encryptCampaignId, fakeCampaignId, campaignIdA0, campaignName, campaignColor,
  campaignColorid, campaignIdA0Note, productType, adType, campaignCreatedAt,
  adNum, asinNum, strategy, spScoreRatio,
  ads:   { <key>: {...} },        // ⚠️ 对象不是数组，前端用 Object.entries 转
  flows: [ {score, ratio, ...}, … ], // 与顶层 dates[] 同下标
  adAsins: [ {fakeAdId, encryptAdId, asins:[{asin,img}]} , … ]
}
```

关键代码：
```js
e.ads = Object.entries(e.ads).map(([a,i]) => ({key:a, ...i}))
e.flowsData = []; e.flows.forEach(t => e.flowsData.push(t && t.score || null))
e.flowsDataMax = Math.max(...)
```

⚠️ `ads` 是**以某个 id 为 key 的对象**，key 是什么（`encryptAdId`? `fakeAdId`?）
无证据。`flows[]` 元素可为 `null`（空时间片）。

### 3.4 adOverview 的二维矩阵

`chunks/30 @159105`：
```js
const {date, overviews, ads} = chartData.data
data = overviews.map((e, t) => ({
  ...e,
  campaigns: ads.map(x => x[t]).filter(Boolean).reverse()
}))
// setPolarData: ads[n] 是一个 series，ads[n][i] = {score, fakeAdId, encryptAdId}
```

即 `ads` 是 **`[投放小组索引][时间点索引]` 的二维数组**，
`overviews` 是与 `date` 平行的概览数组。入库要按 `(encryptAdId, date)` 拆平。

## 4. 枚举字典

### 4.1 dict_ad_type — 广告类型（任务重点，代码内部值已核实）

**权威定义**：`chunks/30.e24ae056.js @481008`，模块 `hfXk` 导出 `d`（代码里 `X.d`）：
```js
{1:"SP", 2:"SB", 3:"SBV", 4:"SBBV"}
```

| code | 内部名 | UI 显示 | CSS class | 概览色 | 来源 |
|---|---|---|---|---|---|
| `1` | `SP` | `SP` | `adType` | `#009f52` | `hfXk` 导出 `d`；`@189854` `funAdType`；`@248556` `addClassType` |
| `2` | `SB` | `SB` | `sb_type` | `#b76e22` | 同上 |
| `3` | `SBV` | `SBV` | `sbv_type` | `#af6acd` | 同上 |
| `4` | `SBBV` | `SB+SBV` | `sbbv_type` | `#5b709f` | 同上 |

配色来自 `chunks/30 @162472` `canvasColors:["#009f52","#b76e22","#af6acd","#5b709f"]`
与 `@189854` 的 `case 3→"#af6acd"` / `case 4→"#5b709f"`。

筛选下拉版（`hfXk` 导出 `b`，**值是字符串**）：
```js
[{label:"全部",value:""},{label:"SP",value:"1"},{label:"SB",value:"2"},
 {label:"SBV",value:"3"},{label:"SB+SBV",value:"4"}]
```
消费时被转回 number：`params.conditions.adType = Number(this.filterType)`（`@172221`）。

⚠️ **`switch(e){case 1: case "1":}` 同时匹配 number 和 string**
（`funAdType` / `funAdTypeLook` / `addClassFun` / `addClassType` / `funEditBg` 五个函数都这么写）
→ **后端返回类型不稳定，入库必须统一。**

⚠️ **这套枚举里没有 SP常规 / SP推荐的区分**，见 §4.2。

派生映射（`chunks/30 @189854`）：
```js
funAdTypeLook: 1→"sp", 2→"sbv", 3→"sbv", 4→"sbv"   // ⚠️ 2/3/4 全塌成 sbv
funEditBg:     1→"text_ad", 2→"text_ad_sb", 3→"text_ad_sbv", 4→"text_ad_sbbv"
addClassFun:   1→"SP_color", 2→"SB_color", 3→"SBV_color", 4→"SBBV_color"
```
`funAdTypeLook` 把 SB/SBV/SBBV 全映成 `"sbv"`，用于选排名图配置 —— **不是业务分类**，
不要拿它当枚举。

---

### 4.2 dict_traffic_type — 流量类型（SP常规/SP推荐 在这里）

**来源**：`chunks/63.a6cfa9ac.js @79699`（模块导出 `q` = key 集，`c` = 中文名，
`k` = 去掉“流量”的短名）。

| code（字符串） | 中文名 | 短名 | 说明 |
|---|---|---|---|
| `total` | 全部流量 | 全部 | 自然 + 广告 |
| `nf` | 自然流量 | 自然 | Natural Flow |
| `ad` | 广告流量 | 广告 | 所有广告 |
| `allSp` | SP广告流量 | SP广告 | SP 汇总 |
| `sp` | **SP(常规)流量** | SP(常规) | ← **SP常规的代码值是 `"sp"`** |
| `spRec` | **SP(推荐)流量** | SP(推荐) | ← **SP推荐的代码值是 `"spRec"`** |
| `allSb` | SB广告流量 | SB广告 | SB 汇总 |
| `sb` | **SB(常规)流量** | SB(常规) | ← SB常规 = `"sb"` |
| `sbv` | SBV流量 | SBV | |

原文：
```js
w={total:"total",nf:"nf",ad:"ad",allSp:"allSp",sp:"sp",spRec:"spRec",
   allSb:"allSb",sb:"sb",sbv:"sbv"}
S={total:"全部流量",nf:"自然流量",ad:"广告流量",allSp:"SP广告流量",
   sp:"SP(常规)流量",spRec:"SP(推荐)流量",allSb:"SB广告流量",
   sb:"SB(常规)流量",sbv:"SBV流量"}
```

**任务重点答案**：
- SP常规 → `"sp"`
- SP推荐 → `"spRec"`
- SB常规 → `"sb"`
- SBV → `"sbv"`

**注意这与 §4.1 是两个正交维度**：`adType`(1-4) 描述广告活动是什么类型；
`trafficType`(字符串) 描述流量归到哪个渠道。建议**建两张枚举表**，
不要合并。查广告词页同时用到两者：`adTypeName[trafficType.sp]`（`chunks/42 @56128`）。

⚠️ `allSp` 是否等于 `sp + spRec`、`allSb` 是否等于 `sb + sbv` —— 无证据。

⚠️ 这个枚举定义在 **cpc chunk**（63）里，但被查广告词页（42）以 `z.q`/`z.c` 引用，
说明它在公共常量模块。SBBV（adType=4）在流量枚举里**没有对应项**。

---

### 4.3 dict_ad_sort — 排序方式

`chunks/30 @481008` 模块 `hfXk` 导出 `c`：

| value | label |
|---|---|
| `"1"` | 按广告活动时间倒序 |
| `"2"` | 按广告活动时间正序 |
| `"3"` | 按投放小组时间倒序 |
| `"4"` | 按投放小组时间正序 |
| `"5"` | 广告活动流量大到小 |
| `"6"` | 广告活动流量小到大 |

⚠️ 这 6 个值是 UI 层的，真正发给后端的是 `params.sortBy`（默认 `"campaign"`，
`flow` 排序时另有 `desc` 翻转逻辑）+ `desc`。**value 与 sortBy 的映射表没找到**。

---

### 4.4 dict_ad_group_by — 聚合粒度（查广告组页专有）

`chunks/36 @77660` `sortOptions`：

| value | label | 效果（`@91371`） |
|---|---|---|
| `"1"` | 以投放小组为单位 | `params.groupByCampaign = false` |
| `"2"` | 合并展示同一个广告活动 | `params.groupByCampaign = true` |

---

### 4.5 dict_granularity — 时间粒度

`chunks/63 @79699` 常量 `v = {day:"day", week:"week", month:"month"}`。
广告页 UI 只暴露 week/month（`chunks/30 @164676`
`options:[{groupid:"week",groupName:"按周"},{groupid:"month",groupName:"按月"}]`）。

查广告词页用另一套（`chunks/42 @65227`）：

| groupid | label | 对应参数 |
|---|---|---|
| `latelyDay7` | 最近7天 | `timePieceType:"latelyDay", latelyDay:7` |
| `latelyDay30` | 最近30天 | `timePieceType:"latelyDay", latelyDay:30` |
| `week` | 选择某周 | `timePieceType:"week", week:<值>` |
| `month` | 选择某月 | `timePieceType:"month", month:<值>` |

---

### 4.6 dict_match_type — 匹配模式（cpc）

`chunks/63 @79699` 常量 `g`：

| groupid | label | 备注 |
|---|---|---|
| `"0"` | 全部 | |
| `Exact` | 精准匹配 | |
| `Phrase` | 词组匹配 | |
| `AllMatch` | 广泛匹配 | ⚠️ **不是 `Broad`** |
| `sameNichId` | 相同市场筛选 | ⚠️ 不是匹配模式，混进来的筛选项；拼写疑为 `Niche` |

---

### 4.7 dict_bid_strategy — 竞价策略（cpc，6 组合）

两套命名并存。**排序键**（`chunks/63 @18866` `headType[].sort`）
vs **展示常量**（`@79699` 常量 `f[].type`）：

| sort（排序键） | type（展示） | 表头 | 短名 |
|---|---|---|---|
| `autoExact` | `autoForSales_exact` | 提升与降低/精准 | 提降·精准 |
| `autoPhrase` | `autoForSales_phrase` | 提升与降低/词组 | 提降·词组 |
| `autoBroad` | `autoForSales_broad` | 提升与降低/广泛 | 提降·广泛 |
| `legacyExact` | `legacyForSales_exact` | 仅降低/固定/精准 | 固定·精准 |
| `legacyPhrase` | `legacyForSales_phrase` | 仅降低/固定/词组 | 固定·词组 |
| `legacyBroad` | `legacyForSales_broad` | 仅降低/固定/广泛 | 固定·广泛 |

⚠️ **两列的对应关系是我按语义配的，代码里没有映射表。** 进不确定清单。

---

### 4.8 dict_cpc_task_type — 竞价任务类型

`chunks/63 @36718`（UI）+ `sureChoice`（接口）：

| UI `taskType` | UI 文案 | **接口 `type`** |
|---|---|---|
| `1` | 查询亚马逊自动推荐的广告词 | `0` |
| `2` | 手动输入关键词 | `1` |

原文：`Object(_.c)({type: 1==e.taskType ? 0 : 1, asin, keywords})`。
⚠️ **UI 值和接口值反向**，照抄会搞反。是否笔误无法判断。

---

### 4.9 dict_ad_status — 广告活动状态

`chunks/62 @37190` `optionsSel`：

| value | label |
|---|---|
| `"ENABLED"` | 查看进行中的广告活动 |
| `null` | 查看全部广告活动 |

⚠️ 只见到 `ENABLED` 一个具体值，其他状态（PAUSED/ARCHIVED 之类）**素材未覆盖**。

---

### 4.10 dict_product_type — 产品归属

| value | UI 变量值 | label |
|---|---|---|
| `"mine"` | `"1"` | 我的产品 |
| `"rival"` | `"2"` | 竞品 |

来源 `chunks/30 @174521` `productType:"1"==myProduct?"mine":"rival"`；
`chunks/62 @42952` `0===e ? "mine" : "rival"`；文案 `我的产品` / `竞品`。

---

### 4.11 dict_chart_mode — 图表模式（cpc）

`chunks/63 @79699` 常量 `y`：`[{type:"nfAd",name:"自然-广告"},
{type:"exposurePosition",name:"曝光位置"}]`

### 4.12 dict_word_frq_mode — 词频模式

`chunks/63 @79699` 常量 `_`：
`one`(只看1个单词的词频) / `two` / `three`

## 5. 用户产生数据（系统表范畴）

### 判断：adNote 属于用户产生数据，是系统表，不是业务数据

**结论明确，证据充分：**

1. **路径前缀是 `/api/user/`**，不是 `/api/search/`。本域所有业务查询走
   `/api/search/*`，adNote 全部 8 个端点走 `/api/user/*`。
   这是后端自己的模块划分。
2. **数据只对本人可见。** 输入框 placeholder 原文（`chunks/30`、`chunks/62 @37190`）：
   `请输入亚马逊后台广告活动名称，仅自己可见`。
   这排除了“共享业务字典”的可能。
3. **内容是用户手工录入的对应关系。** `idA0`（后台 A 开头 ID）、
   `name`（用户起的名字）、`colorid`（用户选的色）都不是爬取来的 —— 
   Sif 爬不到卖家后台。功能定位文案：`前台广告位溯源后台广告活动`。
4. **可增删改，有 CRUD 全套**（upsert/batchUpsert/updateByid/delete/batchUpdateColor/list），
   业务事实表不会长这样。
5. **有分页管理界面**（`/ad-multiNotes-view`，`管理已备注的广告活动`），
   典型的用户数据管理页。

**因此：`sys_user_ad_note` 归系统表 / 用户数据域，不进广告业务事实层。**
广告业务表里的 `campaignName` / `campaignColor` / `campaignColorid` /
`campaignIdA0Note` / `productType` 五个字段是**查询时 JOIN 出来的用户备注**，
不是 campaign 的固有属性 —— 证据：删除备注后前端只清这 5 个字段
（`chunks/30 @173553`），其余 campaign 字段不动。

---

### 5.1 sys_user_ad_note — 用户广告活动备注

**用途**：用户把「前台纯数字 ID」和「后台 A 开头 ID + 自己的活动名」手工对应起来，
并用背景色分类（`比如将相同的投放模式统一为同样的背景色`，`chunks/62 @60777`）。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `id` | bigint ⚠️ | 备注自增主键。`delete({ids:[e.id]})` / `batchUpdateColor({ids})` 用它 | `chunks/62 @39874`、`@40065` |
| `user_id` | bigint ⚠️ | 归属用户。⚠️ **前端不传，由 token 推导**，所以是我补的字段 | 推断（`仅自己可见` + `/api/user/` 前缀） |
| `type` | string ⚠️ | 备注对象类型。**见到的唯一值 `"campaign"`** | `chunks/30 @174521` `upsert({type:"campaign", …})` |
| `target_id` | string ⚠️ | 被备注对象 ID = `encryptCampaignId`。接口里参数名就叫 `id` | `chunks/30 @174521` `id:e.adAncryptCampaignId`（该值来自 `e.encryptCampaignId`，见 `@176266`） |
| `name` | string(200) ⚠️ | 用户起的活动名。⚠️ 长度限制不一致：架构页 40，管理页 `nameMaxLength:200` | `chunks/30 @174521`；`chunks/62 @37190` |
| `idA0` | string ⚠️ | 后台 A 开头 ID，`/^A[0-9a-zA-Z]+$/` | `chunks/83 @3391` `{idA0, name, colorid, country}` |
| `colorid` | int ⚠️ | 背景色 ID，外键 → 颜色池 | `chunks/30 @174521`；`chunks/62 @40065` |
| `country` | string ⚠️ | 站点。批量提交时逐行带 | `chunks/83 @3391` `country:e.selectValue` |
| `productType` | string ⚠️ | `"mine"` / `"rival"`，见 §4.10 | `chunks/30 @174521` |
| `created_at` | datetime ⚠️ | 备注时间。管理页表头有 `备注时间` 列 | `chunks/62 @60777` 静态表头 |

**⚠️ 关键不一致（必须裁决）**：
`delete` 的两种载荷指向同一路径但键不同：
```js
// 管理页 chunks/62 @39874
Object(g.a)({ ids: [e.id] })                       // e.id = 备注自增 id
// 架构页 chunks/30 @173553
Object(M.a)({ ads: [{ id: e.encryptCampaignId }] }) // 传的是 campaign id
```
两个 `id` 是**不同的东西**。要么后端兼容两种语义，要么其中一处是 bug。

**关系**
- N : 1 → `ad_campaign`（`target_id` → `encryptCampaignId`，应用层维护）
- N : 1 → `sys_ad_note_color`（`colorid`）
- N : 1 → 用户表（`user_id`）

---

### 5.2 sys_ad_note_color — 备注背景色池

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `id` | int ⚠️ | 色 ID，被 `colorid` 引用 | `chunks/30 @176266` `colors.findIndex(e=>e.id===colorId)` |
| `color` | string ⚠️ | 色值，见到的字面量 `"#7fda6a"` | `chunks/62 @41732` `colorBat="#7fda6a"` |

响应形状：`res.data.colors = [{id, color}, …]`
（`chunks/30 @176266`、`chunks/62 @38241`、`chunks/83 @416` 三处一致）。

⚠️ **接口路径未定位。** 调用点是 `Object(M.w)()` / `Object(g.w)()` / `Object(h.w)()`，
但该导出对应的路径不在 `docs/raw/domains/ads.txt` 里，我在本域素材中没找到。
可能属于用户配置域。进不确定清单。

`colorShow(e)` 用 `this.colorList[e-1].color` 取色（`chunks/62 @41732`）
→ **`colorid` 从 1 开始且连续**，是数组下标 +1。

---

### 5.3 cpc 竞价查询任务（也是用户产生数据）

`/api/search/cpc/*` 虽然在 `/api/search/` 下，但 create/deleteTask/refreshTaskStatus
是**用户创建的异步任务**，消耗积分（`role_integral_limit`），属用户数据。

#### sys_user_cpc_task — 竞价查询任务

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `id` | bigint ⚠️ | 任务 ID。`detail({id})` / `refreshTaskStatus({id})` 的键 | `chunks/63 @18866` `paramsDetail.id=e.searchTimes[0].id` |
| `asin` | string(10) ⚠️ | 查询的 ASIN | `chunks/63 @14176` |
| `type` | tinyint ⚠️ | `0`=自动推荐，`1`=手动关键词（见 §4.8 反向映射） | `sureChoice` 的 `type:1==taskType?0:1` |
| `createdAt` | datetime ⚠️ | 创建时间。填“查询时间”下拉的 label | `chunks/63 @18866` `sortOptions.push({groupid:e.id, groupName:e.createdAt})` |
| `finish` | boolean ⚠️ | 是否完成。为真才显示 `再次查询/查看/删除` | `chunks/63 @35755` `t.finish?…:…` |
| `waitingTime` | int ⚠️ | 预计等待秒数，UI `预计{waitingTime}秒后返回结果` | `chunks/63 @35755` |
| `lastKeywords` | array\<string\> ⚠️ | 上次查询的关键词，"再次查询"时回填 | `chunks/63 @14176` `e.lastKeywords.join(",")` |
| `user_id` | bigint ⚠️ | 归属用户（前端不传，token 推导）⚠️ | 推断 |

**⚠️ 一个 ASIN 可以有多个任务**（多次查询）：
`asinTaskList({asin})` → `data.tasks[]`，文案 `的多次查询历史` / `对比多次查询`。
主表行里也有 `searchTimes[]`（`chunks/63 @35755` `t.searchTimes.length>3` 才显示"查看更多"）。
所以 `ad_cpc_task` 是 `asin` 的 1:N。

#### ad_cpc_suggested_bid — 建议竞价结果（业务数据）

⚠️ **字段集素材未覆盖。** 只知道：
- `detail({id, adType:"sp", granularity, searchKeyword, pageNum, pageSize, sortBy, desc})`
  返回 `{keywords:[], total, globalKeywordNum}`（`chunks/63 @19967`）
- 每个 keyword 有 6 个竞价值（§4.7 的 6 种策略×匹配组合），因为表头是 6 列
- `globalKeywordNum` 缺省兜底 `1e6`

具体每列的字段名**没有 prop 定义**（chunk 63 的 `prop:"…"` 提取结果为空，
表格是手写 `<table>` 不是 el-table）。进不确定清单。

## 6. 静态属性 vs 时序快照的划分（任务重点 3）

### 6.1 广告结构静态属性（一个实体一行，随时间基本不变）

| 实体 | 静态字段 | 判据 |
|---|---|---|
| `ad_campaign` | `encryptCampaignId`, `fakeCampaignId`, `campaignIdA0`, `encryptCampaignIdA0`, `encryptCampaignIdNum`, `adType`, `campaignCreatedAt`, `country` | 都是身份标识或创建时确定的属性 |
| `ad_product_ad` | `encryptAdId`, `adShowId`, `fakeAdId`, `encryptCampaignId`, `adType`, `adCreatedAt`, `asin`, `img` | 同上；`img` 会变但不是广告数据 |
| `ad_product_ad_variant` | `encryptAdId`, `asin`, `features` | 变体属性 |
| `ad_search_term` | `keyword` | 词本身 |

**注意 `adType` 冗余在 campaign 和 ad 两层**（`chunks/36 @93384` `leftDays` 同时带
`adType` 和 `fakeCampaignId`）。理论上 ad 继承 campaign，但两层都返回了 —— 
建议 ad 层保留冗余字段以避免 JOIN（Doris 场景合理）。

### 6.2 按日/按时变化的投放数据快照

| 快照实体 | 变化字段 | 时间键 | 判据 |
|---|---|---|---|
| `ad_campaign_flow_snapshot` | `score`, `ratio`, `diffScore`, `diffRatio`, `spScoreRatio` | `stat_date` + `granularity` | `campaigns[].flows[]` 与顶层 `dates[]` 同下标（`chunks/30 @177773`） |
| `ad_search_term_exposure_snapshot` | `rank`, `rankStr`, `recRanks` | `stat_date` | `spHistory.date[]` 平行数组（`chunks/42 @82726`） |
| `ad_search_volume_snapshot` | `estSearchesNum` | `date` | `estSearchesNumHistory.{date[],estSearchesNum[]}` |
| `ad_product_ad_history` | ⚠️ 字段未知 | `ts` | `chunks/36 @93384` `t.history.forEach(e => …[e[0], e[1]])` → **二元组 `[时间, 值]`**，值语义取决于 `radioClass`（SP广告词数量 / SP广告流量） |

### 6.3 归类困难的三类（需要裁决）

**(a) 区间聚合计数 —— 不是快照，是查询结果**

`spNum` / `sbNum` / `sbvNum` / `sbSbvNum` / `adNum` / `adCount` / `campaignTotal` /
`campaignIdNum` / `adIdNum` / `variantNum` / `campaignIdTotalNum` / `adIdTotalNum` /
`variantTotalNum`。

判据：这些字段在响应**顶层**（不与 `dates[]` 平行），且所有 tooltip 都写
`所选时间区间内有曝光的…数量`（`chunks/42 @56128` 三处）。
**它们是 GROUP BY 出来的，不该落表。** 建议查询时聚合，见 §2.4 的建议。

**(b) `clickPurchaseRatio` —— 市场均值不是本品指标**

表头注 `关键词下所有产品的平均点击转化率`（`chunks/30 @216476` 附近）
+ `关键词转化率数据是 市场平均`（`chunks/42 @56128`）。
所以它是**搜索词的属性**（该词下全市场均值），不是 `(asin, keyword)` 的属性。
应挂在 `ad_search_term` 或关键词域，**不要按 ASIN 存**。

**(c) `estSearchesNumHistoryPrev` —— 同比基线**

`chunks/30 @216476` 与 `estSearchesNumHistory` 并列返回。是**上一期还是去年同期**没有证据。
若是去年同期，则不需要单独存（同一张时序表查历史即可）；
若是"上一个等长区间"，也是派生值。**建议不落表。**

### 6.4 Doris 建表倾向（我的建议，供裁决）

```
维表（低频变化，Unique Key）
  ad_campaign            UNIQUE KEY(encryptCampaignId)
  ad_product_ad          UNIQUE KEY(encryptAdId)
  ad_product_ad_variant  UNIQUE KEY(encryptAdId, asin)
  ad_search_term         UNIQUE KEY(keyword, country)      ⚠️ country 是我加的

事实表（Aggregate 或 Duplicate Key，按时间分区）
  ad_campaign_flow_snapshot            (encryptCampaignId, stat_date, granularity)
  ad_search_term_exposure_snapshot     (keyword, asin, encryptAdId, stat_date)
  ad_search_volume_snapshot            (keyword, stat_date)
  ad_product_ad_history                (encryptAdId, stat_date, metric_type)  ⚠️ metric_type 是我加的

系统表（用户数据）
  sys_user_ad_note       UNIQUE KEY(user_id, type, target_id)   ⚠️ 唯一性约束是我推的
  sys_ad_note_color      UNIQUE KEY(id)
  sys_user_cpc_task      UNIQUE KEY(id)

不建
  ad_group（AdGroup）    —— 素材完全未覆盖
  ad_keyword（投放词）    —— Sif 拿不到，只能推测
  ad_product_target      —— 是查询视角不是实体
  ad_type_daily_count    —— 区间聚合，查询时算
```

## 7. 未能定型的字段（进不确定清单）

| 字段/结构 | 问题 |
|---|---|
| `adShowId` vs `encryptAdId` | chunk 36 用前者、chunk 30 用后者，是否同物无证据。若不同则 `ad_product_ad` 要两个 ID 列 |
| `adNum` vs `adCount` | 两页各用一个，是否同义未知 |
| `fakeAdIdOrg` / `fakeCampaignIdOrg` | `Org` 后缀语义，前端只 push 进 `leftDays` 未渲染 |
| `campaignSeq` | 是结果集内序号还是稳定 ID？跨请求是否一致？ |
| `strategy` | 备注弹窗读 `curLaunch=e.strategy`，值域完全未知 |
| `campaigns[].ads` 的 object key | 是 `encryptAdId` 还是 `fakeAdId`？（`Object.entries` 只取 value） |
| `adList` 响应 `data.list[]` 外层 | 除 `ads` 数组外前端不读任何属性，外层是什么维度未知 |
| `score` 量纲 | 只知道 UI 叫 `流量(分)`，不是曝光量。评分算法无从得知 |
| `spHistory` 动态 key | key 是变体 ASIN？还是变体序号？`Object.keys` 排除 `"date"` 后未做校验 |
| `features` 元素类型 | 字符串数组 or 对象数组，两处渲染方式不一致 |
| `ad_product_ad.asin` 基数 | 单值（`投放{t.asin}`）vs `asins[].length>1` 分支，1:1 还是 1:N |
| 颜色池接口路径 | `M.w`/`g.w`/`h.w` 对应路径不在本域清单内 |
| `adNote/delete` 双载荷 | `{ids:[备注id]}` vs `{ads:[{id:campaignId}]}`，语义冲突 |
| `adNote/updateByid` | 无调用点，与 `upsert` 区别不明 |
| `name` 长度 | 40（架构页）vs 200（管理页） |
| `adStatus` 值域 | 只见 `"ENABLED"` 和 `null` |
| cpc `type` 反向映射 | `1==taskType?0:1`，笔误还是设计 |
| cpc 竞价 6 列字段名 | 手写 table 无 prop，字段名全未知 |
| `dict_bid_strategy` 两套命名映射 | `autoExact` ↔ `autoForSales_exact` 无代码映射表 |
| `sameNichId` | 混在匹配模式枚举里，语义+拼写皆可疑 |
| `allSp` / `allSb` | 是否等于各分项之和 |
| `estSearchesNumHistoryPrev` | "上一期"的定义 |
| `spTraceBackTime` 是否按站点 | 随查询响应返回，是配置还是实时计算 |
| SBBV（adType=4）语义 | `SB+SBV` 是并集还是独立类型 |
| 按天口径 | 首页"7天活跃广告活动"用的口径不在本域素材内 |
| `/api/search/adCampaignView` | 与 `asinAdCampaignView/*` 的关系，无调用点 |
| `/api/search/focusKeywords/cpcCategory` | 在查广告架构页被引用，用途不明 |









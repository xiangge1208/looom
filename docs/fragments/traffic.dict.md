# 查流量结构域 — 数据字典片段

> 素材：webpack 压缩前端产物。字段名是**直接看到的**；类型列是我从"该字段被怎么用"反推的
> （格式化函数、比较运算、解构位置），每条都给了推断依据；只有真正零证据的才标 ⚠️。
>
> 主证据文件：
> - `docs/raw/_probe/chunks/35.e6a6f4aa.js` — `/search` 查流量结构页
> - `docs/raw/_probe/chunks/34.0c5a7c92.js` — 同组件 + `/compare-structure`
> - `docs/raw/_probe/chunks/3.ba8c09db.js` — API 封装模块 `cIs/`
> - `docs/raw/_probe/app.js` — 颜色/枚举常量模块 `+n12`

## 0. 全域建模约定

### 0.1 country 必须进主键

沿用 `_common.spec.md` 结论：拦截器强制给所有请求追加 `country`，支持 13 个站点
（`US UK DE FR IT ES JP CA MX AU AE SA BR`）。**本域所有表都带 `country CHAR(2)` 且进 Unique Key。**

### 0.2 时间切片主键

协调方实测确认：`timePieceType` 只有 `month` / `week` 两种，无日粒度。
- `month` → `timePieceValue` 格式 `YYYY-MM`
- `week` → `timePieceValue` 格式 `YYYY-MM-DD_YYYY-MM-DD`

时序快照表主键统一：`(asin, country, time_piece_type, time_piece_value)`。

> ⚠️ **与代码证据冲突，需主 Agent 裁决**：前端 chunk 里明确存在第三种取值 `latelyDay`。
> `34.0c5a7c92.js` 初始 state：`params:{timePieceType:"latelyDay",timePieceValue:"7",...}`，
> 粒度下拉 4 项：`latelyDay7`=最近7天、`latelyDay30`=最近30天、`week`=选择某周、`month`=选择某月，
> 且 URL 回填分支 `piece=latelyDay && date=7|30` 存在（`@186071`）。
> 可能是「前端仍带 latelyDay，但后端已收敛为 month/week」或「实测样本未覆盖」。
> 建表按实测的 month/week 走，但 `time_piece_type` 字段**留 `latelyDay` 的取值空间**，不要建成 2 值 ENUM。

### 0.3 命名清理

原站有拼写错误，复刻建议纠正并在映射层处理：

| 原站字段 | 建议字段 | 说明 |
|---|---|---|
| `vaiantsNum` | `variants_num` | 原站漏了 `r` |
| `nkVaiantsNum` | `nk_variants_num` | 同上 |
| `vedio` / `vedioBest` / `vedioRatio` | `sbv` / `sbv_best` / `sbv_ratio` | 原站把 video 拼成 vedio，全站一致地错 |
| `brandVedio` | `sb_all` | 语义是「SB 全部（常规+视频）」，不是"品牌视频" |
| `spRec` | `sp_all` | 语义是「SP 全部（常规+推荐）」 |

> 注意 `spRec` 与 `rec` 的坑：`spRec` = SP 全部，`rec` = SP(推荐)。
> 但埋点映射里 `spRec→spAd/spAll`、`rec→spRecommend`，`trafficType` 映射里 `spRec→allSp`、`rec→spRec`。
> **同一个字符串 `spRec` 在两个上下文里含义相反**，复刻务必改名。

---

## 1. 基础实体

### 1.1 `dim_asin` — ASIN 基础维度

用途：被查询的产品主体。本域只用到很薄的一层，完整定义应以其他域为准，这里只登记本域可见字段。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `asin` | CHAR(10) | 亚马逊 ASIN。长度由校验正则确定 | `34.0c5a7c92.js > /^[A-Z0-9a-z]{10}$/.test(searchValue)` |
| `country` | CHAR(2) | 站点代码 | 全局拦截器注入，`_common.spec.md` |
| `img` | VARCHAR | 主图 URL，表格里直接 `<img :src="row.img">` | `34.0c5a7c92.js > attrs:{src:n.img}`（区块 D 表格） |
| `is_parent_asin` | BOOLEAN | 是否父体。响应 `data.isParentAsin` 直接赋给同名布尔 state 并作条件传参 | `34.0c5a7c92.js > e.isParentAsin=n.data.isParentAsin` |
| `pasin` | CHAR(10) | 父 ASIN。字段名见 `pasinBoughtHistory`（父体销量历史）与图表组件 `update:pasin` | `34.0c5a7c92.js > t.pasinBoughtHistory` |

关系：`dim_asin 1 —— N dim_asin_variant`（父体带多个子体）；
被 §2 所有时序快照表按 `(asin, country)` 引用。

### 1.2 `dim_asin_variant` — 变体 / 属性维度

用途：区块 D、E 的行主体。**同一张表承载两种粒度**：`dimension="asin"` 时一行 = 一个子体 ASIN；
`dimension="color"|"size"|…` 时一行 = 一个属性取值（如 Color=Red 聚合）。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `asin` | CHAR(10) | 所属父体 / 查询主体 | 请求参数 `asin` |
| `country` | CHAR(2) | 站点 | 拦截器 |
| `dimension` | VARCHAR(32) | 维度代码，见枚举 §4.5。`asin` 或属性 code | `34.0c5a7c92.js > paramsEgg.dimension`；`features[].code` |
| `dim_value` | VARCHAR | 维度取值。区块 D 表格里就是 `row.val`，`dimension=asin` 时是子体 ASIN，否则是属性值 | `34.0c5a7c92.js > e._s(n.val)` 与 `#序号-{{t.val\|\|"-"}}` |
| `variant_asin` | CHAR(10) | 子体 ASIN。列 prop 名 | `34.0c5a7c92.js > prop:"variantAsin"` |
| `img` | VARCHAR | 变体主图 | 同上，`n.img` |
| `features` | ARRAY&lt;VARCHAR&gt; | 变体特征标签数组。模板 `v-for` 遍历并用 `\|` 分隔；`features.length-1` 判末项 → **确定是数组** | `34.0c5a7c92.js > e._l(n.features,(t,i)=>...i!==n.features.length-1` |
| `color` | VARCHAR | ⚠️ 仅从 `hideDimensionList:["color","size"]` 与堆积图 `li` 的 `background:t.color` 反推存在；后者可能是图表配色而非商品颜色，**两处同名不同义的风险** | `34.0c5a7c92.js > hideDimensionList` / `style:{background:t.color}` |

关系：`dim_asin_variant N —— 1 dim_asin`；被 `fact_listing_score_chart` 与 `fact_asin_traffic_summary` 按 `dim_value` 引用。

### 1.3 `dim_recommend_column` — 推荐专栏维度

用途：区块 C 第三块「推荐专栏流量分布」的行主体。亚马逊详情页/搜索页的推荐位板块。
**关键特征：这是开放集合，接口返回的 key 就是专栏英文标题本身，不是 id。**

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `rec_title` | VARCHAR(64) | 专栏英文标题，主键。既是 `data.recommend` 的 object key，也是 `recTitle` 字段名 | `app.js > "+n12"` 颜色表 `O` 的 key；`P.setRecColor` 内 `t.recTitle` |
| `rec_title_lower` | VARCHAR(64) | 小写化标题。前端建了一份全小写索引做大小写不敏感匹配 → 说明**接口返回的大小写不稳定** | `app.js > A=Object.fromEntries(Object.keys(O).map(([n,r])=>[n.toLowerCase(),r]))` |
| `color` | CHAR(7) | 前端配色，非业务字段。已知 13 个专栏有固定色，未知专栏从备用色池取 | `app.js > "+n12" O` 与 `P.getOtherRecColor()` |

已知的 13 个专栏见 §4.2。关系：`dim_recommend_column 1 —— N fact_asin_flow_overview`（按 rec_title 展开）。

---

## 2. 时序快照实体

四张表分别对应四个接口。**都是「某 ASIN 在某时间切片下的一份快照」**，无自增主键，
建议 Doris Unique Key 模型，主键含 `(asin, country, time_piece_type, time_piece_value)`。

### 2.1 `fact_asin_traffic_summary` — 变体流量词/流量分明细（区块 E）

来源接口：`/api/struct/asinSummary`，响应 `data.asins[]`。
用途：Listing 下每个变体（或属性）在各流量渠道上的**流量词数量**或**流量得分**。

主键：`(asin, country, time_piece_type, time_piece_value, dimension, dim_value, show_type)`

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `asin` | CHAR(10) | 行主体 ASIN | `row.asin`（表格 `t.row.asin`，并用于 `reverse` 跳转 query） |
| `country` | CHAR(2) | 站点 | 拦截器 |
| `time_piece_type` | VARCHAR(16) | 时间粒度，见 §4.6 | 请求参数 `timePieceType` |
| `time_piece_value` | VARCHAR(32) | 时间值 | 请求参数 `timePieceValue` |
| `show_type` | TINYINT | `1`=流量词口径 / `2`=流量分口径。**同一行在两种口径下数值不同**，故进主键 | `params.showType=1*flowStructureValue`，`flowStructureOption:[{label:"流量词",value:"1"},{label:"流量分",value:"2"}]` |
| `dimension` | VARCHAR(32) | 聚合维度 | 请求参数 `dimension`；`row.dimension` 也存在 |
| `total` | BIGINT | 全部流量（词数或得分）。口径：`全部流量 = 自然流量 + 广告流量`，词口径下是**去重后**数量 | 列头 popover 原文；`row.total` |
| `natural` | BIGINT | 自然流量。`指通过自然搜索带来曝光流量的搜索词` / `指自然搜索的曝光流量` | `row.natural`，`sortEnum.natural` |
| `ad` | BIGINT | 广告流量。`广告流量 = SP广告流量 + SB广告流量` | `row.ad` |
| `sp_all` | BIGINT | SP 全部（常规+推荐，去重）。原名 `spRec` | `row.spRec` |
| `sp` | BIGINT | SP(常规) | `row.sp` |
| `sp_rec` | BIGINT | SP(推荐)。原名 `rec` | `row.rec` |
| `sb_all` | BIGINT | SB 全部（常规+SBV，去重）。原名 `brandVedio` | `row.brandVedio` |
| `sb` | BIGINT | SB(常规)。原名 `brand` | `row.brand` |
| `sbv` | BIGINT | SBV。原名 `vedio` | `row.vedio` |
| `ac` | BIGINT | AC 推荐词数。仅 `dimension=asin` 或对比模式+词口径时展示 | `row.ac`，`sortEnum.ac` |
| `natural_ratio` | DECIMAL(9,6) | 自然流量占比。0..1 小数：显示时走 `getRatioValue()`，且 popover 直接拼接 `占比为{spRatio}` | `row.naturalRatio` |
| `ad_ratio` | DECIMAL(9,6) | 广告流量占比 | `row.adRatio` |
| `sp_all_ratio` | DECIMAL(9,6) | 原名 `spRecRatio` | `row.spRecRatio` |
| `sp_ratio` | DECIMAL(9,6) | | `row.spRatio` |
| `sp_rec_ratio` | DECIMAL(9,6) | 原名 `recRatio` | `row.recRatio` |
| `sb_all_ratio` | DECIMAL(9,6) | 原名 `brandVedioRatio` | `row.brandVedioRatio` |
| `sb_ratio` | DECIMAL(9,6) | 原名 `brandRatio` | `row.brandRatio` |
| `sbv_ratio` | DECIMAL(9,6) | 原名 `vedioRatio` | `row.vedioRatio` |
| `total_best` | BOOLEAN | 该指标是否为 Listing 内最优（渲染皇冠图标 `isShowCrown`） | `row.totalBest` → `CrownCell items:{isShowCrown:...}` |
| `natural_best` … `vedio_best` | BOOLEAN | 同上，9 个渠道各一个 `*Best` | `row.naturalBest/adBest/spRecBest/spBest/recBest/brandVedioBest/brandBest/vedioBest/acBest` |
| `flow_resources` | JSON / MAP&lt;VARCHAR,BOOLEAN&gt; | 流量来源命中标记。子组件按 `trafficSources.natural/sp/sb/sbv/bs/rec/deal` 逐个取真假决定徽章高亮 → **是对象而非数组** | `row.flowResources` → `<TrafficSource :trafficSources="...">`，组件内 `trafficSources.deal ? color : "#C5C5C5"` |
| `is_focus` | BOOLEAN | 是否已加关注 | `row.isFocus`，`this.tableData[i].isFocus=true` |

不入库的前端态：`row.checked`（多选框，`forEach(e=>e.checked=!1)` 初始化）。

同接口的表级（非行级）响应字段，建议单独一张汇总表或作为查询返回的 meta：

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `total` | BIGINT | 总行数，喂分页器 `:total` | `data.total` |
| `variants_num` | INT | 变体数。原名 `vaiantsNum` | `data.vaiantsNum\|\|0` |
| `nk_variants_num` | INT | ⚠️ 语义未知（`nk` 前缀无处可查），仅知是数值且默认 0 | `data.nkVaiantsNum\|\|0` |
| `is_parent_asin` | BOOLEAN | 查询的是否父体 | `data.isParentAsin` |
| `bought_month` | VARCHAR | 销量迷你图里要高亮的月份。前端拿它在 `boughtHistoryDates` 里 `indexOf` 定位，把该点染成 `#d95140` | `data.boughtMonth` |

⚠️ `boughtHistory` / `pasinBoughtHistory` / `boughtHistoryDates`（行级数组）属销量域，本片段只登记不定义。

关系：`N —— 1 dim_asin`（按 asin+country）；`N —— 1 dim_asin_variant`。

### 2.2 `fact_asin_traffic_agg` — Listing 流量词汇总（区块 B）

来源接口：`/api/struct/asinSummaryAgg`，响应 `data`（**单个对象，非数组**）。
用途：整个 Listing（父体层面）的 9 个渠道流量词总数，画三组柱状图。

主键：`(asin, country, time_piece_type, time_piece_value)`

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `asin` / `country` / `time_piece_*` | 同上 | 请求参数 `searchValue`（type=1）或 `searchKeyword`（type=2） | `paramsAgg` |
| `search_type` | TINYINT | `1`=按 ASIN 查 / `2`=按关键词查 | `paramsAgg.type=1\|2` |
| `total` | BIGINT | Listing全部流量词(去重) | `allData.total`，柱标题 |
| `natural` | BIGINT | 自然流量词 | `allData.natural` |
| `ad` | BIGINT | 广告流量词 | `allData.ad` |
| `sp_all` | BIGINT | SP全部流量词（去重）。原名 `spRec` | `allData.spRec` |
| `sp` | BIGINT | SP(常规)流量词 | `allData.sp` |
| `sp_rec` | BIGINT | SP(推荐专栏)流量词。原名 `rec` | `allData.rec` |
| `sb_all` | BIGINT | SB全部流量词（去重）。原名 `brandVedio` | `allData.brandVedio` |
| `sb` | BIGINT | SB(常规)流量词。原名 `brand` | `allData.brand` |
| `sbv` | BIGINT | SBV流量词。原名 `vedio` | `allData.vedio` |

访问控制：本表数据仅 `vipLevel ∈ {high, shark}` 可见，前端连请求都不发。
`total` 同时作为三组柱图共同的 `maxValue` 基准（`maxValue = allData.total`）。

关系：与 `fact_asin_traffic_summary` 是同一套 9 个渠道指标的「Listing 汇总」视角
（⚠️ 是否严格等于明细表纵向求和无法证明，见 spec 不确定项 13）。

### 2.3 `fact_asin_flow_overview` — 流量分布总览（区块 C 三块图）

来源接口：`/api/struct/asinFlowOverview`。**响应是三层嵌套，且第三层是开放 key**，
建议拍平成一张长表：一行 = 一个 (ASIN, 时间切片, 渠道)。

主键：`(asin, country, time_piece_type, time_piece_value, block, channel_code)`

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `asin` / `country` / `time_piece_*` | 同上 | 请求参数 | `{timePieceType, timePieceValue, asin, isListingSearch:true, supplementResult:true}` |
| `block` | VARCHAR(16) | 所属区块：`overview` / `ad` / `recommend`。对应响应三个顶层 key | `c.overview, c.ad, c.recommend` |
| `channel_code` | VARCHAR(64) | 渠道代码。`block=overview` 时 `nf\|ad`；`block=ad` 时 `sp\|sb\|sbv\|recommend`；`block=recommend` 时是专栏标题 | `u.nf, u.ad, p.sp, p.sb, p.sbv, p.recommend` |
| `name` | VARCHAR(64) | 展示名。模板直接 `{{n.name}}` 且 `title=n.name` → **是接口下发的展示文案，不是前端映射** | `34.0c5a7c92.js > a("span",{attrs:{title:n.name}},[e._v(e._s(n.name))])` |
| `score` | BIGINT | 流量得分。**接口返回，非前端计算**。用于条内数字、排序、以及 `ad.score>0` 的显隐判断 | `handleFormatThousand(n.score)`；`v.score>0`；`sort((a,b)=>b[1].score-a[1].score)` |
| `ratio` | DECIMAL(9,6) | 占比原始值，0..1 小数。条宽 = `ratio/maxRatio*100%`；空判 `null===ad.ratio` → **可为 NULL** | `parseFloat(100*(n.ratio/t.maxRatio\|\|0)).toFixed(2)+"%"`；`verifyEmpty` 判 null |

响应原始结构（`34.0c5a7c92.js @210130` 解构原文）：
```
data.overview.nf        → 块1「Listing自然-广告流量分布」左项
data.overview.ad        → 块1 右项
data.ad.sp              → 块2「广告流量分布」SP(常规)
data.ad.recommend       → 块2 SP(推荐)，前端 key 重命名为 recAd
data.ad.sb              → 块2 SB(常规)
data.ad.sbv             → 块2 SBV
data.recommend.{title}  → 块3「推荐专栏流量分布」，key 为专栏标题，按 score 降序
```

不入库的派生字段（前端算）：`ratioPercent`、`ratioDisplay`（`7VAF.b` 最大余额法整数化）、
`maxRatio`（每块内 `max(ratio)`）。

关系：`block=recommend` 的行 `N —— 1 dim_recommend_column`（按 `rec_title`）。

### 2.4 `fact_listing_score_chart` — 流量结构分渠道占比（区块 D）

来源接口：`/api/struct/listingscore/chart`，响应 `data.chars`。
**结构特殊：`chars` 是「列式」而非行式** —— 7 个平行数组，按下标对齐。

`data.chars` 的 7 个 key（`34.0c5a7c92.js @194488` 与表格模板逐一取用）：

| chars key | 含义 | 取用处 |
|---|---|---|
| `dims` | 行维度信息（行头）。`formatChars(chars).dims` 直接赋给 `leftDays` | `e.leftDays=formatChars(a.data.chars).dims` |
| `nfs` | 自然流量 | `charsData.nfs[i]`，列 prop `nfs` |
| `ads` | 广告流量（合计）。**只在「自然-广告分布」双色条里用，没有独立列** | `charsData.ads[n].dist` |
| `sps` | SP(常规) | 列 prop `sps` |
| `recs` | SP(推荐) | 列 prop `recs` |
| `sbs` | SB(常规) | 列 prop `sbs` |
| `sbvs` | SBV | 列 prop `sbvs` |

建议拍平成长表。主键：`(asin, country, time_piece_type, time_piece_value, dimension, dim_value, channel_code)`

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `asin` / `country` / `time_piece_*` | 同上 | 请求参数 | `paramsEgg` |
| `dimension` | VARCHAR(32) | `asin` / 属性 code | `paramsEgg.dimension` |
| `dim_value` | VARCHAR | 行标识，来自 `dims[i].val` | `t.val`，堆积图 y 轴 category 亦取 `e.val` |
| `channel_code` | VARCHAR(16) | `nf\|ad\|sp\|spRec\|sb\|sbv`（对应 chars 的 nfs/ads/sps/recs/sbs/sbvs） | chars key |
| `score` | BIGINT | 该行该渠道的流量得分。**接口返回**；堆积图 series 直接 `chars[key].map(e=>e.score)` | `dataFun` 原文；`charsData.nfs[n].score` |
| `ratio` | DECIMAL(9,6) | 该行该渠道占比，0..1。列头说明「纵向相加为 100%」→ **是列内归一化，不是行内** | `getRatioValue(charsData.nfs[n].ratio)`，`getRatioValue = 100*e` |
| `dist` | DECIMAL(9,6) | **仅 `nfs` / `ads` 有**。行内自然 vs 广告的二分占比，喂双色条 | `charsData.nfs[n].dist` / `charsData.ads[n].dist` |

`dims[]` 元素（即行头，可并入 `dim_asin_variant` 或单列）：

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `val` | VARCHAR | 行取值（子体 ASIN 或属性值） | `t.val`、`n.val` |
| `img` | VARCHAR | 变体图 | `t.img` |
| `features` | ARRAY&lt;VARCHAR&gt; | 特征标签 | `t.features.length>0` 后 `v-for` |
| `sum_score` | BIGINT | 该行**总流量得分**（跨渠道合计）。这是「流量得分」在表格里的主口径字段 | `trafficScore:n.sumScore`；`流量得分:{{handleFormatThousand(t.sumScore)}}` |
| `ratio` | DECIMAL(9,6) | 该行总流量占比 | `percentage:getRatioValue(n.ratio)`；`{{变体\|属性}}流量占比:{{ratioDisplay(t.ratio)}}` |
| `color` | CHAR(7) | ⚠️ 堆积图左栏 `li` 的背景色。是接口下发还是别处赋值，本 chunk 内未见赋值代码 | `style:{background:t.color}` |

同接口表级字段：`data.total`（总行数，喂 `chartTotal` 与分页器）、
`data.features[]`（维度选项，见 §3.2）。

**「流量得分」字段归属结论（重点任务回答）**：
`score`、`sumScore` 都是**接口返回的字段**，前端只做千分位格式化（`handleFormatThousand`/`scoreFormat`）。
另有一处旁证：产品概览配置里 `{title:"7天流量得分", field:"trafficScore", minifield:"trafficScoreChangeRatio"}`
（`34.0c5a7c92.js @51837`）——说明后端还有一个成对的环比字段 `trafficScoreChangeRatio`。
前端计算的**只有占比的显示形态**：`ratioPercent` / `ratioDisplay` / `distPercent` / `distDisplay`
（模块 `7VAF`，最大余额法整数化 + `<1%` 特判）。

---

## 3. 关系实体

### 3.1 `rel_listing_variant` — Listing 与变体的父子关系

用途：区块 D/E 的行都挂在一个 Listing 下。原站有独立的「更新父子体关系」动作
（`34.0c5a7c92.js > 84vd` 组件，调 `q.bb`，文案 `Sif每周更新一次父体与子体关系`）。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `parent_asin` | CHAR(10) | 父体 | `isParentAsin` / `pasin` |
| `child_asin` | CHAR(10) | 子体 | `variantAsin` |
| `country` | CHAR(2) | 站点 | 拦截器 |
| `features` | ARRAY&lt;VARCHAR&gt; | 该子体的属性特征 | `row.features` |
| `updated_at` | DATETIME | 关系更新时间。原站口径**每周一次**，支持手动实时刷新 | 文案 `Sif每周更新一次父体与子体关系` |

### 3.2 `rel_listing_dimension` — Listing 可用的聚合维度

用途：区块 D 的「不同变体 / 不同Color / 不同Size」选项。**这是接口驱动的动态集合**，
不同 Listing 可用维度不同（有的没 Size），所以是关系表而非纯枚举表。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `asin` / `country` | | Listing | 请求参数 |
| `code` | VARCHAR(32) | 维度代码，用作 `dimension` 请求参数 | `data.features[].code` |
| `name` | VARCHAR(32) | 维度中文/英文名。前端拼 `"不同"+name` 作按钮文案 | `data.features[].name` |
| `sort_order` | INT | 展示顺序。前端保序，并在首位 `unshift` 固定项 `{label:"不同变体",value:"asin"}` | `featuresList.unshift({label:"不同变体",value:"asin"})` |

原文：`featuresList = data.features.map(e=>({label:"不同"+e.name, value:e.code}))`（`@198113`）。

---

## 4. 枚举字典

### 4.1 流量渠道类型（本域核心枚举）

原站**没有一张统一的渠道枚举**，而是按用途散在 5 个映射表里，且各表 key 不完全一致。
下表把它们对齐成一张主表 —— 这是建 `dict_traffic_channel` 的依据。

| 建议规范值 | 展示名（主） | asinSummary 列 key | chars 数组 key | flowOverview key | trafficType（跳 /reverse） | 埋点值 | 颜色 |
|---|---|---|---|---|---|---|---|
| `NATURAL` | 自然流量 | `natural` | `nfs` | `overview.nf` | `nf` | `natural` | `#1AB364` |
| `AD_ALL` | 广告流量 | `ad` | `ads` | `overview.ad` | `ad` | `ad` | `#F0AA11` |
| `SP_ALL` | SP广告流量 | `spRec` | — | — | `allSp` | `spAd` / `spAll` | `#F2732F`+渐变 |
| `SP_NORMAL` | SP(常规)流量 | `sp` | `sps` | `ad.sp` | `sp` | `spNormal` | `#F2732F` |
| `SP_RECOMMEND` | SP(推荐)流量 | `rec` | `recs` | `ad.recommend` | `spRec` | `spRecommend` | `#FF8F18` |
| `SB_ALL` | SB广告流量 | `brandVedio` | — | — | `allSb` | `sbAd` / `sbAll` | `#FFB302`+渐变 |
| `SB_NORMAL` | SB(常规)流量 | `brand` | `sbs` | `ad.sb` | `sb` | `sbNormal` | `#FFB302` |
| `SBV` | SBV流量 | `vedio` | `sbvs` | `ad.sbv` | `sbv` | `sbv` | `#EEDB47` |
| `TOTAL` | 全部流量 | `total` | `dims.sumScore` | — | `total` | `all` / `listingAll` | 渐变 |
| `AC` | AC推荐词 | `ac` | — | — | `total`+`condition=isAC` | — | — |
| `DEAL` | Deal活动 | — | — | — | — | — | `#CC0C39` |
| `BS` | Best Seller | — | — | — | — | — | `#D14900` |
| `REC_COLUMN` | 推荐专栏 | — | — | `recommend.{title}` | — | `recommend` | 见 §4.2 |

原始映射表逐条列出（**这些是内部值的直接证据**）：

**(1) 排序字段枚举** `iaiF` 导出 `f`（页面里 `sortEnum`），`34.0c5a7c92.js @291710`：
```js
{total:"total", natural:"natural", ad:"ad", spRec:"spRec", sp:"sp",
 rec:"rec", brandVedio:"brandVedio", brand:"brand", vedio:"vedio", ac:"ac"}
```
→ 全部是**字符串**，key 与 value 同名。区块 E 的 `sortBy` 直接传这些值。

**(2) 跳转 /reverse 的 trafficType 映射** `iaiF` 导出 `g`：
```js
{total:"total", natural:"nf", ad:"ad", spRec:"allSp", sp:"sp",
 rec:"spRec", brandVedio:"allSb", brand:"sb", vedio:"sbv"}
```
→ **关键词域的渠道内部值是这一套**（`nf` / `allSp` / `spRec` / `allSb` / `sb` / `sbv`），
与流量结构域的 `natural` / `spRec` / `rec` / `brandVedio` / `brand` / `vedio` **不同名**。
复刻务必统一，否则两页对不上。

**(3) 堆积图 series 名 → chars key 映射** `iaiF` 导出 `e`：
```js
{"自然流量":"nfs", "SP(常规)广告流量":"sps", "SP(推荐)广告流量":"recs",
 "SB(常规)广告流量":"sbs", "SBV广告流量":"sbvs"}
```
→ 这 5 个中文串是堆积图的**图例文案**，也是 tooltip 反查 key 的依据。

**(4) 流量来源徽章枚举** 模块 `VWEL`（`TrafficSource` 组件），`34.0c5a7c92.js @117089`：
```js
i = {natural:"自然流量", sp:"SP(常规)流量", sb:"SB(常规)流量", sbv:"SBV流量",
     bs:"BS", rec:"SP(推荐)流量", deal:"Deal活动"}
s = ["natural","sp","sb","sbv","bs","rec","deal"]   // 展示顺序
```
→ **这是含 Deal 和 BS 的最完整一份**，共 7 值，且 `s` 给出了固定排序。
`row.flowResources` 就按这 7 个 key 取真假点亮徽章。徽章里 SB 组还有二级文案 `常规` / `视频`。

**(5) 埋点值映射** `34.0c5a7c92.js @146900`：
```js
we = {sp:"spNormal", recAd:"spRecommend", sb:"sbNormal", sbv:"sbv"}          // 区块 C 行按钮
Se = {total:"all", natural:"natural", ad:"ad", spRec:"spAd", sp:"spNormal",
      rec:"spRecommend", brandVedio:"sbAd", brand:"sbNormal", vedio:"sbv"}    // 区块 E 单元格
Ce = {total:"listingAll", natural:"natural", ad:"ad", spRec:"spAll", sp:"spNormal",
      rec:"spRecommend", brandVedio:"sbAll", brand:"sbNormal", vedio:"sbv"}   // 区块 B 柱子
```
→ `spNormal` / `spRecommend` / `sbNormal` / `sbv` / `spAll` / `sbAll` 这套命名最规范，
**建议复刻直接采用它作为规范值**。

**(6) 颜色枚举** `app.js > "+n12"` 导出 `i`（页面里 `A.i` / `reverseColors`）：
```js
{nf:"#1AB364", sp:"#F2732F", spRec:"#FF8F18", recAd:"#FF8F18", rec:"#FF8F18",
 sb:"#FFB302", sbv:"#EEDB47", deal:"#CC0C39", bs:"#D14900", ad:"#F0AA11",
 total:"linear-gradient(to bottom, #f0aa11, #1ab364)",
 sbAll:"linear-gradient(180deg, #EEDB47 50%, #FFB302 100%)",
 spAll:"linear-gradient(180deg, rgba(255,143,24,0.9) 59.62%, #F2732F 100%)"}
```
→ 又一套 key：`nf/sp/spRec/recAd/rec/sb/sbv/deal/bs/ad/total/sbAll/spAll`。
注意 `spRec`/`recAd`/`rec` **三个 key 同色**，说明它们在颜色语义上是同一个渠道（SP推荐）——
这与 §4.1 表里 `spRec` 在排序枚举中表示"SP全部"的用法**互相矛盾**，是原站遗留混乱。

进度条配色数组 `+n12` 导出 `g`：`[nf, ad, sp, spRec, sb, sbv]`，
表格列按 `progressColor[0..5]` 取色 → 印证列的渠道顺序是 自然/广告/SP常规/SP推荐/SB常规/SBV。

**(7) 排名类型文案** `+n12 > P.nameChange`（switch/case，非本页面主用但同一套 code）：
```
nf→自然排名, sp→SP排名, sb→SB排名, sbv→SBV排名, rec→REC排名
```

**(8) 更广的流量来源文案表** `+n12 > P.formatKey`（其他页面共用，登记备查）：
```
natural→自然搜索, ac→AC专栏, sp→SP广告, top→头部品牌广告, bottom→底部品牌广告,
er→ER专栏, vedio→视频广告, tr→TR专栏, trfob→TRFOB专栏,
coupon→优惠券(Coupon), lowestPrice→30日最低价(Lowest Price),
limitedTimeDeal→限时优惠(Limited Time Deal), bs→Best Seller
```
`+n12 > P.formatData`：`natural→自然搜索, amz→官方推荐, ppc→PPC广告, deal→Deal`
> ⚠️ 这两个函数在本页面被注册（`formatData`/`formatKey`/`formatDataHover`）但我未定位到实际调用的列，
> 可能是历史遗留或其他域共用。`er`/`tr`/`trfob`/`coupon`/`lowestPrice`/`limitedTimeDeal`
> 这些值**本页面无对应字段**，登记供主 Agent 跨域对齐，不要据此给本域建表。

### 4.2 推荐专栏类型（`dict_recommend_column`）

**开放枚举**：接口 key 就是专栏标题。前端硬编码了 13 个已知专栏的配色，
未知专栏走备用色池（`P.getOtherRecColor()`）→ **证明这个集合会增长，不能建成封闭 ENUM**。

已知 13 个（`app.js > "+n12"` 导出 `h`，即对象 `O`）：

| 内部值（= 展示名，接口 key） | 颜色 | 用户截图中出现 |
|---|---|---|
| `Customers frequently viewed` | `#73BE00` | 是 |
| `Trending now` | `#33B99D` | 是 |
| `Picks from Amazon Influencers` | `#13BFE5` | 是 |
| `Seen on social media` | `#846C04` | 是 |
| `4 stars and above` | `#F26AB0` | |
| `Recently bought and rated` | `#8DAA91` | |
| `Customers mention` | `#6A0E49` | |
| `Today's deals` | `#7B9EA8` | |
| `Trending styles` | `#292F36` | |
| `From frequently shopped brands` | `#BD755D` | |
| `Other items to consider` | `#06A152` | |
| `Inspired by similar searches` | `#C492B1` | |
| `New arrivals` | `#7A8DE6` | |

大小写处理：前端另建了一份全小写映射 `A = Object.fromEntries(Object.keys(O).map(k=>[k.toLowerCase(), O[k]]))`
并在 `setRecColor` 里用 `toLocaleLowerCase()` 匹配 → **入库建议存原文 + 小写规范列，匹配走小写**。

业务说明（tooltip 原文）：`常见的推荐专栏都是SP广告产品，点击可查产品在推荐专栏的曝光情况`
→ 推荐专栏流量在归因上算 SP 广告流量的一部分，对应 `ad.recommend`。

### 4.3 `dict_show_type` — 数值口径

| 内部值 | 展示名 | 说明 |
|---|---|---|
| `1` | 流量词 | 数值为**流量词数量**（去重口径），列名后缀 `词` |
| `2` | 流量分 | 数值为**流量得分**，列名后缀 `流量` |

来源：`flowStructureOption:[{label:"流量词",value:"1"},{label:"流量分",value:"2"}]`，
请求参数 `params.showType = 1*flowStructureValue`（**字符串转数字后发送**）。

### 4.4 `dict_search_type` — 查询主体类型

| 内部值 | 展示名 | 配套参数 |
|---|---|---|
| `1` | ASIN | `searchValue` |
| `2` | 关键词 | `searchKeyword` |

来源：`optionsSearch:[{groupid:"1",groupName:"ASIN"},{groupid:"2",groupName:"关键词"}]`，
`params.type` / `paramsAgg.type`。

### 4.5 `dict_dimension` — 聚合维度

| 内部值 | 展示名 | 来源 |
|---|---|---|
| `asin` | 不同变体 | 前端硬编码 `unshift({label:"不同变体",value:"asin"})` |
| `color` | 不同Color | `hideDimensionList:["color","size"]` 硬编码 + 接口 `features[].code` |
| `size` | 不同Size | 同上 |
| 其他 | `"不同"+name` | 完全由 `data.features[]` 驱动 |

**非封闭枚举**，建议存成 §3.2 的关系表，`dict` 只登记 `asin` 这个固定项。
埋点侧的规范值：`asin → allVariant`，其余 → `byAttribute`（`ke` 函数）。

### 4.6 `dict_time_piece_type` — 时间粒度

| 内部值 | 展示名 | timePieceValue 格式 | 依据 |
|---|---|---|---|
| `month` | 选择某月 | `YYYY-MM` | 协调方实测 + `options` 数组 `{groupid:"month",groupName:"选择某月"}` |
| `week` | 选择某周 | `YYYY-MM-DD_YYYY-MM-DD` | 协调方实测 + `{groupid:"week",groupName:"选择某周"}` |
| `latelyDay` ⚠️ | 最近7天 / 最近30天 | `7` / `30` | **仅代码证据**，实测未覆盖：`params:{timePieceType:"latelyDay",timePieceValue:"7"}`、`options` 前两项 `latelyDay7`/`latelyDay30`、URL 回填分支 |

前端 UI 层另有合成值 `granularityValue` / `timeInfo.value`：
`latelyDay7`、`latelyDay30`、`周:{value}`、`月:{value}` —— 这是**展示层拼串，不是接口值**。

冷热数据口径：`week`/`month` 属冷数据，对比模式下提示 `历史数据为冷数据，查询较慢，请稍候`
→ 建模时 week/month 快照可考虑与近期数据分表/分区。

### 4.7 `dict_view_mode` — 视图模式（纯前端，不入库）

| 内部值 | 展示名 | 埋点值 | 分页行为 |
|---|---|---|---|
| `separate` | 分列对比模式 | `splitCompare` | `pageSize=999999`（全量） |
| `stacked` | 堆积图模式 | `stacked` | `pageSize=5` |

持久化 `localStorage["sif_search_searchModelValue"]`，默认 `separate`。
另有 `localStorage["sif_search_trafficScoreValue"]`（布尔，"展示流量得分"开关）。

### 4.8 `dict_vip_level` — 会员等级（本域仅用于门禁）

| 内部值 | 本域行为 |
|---|---|
| `high` | 可见区块 B 汇总 |
| `shark` | 可见区块 B 汇总 |
| 其他值 | 区块 B 打码，文案 `汇总信息会员可见`；且**前端不发 asinSummaryAgg 请求** |

来源：`"high"!=a.data.vipLevel&&"shark"!=a.data.vipLevel`、`!["high","shark"].includes(vipLevel)`。
⚠️ 完整等级枚举不在本域素材内，交系统域。

### 4.9 业务状态码（本域用到的）

| code | 含义 | 本域行为 |
|---|---|---|
| `1` | 成功 | 正常渲染 |
| `1104` | 权限/额度不足 | 弹会员对话框 + `clearSearchQueryParams()`；区块 D 静默清空不弹 toast |
| `3101` / `3111` | 积分不足（个人 / 团队） | 下载时弹积分弹窗，带 `balanceIntegral`、`consumeIntegral`、`channel` |
| `3113` | 积分达上限 | 弹 `limitScore`，带 `integralLimit` |

---

## 5. 实体关系总图

```
dim_asin (asin, country)
  │
  ├─1:N─ dim_asin_variant (asin, country, dimension, dim_value)
  │         └─ rel_listing_variant (parent_asin, child_asin, country)  [每周更新]
  │
  ├─1:N─ fact_asin_traffic_summary   (+ time_piece, dimension, dim_value, show_type)  区块E
  ├─1:1─ fact_asin_traffic_agg       (+ time_piece)                                   区块B  [会员限定]
  ├─1:N─ fact_asin_flow_overview     (+ time_piece, block, channel_code)              区块C
  ├─1:N─ fact_listing_score_chart    (+ time_piece, dimension, dim_value, channel_code) 区块D
  └─1:N─ rel_listing_dimension       (code, name)                                     维度选项

dict_traffic_channel  ──被 fact_asin_flow_overview.channel_code
                        与 fact_listing_score_chart.channel_code 引用
                        （fact_asin_traffic_summary 是宽表，渠道横向展开成列）

dict_recommend_column ──被 fact_asin_flow_overview（block=recommend）按 rec_title 引用
```

**建模取舍提示**：`fact_asin_traffic_summary` 在原站是**宽表**（9 渠道 × 值/占比/皇冠 = 27 列），
`fact_listing_score_chart` 是**列式数组**。复刻时若统一成长表（一行一渠道），
查询侧要自己做行转列；若保持宽表，加渠道就要改表结构。
建议 `summary` 保持宽表（列固定且有业务口径 popover），`score_chart` 拍平成长表。

---

## 6. 不确定清单（数据字典部分）

1. ⚠️ **`time_piece_type` 是否真的没有 `latelyDay`** —— 代码里有明确的 `latelyDay` + `7`/`30`
   三处证据（初始 state、下拉选项、URL 回填），与实测的 month/week 两值冲突。见 §0.2。
2. ⚠️ `score` / `sumScore` 的**业务口径与单位**：确认是接口字段，但"流量得分"怎么算的
   （曝光量？加权分？搜索量×排名权重？）代码里没有任何线索。这直接决定 ETL 能否自建。
3. ⚠️ `nkVaiantsNum` 语义未知（`nk` 前缀无处可查）。
4. ⚠️ `dims[].color` 是接口下发还是前端赋值 —— 本 chunk 内未见赋值代码。
5. ⚠️ `flowResources` 的确切结构：从取值方式确定是对象且 key 是那 7 个，
   但**值是布尔还是数值**未定（`trafficSources.deal ? A : B` 对两者都成立）。
6. ⚠️ `supplementResult:true` 语义未知，可能影响缺失渠道是否补 0 —— 影响 NULL vs 0 的建模。
7. ⚠️ `ratio` 是否可为 NULL：`verifyEmpty` 里显式判 `null===ad.ratio` → **可以为 NULL**，
   但"NULL"与"0"的业务区别（无数据 vs 占比为零）未明。
8. ⚠️ `spRec` 一名两义（排序枚举里=SP全部，颜色表里=SP推荐）是原站 bug 还是有意，
   影响我们规范值的选择。建议按埋点那套（`spAll`/`spRecommend`）重命名。
9. ⚠️ 区块 B 的汇总值是否等于区块 E 明细的纵向求和（同源同口径）无法证明。
10. ⚠️ `DEAL` / `BS` 两个渠道只出现在 `flowResources` 徽章和颜色表里，
    **本域没有任何列或 chars key 承载它们的数值** —— 是别的域（反查流量词）的渠道，
    还是本域后端有但前端没展示，需主 Agent 跨域确认。
11. ⚠️ `dict_dimension` 除 `asin`/`color`/`size` 外还有哪些 code，接口驱动，集合不可枚举。
12. ⚠️ `AC` 渠道的数据归属：`row.ac` 在 summary 表里，但没有 `acRatio`，
    也不在 chars 里 —— 它是"标记数"而非"流量"，建模上应与 9 个渠道区分。
13. ⚠️ 所有 BIGINT / DECIMAL 精度是我按用法定的（千分位格式化 → 整数大数；
    `100*ratio` 且 `toFixed(2)` → 小数）。**真实精度需接口样例确认**。

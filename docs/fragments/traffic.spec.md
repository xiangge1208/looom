# 查流量结构（Traffic Structure）页面域 — 规格片段

> 素材：webpack 压缩前端产物，非接口响应样例。所有"类型"结论几乎都是推断，已标 ⚠️。
> 主证据 chunk：
> - `docs/raw/_probe/chunks/35.e6a6f4aa.js` —— **`/search`（查流量结构，单产品）页面实现**
> - `docs/raw/_probe/chunks/34.0c5a7c92.js` —— `/compare-structure`（对比流量结构，多产品）
> - `docs/raw/_probe/chunks/3.ba8c09db.js` —— 共享 API 封装模块（webpack 模块 id `cIs/`）
> - `docs/raw/_probe/app.js` —— 路由表、颜色/枚举常量模块（`+n12`）

## 0. 关键定位结论（先读这条）

35 与 34 两个 chunk 都注册了 webpack 模块 `dQSg:function`（页面组件），且**两者的表格列定义、
三块分布图逻辑、字段名完全一致**。差异只在 34 额外注册了 `NzuS`（`/compare-structure` 的多产品外壳）。

`app.js` 路由表原文：

```js
{path:"/search",component:...n.e(35)...n.bind(null,"dQSg"),name:"search",meta:{title:"查流量结构|Sif"}}
{path:"/compare-structure",component:...n.e(34)...n.bind(null,"NzuS"),name:"compare-structure",meta:{title:"对比流量结构-多产品对比|Sif"}}
```

即：**`/search` 是单产品查流量结构页，`/compare-structure` 复用同一套组件加多产品对比外壳**
（组件内以 `props.isCompare` 区分，见 `34.0c5a7c92.js > props:{isCompare:{type:Boolean,default:!1}}`）。

导航归属（`app.js > "S/Xg"` 模块）：
```js
search:{page:"search",parentTab:"反查流量（词）",childTab:"查流量结构"}
```
侧栏（`app.js` 菜单数组 `re`）：`查流量(词)` → `查流量结构 /search`、`反查流量词 /reverse`、`查多变体自然位 /multi-variants`。
功能说明文案（`app.js` 数组 `oe`）：`{label:"查流量结构",moduleId:12,tip:"查询每个Listing的流量在不同变体和不同流量位的分布"}`。

### 域边界修正（重要，需主 Agent 知悉）

我的端点清单 `docs/raw/domains/traffic.txt` 里 15 个端点，实际归属为：

| 端点 | 是否属于本页面 | 依据 |
|---|---|---|
| `/api/struct/asinSummary` | 是 | chunk 35/34 直接调用 |
| `/api/struct/asinSummary/download` | 是 | 同上 |
| `/api/struct/asinSummaryAgg` | 是 | 同上 |
| `/api/struct/asinFlowOverview` | 是 | 同上 |
| `/api/struct/listingscore/chart` | 是 | 同上 |
| `/api/struct/listingscore/chart/download` | 是 | 同上 |
| `/api/search/asinOpTrafficTrend`（及 `/detail`、`/coreKeywords`、`/headKeywords`、`/changeDetail`） | **否** | 在 chunk 35/34/3 中 `grep 'asinOpTrafficTrend'` **命中数为 0**；只出现在 `26.79e84b23.js`（`/reverse`）与 `27.6b4f3218.js`（`/timemachine-traffic`） |
| `/api/search/timeMachine/asinOpTrafficTrend`（及 `/detail`、`/list`） | **否** | 同上，属时光机域 |
| `/api/updown/timeMachine/asinOpTrafficTrend/download` | **否** | 仅在 `27.6b4f3218.js` |

`asinOpTrafficTrend` 在 chunk 26 的用法是作为图表组件的 `serviceApi` prop：
`26.79e84b23.js @314781 > serviceApi:"/api/search/asinOpTrafficTrend", tip:"点击柱子可快速定位流量变化的类型和主要关键词"`。
本片段**不对这 9 个端点下结论**，交主 Agent 转给 keywords / timemachine 域。

## 1. 页面路由与标题

| 项 | 值 |
|---|---|
| 路由 | `/search` |
| route name | `search` |
| `meta.title` | `查流量结构\|Sif` |
| 侧栏文案 | 查流量结构 |
| moduleId | `12`（`app.js` 数组 `oe`，权限/埋点用） |
| 关联对比页 | `/compare-structure`（`meta.title`：对比流量结构-多产品对比） |
| URL query | `asin`、`piece`（= `timePieceType`）、`date`（= `timePieceValue`）、`type`、`country`、`from`（`from=plugin` 时自动滚动到列表） |

query 回填逻辑：`34.0c5a7c92.js @186071`，`piece=latelyDay&date=7` → `timeInfo={value:"latelyDay7"}`，
`piece=week` → `timeInfo={value:"周:"+date}`，`piece=month` → `月:`+date。

## 2. 页面区块拆解

### 区块 A — 搜索区

- 控件：搜索类型下拉（`optionsSearch`：`{groupid:"1",groupName:"ASIN"}` / `{groupid:"2",groupName:"关键词"}`）、
  输入框（placeholder `输入ASIN，多个逗号隔开`）、时间粒度选择器、站点切换。
- 时间粒度选项（`34.0c5a7c92.js > options`）：
  `latelyDay7`=最近7天、`latelyDay30`=最近30天、`week`=选择某周、`month`=选择某月。
- 日期可选范围上界为今天：`pickerOptions.disabledDate: e.getTime()>Date.now()||e.getTime()<new Date(Fe.a).getTime()`。
- 交互：`searchBtn()` 重置 `params.pageNum=1`、`params.condition=""`、`params.showType=1`、`countValue=1`，
  中文逗号自动转半角（`replace(/，/g,",")`），空格分隔也支持。
- ASIN 格式校验（同 bundle 内 `84vd` 组件）：`/^[A-Z0-9a-z]{10}$/`，不符提示 `您输入的ASIN格式不正确`。
- 搜索成功后串行触发：`getAsins()` → `getPolor()` → `getAll()` → `getListingInfo()`（`34.0c5a7c92.js @207347`）。

### 区块 B — 汇总条形图（Listing 流量词汇总）

三组柱状图（组件 `barChartThree`，数据源 `/api/struct/asinSummaryAgg`）：

| 组 | id | 柱标题 | 取值字段 |
|---|---|---|---|
| 1 | 1 | Listing全部流量词(去重) | `allData.total` |
| 1 | 2 | 自然流量词 | `allData.natural` |
| 1 | 3 | 广告流量词 | `allData.ad` |
| 2 | 4 | SP全部流量词（去重） | `allData.spRec` |
| 2 | 5 | SP(常规)流量词 | `allData.sp` |
| 2 | 6 | SP(推荐专栏)流量词 | `allData.rec` |
| 3 | 7 | SB全部流量词（去重） | `allData.brandVedio` |
| 3 | 8 | SB(常规)流量词 | `allData.brand` |
| 3 | 9 | SBV流量词 | `allData.vedio` |

来源：`34.0c5a7c92.js @180800 > allBarData` computed。

- **会员门禁**：`isDisabled = !["high","shark"].includes(vipLevel)`；非会员整块打码，
  文案 `汇总信息会员可见` + 按钮 `立即开通旗舰会员`（链接 `https://www.sif.com/member?country=US`，dev 环境为 `dev.sif.com`）。
- 并且 `getAll()` 里**先查用户信息，只有 `vipLevel` 为 `high`/`shark` 才发 `asinSummaryAgg` 请求**（`@209273`）。
- 交互：点柱子 → `reverse(allData, key)` 跳 `/reverse`，带 `isListingSearch:true`。
- hover：全组联动置灰（`globalHoveredId`），非 hover 柱变 `#C5C5C5`，值为 0 也置灰。
- `maxValue` 取 `allData.total`，柱高 `Math.max(10, Math.min(100, value/maxValue*100))`。

### 区块 C — 顶部三块分布图（用户截图中的三块）

数据源：`/api/struct/asinFlowOverview`。构造代码 `34.0c5a7c92.js @210130 > getListingInfo()`：

```js
c=o.data||{}, u=c.overview, p=c.ad, h=c.recommend,
m=u.nf, v=u.ad, y=p.sp, b=p.sb, _=p.sbv, w=p.recommend,
x=[
  {title:"Listing自然-广告流量分布", height:32, marginBottom:24, isNf:!0, value:{nf:m, ad:v}},
  {title:"广告流量分布", isAd:!0, value: v.score>0 ? {sp:y, recAd:w, sb:b, sbv:_} : {}},
  {title:"推荐专栏流量分布", isRc:!0, isRecommend:!0,
   value: Object.fromEntries(Object.entries(h).sort((a,b)=>b[1].score-a[1].score))}
]
```

要点：
1. **三块的 key 是固定的**：块1 = `nf`/`ad`；块2 = `sp`/`recAd`/`sb`/`sbv`（注意 `recAd` 对应响应里的 `ad.recommend`）；
   块3 = 动态 key，即推荐专栏标题字符串。
2. 块2 有条件渲染：**只有 `overview.ad.score > 0` 才展示**，否则 `value:{}` → 走空态。
3. 块3 **按 `score` 降序**排序后展示，前端排序不是接口排序。
4. 每块算 `maxRatio = max(value[*].ratio)`，条宽 = `ratio / maxRatio * 100%`（相对最大值，不是绝对占比）。
5. 条内显示 `score`（千分位格式化），条右显示 `ratioDisplay`（前端计算，见 §5）。
6. 只在**单 ASIN**查询时展示：`searchAsinsLength > 1` 时 `getListingInfo()` 直接 return；
   模板条件 `isSearch && 1==searchAsinsLength && isListingSearch`。

区块内按钮：

| 位置 | 文案 | 行为 |
|---|---|---|
| 块2 标题右侧 | `查广告架构` | `goAdxray(1,{asin:searchValue},{module:"listingTraffic",position:"all"})` → 新窗口 `/adxray-structure` |
| 块2 每行下方 | `查广告架构` | `goAdxray(1,{asin, type:getTypeKey(key)},{module:"listingTraffic",position:key})`；`getTypeKey`：`recAd`→`sp`，其余原样 |
| 块3 标题右侧 | `查推荐专栏` | `goRc()` → 新窗口 `/recommend?asin=&country=` |

块3 按钮的 tooltip 文案：`常见的推荐专栏都是SP广告产品，点击可查产品在推荐专栏的曝光情况`。

`goAdxray` 跳转 query（`34.0c5a7c92.js @192210`）：
`{piece:timePieceType, date:timePieceValue, asin, country, type?, ...trackParams}`。

### 区块 D — 「流量结构」表格 / 堆积图（用户截图中的下方表格）

数据源：`/api/struct/listingscore/chart`。标题固定文案 `流量结构`。

表头控件：

| 控件 | 取值 | 说明 |
|---|---|---|
| 维度单选（`featuresList`） | 首项固定 `{label:"不同变体",value:"asin"}`，其余由响应 `data.features` 生成 `{label:"不同"+name, value:code}` | 截图里的「不同Color / 不同Size」就是这里，**是接口驱动的动态选项，不是硬编码** |
| `展示流量得分` 复选框 | `trafficScoreValue`，布尔 | 持久化 `localStorage["sif_search_trafficScoreValue"]`；勾选后在进度条内/柱子上叠加 `score` 数字 |
| 视图单选 | `separate`=`分列对比模式`、`stacked`=`堆积图模式` | 持久化 `localStorage["sif_search_searchModelValue"]`，默认 `separate` |
| 下载按钮 | `downPolor()` | `disabled: !(chartTotal>0)` |

来源：`34.0c5a7c92.js @182775 > searchModelOption` / `@229122` 模板 / `@189468 handleChange`。

**两种模式的分页行为不同（重要）**：
- `separate`（表格）：`pageNum=1, pageSize=999999`（一次全量拉）——`getPolor()` 开头强制覆盖。
- `stacked`（堆积图）：`pageNum=1, pageSize=5, sortBy="", desc=true`，走分页器。

表格列（组件 `TrafficWordTable`，`34.0c5a7c92.js @138000-146000`）：

| # | prop | label | 可排序 | 渲染 | 表头 popover |
|---|---|---|---|---|---|
| 1 | — | `#` | 否 | `type:"index"` | — |
| 2 | `variantAsin` | 动态：`searchOptionValue==="asin"` 时 `变体ASIN`，否则取 `searchOptionValue` 原值 | 否 | 图片 hover 放大 + `row.val` + `row.features` 用 `\|` 拼接 | — |
| 3 | `total` | `总流量占比` | 是（默认排序） | `CustomProgress`：`percentage=ratio*100`、`ratioDisplay`、`trafficScore=row.sumScore`、渐变色 | `Listing 下每个 ASIN 的流量占比` |
| 4 | （无 prop） | `自然-广告流量分布` | 否 | `DualProgress`：左 `charsData.nfs[i].dist`，右 `charsData.ads[i].dist`，配 `distDisplay` | `ASIN/属性下自然和广告的流量占比分布` |
| 5 | `nfs` | `自然流量占比` | 是 | `CustomProgress`，取 `charsData.nfs[i]` 的 `score`/`ratio`/`ratioDisplay` | `Listing 下每个 ASIN/属性 的自然流量的流量占比，纵向相加为 100%` |
| 6 | `sps` | `SP(常规)流量占比` | 是 | 同上取 `charsData.sps[i]` | `Listing 下每个ASIN/属性 的SP(常规)流量占比，纵向相加为 100%` |
| 7 | `recs` | `SP(推荐)流量占比` | 是 | `charsData.recs[i]` | `...SP(推荐)流量占比，纵向相加为 100%` |
| 8 | `sbs` | `SB(常规)流量占比` | 是 | `charsData.sbs[i]` | `...SB(常规)流量占比，纵向相加为 100%` |
| 9 | `sbvs` | `SBV流量占比` | 是 | `charsData.sbvs[i]` | `...SBV流量占比，纵向相加为 100%` |

表格属性：`border`、`max-height:600`、默认排序 `{prop:"total", order:"descending"}`，
`sort-orders:["descending","ascending"]`（**不允许取消排序回到无序**）。

排序回传规则（`handleSortChange`）：
```js
n={desc:false, sortBy:prop}; "descending"===order && (n.desc=true);
!order && (n.desc=undefined, n.sortBy=undefined);
"total"===prop && (n.sortBy=undefined)   // 按总流量排序时 sortBy 传空
```
即 **`total` 是后端默认排序，不下发 sortBy**。

堆积图模式（ECharts，`34.0c5a7c92.js @195400`）：
- `type:"bar"`、`stack:"total"`、`yAxis` 为 category（`inverse:true`，`show:false`）、`xAxis` 为 value。
- 5 个 series（顺序即图例顺序）：`自然流量`(nfs) / `SP(常规)广告流量`(sps) / `SP(推荐)广告流量`(recs) / `SB(常规)广告流量`(sbs) / `SBV广告流量`(sbvs)。
- series 取值：`dataFun(data, key)` = `data.chars[key].map(e=>e.score)`，**且把 0 转成 `null`**（不画柱）。
- `label.show = trafficScoreValue`（勾选"展示流量得分"才显示数值）。
- 左侧行标签：`#序号-val`、图片 hover、属性列表、`流量得分:{sumScore}`、`{变体|属性}流量占比:{ratio}`。
- tooltip 通过 `C.e[seriesName]` 反查 `charsData` 的 key 再取 `ratio`，格式 `名称  值 （占比）`。
- 容器高度：`leftDays.length` 在 1..199 时 `height = 100 * n + "px"`，≥200 或 0 时为 `0`。

### 区块 E — ASIN 明细表（Listing 下各变体流量词/流量分）

数据源：`/api/struct/asinSummary`。这是区块 D **之外**的另一张表（组件在 `34.0c5a7c92.js @149690`）。

表头控件：
- `flowStructureOption`（单选）：`{label:"流量词",value:"1"}` / `{label:"流量分",value:"2"}`
  → `flowStructureValueChange` 把 `params.showType = 1*value`，重新请求。
  这个开关**改变列标题后缀**：`getTableLabel(name, suffix)` → `showType==2` 时 `name+suffix`，否则 `name+"词"`。
  例：`SP(常规)广告` + `流量` → `showType=1` 显示 `SP(常规)广告词`，`showType=2` 显示 `SP(常规)广告流量`。
  同时切换 popover 文案（`getTableHeaderPopover(a,b)` → `showType==2` 取 b）。
- `批量操作`（`banthDown`，`total>0` 时可用，否则灰态 `批量操作`）、下载按钮 `downResult()`。

列（`prop` 全部来自 `sortEnum`，见 §4 枚举 1）：

| prop | 列名（流量词模式 / 流量分模式） | 值字段 | 皇冠标记 | 占比字段 |
|---|---|---|---|---|
| — | `#` | 序号 | — | — |
| — | 图片 | — | — | — |
| — | `变体ASIN`（`searchOptionTabValue==="asin"`）或维度名 | `row.asin` | — | — |
| — | `流量来源` | `row.flowResources` | — | — |
| `total` | `全部流量词` / `全部流量` | `row.total` | `row.totalBest` | — |
| `natural` | `自然流量词` / `自然流量` | `row.natural` | `row.naturalBest` | `row.naturalRatio` |
| `ad` | `广告流量词` / `广告流量` | `row.ad` | `row.adBest` | `row.adRatio` |
| `spRec` | `SP广告词` / `SP广告流量` | `row.spRec` | `row.spRecBest` | `row.spRecRatio` |
| `sp` | `SP(常规)广告词` / `SP(常规)广告流量` | `row.sp` | `row.spBest` | `row.spRatio` |
| `rec` | `SP(推荐)广告词` / `SP(推荐)广告流量` | `row.rec` | `row.recBest` | `row.recRatio` |
| `brandVedio` | `SB广告词` / `SB广告流量` | `row.brandVedio` | `row.brandVedioBest` | `row.brandVedioRatio` |
| `brand` | `SB(常规)广告词` / `SB(常规)广告流量` | `row.brand` | `row.brandBest` | `row.brandRatio` |
| `vedio` | `SBV广告词` / `SBV广告流量` | `row.vedio` | `row.vedioBest` | `row.vedioRatio` |
| `ac` | `AC推荐词`（仅 `searchOptionTabValue==="asin"` 或 `isCompare&&showType==1` 时显示） | `row.ac` | `row.acBest` | — |
| — | `操作` | `反查流量词` / `时光机` | — | — |

列头 popover 原文（含金量高，直接给出口径定义）：

- 全部流量：`指自然流量词和广告流量词合并去重后的流量词数量。` / `全部流量 = 自然流量 + 广告流量。`
- 自然流量：`指通过自然搜索带来曝光流量的搜索词。` / `指自然搜索的曝光流量。`
- 广告流量：`指投放PPC广告的流量词。广告流量词数量为SP广告词和SB广告词合并去重后的流量词数量。` / `指PPC广告流量，广告流量 = SP广告流量 + SB广告流量。`
- SP广告：`指SP(常规)广告词和SP(推荐)广告词去重后的流量词数量。` / `SP广告流量 = SP(常规)广告流量 + SP(推荐)广告流量。`
- SB广告：`指SB(常规)广告词和SBV广告词去重后的流量词数量。` / `SB广告流量 = SB(常规)广告流量 + SBV广告流量。`
- SP(常规) 释义：`PPC广告的一种，也是最常见的一种，打了该类广告词的产品混杂在自然搜索结果中，具备sponsored标识，一般在自然搜索结果的前中后部都有分布。每页展示16条时，广告数量一般为4个；每页展示48条时，一般广告数量为12个。`
- AC推荐词释义：`当某个产品在某个关键词下的曝光和转化效果理想，就可以获得亚马逊官方颁发的Amazon's Choice标记……简称AC推荐词。`
- 流量来源列释义：`来曝光或点击的流量来源，包括自然搜索、SP(常规)流量、SP(推荐)流量、SB(常规)流量、SBV流量、Deal活动等。`

单元格 popover 动态文案（两种模式各一套），例 SP 列：
- 流量词模式：`该产品在所选时间段内在{sp}个流量词下投放 SP 广告出现在搜索结果前 3 页的广告搜索位。`
- 流量分模式：`该产品的SP(常规)广告流量的曝光得分是{sp}，SP(常规)广告流量占比为{spRatio}`
- 尾部链接：`点击查看SP(常规)广告示例` → `lookExample("sp")` 跳 `/example`

**"搜索结果前 3 页"是原站数据采集口径的明文证据。**

单元格点击 → `reverse(row, key, condition)` 跳 `/reverse`，`trafficType` 用 `C.g[key]` 映射（见 §4 枚举 2）。
`ac` 列走独立的 `reverseAC(row)`，固定 `trafficType:"total", condition:"isAC"`。

## 3. 交互流程

```
用户输入 ASIN + 选时间粒度 → searchBtn()
  ├─ getAsins()        POST /api/struct/asinSummary        → 区块 E 表格
  ├─ getPolor()        GET  /api/struct/listingscore/chart → 区块 D 表格/堆积图 + featuresList
  ├─ getAll()          先 GET 用户信息，vipLevel∈{high,shark} 才
  │                    POST /api/struct/asinSummaryAgg     → 区块 B 三组柱图
  └─ getListingInfo()  POST /api/struct/asinFlowOverview   → 区块 C 三块分布图
                       （searchAsinsLength>1 时跳过）

切「不同变体/不同Color/不同Size」   → paramsEgg.dimension=code, pageNum=1 → getPolor()
切「分列对比/堆积图」               → 写 localStorage；切到 stacked 时重置 pageSize=5、sortBy="" → getPolor()
勾「展示流量得分」                  → 写 localStorage → getPolor()（会重新请求，非纯前端切换）
区块 D 表头排序                     → paramsEgg.sortBy/desc → getPolor()
区块 E 表头排序                     → params.sortBy/desc → getAsins()
切「流量词/流量分」                 → params.showType=1|2, pageNum=1 → getAsins()
区块 E 换页                         → params.pageNum → getAsins()（并 scrollIntoView #table-scroll）
区块 D 换页（仅堆积图）             → paramsEgg.pageNum → getPolor()（scrollIntoView #table-scroll-por）
点区块 B 柱子 / 区块 E 单元格       → 新窗口 /reverse
点区块 C 块2「查广告架构」          → 新窗口 /adxray-structure
点区块 C 块3「查推荐专栏」          → 新窗口 /recommend
区块 E 行内「时光机」               → 新窗口 /timemachine-traffic
区块 E 多选 ≥2 且 ≤10              → 新窗口 /asin-relatedness（localStorage 传 asins）
「对比」入口                        → 新窗口 /compare-structure?asin=&type=1&country=
```

时间粒度切换时的冷数据提示：`params.timePieceType` 为 `week`/`month` 且 `isCompare` 时，
弹 `历史数据为冷数据，查询较慢，请稍候`（`34.0c5a7c92.js @207900`）。

## 4. 接口契约表

`code===1` 为成功（全站约定，见 `_common.spec.md`）。所有请求自动带 `country`、`_t`、`_m`（拦截器注入）。

| 方法 | 路径 | 请求参数 | 响应字段 | 触发场景 |
|---|---|---|---|---|
| POST ⚠️ | `/api/struct/asinSummary` | `timePieceType`、`timePieceValue`、`type`(1=ASIN/2=关键词)、`pageNum`、`pageSize`(默认100)、`sortBy`、`desc`、`searchValue`(type=1)、`searchKeyword`(type=2)、`showType`(1=流量词/2=流量分)、`dimension`、`condition` | `data.asins[]`、`data.total`、`data.vaiantsNum`、`data.nkVaiantsNum`、`data.isParentAsin`、`data.boughtMonth`；行字段见 §2 区块 E 与字典 | 搜索、换页、排序、切流量词/流量分、切维度 |
| POST ⚠️ | `/api/struct/asinSummary/download` | 同上，但 `pageNum:undefined, pageSize:undefined` | `responseType:"blob"` | 区块 E 下载按钮 |
| POST ⚠️ | `/api/struct/asinSummaryAgg` | `timePieceType`、`timePieceValue`、`type`、`searchValue` 或 `searchKeyword` | `data.{total,natural,ad,spRec,sp,rec,brandVedio,brand,vedio}` | 搜索后（仅 vipLevel∈{high,shark}） |
| POST ⚠️ | `/api/struct/asinFlowOverview` | `timePieceType`、`timePieceValue`、`asin`、`isListingSearch:true`、`supplementResult:true` | `data.overview.{nf,ad}`、`data.ad.{sp,sb,sbv,recommend}`、`data.recommend.{<推荐专栏标题>:...}`；每个节点含 `name`/`score`/`ratio` | 搜索后（单 ASIN） |
| GET ⚠️ | `/api/struct/listingscore/chart` | `timePieceType`、`timePieceValue`、`asin`、`dimension`(asin/color/size/…)、`pageNum`、`pageSize`、`sortBy`(nfs/sps/recs/sbs/sbvs，total 时不传)、`desc` | `data.total`、`data.chars.{dims,nfs,ads,sps,recs,sbs,sbvs}`、`data.features[].{name,code}` | 搜索、切维度、切视图、勾流量得分、排序、换页 |
| GET ⚠️ | `/api/struct/listingscore/chart/download` | 同上，`pageNum:undefined, pageSize:undefined` | `responseType:"blob"` | 区块 D 下载按钮 |

方法标 ⚠️ 的依据：`3.ba8c09db.js` 里 `Object(a.b)(path, params)` 与 `Object(a.a)(path, params)`
是两个不同的 axios 封装，`asinSummary`/`asinSummaryAgg`/`asinFlowOverview` 用 `a.b`，
`listingscore/chart` 用 `a.a`。`a`/`b` 哪个是 GET / POST **在本片段素材范围内未直接可证**，
按 axios 封装惯例推断 `b`=POST、`a`=GET，需主 Agent 从 `app.js` 的 `DcyJ` 模块统一裁定。

模块导出名对照（`3.ba8c09db.js`，webpack 模块 `cIs/`，页面里以 `q.*` 调用）：

| 导出 | 路径 | 封装 |
|---|---|---|
| `q.ob` | `/api/struct/asinSummary` | `a.b` |
| `q.mb` | `/api/struct/asinSummary/download` | `a.b` |
| `q.y` | `/api/struct/asinSummaryAgg` | `a.b` |
| `q.w` | `/api/struct/asinFlowOverview` | `a.b` |
| `q.yb` | `/api/struct/listingscore/chart` | `a.a` |
| `q.xb` | `/api/struct/listingscore/chart/download` | `a.a` |

`isCompare`（`/compare-structure`）时替换为 `q.jb`（列表）与 `q.ib`（下载）——
这两个指向 `/api/compare/**`，属对比域，不在本片段范围。

## 5. 前端计算 vs 接口返回（重点核实项）

**「流量得分」是接口返回的字段，不是前端算的。** 证据：

- 区块 D 表格：`trafficScore: n.sumScore`（`row.sumScore` 直接来自 `data.chars.dims[i]`）、
  各渠道列 `trafficScore: charsData.<key>[i].score`。
- 堆积图 series：`dataFun` = `data.chars[key].map(e=>e.score)`。
- 区块 C：条内显示 `handleFormatThousand(n.score)`。
- `CustomProgress` 组件的 `trafficScore` prop 只做 `scoreFormat`（千分位）展示，无任何计算。
- 另有独立字段名 `trafficScore` 出现在产品概览配置（`34.0c5a7c92.js @51837`）：
  `{title:"7天流量得分", field:"trafficScore", minifield:"trafficScoreChangeRatio", linkConfig:{url:"/search",type:1}}`
  —— 说明"流量得分"在别处也是**后端字段**，且有配套的环比字段。

**前端计算的只有占比的显示形态**，实现在 webpack 模块 `7VAF`（`34.0c5a7c92.js @177310` 前）：

| 函数 | 导出 | 作用 |
|---|---|---|
| `c` | `7VAF.d` | 最大余额法把一组数按比例分配成整数，总和恰为 100（避免各行占比相加≠100%） |
| `u` | `7VAF.c` | `(0===e && t>0) ? "<1%" : e+"%"` —— **占比为 0 但原值>0 时显示 `<1%`** |
| `p` | `7VAF.b` | `formatBarData`：给区块 C 每块的 value 补 `ratioPercent`、`ratioDisplay` |
| `d` | `7VAF.a` | `formatChars`：给 `chars` 每个数组补 `ratioPercent`、`ratioDisplay`；并对 `nfs`/`ads` 成对计算 `distPercent`、`distDisplay` |

即：接口返回 `ratio`（原始比值，0..1）与 `dist`，前端把它们规整成整数百分比再显示。
另有独立的小数阈值格式化（`iaiF.c`）：`＜0.01` / `＜0.01%` 特判。

## 6. 空状态、加载态、错误态

### 空状态

统一空态组件 `Empty`，reasons 数组（`34.0c5a7c92.js @183020`）：
```js
emptyReasons:["站点选择错误","所选时间段内无数据","叠加的其他搜索条件过于严格，没有匹配结果"]
```
- 区块 D 表格：`leftDays.length === 0` → `<Empty :reasons="emptyReasons">`。
- 区块 E 表格：`total === 0` → 同上，且分页器隐藏。
- 区块 C 单块：`verifyEmpty(block.value)` 为假 → 块内显示 `暂无数据`（灰色 `var(--weaken-color)`）。
  `verifyEmpty` 逻辑：`!(!ad||!nf||(null===ad.ratio&&null===nf.ratio)) || ((!ad||!nf||null!==ad.ratio||null!==nf.ratio) && Object.keys(e).length>0)`
- 区块 E 请求成功但 `tableData.length===0` → toast `暂无数据`（type warning，居中）。

### 加载态

| 标志 | 覆盖区域 |
|---|---|
| `tableLoading` | 区块 E 表格（`v-loading`）。仅 `timePieceType==="latelyDay"` 或 week/month 非对比模式时置位 |
| `chartBarLoading` | 区块 D 表格与堆积图 |
| `listingInfoLoading` | 区块 C 整段 |
| `asinSummaryAggLoading` / `titleLoading` | 区块 B |
| `fullscreenLoading` | 全屏 |

### 错误态

| 条件 | 行为 |
|---|---|
| 未输入 ASIN | toast `请输入ASIN`（warning，居中） |
| ASIN 格式非 10 位字母数字 | toast `您输入的ASIN格式不正确` |
| `code === 1104` | 弹会员对话框 `$refs.memberDialog.show()`，并 `pageApi.clearSearchQueryParams()`；区块 D 走 `resetPolorData()` 静默清空（**不弹 toast**） |
| 其他 `code !== 1` | toast `res.message`（warning，居中） |
| 下载 `code === 3101` / `3111` | 积分不足弹窗 `$refs.limit.show(channel==="team"?"团队":"")`，带 `balanceIntegral`、`consumeIntegral` |
| 下载 `code === 3113` | 积分上限弹窗 `$refs.limitScore.show()`，带 `integralLimit` |
| 多选对比 > 10 个 | toast `最多选择10个` |
| 多选对比 < 2 个 | toast `最少选择2个产品` |
| 复制成功 | toast `复制成功`（success） |
| week/month 粒度 + 对比模式 | toast `历史数据为冷数据，查询较慢，请稍候` |

会员相关的兜底：非旗舰会员（`vipLevel` 不在 `{high,shark}`）区块 B 打码，文案 `汇总信息会员可见`。

### 埋点（复刻可不做，但透露了区块语义）

`34.0c5a7c92.js @146800 > _e`：
```js
overviewBtn:{module:"trafficoverview",eventEntity:"overviewBtn"}          // 区块 C
tabGroupStructure:{module:"structurechart",eventEntity:"tabGroup"}        // 区块 D 维度切换
searchViewToggle:{module:"structurechart",eventEntity:"searchViewToggle"} // 区块 D 视图切换
trafficScoreCheckbox:{module:"structurechart",eventEntity:"trafficScoreCheckbox"}
tabGroupKeyword:{module:"keyworddistribution",eventEntity:"tabGroup"}     // 区块 E
keywordOverviewBar:{module:"keyworddistribution",eventEntity:"keywordOverviewBar"} // 区块 B
keywordTableCell / rowActionBtn:{module:"keyworddistribution"}
```
**区块 C 的内部代号是 `trafficoverview`，区块 D 是 `structurechart`，区块 B+E 是 `keyworddistribution`。**
埋点值映射（可作为渠道枚举的又一份证据，见字典枚举 3/4）。

## 7. 本页面的不确定清单

1. ⚠️ 所有接口的 HTTP 方法：`a.a` / `a.b` 两种封装的实际 verb 未在本域素材内证明。需从 `app.js` 的 `DcyJ` 模块裁定。
2. ⚠️ 所有字段的类型、量纲、精度：压缩代码无类型信息。`ratio` 看 `getRatioValue(100*ratio)` 推断是 0..1 小数；`score` 看千分位格式化推断是整数或大数值，但**单位/口径未知**（是曝光量？加权分？）。
3. ⚠️ `data.chars.dims[i].color` 在堆积图左侧 `li` 的 `background` 用到，但不确定是接口返回还是别处赋值——本 chunk 里未见赋值代码。
4. ⚠️ `dimension` 的完整取值集合：只见到 `asin` 硬编码 + `hideDimensionList:["color","size"]`，其余由接口 `features[].code` 动态给出，**枚举不封闭**。
5. ⚠️ `type` 参数（1=ASIN / 2=关键词）在流量结构页 type=2（按关键词查）的完整交互链路未展开分析——`optionsSearch` 存在但主链路都走 type=1。
6. ⚠️ `condition` 参数取值：只见到 `""` 和 `isAC`（来自 `reverseAC`），其他分支值未知。
7. ⚠️ `supplementResult:true` 的语义未知（字面像"补全结果"，可能是让后端把缺失渠道补 0）。
8. ⚠️ 区块 C 块1 的 `overview` 里除 `nf`/`ad` 外是否还有别的 key，代码只解构了这两个。
9. ⚠️ `nkVaiantsNum` / `vaiantsNum` / `variantExNum` 三者的区别（拼写 `vaiants` 是原站 typo，复刻建议改 `variants`）。
10. ⚠️ `boughtMonth` + `boughtHistory` + `pasinBoughtHistory` + `boughtHistoryDates` 属销量迷你图，可能与 sales 域重叠，本片段只登记不解释。
11. ⚠️ `isParentAsin` 为真/假时页面差异未追（只见到传给子组件 `banthDown`）。
12. ⚠️ `/api/struct/asinFlowOverview` 与 `/api/search/asinFlowOverview`（`3.ba8c09db.js` 里同时存在，导出 `q.w` 与 `q.v`）的区别：本页面只用 `struct` 版本，`search` 版本调用点不在本域 chunk。
13. ⚠️ 区块 B 的 9 个柱与区块 E 的 9 个列用的是同一组 key（`total/natural/ad/spRec/sp/rec/brandVedio/brand/vedio`），推断是同一套指标的"汇总 vs 分变体"两个视角，但**是否同源同口径无法证明**。
14. ⚠️ `docs/raw/domains/traffic.txt` 里的 9 个 `asinOpTrafficTrend*` 端点不属于本页面（见 §0），需主 Agent 改派。

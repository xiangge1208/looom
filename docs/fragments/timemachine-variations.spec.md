# 规格片段：运营时光机 / 查多变体自然位

> 素材：`docs/raw/_probe/chunks/27.6b4f3218.js`（运营时光机）、`31.d50bb1ff.js`（查多变体自然位）、
> `28.10b9d182.js`（产品时光机，仅用于确认路由归属）、`124.24894769.js`、`docs/raw/_probe/app.js`（路由表 + 公共时间控件 + adNote 接口）。
> 全部为 webpack 压缩产物，**无接口响应样例**。凡响应字段类型/量纲未在代码中出现证据的，一律见「不确定清单」。

## 0. 路由归属先纠正一处

主 Agent 给的任务书把 `/timemachine-traffic` 和 `/timemachine-product` 都归到「运营时光机」，素材不支持：

| 路由 | `meta.title`（app.js 路由表） | chunk | 归属 |
|---|---|---|---|
| `/timemachine-traffic` | `运营时光机\|Sif` | 27 | ✅ 本片段第 1 节 |
| `/timemachine-product` | `产品时光机\|Sif` | 28 | ❌ 另一个功能（关键词选产品），不在本域 |
| `/multi-variants` | `查多变体自然位\|Sif` | 31 | ✅ 本片段第 2 节 |
| `/adxray-variation` | `查投放变体-广告透视仪\|Sif` | 124 | ❌ **未实现的空壳** |
| `/snapshot` | `坑位快照\|Sif` | 44 | ❌ 未分析（不在我的端点清单里） |

依据：`app.js` 路由表内联片段
`{path:"/timemachine-traffic",...name:"timemachine-traffic",meta:{title:"运营时光机|Sif"}},{path:"/timemachine-product",...meta:{title:"产品时光机|Sif"}}`。
侧边导航里两者也是并列的独立入口（chunk 28 中「运营时光机 」与「产品时光机」是两个 `router-link`）。

`/adxray-variation` 的整个 chunk 124 只有 375 字节，组件 render 函数只输出一个 div 文本「查投放变体」，
`mounted` 里只有 `console.log(this.$route)`，**没有任何接口调用**。占位路由，无需建模。

`/api/search/timemachine/product` 只在 chunk 28 的服务层出现（`Object(r.b)("/api/search/timemachine/product",e)`），
属于产品时光机，本片段不展开。它被 18 个 chunk 引用是因为服务层模块被打包进多个 chunk，不代表这些页面都调它。

---

# 1. 运营时光机 `/timemachine-traffic`

## 1.1 页面定位与整体结构

VIP 文案里的自我描述（chunk 28）：「运营时光机 —— 调研竞品从上架到现在的运营打法」。
输入一个 ASIN，看这个 ASIN 历史上的运营动作（改标题/改图/新增广告活动/价格活动等）叠加在流量趋势上，
再下钻到「某一天流量为什么变了」「哪些词进/出了前 3 页」。

区块自上而下：

1. **ASIN 搜索区** — 单 ASION 输入框（`placeholder:"输入ASIN搜索"`），带搜索历史 + 免费示例（`searchRecord` 用 `searchType:"flowHistory"` 拉取）。
   ASIN 格式校验失败提示「您输入的ASIN格式不正确」，空值提示「请输入ASIN」。
   查询父体时页面顶部提示「当前查询的是**父体**」（`isListingSearch || isPasin`）。
2. **主图表区（Keepa 式多轴叠加图）** — 组件 `Keepa`，`serviceApi:"/api/search/timeMachine/asinOpTrafficTrend"`，
   `isTimeTraffic:!0`，高度 543（无 Keepa 数据站点降到 330）。
3. **诊断区** — 标题动态为「诊断流量」/「诊断流量词」（取决于 `radioClass`），下挂明细表格 + 抽屉。
4. **图例说明**：「下方表格中统一用**绿色**表示数据上升或新出现运营动作，用**红色**表示数据下降」
   ← 这是素材里唯一直接出现「运营动作」四个字的地方。

## 1.2 控件清单

| 控件 | 变量 | 取值 | 依据 |
|---|---|---|---|
| 粒度切换 | `dayValue` | `day` 日趋势 / `week` 周趋势 / `month` 月趋势 | `options:[{groupid:"day",groupName:"日趋势"},{groupid:"week",groupName:"周趋势"},{groupid:"month",groupName:"月趋势"}]` |
| 时间跨度 | `curNum` → `lastMonths` | `null` 全部 / `3` 最近3个月 / `6` 最近6个月 / `12` 最近1年 / `24` 最近2年 | `optionsTime:[{groupid:null,groupName:"全部"},{groupid:3,...},{groupid:6,...},{groupid:12,...},{groupid:24,...},{groupid:1e4,groupName:""}]`；`flowHistory` 页面 `mounted` 里 `optionsTime.splice(5,1)` 删掉最后一项 |
| 自定义日期区间 | `params.conditions.from/to` | 选了区间就把 `lastMonths` 置 `null`，互斥 | `changeDate` / `changeSizeDay` |
| 流量类型（图表+表头） | `radio` | `3` 全部流量 / `6` 前三页自然流量 / `9` 前三页SP广告流量 | `optionTypes:[{groupid:"3",groupName:"全部流量"},{groupid:"6",groupName:"前三页自然流量"},{groupid:"9",groupName:"前三页SP广告流量"}]` |
| 变化项 | `radioClass` | `1` 流量变化 / `2` 流量词数量变化 | `optionClass:[{groupid:"1",groupName:"流量变化"},{groupid:"2",groupName:"流量词数量变化"}]` |
| 词进出（`radioClass=2` 时） | `inValue` | `1` 查看新进前3页的词 / `2` 查看掉出前3页的词 / `3` 查看保持在前3页的词 | `optionIn` |
| 流量变化方向筛选 | `flowValue` | `1` 查看全部变化 / `2` 只看流量增加的变化 / `3` 只看流量减少的变化 | `optionFlow` |
| 自然/广告视角 | `isNfAd` | 布尔，`changeMode` 切换，透传 `showAdDetail` | `changeMode:function(e){this.isNfAd=!e}` |

`radio` → 请求 `type` 的映射写死在两处：`type = radio==3 ? "all" : radio==6 ? "nf" : "sp"`。

## 1.3 时间维度（重点，含对 3 个接口的核实结果）

**粒度：日 / 周 / 月三档可切，默认日。** `granularity` 是显式请求参数，四个 params 对象都带它：

```
params        : {granularity:"week", asin:"", type:"all", keywordTypes:["all"], searchExposureScore:true, lastMonths:3, conditions:{from:null,to:null}}
paramsList    : {granularity:"day", asin:"", endDay:null, interval:null, listingSearch:false, lastMonths:3}
paramsHistory : {granularity:"day", changeType:"in", searchKeyword:"", type:"", keywordType:"", asin:"", endDay:"", sortBy:"estSearchesNum", desc:false}
paramsDetail  : {granularity:"day", type:"", keywordType:"", asin:"", searchKeyword:"", endDay:"", sortBy:"diffScore", filter:null, desc:false, pageNum:1, pageSize:100}
```

⚠️ 注意 `params` 初始值是 `week` 而其余三个是 `day`，但 `searchBtn` 里统一重置：
`e.dayValue="day", e.paramsList.granularity="day", e.paramsHistory.granularity="day", e.paramsDetail.granularity="day"`，
所以**实际首查是日粒度**。`params.granularity` 初始的 `week` 是死值（未被使用或随后被覆盖），已进不确定清单。

URL 可带 `piece` 参数预置粒度：`"week"==qs("piece")` → 四个 params 全设 week；`"month"` 同理。

**可选范围上限：最近 2 年。** 两处独立佐证：
- 跨度下拉最大项 `{groupid:24,groupName:"最近2年"}`；
- 公共时间控件 `timerSelect` 的提示文案「可回溯最近 2 年(720)天的数据」（`showTips` 为真时显示）。

### 三个候选「时间范围接口」的核实结论

任务书怀疑 `/api/search/keyword/months`、`/api/search/keyword/timeRanges`、`/api/search/rankingUpdateTime`
是给前端提供可选时间范围的。核实结果：

| 接口 | 定义位置 | 结论 |
|---|---|---|
| `/api/search/keyword/months` | **只在 `app.js`**：`q=function(e={}){return Object(s.a)("/api/search/keyword/months",e)}` | ⚠️ 是公共服务层导出函数，**在 chunk 27 / 31 里都找不到调用点**。用途「提供可选月份列表」是**合理推断但素材未证实** |
| `/api/search/keyword/timeRanges` | 同上，`U=function(...)` 紧邻 `q` 定义 | ⚠️ 同上，无调用点 |
| `/api/search/rankingUpdateTime` | `app.js`：`g=function(){return Object(s.a)("/api/search/rankingUpdateTime",{},{ignoreSetCountry:!0})}`，**无参数**且 `ignoreSetCountry` | 这是**全局排名数据更新时间**，不是可选范围。旁边有格式化函数返回 `{today, rankTimeMd, updateTimeHm, beijingTime, siteTime, siteText}`，用于「最新数据抓取中 / 更新时间」这类站点级提示 |

**所以：这两个页面的可选时间范围不是靠接口下发的**，而是前端硬编码的选项数组 + `el-date-picker` 的
`disabledDate:function(e){return e.getTime()>Date.now()}`（禁选未来）。
chunk 27 里唯一与「可选时间」有关的接口调用是 `Object(w.W)()` 后取 `e.month=i.data.date.substring(0,7)`
（拿一个日期字符串截出 `yyyy-MM` 作为默认月），但 `w.W` 对应哪个 URL 在 chunk 27 里没有解析出来 → 进不确定清单。

### 公共时间控件 `timerSelect`（两个页面共用，值格式很重要）

`timePiece = {type, value}`，type/value 组合：

| type | value 形态 | groupName |
|---|---|---|
| `latelyDay` | `latelyDay7` | 最近7天 |
| `latelyDay` | `latelyDay30` | 最近30天 |
| `week` | `周:yyyy-MM-dd` | 选择某周 |
| `month` | `月:yyyy-MM` | 选择某月 |

选项定义：`_=[{groupid:"latelyDay7",groupName:"最近7天"},{groupid:"latelyDay30",groupName:"最近30天"},{groupid:"week",groupName:"选择某周"},{groupid:"month",groupName:"选择某月"}]`。
提交前会剥掉前缀：`"latelyDay"===n ? t.replace("latelyDay","") : "week"===n ? t.replace("周:","") : t.replace("月:","")`
→ 即 `timePieceValue` 最终发出去是 `7` / `30` / `yyyy-MM-dd` / `yyyy-MM`。
写回 URL 为 `?piece=<type>&date=<value>`（`$replaceTimePiece`）。
`noDay` 为真时过滤掉 `latelyDay7/latelyDay30`，只剩周/月。

## 1.4 接口契约表

`asinOpTrafficTrend`（趋势主图）由 `Keepa` 组件按 `serviceApi` prop 动态调用，会**分两次请求同一个 URL**：
一次 `{fetchScore:false, fetchKeepa:true, dateAlignment:true}`，一次合并 `{fetchScore:true, fetchKeepa:true}`（见 1.5）。

| 方法 | 路径 | 请求参数 | 响应字段（前端实际读取的） | 触发场景 |
|---|---|---|---|---|
| POST ⚠️ | `/api/search/timeMachine/asinOpTrafficTrend` | `asin`, `granularity`(day/week/month), `listingSearch`, `lastMonths`, `endDay`, `interval`, `conditions{from,to}`, `fetchScore`, `fetchKeepa`, `dateAlignment` | `dates[]`, `asin`, `pasin`, `nonNullMinIndex`, `catName`, `subBsr{类目名: []}`, 以及 1.5 表里全部 series 字段 | 搜索、切粒度、切跨度、切自然/广告视角、`asin`/`listingSearch` 变化（watch immediate） |
| POST ⚠️ | `/api/search/timeMachine/asinOpTrafficTrend/list` | = `paramsList`：`granularity`, `asin`, `endDay`, `interval`, `listingSearch`, `lastMonths` | `list[]`（每行含 `totalScore{scoreChange,scoreChangeRatio}`、`subBsr`（对象→前端转成 `[{keyName,value}]`）等，见数据字典 `sif_asin_op_traffic_daily`） | 搜索后主列表；`radioClass`/`radio` 切换 |
| POST ⚠️ | `/api/search/timeMachine/asinOpTrafficTrend/detail` | = `paramsDetail`：`granularity`, `type`(all/nf/sp), `keywordType`, `asin`, `searchKeyword`, `endDay`, `sortBy`, `filter`, `desc`, `pageNum`, `pageSize`(100) | `list[]`（`score`,`scoreRatio`,`diffScore`,`diffScoreRatio`,`affectWholeRatio`,`pchangeReason{nfInfo,spInfo,sbInfo,recSpInfo}`,`vchangeReason`,`sifNfInfo`,`sifSpInfo`）, `total`, `extraData{<name1>:{isChanged,diffScore,score,diffScoreRatio}}` | 点图表柱子 / 点表格里 `totalScore` 单元格（`openChange`） |
| POST ⚠️ | `/api/search/timeMachine/asinKeywordTrend` | ⚠️ 素材未覆盖参数（该 URL 在 chunk 27 中只见服务层定义，未定位到调用点） | ⚠️ 素材未覆盖 | ⚠️ 素材未覆盖 |
| POST ⚠️ | `/api/search/timeMachine/asinKeywordTrend/list` | = `paramsHistory`：`granularity`, `changeType`(in/out), `searchKeyword`, `type`, `keywordType`, `asin`, `endDay`, `sortBy`(默认 estSearchesNum), `desc` | `inKeywords[]`, `outKeywords[]`, `noChangeKeywords[]`, `extraData{<name>:{isChanged,inNum,outNum,noChangeNum}}` | `radioClass=2`（流量词数量变化）时点图表/表头 |
| POST ⚠️ | `/api/search/timeMachine/asinKeywordTrend/detail` | ⚠️ 服务层有定义（`f=...asinKeywordTrend/detail`），未定位调用点 | ⚠️ 素材未覆盖 | ⚠️ 素材未覆盖 |
| POST | `/api/updown/timeMachine/asinOpTrafficTrend/download` | 同 detail/list（`responseType:"blob"`） | 二进制 | 下载按钮 |
| POST | `/api/updown/timeMachine/asinKeywordTrend/download` | 同上 | 二进制 | 下载按钮 |

**域外但同页调用、对建模很关键**：

| 方法 | 路径 | 请求参数 | 响应字段 | 触发场景 |
|---|---|---|---|---|
| POST ⚠️ | `/api/search/asinOpTrafficTrend/changeDetail` | `{asin, date, listingSearch}` | `lastChangeTime`, `nextChangeTime`, + 变化明细（标题/图片 diff、广告活动等，前端有 `getNewTitle(text, ranges[], ...)` 做 `[start,end]` 区间高亮） | 点图表上「修改标题或图片」/「新增广告活动」散点 |

注意这个 URL **不带 `timeMachine/` 前缀**，所以它不在我的域清单里，但它是「运营动作详情」的唯一来源，必须记一笔。

`跳转下钻`：`radioClass=1` 时把 `paramsDetail` 存进 `asinOpTrafficTrendDetail`（localStorage/session）后跳
`/conversion-rate` 或 `/keyword-relatedness`；`radioClass=2` 时存 `asinKeywordTrendDetail` 并把 `changeType` 设为 `in`/`out`。

## 1.5 图表（这是页面主体，结构复杂）

**类型：ECharts 多 grid + 多轴混合图（折线 + 柱状 + 散点 markPoint），带 dataZoom，柱子可点击。**

- grid / xAxis：**3 个 category 轴**，`data:e.date`，`axisLabel:{interval:0,rotate:45}`。
- yAxis：**至少 10 个**（代码里出现 `yAxisIndex:9`）。第 0 个是排名轴 `{min:1,max:4,interval:1,inverse:true}`（排名越小越好所以反转）。
- 提示 tips：「图中柱子均可点击，点击可查看不同时间的流量变化详情与原因」。
- `needZoom:true` / `onDataZoom` 回传可见区间；`mode==month` 时自动勾上「月销量」图例。

series 字段与中文名（枚举 `A`/`b`，chunk 27）：

| 响应字段 | 图例名 | 归类 |
|---|---|---|
| `dealPrice` | 最终成交价格 | 价格 |
| `ldPrice` | LD秒杀价格 | 价格（值形如 `"价格_xxx"`，前端 `split("_")[0]`） |
| `couponInfo` | Coupon价格 | 价格（值形如 `"价_?_省"`，渲染 `i+"(Save "+n[2]+")"`） |
| `primePrice` | Prime会员价格 | 价格 |
| `buyboxPrice` | Buybox价格 | 价格 |
| `promotion` | Promotion | 活动 |
| `campaignId` | **新增广告活动** | **运营动作（可点击）** |
| `titleImg` | **修改标题或图片** | **运营动作（可点击）**，取值 `1`=修改标题 `2`=修改图片 `3`=修改标题和图片 |
| `woot` | Woot | 活动（`clickChart` 里显式 return，不可点） |
| `totalScore` | 全部流量 | 流量 |
| `nfScore` | 自然流量 | 流量 |
| `adScore` | 广告流量 | 流量 |
| `spScore` | SP(常规)流量 | 流量 |
| `recSpScore` | SP(推荐)流量 | 流量 |
| `sbScore` | SB(常规)流量 | 流量 |
| `sbvScore` | SBV流量 | 流量 |
| `subBsr` | 小类BSR | 排名（多类目，`subBsr[类目名]` → 独立 series，渲染 `#值`） |
| `bsr` | 大类BSR | 排名（渲染 `#值`） |
| `boughtInPastMonth` | 最近30天销量 | 销量 |
| `star` | 评分 | 口碑 |
| `review` | 评论数 | 口碑 |
| `seller` | 卖家数 | 竞争 |

另有关键词排名 series（同组件另一处）：`sbvRank`（取 `e.sbvRank.map(e=>e&&e.rank)`，即数组元素是对象含 `rank`）、
`recRanks`（`xAxisIndex:1,yAxisIndex:1`，带 gold markPoint 表示推荐位命中，元素是对象，`Object.keys` 遍历取 `backgroundColor`）。

## 1.6 明细表格

**表 A：流量变化明细**（`radioClass=1`，`sortBy` 默认 `diffScore` desc）

| 表头 | 字段 |
|---|---|
| 影响流量变化的（词） | 关键词列 |
| 本期贡献总流量及占比 | `score`, `scoreRatio` |
| 相比上期的变化 | `diffScore`, `diffScoreRatio` |
| 流量变化对整体流量的影响占比 | `affectWholeRatio` |
| 流量变化原因之产品流量位变化 | `pchangeReason`（子字段 `nfInfo`/`spInfo`/`sbInfo`/`recSpInfo`，值形如 `"前_后"`，前端 split 后比大小决定 `xxMsg` 标记）、`sifNfInfo`、`sifSpInfo` |
| 流量变化原因之关键词搜索量变化 | `vchangeReason` |

**表 B：流量词进出明细**（`radioClass=2`，`sortBy` 默认 `estSearchesNum` desc）

| 表头 | 字段 |
|---|---|
| 关键词搜索排名 | `searchesRank` |
| 关键词搜索量 | `estSearchesNum`, `keyword` |
| 自然排名（`curTypeValue=="自然流量词"` 才显示） | `lastRank`, `lastRankStr`, `rankTime` |
| 广告排名（`curTypeValue=="SP(常规)流量词"` 才显示） | `adLastRank`, `adLastRankStr`, `adRankTime` |
| 首次出现时间 | `firstTime` |
| 保持率 | `holdRatio`, `holdDays`, `totalDays` |
| 操作 / 每日排名趋势 / 搜索量趋势 | 内嵌迷你图 |

排序白名单（`sortEnum`，chunk 27 共享模块）：
`searchesRank, estSearchesNum, affectWholeRatio, holdRatio, lastRank, adLastRank, firstTime, score, price, diffScoreRatio, diffScore, boughtInPastMonth, boughtInMonth, total, natural, ad, spRec, sp, rec, brandVedio, brand, vedio, ac, nfScoreRatio, brandName, firstAvailableDay`

**流量类型分栏头**（`headList`，点击切换 `keywordType`）：

| type（中文，会加「词」后缀） | name（词数量字段） | name1（流量分字段） |
|---|---|---|
| 全部流量 | `allKeywords` | `totalScore` |
| 自然流量 | `nfKeywords` | `nfScore` |
| 广告流量 | `adKeywords` | `adScore` |
| SP(常规)流量 | `spKeywords` | `spScore` |
| SP(推荐)流量 | `recSpKeywords` | `recSpScore` |
| SB(常规)流量 | `sbKeywords` | `sbScore` |
| SBV流量 | `sbvKeywords` | `sbvScore` |

`extraData` 就是按这套 key 索引的：`radioClass=1` 用 `name1` 取 `{isChanged,diffScore,score,diffScoreRatio}`，
`radioClass=2` 用 `name` 取 `{isChanged,inNum,outNum,noChangeNum}`。

## 1.7 状态

- **空状态** `emptyReasons`：`[j.b（VIP 提示常量）, "站点选择错误", "所选时间段内无数据", "叠加的其他搜索条件过于严格，没有匹配结果"]`
- **加载态**：`fullscreenLoading`（主）、`fullscreenLoading1`（进出词抽屉）、`isSearchList`（列表）、
  `keepaLoading`/`keepaSingleLoading`/`keepaScoreSingleLoading`（图表分段）、`firstFetch` 区分首次
- **超时态**：`isSearchListTimeout` / `fullscreenLoading1Timeout` / `loadingTimeout`，
  `element-loading-text` 换成 `timeOutLoadText`（= `"数据量太大，加载超时，请稍后尝试"`，同文案在 chunk 31 出现）
- **错误码**：`code!==1` 即失败；`1103` → 清空搜索状态；`1104` → 会员权限不足（`is1104`，弹试用/开通引导）；
  「当前无变化」「暂无关键词」「暂无数据」为业务提示
- **请求取消**：每个请求挂 `cancelToken`，同名请求先 `cancelService(t)`；接口带 `debounce`

---

# 2. 查多变体自然位 `/multi-variants`

## 2.1 页面定位与整体结构

输入一个父/子 ASIN，看这个 Listing 的**多个变体在同一个关键词下同时占据自然位**的情况
（Sif 把额外占位的变体叫「**搭子**」，主位叫「**主曝光变体**」），以及由此「额外获得的自然流量」。

区块：

1. **ASIN 搜索区**（同款 `CommonSearch`/`SearchWidget`，校验同 1.2）
2. **`daily` 区块：同一个关键词下多个变体自然位日趋势** — 标题字串「同一个关键词下多个变体自然位日趋势」「多自然位的流量趋势」
3. **`Variants` 区块：获得多自然位的变体** — 变体两两配对表（主曝光变体 + 搭子）
4. **`Keyword` 区块：获得多个自然位的关键词** — 关键词明细表 + 每行内嵌趋势图 + 变体排名弹层
5. **`trendDrawer` 抽屉：单自然位↔多自然位 日变化详情**

标记提示：「该标记代表今天在该关键词下存在多个变体自然位的情况」（组件 `multi_today`，字段 `row.today`）。

## 2.2 控件

| 控件 | 变量 | 取值 | 依据 |
|---|---|---|---|
| 时间范围 | `timePiece` | 同 1.3 公共 `timerSelect`：最近7天/最近30天/选择某周/选择某月 | `timePiece:{type:"latelyDay", value:m.n[0].groupid}`（默认第一项 = `latelyDay7`） |
| 关键词搜索 | `searchKeywordValue` → `searchKeyword` | 文本，「在关键词中搜索」 | `E.searchKeyword` |
| 变体筛选 | `searchAsin` | 下拉，选项 = `[{asin:"",label:"全部"}, ...tableInfo.listingAsins]` | `listingAsins` computed |
| 只看额外自然位 | `isOnlyViewExtra` | 布尔，勾上则图表隐藏 `singleTraffic` 系列 | 文案「只看额外增加的自然位」 |
| 排序 | `sortBy` / `desc` | 见 2.4 白名单，默认 `nfScore` desc | `E={...sortBy:O.nfScore,desc:!0}` |
| 分页 | `pageNum` / `pageSize` | 默认 1 / **100** | 同上 |
| 抽屉方向切换 | `dataType` | `oneTwo`（1个自然位→≥2个）/ `twoOne`（≥2个→1个） | `dataType:this.isOneTwo?"oneTwo":"twoOne"` |
| 抽屉日期前后翻 | `day` / `date` | `viewOtherDay(±1)`，文案「查看后一天 >」 | — |
| 词库标记 | `groupid1` / `subName` | 加入自定义词库 | `CikuAction` |

## 2.3 时间维度（重点）

**粒度：天（day），且是唯一粒度。** 三条证据：

1. 趋势接口叫 `dayTrend`，下钻接口叫 `dayTrend/keywordChange`，表格组件名 `dailyTable`，区块标题「同一个关键词下多个变体自然位**日趋势**」。
2. 趋势请求默认参数只有一个 `A={lastMonths:2}`，**没有 `granularity` 参数**——对比运营时光机四个 params 都显式带 `granularity`，
   这里连字段都不存在，说明后端不接受粒度切换。
3. 趋势响应里 `dates` 数组，前端直接把 `dates[dates.length-1]` 当作抽屉默认 `date`（`dailyTrendDetailParams={date: 最后一天}`），
   `L={date:""}` 单日字符串，抽屉按 ±1 天翻页。

**⚠️ 与运营时光机的关键差异**：`timePiece`（周/月）只作用于 `keywordList`，**不作用于 `dayTrend`**。
`getCommonParams()` 返回 `{asin, timePieceType, timePieceValue}`，只被 `getVariantsKeywords`（→ `keywordList`）合并；
`getDailyTrendChart`（→ `dayTrend`）只合并 `{asin}`，参数集始终是 `{asin, lastMonths:2}`。
即：**趋势图恒为日粒度、固定回溯 2 个月；关键词汇总表则是按所选周/月（或近 7/30 天）聚合的一个区间值**。
这是本域最容易被误合并的地方。

时间跨度上限：`lastMonths:2` 硬编码（趋势图 2 个月）；`timerSelect` 提示「可回溯最近 2 年(720)天的数据」（关键词表）。

## 2.4 接口契约表

| 方法 | 路径 | 请求参数 | 响应字段 | 触发场景 |
|---|---|---|---|---|
| POST ⚠️ | `/api/search/asinMultiNf/dayTrend` | `asin`, `lastMonths`(2) | `dates[]`, `asinCntList[]`, `keywordCntList[]`, `extraScoreList[]`, `scoreList[]`, `totalScoreList[]`, `listingUpdateTime`；数组元素为对象 `{value, ratio, change, changeRatio}` | 搜索、ASIN 变化 |
| POST ⚠️ | `/api/search/asinMultiNf/keywordList` | `asin`, `timePieceType`, `timePieceValue`, `searchKeyword`, `searchAsin`, `sortBy`, `desc`, `pageNum`, `pageSize`(100) | `list[]`（见 2.6）, `listingAsins[]`, ⚠️ 总数字段名未见 | 搜索、切时间、搜词、筛变体、排序、翻页 |
| POST ⚠️ | `/api/search/asinMultiNf/dayTrend/keywordChange` | `asin`, `day`, `dataType`(oneTwo/twoOne), `searchKeyword`, `sortBy`, `desc` | `list[]`, `oneTwoCnt`, `twoOneCnt` | 点趋势图流量柱子（提示「点击流量柱子可切换日变化详情数据」） |
| POST | `/api/updown/asinMultiNf/keywordList/download` | 同 keywordList（`responseType:"blob"`） | 二进制 | 「下载关键词排名趋势」 |

排序白名单 `O`：`nfScore, nfExtraScore, nfExtraScoreRatioOnKwAll, estSearchesNum, searchesRank, clickPurchaseRatio`
（变体配对表另用 `asinListSortEnum`：`nfScore, nfExtraScoreChange, keywordCnt, lastKeywordCnt`）

## 2.5 图表

**趋势图：双 grid + 3 个 Y 轴的折柱混合图，柱子堆叠、可点击。**

| series | 字段 | 类型 | 轴 | 图例名 | 颜色 |
|---|---|---|---|---|---|
| variants | `asinCntList` | line, `step:"end"` | x1 / **y2** | 该关键词下有自然流量的变体数量 | `#ED6A0D` |
| keywords | `keywordCntList` | line, `step:"end"`, `lineStyle.width:2` | x1 / **y1** | 有多个自然位的关键词数量 | `#D6D300` |
| singleTraffic | `scoreList` | bar, `stack:"total"`, `barMaxWidth:30` | x0 / **y0** | 主自然位的自然流量 | 自然流量主色 |
| extraTraffic | `extraScoreList` | bar, `stack:"total"`, `barMaxWidth:30`, `decimalPlaces:2` | x0 / **y0** | 因多自然位额外获得的自然流量 | `#76CD44` |

- `isOnlyViewExtra` 为真时 `singleTraffic` 不渲染。
- tooltip 里额外合成一条 `totalScoreList` 「总自然流量」（双色图例块），
  每项展示 `value`（含 `ratio` 括注）+ `change`（含 `changeRatio` 括注），涨绿跌红。
- 有一个 `chartPointer` 浮标组件，`convertToPixel` 定位到当前 `dataIndex`，默认停在最后一天。
- 关键词行内还有 `variant-lineChart`（单折线，`step:"end"`，`#009f52`，图例名「获得多个自然位的关键词数量」）
  和 `variantsTrend` / `keywordChart`。

## 2.6 表格

**表 A：获得多自然位的变体**（变体配对）

| 列 | 字段 |
|---|---|
| 主曝光变体+搭子 | `mainAsin{asin,img,price,features,rank}`, `extraAsins[]{同上}`, `best`（真则打「最佳CP」标） |
| 成对出现获得的自然流量 | `nfScore` + 括注 `nfRatio` |
| 成对出现获得的自然流量（变化） | `nfExtraScoreChange`, `nfExtraScoreChangeRatio` |
| 获得多个自然位的关键词 | `keywordCnt`, `lastKeywordCnt` |
| 获得多个自然位的关键词数量趋势 | `keywordCntList`, `dates` |

变体信息卡（`asinInfo`）另含：`nfScoreRatio`, `appearDays`, `avgRank`（「平均自然排名」）, `boughtInPastMonth`（「子体月订单量」）。

**表 B：获得多个自然位的关键词**

| 列 | 字段 |
|---|---|
| 关键词 | `keyword`, `today`（今日多变体标记） |
| 给Listing贡献的自然流量及占比 | `nfScore`, `nfScoreRatio` |
| 因多自然位额外获得的自然流量 | `nfExtraScore`, `nfExtraScoreRatio` |
| 单自然位→多自然位自然流量市场份额变化 | `nfScoreRatioOnKwAll`, `nfMainScoreRatioOnKwAll`, `nfExtraScoreRatioOnKwAll` |
| 周/月搜索量 | `estSearchesNum`, `estSearchesNumHistory`, `estSearchesNumHistoryPrev`, `searchesRank` |
| 关键词的点击转化率 | `clickPurchaseRatio` |
| 获得多个自然位的变体及排名 | 弹层，逐变体 `asin/price/features/rank`（「自然排名：」+`rank`） |
| 多自然位的流量趋势 / 获得自然位的变体 | 内嵌图 |

表头随粒度变文案：`"month"===granularity ? "月" : "week"`（`timePieceType` 含 `month` 或 `latelyDay30` → 「月」，否则「周」），
所以「周搜索趋势」/「月搜索趋势」是同一字段的两种表头。

**抽屉：单自然位↔多自然位日变化**
头部两个 tab：「1个自然位 → ≥2个自然位(`oneTwoCnt`)」「≥2个自然位 → 1个自然位(`twoOneCnt`)」，
`resData.list[]`，底部显示「共N条结果」，可按日期前后翻。

## 2.7 状态

- **趋势区空状态** `emptyReasons`：`["该Listing下只有1个变体", "该Listing从未进入过任何关键词搜索结果的前3页", "站点选择错误", "输入的ASIN有误"]`
- **关键词区空状态** `emptyReasons`：`["该Listing在所选时间段内未获得多个自然位 或者 获得多个自然位时未包含您所"筛选"的变体", "该Listing从未进入过任何关键词搜索结果的前3页", "站点选择错误", "输入的ASIN有误"]`
- 其他文案：「当前日期暂无关键词数据，请切换其他日期查看」「暂无匹配当前搜索条件的关键词」「暂无数据」「该Listing下只有1个变体」
- **加载态**：`dailyTrendChartLoading`, `variantsKeywordsLoading`, `dailyTrendDetailLoading`, `loading` + 各自 `firstFetch`
- **超时**：「数据量太大，加载超时，请稍后尝试」
- **错误码**：`1103` → 清空搜索；`1104` → 会员权限（配合 `specialPermitType` 走 `getSpeModel` 试用引导）
- **权限**：旗舰会员专享（「历史数据仅旗舰会员可查看」「该功能为旗舰会员专享功能」「领取 3 天功能试用」）
- 「当前请求正在执行中，请稍候」+ 全量 `cancelToken` + `debounce(80/100)`

---

# 3. 不确定清单

## 3.1 通用（两页都适用）

1. **HTTP 方法全部未确认。** 服务层统一是 `Object(xx.b)(url, params)` 或 `Object(xx.a)(url, params)`；
   axios 封装在 `app.js`，`a`/`b` 哪个是 GET 哪个是 POST **我没有验证**（不属于本域，建议主 Agent 统一裁定一次）。
   经验上 `b` 带 body 更像 POST，但这是推断。
2. **所有响应字段类型/量纲无证据。** 压缩代码里只有字段名和格式化函数。可间接推断的仅：
   - 走 `scoreFormat`/`isScore:true`/`decimalPlaces:2` 的（`nfScore`,`extraScore`,`totalScore`...）→ 小数，UI 叫「流量(分)」，是 Sif 自算的**流量得分**不是曝光量
   - 走 `getPercentage`/`isPercent:true` 的（`*Ratio`）→ 比率，⚠️ 是 0~1 还是 0~100 未知
   - 渲染成 `#值` 的（`bsr`,`subBsr`）→ 整数排名
   其余一律 ⚠️。
3. **站点维度必然存在但不在业务参数里。** 请求参数里看不到 `country`，但 axios 封装有 `ignoreSetCountry` 开关
   （`/api/search/rankingUpdateTime` 显式设 `true`），说明**默认会自动注入站点**。
   → 所有快照表都必须带站点字段，但字段名素材未覆盖（URL query 里用 `country`，store 里叫 `countryCode`）。
4. `estSearchesNum` 有两种口径：`keywordDataType` 为 `search` 时是「搜索量」，为 `aba` 时是「ABA排名」
   （`searchNumLabel` computed，存 localStorage key `sif_keyword_data_type`）。同一字段两种语义，⚠️ 建模时要注意。
5. **父体/子体（pasin/asin）语义未完全确认。** `listingSearch`/`pasin`/`isPasin` 三个标志混用；
   `dataList` 里 `pasin` 是父 ASIN。父体查询时的口径（是否聚合全部子体）素材未覆盖。

## 3.2 运营时光机

6. `params.granularity` 初始 `"week"` 但 `searchBtn` 立刻覆盖成 `"day"`——是死代码还是某条路径会用到 week，未确认。
7. `params.searchExposureScore:true`、`paramsList.interval`、`paramsDetail.filter` 三个参数**含义完全未知**，
   代码里只见赋值/置空，没见语义。
8. `/api/search/timeMachine/asinKeywordTrend`（无后缀）和 `/asinKeywordTrend/detail` 的调用点没找到。
   服务层有定义（`p=.../asinKeywordTrend/list`、`f=.../asinKeywordTrend/detail`），但页面只用到 `/list`。
   可能被别的 chunk 用，或已废弃。
9. `Object(w.W)()` 返回 `data.date` 被截成 `yyyy-MM` 当默认月，`w.W` 对应哪个 URL 未解析出。
10. `pchangeReason` 的 `"前_后"` 拼接串具体拆成什么单位（排名？位次？）未确认，只知道前端比大小后打 `Msg` 标记。
11. `subBsr` 响应是**对象**（`{类目名: 值或对象}`）而非数组，前端手动转 `[{keyName,value}]`。
    这个动态 key 结构入库要拍平，⚠️ 类目名取值范围未知。
12. `couponInfo` / `ldPrice` 是下划线拼接的复合串（`"a_b_c"`），字段是复合值不是标量。
13. 「运营动作」是否有用户手工标注的一路：见 3.4。

## 3.3 查多变体自然位

14. `keywordList` 的**总数/分页总条数字段名未见**（`variantsKeywordsInfo` 只被回填了前端自己的 `pageNum/pageSize`）。
15. `dayTrend` 的 `lastMonths:2` 是否可被用户改：**素材里找不到任何修改它的 UI**，看起来是硬编码。
16. `best`（最佳CP）的判定逻辑在后端，前端只读布尔。
17. `nfScoreRatioOnKwAll` / `nfMainScoreRatioOnKwAll` / `nfExtraScoreRatioOnKwAll` 三者分母是否都是「该词全站自然流量」，
    只能从命名推断（`OnKwAll`），未证实。
18. `appearDays` / `avgRank` / `holdDays` / `totalDays` 的统计窗口（是所选区间还是全历史）未覆盖。
19. `dayTrend/keywordChange` 的 `sortBy` 默认值来自 `Ce`，`Ce` 的完整定义我没定位到（只知含 `searchKeyword`/`sortBy`/`desc`）。

## 3.4 「运营动作」的性质（任务书重点问题，结论见数据字典 §5）

20. `/ltevent` 与本域**无关**。`app.js` 路由表：`{path:"/ltevent",...meta:{title:"有奖征稿|Sif"}}`，
    且它在用户中心菜单里（积分信息 / MCP密钥 / 购买记录 / **有奖征稿** / 退出），是征稿活动页。
    任务书把它当成 event 标注线索是误判。
21. `adNote` 是**真实存在的用户手工标注体系**，但**不属于这两个页面**。`app.js` 里有完整 CRUD：
    `/api/user/adNote/upsert`、`/delete`、`/extraInfo`、`/batchUpsert`、`/id`、`/list`、`/batchUpdateColor`、`/updateByid`。
    带 `batchUpdateColor` 说明是带颜色标签的笔记。
    但 chunk 27 / 31 **都不引用 adNote**（`grep adNote` 只命中 `app.js`），
    对应页面应是 `/ad-multiNotes-view` / `/ad-multiNotes-submit`（chunk 62 等），不在我的域。
    → **是否要把 adNote 与时光机的时间轴关联，需要主 Agent 跨域裁决。**

# 反查流量词 页面域 规格片段

> 素材：`docs/raw/_probe/chunks/26.79e84b23.js`（主）、`41.f781c26c.js`（旧版）、`40.a20352a7.js`（转化率页）、`docs/raw/_probe/app.js`（路由）。
> 所有结论来自 webpack 压缩产物的字符串字面量，**不是接口响应样例**。

## 0. 关键结论：路由归属纠正

`docs/raw/_probe/app.js` 的路由表给出的 title 与任务描述不一致，需要主 Agent 注意：

| 路由 | name | meta.title | 加载 chunk | 说明 |
|---|---|---|---|---|
| `/reverse` | `reverse` | **反查流量词\|Sif** | `[0,2,8,12,26]` | **当前主力页面** |
| `/old_reverse` | `old_reverse` | **反查流量词\|Sif** | `[0,1,3,7,41]` | 旧版同功能页 |
| `/keywords` | `keywords` | 以词拓词-拓展流量词\|Sif | `[0,1,14,13,61]` | **不是**反查流量词，是「以词拓词」 |
| `/words` | `Words` | 关键词库-我的关注\|Sif | `[0,8,121,1,51]` | 关键词库（收藏夹） |

依据：`app.js > path:"/reverse",component:...n.e(26)...,name:"reverse",meta:{title:"反查流量词|Sif"}`
以及 `path:"/old_reverse",...n.e(41)...,meta:{title:"反查流量词|Sif"}`。

侧栏分组也印证了这点：`app.js > {urls:["/expand","/keywords","/category"],items:[{label:"通过竞品拓词",path:"/expand"},{label:"以词拓词",path:"/keywords"}]}`，
而 `/reverse` 在另一组：`{path:"/reverse",activeUrls:["/reverse","/search","/multi-variants"],items:[{label:"查流量结构",path:"/search"},...]}`。

**goal.md 的 `/keywords`（反查流量词）对应本站 `/reverse`。**

### 关于 goal.md 的 `/keywords/source`（某关键词的流量来源分析）

**素材未覆盖独立页面。** 全量 83 条路由中没有任何 `/source`、`keywords/source`、`trafficSource` 路径
（`grep` app.js 全部 0 命中）。代码里唯一带 `isSource` 语义的是 `exposurePosition` 组件的一个布尔 prop：

```
26.79e84b23.js @197894  nn={name:"exposurePosition",props:{isSource:{type:Boolean,default:!1},...}}
26.79e84b23.js @200605  e.isSource?n("div",{staticClass:"exposureLine"},[... "isLimitedTimeDeal" ...
```

即 `isSource=true` 时该组件多渲染一行"限时秒杀"曝光位。这是**同一组件在另一个页面（本域素材未覆盖）的复用开关**，不是本页的独立视图。

代码里承担"某关键词的流量来源"语义的是**跳转到别的独立路由**，而非本页子视图：

| 入口按钮文案 | 目标路由 | 传参 | 来源 |
|---|---|---|---|
| 查看竞争格局 | `/compete`（流量位竞争格局-关键词竞争分析） | `keyword` + `piece` + `date` | `26.js > lookConpete(row,"/compete",{needTimePiece:!0})` |
| 查看竞品数量 | `/amount`（关键词竞品数量） | `keyword` | `26.js > lookConpete(row,"/amount")` |

**待主 Agent 裁决**：`/keywords/source` 在本站没有对位路由；可选方案是把它建成 `/compete` + `/amount` 的合并页，或建成本页行内 Drawer 的独立化。

---

## 1. 页面路由与标题

- 路由：`/reverse`，路由 name `reverse`，`meta.title = "反查流量词|Sif"`
- 主 chunk：`26.79e84b23.js`（172 个端点），依赖公共 chunk `0/2/8/12`
- URL query 参数（页面从 URL 读初始态，`26.js > mounted` + `W.j.qs(...)`）：

| query | 用途 | 来源 |
|---|---|---|
| `asin` | 初始查询 ASIN，有值即自动触发查询 | `created:function(){var e=W.j.qs("asin");e&&(this.searchValue=e,this.asin=e,this.isSearch=!0)}` |
| `isListingSearch` | 是否按父体（Listing）聚合查询，字符串 `"true"` 或布尔 | `r=W.j.qs("isListingSearch"),e.isListingSearch="boolean"==typeof r?!!r:"true"===r` |
| `trafficType` | 预设流量类型筛选（值域见 §7 流量类型枚举） | `c=W.j.qs("trafficType")` |
| `condition` | 旧式入口筛选，经 `re` 映射转 trafficType | `re={nfPosition:B.q.nf,isSpAd:B.q.sp,isBrandAd:B.q.sb,isVedioAd:B.q.sbv}` |
| `piece` / `date` | 时间粒度类型 + 值 | `timeQuery:function(){var e=this.$route.query,t=e.piece,n=e.date...}` |
| `country` | 站点（全站公共，来自 vuex `countryCode`） | `query:function(){var e={country:this.currentSite}...}` |

页面用 `$replaceRouteParams({asin,isListingSearch,trafficType})` 回写 URL（`26.js > searchBtn`）。

---

## 2. 页面区块拆解

区块顺序取自页面根模板 `26.79e84b23.js @311300-321500`。

### 2.1 搜索区（顶部，常驻）

- 组件 `Search` → 内部包 `CommonSearch`，`selectConfig:{multiple:!1,isAllSelect:!1}`（**单 ASIN 输入**）
- 控件：ASIN 输入框、站点选择、时间粒度选择器（`modelData:e.timePiece`）、示例 ASIN 面板、查询按钮
- 交互：`Enter` 提交（`handleKeyCode:function(e){13==e.keyCode&&...this.searchBtn()}`）
- 前端校验：`if(!Object(Q.Q)(C))return void this.$message({message:"您输入的ASIN格式不正确",type:"warning",center:!0})`
- `searchBtn` 有 200ms debounce：`searchBtn:Object(Ae.debounce)(200,function(){...})`

### 2.2 mainVariantsWrap — 主体/变体切换条

- 组件 `mainVariantsWrap`，props `asin / topAsin / pasin / isListingSearch / timeParams`
- 用途：父体 ↔ 子体切换，`isListingSearch` 为 true 时按父体（Listing）聚合
- 相关子组件 `parentChild`（`26.js @169286`），默认 params `{asin:"",isListingSearch:!1,pageNum:1,pageSize:7,sortBy:"score"}`
- 卡片指标（`26.js @169369`）：父体卡 `流量得分 / 相比上期`；子体卡 `流量得分 / 流量占比 / 相比上期 / 影响父体`
- 翻页是 ASIN 维度的左右箭头（`prevClick` / `isFirstPage` / `isLastPage`），非表格分页

### 2.3 PieChart — 流量结构饼图

- 组件 `ReversePieChart` / `ReversePie`（`26.js @131900`），三环饼图 `baseConfig:[{center:"15%",radius:"75%"},{center:"50%",radius:"70%"},{center:"80%",radius:"65%"}]`
- 数据 prop `originData`，读字段：`nfScore / nfScoreRatio / adScore / adScoreRatio / recScoreList / dates / list`
- 环 1（自然/广告）：`oe` 数组，field `adScore` / `nfScore`；配套 `xxxScoreRatioDisplay / xxxScoreRatioPercent / xxxScoreRatio`
- 环 2/3（广告细分）：`ce` 数组，field `recSpScore / sbScore / sbvScore / spScore`
- Tooltip 显示 `占比` 与 `相比上期`（读 `data.info.scoreChangeRatio`）
- **接口未在本 chunk 定位**：`overviewData` 由页面外层注入，素材未覆盖其请求

### 2.4 日流量趋势区（`dynamic_block`）

- 标题「日流量趋势」，可折叠（`CollapseBtn`，`storage-key:"reverse_dynamic_collapsed"`）
- Keepa 图：`serviceApi:"/api/search/asinOpTrafficTrend"`，`tip:"点击柱子可快速定位流量变化的类型和主要关键词"`
- 切换控件：`selMode`（自然-广告 / 曝光，`storage-key:"reverse_nf_ad_mode"`）、`ParentOrChildBtn`
- 右侧「快速切换 / 常看产品」：`历史记录产品 →`、`SearchExamplePanel`、`products` 列表
- 外链按钮：`linkBtn name:"查看全部运营动作" url:"/timemachine-traffic"`
- 点击柱子 → `clickKeepaChart(date)` → 更新 `dynamicFetchParams.date` → `getDynamicInfo()`

### 2.5 当日关键词三联表（折叠区内，`isListingSearch` 为 true 时隐藏 core/head 两块）

| 子块 | 组件 | 接口 | 说明 |
|---|---|---|---|
| 主要流量词 | `BaseToadyKeywordTable ref=mainKeywordRef` type=`core` | `/api/search/asinOpTrafficTrend/coreKeywords` | 自然侧 |
| 广告头部词 | `BaseToadyKeywordTable ref=mainAdKeywordRef` type=`head` | `/api/search/asinOpTrafficTrend/headKeywords` | 广告侧 |
| 自然词动态 | `NfKeyword` | 复用 dynamic 数据 | 有 `isNfInKeywords` 开关 |

- `core`/`head` 枚举：`pe={core:"core",head:"head"}`；埋点键 `Ne={core:{tab:"naturalKeywordTab",...},head:{tab:"adKeywordTab",...}}`
- 两表都返回 `{list, suggestList, campaignRemark}`，前端给 list 打 `isTarget:!0` 并算 `polarRank`
- 动态表列（`26.js @160800` 一带）：`关键词 / 流量变化 / 影响原因 / 日期 / 变体及排名 / 获得曝光的变体 / 进入时排名 / 动态`
- 动态表空文案：`emptyText:"暂无数据，请重新选择"`
- 动态表分页：`pageSize:10, pageNum:1`，`maxPageNum` 前端按 `Math.ceil(originTableData.length/pageSize)` 算 → **前端分页，不发请求**

### 2.6 流量词总览条（`revTableWrap` 内的 overview）

- 可折叠：`onOverviewToggle` + 埋点 `trafficOverviewToggle({eventEntityValue:e?"collapse":"expand"})`
- 每个流量类型一格，格内 4 个数：`total`（本期）/ `prev`（上期）/ `in`（+新进）/ `out`（-流失）
- `total` 一格额外显示 `历史累计{historyTotal}`（仅 `totalPeriod` 且 `historyTotal!==0`）
- **点数字即筛选**：`setConditions(t, cntEnum.total|in|out)` → 写入 `conditions` → 重查表格
- `out` 数字旁有 `downloadBtn`（导出流失词，`/api/updown/asinKeywordList/outKeywords/download`）
- 时间选择器 `timerSelect`；默认文案 `timePieceText:{currentText:"最近7天",prefixText:"上个7天"}`

### 2.7 流量词主表（页面核心，`revTableWrap` → `el-table ref=myTable`）

- 左侧固定两列：序号 `ColNum`（width 62，`isSticky:!0`）+ `流量词`（width 158，`class-name:"shadow reverse_sticky_two"`）
- 可选列由 `visibleColumns` 控制，列开关弹窗 `ColumnSettingDialog`（分 3 组，见 §6）
- 表内搜索框：`searchBtnKey(){this.$emit("searchKeyword",this.keywordSearch)}` → 参数 `keywordSearch`
- 批量条 `TableBatch`：`对比排名（n/10）` / `复制（n）`
- 行操作列（width 105）：`CikuAction`（加词库+标相关性）、`ViewRank`、`查看竞争格局`、`查看竞品数量`、`downloadSearchTrend`
- 表格空文案：`emptyText:"暂无数据，请重新选择"`
- 页面级空状态组件 `empty` + `emptyReasons`（见 §8）

### 2.8 弹窗/抽屉（页面级）

| ref | 组件 | 用途 |
|---|---|---|
| `wordFreq` | `WordFreq` | 词频统计，`wordFrqTypeKey:"asinKeywordsWordFrq"` |
| `mixedDrawer` | `mixedDrawer` | 排名/搜索量趋势抽屉 |
| `compareKeyword` | `compare-keyword` | 多词排名对比（≤10 词） |
| `explainColorDialog` | `ExplainColorDialog` | 排名颜色说明 |
| `memberDialog` | `memberDialog` | 会员限制（code 1104 触发） |
| `renew` / `renewOpen` | 续费提醒 | 进页时 `Object(S.r)()` 判断 `needPopup` |

---

## 3. 交互流程

```
输入 ASIN + Enter/点查询
  → 前端 ASIN 格式校验（不通过 → toast「您输入的ASIN格式不正确」）
  → $replaceRouteParams({asin,isListingSearch,trafficType})
  → 并发触发：
      getTableOverview()  POST /api/search/asinKeywordOverview   （总览条）
      getTableInfo()      POST /api/search/asinKeywordList        （主表）
      getDynamicInfo()    POST /api/search/asinOpTrafficTrend...  （日趋势 + 当日词表）
      Keepa 图             /api/search/asinOpTrafficTrend
  → 主表返回后，对 list 中 isMonitor 为真的行收集 keyword，
    追加一次 POST /api/search/asinKeywords/monitorSnapshot 回填 monitorSnapshot / canShowRank
```

各交互动作对应的请求变化（均走 `changeTableParamsAndFetch` → 重新 `getTableInfo`）：

| 用户操作 | 改动的请求参数 | 是否重置页码 | 来源 |
|---|---|---|---|
| 点列头排序 | `sort` + `desc` | 是 | `handleSortChange({column,order})→changeTableSortProvide({sort:column.property,desc:"descending"===order})` |
| 翻页 | `pageNum` | 否 | `changeTablePage(e){changeTableParamsAndFetch({pageNum:e},{needResetPage:!1})}` |
| 表内搜关键词 | `keyword` | 是 | `changeKeyword(e){changeTableParamsAndFetch({keyword:e})}` |
| 点总览条数字 | `conditions` (+可能改 `sort`) | 是 | `changeTypes({conditions,trafficType})` |
| 切筛选下拉 | `conditions` | 是 | `changeFilterType(e)` |
| 切时间粒度 | `timePieceType` + `timePieceValue` | 是 | `getCommonParams()` |
| 切流量占比列的流量类型 | 前端切 `tableTrafficFieldMapping[type]`；若当前排序含 `scoreRatio` 则同步改 `sort` | 是 | `trafficTypeChangeCallback` |
| 点刷新 | 全部重取，`needResetFetchParams:!0` | 是 | `handleRefresh` |

切流量类型时改排序的逻辑：
`this.tableFetchParams.sort.indexOf("scoreRatio")>-1&&(l.sort=ue[u]+".scoreRatio")`

请求取消：每个 fetch 方法带 `cancelToken`，同名请求先 `cancelService(name)`（`26.js > cancelService`）。

---

## 4. 接口契约表

### 4.1 当前 `/reverse` 实际调用的接口

| 方法 | 路径 | 请求参数 | 响应字段 | 触发场景 |
|---|---|---|---|---|
| POST | `/api/search/asinKeywordList` | `asin`, `listingSearch`, `timePieceType`, `timePieceValue`, `pageNum`（实测 body 用 `page` ⚠️）, `pageSize`(50), `sortBy`, `desc`, `conditions[]`, `keyword`, `keywordSearch` | `code`, `message`, `consumeIntegral`, `balanceIntegral`, `data.list[]`（**行含 `keywordId`，实测**）, `data.total`, `data.pasin`, `data.campaignRemark{spCampaignId→{campaignName,campaignColor}}` | 查询/翻页/排序/筛选/搜词 |
| POST | `/api/search/asinKeywordOverview` | `asin`, `listingSearch`, `timePieceType`, `timePieceValue` | `data.{totalPeriod\|nfKeywordCnt\|adKeywordCnt\|allSpKeywordCnt\|spKeywordCnt\|recSpKeywordCnt\|allSbKeywordCnt\|sbKeywordCnt\|sbvKeywordCnt}.{total,prev,in,out}`, `data.historyTotal` | 查询时（与主表并发） |
| POST | `/api/search/asinKeywords/monitorSnapshot` | `asin`, `listingSearch`, `timePieceType`, `timePieceValue`, `keywords[]` | `data.list[].{keyword, isHour, crawlerStatus, days, totalDays, leftDays, isRenew, history, allRankHistory, queryParams}`, `data.campaignRemark` | 主表返回后，对 `isMonitor` 行补拉 |
| POST | `/api/search/asinKeywordListWordFrq` | `asin`, `sortBy:"searchWeightByAmzMode"`, `desc:true`, `wordModel`(`one\|two\|three`), `timePieceType`, `timePieceValue`, `isListingSearch`, `conditions:[]` | `data.words[].{word, translateKeyword, searchWeightByAmzMode, frq}` | 点「词频统计」 |
| POST | `/api/search/asinOpTrafficTrend/coreKeywords` | `dynamicFetchParams`（含 `asin`,`date`,`timePieceType`,`timePieceValue`） | `data.{list[], suggestList[], campaignRemark}` | 日趋势区加载 / 点柱子 |
| POST | `/api/search/asinOpTrafficTrend/headKeywords` | 同上（另有 `mine` 开关） | 同上 | 同上 |
| POST | `/api/search/compare/asinKeywords` | `type`(1=自然排名/2=SP广告排名), `asin`, `keywords[]` | `data.chartModelData.{keywordLastRankHistory\|keywordAdLastRankHistory}{kw→{date[],rank[]}}`, `data.listModelData` | 勾选多词 → 对比排名（≤10） |
| POST | `/api/search/asinKeywordRankHistory` | `asin`, `keyword`, `isListingSearch`, `lastMonths` | `data`（趋势抽屉数据，字段素材未覆盖细节） | 打开排名趋势抽屉 |
| POST | `/api/search/asinKeywordTypeHistory` | 素材未覆盖 payload | 素材未覆盖 | 排名类型历史 |
| POST | `/api/search/keywordImgs` | 素材未覆盖 payload | 关键词下产品图 | `hoverImg` 悬浮取图 |
| POST | `/api/user/focusKeywordRelevance/add` | `groupid`, `keywords[]`, `relevance`(`high\|middle\|low\|no`) | `data.isSuccess` | 行操作 → 标相关性 + 加词库 |
| POST | `/api/user/focusKeywordRelevance/batchAdd` | 素材未覆盖（批量版同上） | 素材未覆盖 | 批量加词库 |
| POST | `/api/user/focusKeywordTag/handle` | 素材未覆盖 | 素材未覆盖 | 词标签操作 |
| POST | `/api/updown/asinKeywordList/download` | 与 `asinKeywordList` 同参 | `blob`（`responseType:"blob"`） | 下载关键词 |
| POST | `/api/updown/asinKeywordList/outKeywords/download` | 同上 | `blob` | 总览条 out 数旁的导出 |
| POST | `/api/updown/asinKeywordListWordFrq/download` | 与词频同参 + `word` | `blob` | 下载词频 |

来源：`26.79e84b23.js @166468-169400`（接口封装 `At/bt/_t/Ct/St/xt`）、`@290612`（`getListServiceFn`）、`@304400-307900`（`getTableOverview`/`getTableInfo`/`getMonitorSnapshotInfo`）、`@353917 LB1u`、`@612300`。

### 4.2 你的域清单里 `/api/search/asinKeywords` 的实际归属（**已实测下线**）

> **主 Amp 实测结论：`/api/search/asinKeywords` 返回 404，接口已下线。**
> 因此「复刻哪一代」不再是开放问题 —— **只复刻新版 `asinKeywordList`**。
> 以下旧版内容仅作历史对照，**不作为建表/复刻依据**。

`/api/search/asinKeywords` 在 `26.79e84b23.js` 里**只以封装函数存在（`LB1u` 模块的 `.c`），本页未调用**。
唯一调用点在 `41.f781c26c.js`（即 `/old_reverse`）—— 该页面依赖的接口已 404，属残留死代码：

| 方法 | 路径 | 请求参数 | 响应字段 | 触发场景 |
|---|---|---|---|---|
| POST | `/api/search/asinKeywords` | `asin`, `timePieceType`(默认 `latelyDay`), `timePieceValue`(默认 `"7"`), `pageNum`, `pageSize`(**100**), `sortBy`, `desc`, `needWF`, `conditions[]`, `keyword`(仅当搜索框非空) | `code`, `consumeIntegral`, `balanceIntegral`, `data.keywords[]`, `data.total`, `data.historyTotal`, `data.globalKeywordNum`, `data.hasVaiants`, `data.isParentAsin`, `data.hasValidVaiants` | `/old_reverse` 查询 |
| POST | `/api/updown/asinKeywords/download` | 同上 | `blob` | 旧版下载 |
| POST | `/api/search/asinKeywordsWordFrq` | 与词频同参 | `data.words[]` | 旧版词频（`26.js` 也封装了，键名 `wordFrqTypeKey:"asinKeywordsWordFrq"` 仍在用） |

来源：`41.f781c26c.js @213793`（`LB1u` 封装）、`@110950`（`getKeyword` 调用 + 响应解构）、`@85269`（`params` 默认值）。

注意口径差异：新版 `data.list` + `pageSize:50`，旧版 `data.keywords` + `pageSize:100`。

### 4.2.1 新版 `asinKeywordList` 的实测补充

主 Agent 实测 `POST /api/search/asinKeywordList`：

```
body: {asin:'B01N5IB20Q', timePieceType:'month', timePieceValue:'2026-08', page:1, pageSize:5}
```

实测确认的两点，前端静态素材看不到：

1. **响应行含 `keywordId`（int）**，例 `keywordId: 4293091`。压缩模板只渲染 `keyword` 文本、不渲染 ID，
   所以 chunk 里搜不到该字段。**这是关键词的稳定主键**（跨站点 US/UK/DE 验证 ID 段不重叠，详见 `keywords.dict.md` §0.1）。
2. **流量渠道是 7+ 个同构嵌套对象**（`scoreInfo` / `nfScoreInfo` / `adScoreInfo` / `allSpScoreInfo` /
   `spScoreInfo` / `recSpScoreInfo` / `allSbScoreInfo` / `sbScoreInfo` / …），每个内部相同 5 个指标
   （`score` / `scoreRatio` / `scoreChange` / `scoreChangeRatio` / `contriChangeRatio`）。
   与我从 `26.js @130400` 的 `ue` 映射静态读出的 9 个渠道完全对齐（实测省略号处即第 9 个 `sbvScoreInfo`）。

⚠️ 实测 body 用的分页键是 `page`，而 chunk 里前端状态与请求都用 `pageNum`
（`ae={pageSize:50,pageNum:1,...}`，`el-pagination current-page:e.params.pageNum`）。
**后端可能同时接受 `page` 与 `pageNum`，或 `page` 是别名** —— 待主 Agent 确认以哪个为准。

跨站点词数实测（同一 ASIN `B01N5IB20Q`）：US 123 词 / UK 15 词 / DE 20 词
→ 印证「ASIN × 关键词」的任何存储都必须带 `country` 进主键。

### 4.3 你的域清单里其余端点的归属（重点任务 3）

| 端点 | 归属页面 | 干什么 | 依据 |
|---|---|---|---|
| `/api/search/keywordFunnel/list` | **`/conversion-rate`（关键词转化率）**，chunk `40.a20352a7.js` | 按**关键词列表**（不是 ASIN）查转化漏斗；请求 `{keywords[], strategy, matchTypes[], pageNum, pageSize:100, sortBy, desc, customPrice, customProfitRate}`；响应 `data.keywords[]` + `data.total` + `data.weekDate` | `40.js @99416` 封装；`@131513` 调用点；`@126013` `oe={pageSize:100,pageNum:1,sortBy:"",customPrice:"",customProfitRate:"",desc:!0}`；`typeKey:"keywordConversion"` |
| `/api/search/asinKeywordsWordFrq` | 旧版 `/old_reverse` 词频（新版对应 `asinKeywordListWordFrq`） | **词根/单词词频聚合**：把关键词打散成单词，按「搜索量加权词频」和「出现次数词频」统计 | `26.js @506753` 封装；`@407200` 表头 `词频 / 翻译 / 搜索量加权词频(亚马逊官方方法) / 出现次数词频 / 操作`，行字段 `word / translateKeyword / searchWeightByAmzMode / frq` |
| `/api/search/keywordGroupWordFrq` | 词库分组维度的同类词频 | 与上同结构，输入是词库分组而非单 ASIN。**本页未调用**，只在 chunk 内有封装 `26.js @505061` | `26.js @505061` |
| `/api/search/focusKeywords` / `focusKeywords/cpcCategory` / `focusKeyword/demandInsight` | 词库（`/words`）相关，本页未调用 | 素材未覆盖调用点 | `26.js @504xxx` 仅封装 |
| `/api/user/search/focusKeywordNumGroups` / `focusKeyword/handle` / `focusKeywordAdd/variantKeywordRelevance` / `focusKeywordRelevance/regroup` / `focusKeyword/relevanceBatchAdd` | 词库写操作 | 本页只用到 `focusKeywordRelevance/add`（加词库+标相关性）；其余是词库页/筛查页的操作 | `26.js @612300-613500`、`@501315` |
| `/api/search/keywordSearchKeyword` | 关键词搜关键词，属 compare 模块封装 | 本页未调用 | `26.js @323807` 与 `compare/asinSummary`、`compare/asinMagic` 同模块 |

**「搜索量加权词频」算法（页面 tooltip 原文，`26.js @408100`）**：
> 将关键词打散为单词，然后将单词所在的关键词的搜索量排名取倒数并乘以100万，最后将得分相加，就得到每个单词经过搜索量加权之后的词频

**结论**：这三个都不是"漏斗"就是"词频"——`keywordFunnel/list` 是**另一个页面的转化率漏斗**（应归 `/conversion-rate` 域），
`asinKeywordsWordFrq` 与 `keywordGroupWordFrq` 是**同一套单词级词频聚合**，只是输入维度不同（ASIN vs 词库分组）。
它们的返回结构一致且与关键词行数据正交，**需要独立实体**（见 dict 的 `word_frequency`）。

---

## 5. 分页机制

**页码分页**（不是游标分页）。

| 项 | 值 | 来源 |
|---|---|---|
| 页码参数 | `pageNum`，1-based | `ae={pageSize:50,pageNum:1,...}` |
| 每页条数 | **50**（`/reverse`）；**100**（`/old_reverse`）；固定值，无 UI 切换 | 同上 / `41.js @85269` |
| 总数返回 | `data.total`（整数） | `e.tableDataInfo=f()({},h.data||{},{list:y,pageNum:...})` + `total:function(){...}` |
| 分页控件 | `el-pagination layout:"prev, pager, next, jumper"`，仅 `total>0` 时渲染 | `26.js @246176` |
| 序号计算 | `(pageNum-1)*pageSize+1+index` | `41.js @162436`（旧版显式；新版由 `ColNum` 组件按 `pageSize`/`pageNum` 算） |
| 额外计数 | `data.historyTotal`（历史累计词数）、`data.globalKeywordNum`（旧版） | `getKeyword` / overview `historyTotal` |

翻页只改 `pageNum`，其他参数保持（`changeTablePage` 传 `needResetPage:!1`）。
任何筛选/排序/搜索变更都会强制 `pageNum:1`（`changeTableParamsAndFetch` 里 `pageNum:e&&e.pageNum||1`）。

变体卡片区是**独立分页**：`pageSize:7`，左右箭头翻 ASIN（`26.js @169286`）。
当日词动态表是**前端分页**：`pageSize:10`，`maxPageNum` 由本地数组长度算出。

---

## 6. 排序与筛选项

### 6.1 排序

- 请求字段名：前端状态叫 `sort`，**发出去时改名为 `sortBy`**：
  `l.sort, d=i()(l,["sort"]), St(f()({},d,{sortBy:l.sort}), ...)`（`26.js > getTableInfo`）
  → 后端收 `sortBy` + `desc`（布尔）
- 默认排序：`sort:"scoreInfo.scoreRatio", desc:!0`（`ae`）
- 排序方向只有两档且降序优先：`sAbz > a={name:"custom",orders:["descending","ascending"]}`

可排序字段（列头挂 `sortable`）：

| 排序值 | 对应列 | 备注 |
|---|---|---|
| `<scoreInfoField>.scoreRatio` | 流量占比 | `scoreInfoField` 随流量类型切换，见下表 |
| `<scoreInfoField>.scoreChange` | 流量变化（变化类型=流量变化） | |
| `<scoreInfoField>.contribution` | 流量变化（变化类型=变化贡献度） | |
| `nfLastRank` | 最新自然排名 | |
| `spLastRank` | 最新 SP(常规) 排名 | |
| `estSearchesNum` | 搜索趋势（搜索量） | |
| `clickPurchaseRatio` | 关键词点击转化率 | |
| `clickShared` | ABA Top3 集中度（默认 field） | `AbaTop3 props.field default "clickShared"` |
| `cpc.<strategy>` | 建议竞价 | `propField:"cpc."+e.cpcValue` |
| `searchWeightByAmzMode` | 词频表固定排序 | 仅词频接口 |

流量类型 → scoreInfo 字段映射（`ue`，`26.js @130400`）：

| 流量类型 | scoreInfo 字段 | 总览条计数字段 |
|---|---|---|
| `total` | `scoreInfo` | `totalPeriod` |
| `nf` | `nfScoreInfo` | `nfKeywordCnt` |
| `ad` | `adScoreInfo` | `adKeywordCnt` |
| `allSp` | `allSpScoreInfo` | `allSpKeywordCnt` |
| `sp` | `spScoreInfo` | `spKeywordCnt` |
| `spRec` | `recSpScoreInfo` | `recSpKeywordCnt` |
| `allSb` | `allSbScoreInfo` | `allSbKeywordCnt` |
| `sb` | `sbScoreInfo` | `sbKeywordCnt` |
| `sbv` | `sbvScoreInfo` | `sbvKeywordCnt` |

### 6.2 筛选：`conditions` 数组

`conditions` 是**字符串数组**，元素形态 `"<计数字段>.<in|out|total|prev>"`，默认 `["totalPeriod.total"]`。

```
te={totalPeriod:"totalPeriod",nfKeywordCnt:"nfKeywordCnt",adKeywordCnt:"adKeywordCnt",
    allSpKeywordCnt:"allSpKeywordCnt",spKeywordCnt:"spKeywordCnt",recSpKeywordCnt:"recSpKeywordCnt",
    allSbKeywordCnt:"allSbKeywordCnt",sbKeywordCnt:"sbKeywordCnt",sbvKeywordCnt:"sbvKeywordCnt"}
ne={in:"in",out:"out",total:"total",prev:"prev"}
ae={pageSize:50,pageNum:1,sort:"scoreInfo.scoreRatio",desc:!0,
    conditions:[te.totalPeriod+"."+ne.total],keyword:""}
```

同一个 `conditions` 数组还承载**词特征筛选下拉**（`ie`，单选，值直接 push 进 conditions）：

| 显示名 | value | 分隔 |
|---|---|---|
| 全部 | `""` | |
| AC推荐词 | `isAC` | |
| 多变体自然位词 | `isMultiVariantKw` | |
| 搜索量同比增长词 | `isSearchVolUpKw` | |
| 搜索量同比下降词 | `isSearchVolDownKw` | divider |
| 精准流量词 | `isAccurateKw` | |
| 精准长尾词 | `isAccurateTailKw` | |
| 有效出单词 | `isPurchaseKw` | |
| 转化优质词 | `isQualityKw` | |
| 转化平稳词 | `isStableKw` | |
| 转化流失词 | `isLossKw` | |
| 无效曝光词 | `isInvalidKw` | |

来源：`26.js @128725 ie=[{name:"全部",value:""},{name:"AC推荐词",value:"isAC"},...]`

旧版 `/old_reverse` 的 `conditions` 是**布尔对象**再转数组（`41.js @85269`）：
`conditions:{nfPosition:!1,isSpAd:!1,isBrandAd:!1,isVedioAd:!1,isAC:!1,isER:!1,isTR:!1,isPurchaseKw:!1,isQualityKw:!1,isStableKw:!1,isLossKw:!1,isInvalidKw:!1,isAccurateKw:!1,isAccurateTailKw:!1}`
→ 通过 `getObjectKeys(conditions)` 转成 `conditionsList` 数组。旧版多了 `isER`（Editorial Recommendation）、`isTR`（Top Rated）。

### 6.3 其他筛选/切换控件（不进 conditions，属列内切换）

| 控件 | 状态字段 | 取值 | 影响 |
|---|---|---|---|
| 流量占比列 流量类型下拉 | `tableTrafficType` | 9 种流量类型 | 改列取值字段，可能改 `sort` |
| 流量变化列 变化类型下拉 | `changeComparedType` | `scoreChange`（流量变化）/ `contribution`（变化贡献度） | `fe={scoreChange:"scoreChange",contribution:"contribution"}` |
| 流量分布列 分布类型下拉 | `trafficDistributionType` | `nfAd`（自然-广告）/ `ad`（广告分布） | `he={nfAd:"nf_ad",ad:"ad"}` |
| 建议竞价列 策略下拉 | `cpcValue` | 见 §7 CPC 策略 | 改 `cpc.<strategy>` 取值/排序 |
| 搜索趋势列 粒度 | `granularity` / `trendMode` | `day` / `week` / `month`；默认 `week`（显示"周"） | `v={day:"day",week:"week",month:"month"}` |
| 搜索量 / ABA 排名 切换 | `keywordDataType` | `search` → 用 `estSearchesNum`；否则用 `searchesRank` | tooltip `点击切换为"ABA排名"数据展示` |
| 时间粒度 | `timePiece` | 见 §7 时间粒度 | 改 `timePieceType`/`timePieceValue` |
| 父体/子体 | `isListingSearch` | 布尔 | 改 `listingSearch`，并影响可见列 |

### 6.4 列开关（`ColumnSettingDialog`，3 组 14 列）

```
me = REVERSE_COLUMN_KEYS = {
  TRAFFIC_RATIO:"trafficRatio", TRAFFIC_CHANGE:"trafficChange", TRAFFIC_DIST:"trafficDist",
  IMPRESSION_POS:"impressionPos", NATURAL_RANK:"naturalRank", SP_RANK:"spRank",
  SP_FEATURED:"spFeatured", RANK_TREND:"rankTrend", SEARCH_TREND:"searchTrend",
  SUGGESTED_BID:"suggestedBid", CLICK_CVR:"clickCvr", ABA_TOP3:"abaTop3",
  TOP10_PRODUCTS:"top10Products", VARIANT_EXPOSURE:"variantExposure" }
```

| 分组 | key | 列标签 | 宽度 | 取值字段 |
|---|---|---|---|---|
| 流量 | `trafficRatio` | 流量占比 | 90 | `<scoreInfoField>.scoreRatio`（主）+ `.score`（副行） |
| 流量 | `trafficChange` | 相比上期的流量变化/变化贡献度 | 98 | `.scoreChangeRatio` + `.scoreChange`，或 `.contriChangeRatio` |
| 流量 | `trafficDist` | 自然-广告流量分布 | 120 | `keywordNfScoreRatio` / `keywordAdScoreRatio` / `keywordSpScoreRatio` / `keywordRecSpScoreRatio` / `keywordSbScoreRatio` / `keywordSbvScoreRatio` |
| 流量 | `variantExposure` | 获得的曝光变体及流量占比(仅搜索父体时展示该项) | — | 组件 `ListingVariants`，仅 `isListingSearch` 时渲染 |
| 排名位置 | `impressionPos` | 曝光位置 | 115 | `exposurePositions[]` |
| 排名位置 | `naturalRank` | 最新自然排名 | 122 | `nfLastRank` / `nfLastRankStr` / `nfLastRankAsin` / `nfLastRankTime` / `nfLastRankTimeStr` |
| 排名位置 | `spRank` | 最新SP(常规)排名 | 122 | `spLastRank` / `spLastRankStr` / `spLastRankAsin` / `spLastRankTime` / `spLastRankTimeStr` + `spCampaignId`/`spMaskCampaignId` |
| 排名位置 | `spFeatured` | SP(推荐专栏)位置 | 136 | `recSpScoreList` |
| 排名位置 | `rankTrend` | 排名趋势 | 动态 | `allRankHistory` / `nfHistory` / `spHistorySelf` / `rankHistoryDate` / `polarRank`(前端算) |
| 词竞争 | `searchTrend` | 搜索趋势/ABA排名 | 动态 | `estSearchesNum` / `searchesRank` / `estSearchesNumHistory` / `estSearchesNumHistoryPrev` |
| 词竞争 | `suggestedBid` | 建议竞价 | 90 | `cpc.<strategy>` |
| 词竞争 | `clickCvr` | 关键词点击转化率 | 100 | `clickPurchaseRatio` |
| 词竞争 | `abaTop3` | ABA Top3集中度 | 100 | `clickShared` / `cvrShared`(转化，字段名素材仅见 `t.row.c...` 被截断 ⚠️) |
| 词竞争 | `top10Products` | 最近7天自然流量Top 10产品 | — | `topAsins` / `top10Asins` / `imgs`，元素 `{img, title, price, showImg}` |

固定列（不在开关里）：序号、流量词、操作。

---

## 7. 枚举字典

来源集中在 `26.79e84b23.js @424502` 的 `WlAH` 模块。

### 7.1 流量类型（`_`/`B.q` + 名称 `C`/`B.s`）

| value | 全名（`B.s`） | 简称（`B.c`，去"流量"） | 排名名（`B.p`） |
|---|---|---|---|
| `total` | 全部流量 | 全部 | 全部广告排名 |
| `nf` | 自然流量 | 自然 | 自然排名 |
| `ad` | 广告流量 | 广告 | 广告广告排名 |
| `allSp` | SP广告流量 | SP广告 | SP广告广告排名 |
| `sp` | SP(常规)流量 | SP(常规) | SP(常规)广告排名 |
| `spRec` | SP(推荐)流量 | SP(推荐) | SP(推荐)广告排名 |
| `allSb` | SB广告流量 | SB广告 | SB广告广告排名 |
| `sb` | SB(常规)流量 | SB(常规) | SB(常规)广告排名 |
| `sbv` | SBV流量 | SBV | SBV广告排名 |

`exposurePositions[]` 里的取值是 `nf / sp / recSp / sb / sbv`（注意是 `recSp` 不是 `spRec`，组件里做了转换：`var t="recSp"===e?"spRec":e`）。
`isSource` 模式下额外有 `isLimitedTimeDeal`。

### 7.2 时间粒度（`b`/`B.n`）

| groupid | groupName |
|---|---|
| `latelyDay7` | 最近7天 |
| `latelyDay30` | 最近30天 |
| `week` | 选择某周 |
| `month` | 选择某月 |

请求里拆成 `timePieceType`（`latelyDay` / `week` / `month`）+ `timePieceValue`（`"7"` / `"30"` / 具体周月值）。
默认 `{timePieceType:"latelyDay", timePieceValue:"7"}`（`41.js`）/ `timeInfo:{value:"latelyDay7",type:"latelyDay"}`。
埋点把它归一成 `7d / 30d / week / month`（`changeTime`）。

### 7.3 趋势粒度（`v`/`B.i`）

`{day:"day", week:"week", month:"month"}`；表头 label 见 `label:"day"/"hour"/"week"/"month"`。

### 7.4 CPC 竞价策略（`g`/`B.f`）

| type | name |
|---|---|
| `legacyForSales_exact` | 固定·精准 |
| `legacyForSales_phrase` | 固定·词组 |
| `legacyForSales_broad` | 固定·广泛 |
| `autoForSales_exact` | 提降·精准 |
| `autoForSales_phrase` | 提降·词组 |
| `autoForSales_broad` | 提降·广泛 |

### 7.5 匹配类型（`m`/`B.m`，用于筛查/拓词，本页未直接用）

`0`=全部、`Exact`=精准匹配、`Phrase`=词组匹配、`AllMatch`=广泛匹配、`sameNichId`=相同市场筛选

### 7.6 词频单词数（`A`/`B.j`）

`one`=只看1个单词的词频、`two`=只看2个单词的词频、`three`=只看3个单词的词频（请求字段 `wordModel`）

### 7.7 推荐专栏（`j`/`B.e` + `E`/`B.k`）

| key | 英文名 |
|---|---|
| `Media` | Seen on social media |
| `4Star` | 4 stars and above |
| `fView` | Customers frequently viewed |
| `KOL` | Picks from Amazon Influencers |
| `rBuy` | Recently bought and rated |
| `Trend` | Trending now |
| `New` | New arrivals |
| `tDeal` | Today's deals |
| `other` | （空串，中文兜底"其它"） |

页面 tooltip 提到共 11 个专栏（`了解全部11个推荐专栏`），但代码里只枚举了 8 + other ⚠️。

### 7.8 相关性等级（`levelList`）

| relevance | 显示 | 颜色（`/reverse` 版） |
|---|---|---|
| `high` | 高 | `#009e2c` |
| `middle` | 中 | `#eed44b` |
| `low` | 低 | `#f59a23` / `#ED912F` |
| `no` | 不 | `#d95140` / `#E3574D` |

### 7.9 词特征标签（渲染在关键词单元格内）

字段 `keywordTags` 优先，回退 `kwCharacters` / `conversionCharacters`（`arrayContainBoolean(item.keywordTags||item.kwCharacters, "isXxx")`）：

| 标记 key | 徽标文字 | 归属数组 |
|---|---|---|
| `ac`（+`acDates[]`） | AC | 独立字段，非数组 |
| `isMainKw` | 主要 | `kwCharacters` |
| `isAccurateKw` | 精准 | `kwCharacters` |
| `isAccurateTailKw` | 长尾 | `kwCharacters` |
| `isPurchaseKw` | 出单 | `conversionCharacters` |
| `isQualityKw` | 优质 | `conversionCharacters` |
| `isStableKw` | 平稳 | `conversionCharacters` |
| `isLossKw` | 流失 | `conversionCharacters` |
| `isInvalidKw` | （无效曝光，文字素材未完整截到 ⚠️） | `conversionCharacters` |

旧版还有 `isMultiVariantKw`（多变体自然位）、`isSearchVolUpKw`、`isSearchVolDownKw`、`isER`、`isTR`。

### 7.10 批量操作类型（`se`）

`{compare:"compare", keyword:"keyword"}` → 对比排名（≤10）/ 复制关键词。旧版用数字 `batchType: 1|3`。

### 7.11 业务码（axios 层约定）

| code | 含义 | 处理 |
|---|---|---|
| `1` | 成功 | 正常渲染 |
| `1102` | 词频统计不支持积分使用 | toast `词频统计不支持积分使用` |
| `1103` | 权限/限制 | 清 URL 查询参数，`isSearch=!1` |
| `1104` | 会员功能受限 | 弹 `memberDialog`，数据置 `{list:[],total:0}` |

`code:1` 时若返回 `consumeIntegral`，弹成功 toast：`"本次操作消耗"+consumeIntegral+"积分，还剩余"+balanceIntegral.toLocaleString()`

---

## 8. 空状态 / 加载态 / 错误态（代码原文）

### 8.1 空状态

主表空状态原因清单（`26.js @225110`，组件 `empty` 的 `reasons`）：

```
该ASIN在所选时间段内没有进入过任何关键词搜索结果的前3页
请检查当前使用站点、ASIN 输入是否有误
历史数据仅旗舰会员可查看
叠加的其他搜索条件过于严格，没有匹配结果
积分不足、积分限制
```

触发条件：`e.total&&0!==e.total||e.firstFetch ? 不显示 : 显示 empty`（即非首次加载且 total 为 0）。

其他空文案：
- `el-table` 内置：`emptyText:"暂无数据，请重新选择"`（主表与动态表都是这个）
- 词频弹窗：`this.$message({message:"暂无词频",center:!0,type:"warning"})`，且 `dialogVisible` 立刻关掉
- 转化率页（`40.js`，供参考）：`emptyReasons:["您输入的关键词没有转化率数据，请重新输入","暂无符合当前选择的匹配模式的关键词，请重新选择"]`

### 8.2 加载态

| 状态字段 | 覆盖区域 |
|---|---|
| `tableLoading` | 主表 |
| `tableOverviewLoading` | 总览条 |
| `dynamicLoading` | 日趋势区 |
| `coreKeywordLoading` / `headKeywordLoading` | 当日词两表 |
| `productDataLoading` | 常看产品 |
| `fullscreenLoadingWord` | 词频弹窗 |
| `chartLoading` | 图表 |

配套 `xxxFirstFetch` 布尔位区分"从未加载"与"加载后为空"，用来决定要不要显示空状态。

历史数据慢查询提示（旧版 `getKeyword`）：
```
"latelyDay"==params.timePieceType ? loadText="" :
("week"==type||"month"==type) && (loadText="历史数据为冷数据，查询较慢，请稍候")
```

下载中遮罩：`$loading({lock:!0, text:"文件打包中", spinner:"el-icon-loading", background:"rgba(0, 0, 0, 0.7)"})`

### 8.3 错误态

| 文案 | 触发 | 来源 |
|---|---|---|
| `您输入的ASIN格式不正确` | 前端 ASIN 校验失败 | `searchBtn` |
| `数据量太大，加载超时，请稍后尝试` | 超时 | `WlAH > N` |
| `当前功能为会员功能，请开通旗舰会员` | 会员门槛 | `WlAH > f`（`VIP_FEATURE_TIP`） |
| `旗舰版会员可用` | 下载词频无权限 | `downLoad` 里 `!speInfo.isValidShark` |
| `词频统计不支持积分使用` | code 1102 | `wordCount` |
| `复制成功` | 复制成功 | `doCopy` |
| `标记成功，已加入词库"{groupName}"` | 加词库成功 | `addWordApi` |
| 后端 `message` 原样 toast | 其他非 1 code | `Object(_a.b)(h)||e.$message({message:h.message,type:"warning",center:!0})` |
| 请求取消 | 同名请求重入 | `cancelService(name)` → `cancel[name]("cancel")`，catch 后仅关 loading |

---

## 9. 本页面的不确定清单

### 已由实测关闭

| 原问题 | 结论 |
|---|---|
| ~~`asinKeywords` vs `asinKeywordList` 复刻哪一代~~ | **已关闭**：旧接口实测 404 下线 → 只复刻新版 `asinKeywordList` + `asinKeywordOverview`；`/old_reverse` 页面属残留死代码 |
| ~~关键词有无稳定 ID~~ | **已关闭**：实测响应行含 `keywordId`（int），跨站唯一 |
| ~~流量渠道嵌套对象的完整清单~~ | **已关闭**：实测 7+ 个同构对象，与静态读出的 9 个渠道对齐（§4.2.1、`keywords.dict.md` §4.1） |

### 仍待裁决

1. **`/keywords/source` 无对位路由**（见 §0）。素材里没有"某关键词的流量来源分析"独立页面，只有 `/compete`、`/amount` 两个关键词维度的独立路由和本页的 Drawer。需主 Agent 裁决怎么复刻。
2. **分页参数名 `page` 还是 `pageNum`** ⚠️。前端 chunk 统一用 `pageNum`，主 Agent 实测 body 用 `page` 且成功返回。需确认后端是否两者兼收。
3. **PieChart（流量结构饼图）的接口未定位**。`overviewData` 由 `/reverse` 页面外层传入，本 chunk 里没找到它的请求封装。可能来自公共 chunk（`2`/`8`/`12`）。
4. **`asinKeywordTypeHistory` 的 payload 与响应完全未覆盖**，只找到封装。
5. **`keywordImgs` 的 payload 与响应未覆盖**，只知道给 `hoverImg` 提供关键词下的产品图。
6. **ABA Top3 的"转化"字段名未截全**。模板里 `点击: getPercentage(t.row.clickShared)` 清楚，转化那行被压缩截断成 `t.row.c...`，推测是 `cvrShared` 或 `purchaseShared` ⚠️。
7. **`cpc` 对象的内部结构**只知道按策略 key 取值（`cpc.legacyForSales_exact` 等），值本身是数字还是 `{min,max}` 素材未覆盖 ⚠️。
8. **推荐专栏数量不一致**：tooltip 说 11 个，枚举只有 8 个 + other。
9. **所有字段的类型/量纲无证据**。压缩代码里没有类型信息。只能从格式化函数反推：过 `getPercentage` 的是比率（0-1 小数），过 `moneyFormat`/`localStringNum` 的是数值，过 `format2Str` 的是时间戳/日期串。
10. **"流量得分"（score）的量纲未知**。只知道有 `Math.round(100*score)/100` 的两位小数处理，说明是小数。
11. **`polarRank` 是纯前端计算字段**（`Object(sa.d)(t.allRankHistory,{...})`），不是接口字段，落库不需要。
12. **`campaignRemark` 是与 list 平级的旁挂 map**（`{spCampaignId: {campaignName, campaignColor}}`），前端 merge 进行。属广告域数据，本域只是消费方。
13. **`conditions` 语义混杂**：既承载"计数维度筛选"（`totalPeriod.total`）又承载"词特征筛选"（`isAC`），后端解析规则未知 ⚠️。
14. **`monitorSnapshot` 的 `history` / `allRankHistory` / `queryParams` 内部结构未覆盖**。
15. **`/api/user/*` 那批 focusKeyword 写接口的 payload 大多未覆盖**，本页只确证了 `focusKeywordRelevance/add` 的 `{groupid, keywords[], relevance}`。

# 查销量（/Sales）规格片段

素材：`docs/raw/_probe/chunks/38.fba11644.js`（路由 `/Sales` 的懒加载 chunk，由 `docs/routes.json` 中 `{"path":"/Sales","chunks":[0,2,4,6,38]}` 定位）、`docs/raw/_probe/app.js`（导航表）。
UI 结构与参数名来自静态分析；**接口方法、参数、响应字段已实测验证**（本地代理 + 已登录身份，方法见 `docs/raw/LIVE_PROBE.md`，测试 ASIN `B01N5IB20Q` / `B0BHJJ9Y77` / `B09B8V1LZ3`，站点 US / DE）。

## 1. 页面路由与标题

| 项 | 值 | 来源 |
|---|---|---|
| 路由 path | `/Sales` | `routes.json`；`38.fba11644.js` 内多处 `path:"/Sales"` |
| 路由 name | 空（routes.json 中 `name:""`） | `docs/routes.json` |
| 导航标题 | 查销量 | `app.js > re=[{label:"查销量",path:"/Sales",items:[]}...]` |
| 导航副标题/说明 | 查不同变体或不同属性(Color/Size)销量 | `app.js > oe=[{label:"查销量",path:"/Sales",tip:"查不同变体或不同属性(Color/Size)销量"}...]` |
| 埋点 campaign | `Sales`（`mounted` 时 `Storage.set("campaign","Sales")` 并上报 `operation:"landing"`） | `38.fba11644.js > T.a.set("campaign","Sales")` |

同一个 Vue 组件被 `/Sales` 与「时光机-产品」复用，通过 props `ifTimemachine` / `isCompare` / `simpleMode` 切换分支：
`38.fba11644.js > props:{timemachineParams,isCompare,simpleMode,propKeyword,timePieceType,timePieceValue,ifTimemachine}`。
本文只描述 `/Sales` 分支（`isCompare=false`、`ifTimemachine=false`）。⚠️ 对比销量（`/compare-sales`）走同组件的 `isCompare=true` 分支，接口换成 `/api/compare/**`，本片段只标注不展开。

## 2. 页面区块拆解

### 2.1 搜索区（顶部）

| 项 | 内容 | 来源 |
|---|---|---|
| 搜索粒度切换 | `options:[{groupid:"asin",groupName:"ASIN查产品"},{groupid:"keyword",groupName:"关键词查产品"}]` | `38.fba11644.js > options:[{groupid:"asin",...}]` |
| ASIN 模式 placeholder | `输入ASIN，多个逗号隔开` | 同上 `placeholder:"输入ASIN，多个逗号隔开"` |
| 关键词模式 placeholder | `输入关键词查产品销量` | `changeDay:function(e){..."keyword"==e&&(this.placeholder="输入关键词查产品销量")}` |
| 免费示例默认 ASIN | `B01NBNDC1`（⚠️ 只有 9 位，疑似素材里被截断/占位） | `freeExampleFirstValue:"B01NBNDC1"` |
| 时间粒度选择器 | UI 提供 `最近7天 / 最近30天 / 选择某周 / 选择某月`，默认 `timePieceType:"latelyDay"`, `timePieceValue:"30"`。**实测只有 `月` 与 `最近30天` 真正可用**：`最近7天` 返回空结果、`选择某周` 返回 `服务异常` | `38.fba11644.js > b=[{groupid:"latelyDay7",groupName:"最近7天"},{groupid:"latelyDay30",groupName:"最近30天"},{groupid:"week",groupName:"选择某周"},{groupid:"month",groupName:"选择某月"}]`（模块 `WlAH` 导出 `n`）+ 实测逐值验证 |
| 历史搜索记录 | 进搜索面板时拉取，`searchType` 取 `boughtByAsin` / `boughtByKeyword` / `boughtMultiAsin` | `searchRecord:function(){n="boughtByAsin",e.isCompare?n="boughtMultiAsin":"keyword"==e.isSearchType&&(n="boughtByKeyword")...Object(b.Db)({searchType:n})` |
| 站点切换 | `changeSite`，站点码进 URL `country`，用于货币符号与亚马逊域名 | `changeSite:function(e){Object(U.a)(this,e)}`、`siteCurrency:k.j.siteCurrency(...)` |
| 更新父子体关系 | 按钮 + 悬浮说明「Sif每周更新一次父体与子体关系……点击此按钮可以实时获取最新的父子关系」，调 `/api/user/commit/brandListedRefresh`，返回 `data.isSuccess` / `data.message` | `38.fba11644.js@51680`、`getFather:function(){...Object(o.bb)({asin:e.searchValue},e.currentSite)}` |

ASIN 输入校验：逐个走 ASIN 正则，非法则 `您输入的ASIN格式不正确`；统一 `trim().toLocaleUpperCase()`；中文逗号/空格/Tab 都归一成英文逗号。
关键词模式仅支持 1 个词，超出提示 `搜索超限制，最多支持搜索1个关键词`。

### 2.2 变体维度销量折线图（`ASIN 查产品` 模式）

- 维度切换：`el-radio-group`，按钮文案模板 `"不同"+t.name+"销量"`，选项来自接口 `data.features`，前端再 `unshift({code:"asin",name:"变体"})`。
  来源：`38.fba11644.js > e.featuresList=i.data.features||[],e.isCompare||e.featuresList.unshift({code:"asin",name:"变体"})` 与 `e._l(e.featuresList,...[e._v("不同"+e._s(t.name)+"销量")])`。
  **实测：属性维度是动态的，不止 Color/Size。** 观测到 `["Size"]`、`["Style","Size"]`、`["Color","Configuration"]` 三种组合，所以按钮可能是「不同Style销量」「不同Configuration销量」。截图里的 Color/Size 只是该商品恰好如此。
  `dimension=Size` 时 `chars[].dimVal` 返回属性值（`"240 GB"` / `"480 GB"` / `"960 GB"`）、`features` 为 null；`dimension=asin` 时 `dimVal` 返回 ASIN 码。
- 横轴：`xData:i.data.boughtHistoryDates`。**实测恒为 40 个 `YYYY-MM`（`2023-05` ~ `2026-08`），且不随时间参数变化。**
- 纵轴：`series[].data = t.boughtList.map(e=>({value:e.bought,...}))`，`minInterval:1`。
- series 名编码：`t.dimVal+"^"+t.img+"^"+t.featuresStr`，`featuresStr` 由 `features[].feature + ":" + features[].value` 用 ` | ` 拼接；图例侧 `parseData` 再按 `Size:` / `Color:` 前缀拆回 `size` / `colorTip`。
  来源：`a.push({name:t.dimVal+"^"+t.img+"^"+t.featuresStr,type:"line",...})`、`parseData:function(e){...e.startsWith("Size:")...startsWith("Color:")...}`
- 图例：自绘 `legendData`（缩略图 `img`、`colorTip`、`size`、`boughtInPastMonthBest` 显示「近30天最畅销」徽标、`isSearched` 标记搜索命中的 ASIN）。
- 图表分页：`el-pagination`，`paramsPolar:{pageSize:5,pageNum:1,asins:"",dimension:"asin"}`，即一次只画 5 条线。
- 「下载图表」按钮：`downPolor`，只传 `{asins}`。
- 顶部统计条：
  - 父体命中时显示 `当前搜索的是父体`（由 `isParentAsin` 控制）。
  - 子体命中时显示 `子体{singleSon}` + `最近30天销量` + 值 `boughtInPastMonth`（实测取自折线图接口顶层，是分档串如 `"100+"`）。`singleSon = this.params.asins[0]`。
  - 「最近30天销量」旁 popover：`最近30天销量是亚马逊在前台展示的：xxx+ bought in past month`，另有链接「了解亚马逊前台销量的统计逻辑」和一张示意图（阿里云 OSS 图片）。
  - 来源：`38.fba11644.js@363700-365200`。

### 2.3 ASIN 信息表格

`isMore` 控制列的多寡（`isMore = "keyword"==resType`，即关键词查产品时列更全）。列定义在同 chunk 的 `asinTable` 组件（`38.fba11644.js@315150-323900`）：

| 列 | 显示条件 | prop / 字段 | 说明 |
|---|---|---|---|
| `#` | 始终 | 计算 `(pageNum-1)*pageSize+1+$index`；批量态换成 `el-checkbox`（`row.checked`） | |
| 图片 | 始终 | `hoverBigImg` 组件，输入整行 | |
| ASIN 信息 | 始终 | `asinInfo` 组件：`title`、`features[]`（字符串数组）、`price`、`score`、`ratingNum`、`asin`、`isFocus` | 悬浮 tooltip 显示「评分：x   评论数：y」；点标题跳 `/reverse` |
| 属性 | `isMore` | `row.features[] = {feature, value}`，渲染 `feature: value`，空则 `-` | |
| 品牌 | `ifTimemachine && isMore && !noKeepaDataSite` | `sortEnum.brandName` = `brandName` | `/Sales` 不显示 |
| 上架时间 | 同上 | `sortEnum.firstAvailableDay` = `firstAvailableDay` | `/Sales` 不显示 |
| 评论数 | `isMore` | `ratingNum`，另有 `ratingNumBest` 控制皇冠 | |
| 评分 | `isMore` | prop `star`，取值用 `row.score`，另有 `scoreBest` | 实测两字段并存且都有值：`score`=真实评分(4.8)，`star`=半星取整值(5.0)，关系 `star=round(score*2)/2`。列显示 `score`、排序传 `star`，是有意为之 |
| 价格 | 始终 | `price`，另有 `priceBest`，前缀 `siteCurrency` | |
| 动态属性列 | 顶层 `data.features`（实测为字符串数组，如 `["Style","Size"]`）逐个成列 | 单元格值 `featuresShow(row.features, col)`：按 `column.label` 在 `row.features` 里找 `code===label` 取 `value`；`featureIsBest` 看该项 `boughtInPastMonthBest` 显示「最畅销属性」 | 实测 `row.features[]` 恒为 `{code,feature,value,boughtInPastMonthBest}`，`code` 与 `feature` 值相同，两种键名不冲突 |
| 子体近30天销量 | 始终 | `sortEnum.boughtInPastMonth` = `boughtInPastMonth`，`boughtInPastMonthBest` 显示「最畅销变体」徽标。**实测值是分档字符串**（`"200+"` / `"6,000+"` / `"<50"`），前端直接原样输出，所以截图里的 `20,000+` 是后端给的串 | popover 文案：`子体最近30天销量为{boughtInPastMonth}` / `销量数据源自于亚马逊前台`；非 30 天粒度时文案为 `子体{timePieceValue}销量为{boughtInPastMonth}` |
| 月销量趋势 | 始终 | `polarSale` 组件，prop 排序键 `sortEnum.boughtInMonth` = `boughtInMonth`；数据 `row.boughtHistory[]` + `row.boughtHistoryDates[]` | 迷你 ECharts 折线，`connectNulls:!1`；关键词模式下还会用 `row.pasinBoughtHistory` |
| 操作 | 始终 | 见 2.4 | |

排序枚举（`38.fba11644.js@306333`）：
`J={price:"price",star:"star",ratingNum:"ratingNum",boughtInPastMonth:"boughtInPastMonth",boughtInMonth:"boughtInMonth",brandName:"brandName",firstAvailableDay:"firstAvailableDay"}`，默认 `defaultSort:{sortBy:"boughtInPastMonth",desc:!0}`。

表格分页：`el-pagination`，`layout:"prev, pager, next, jumper"`，`params.pageSize` 默认 100。

结果计数提示（`38.fba11644.js@~318000` 文案区，`vaiantsNum` / `nbVaiantsNum` 组合出 4 种文案）：
- `搜索到{total}个结果`
- `搜索到1个结果，其余{vaiantsNum}个为同组变体`
- `搜索到1个结果，另有{nbVaiantsNum}个变体因月{text}而未展示`（`text` 默认 `"销量<50"`）
- `搜索到1个结果，其余{vaiantsNum}个为同组变体，另有{nbVaiantsNum}个变体因月{text}而未展示`

关键词模式的提示文案不同：`{simpleMode?"所选时间段内":"7天内"} 进入过搜索结果前3页的产品有{totalKey}个，默认按照产品和关键词的相关性排序`。

### 2.4 操作列与批量操作

行内操作（`isMore=false`，即 `/Sales` 的 ASIN 模式，顺序即代码顺序）：
`查流量结构` → `/search?asin=&type=1&country=`；
`反查流量词` → `/reverse?asin=&piece=&date=&country=`；
`查广告架构` → `/adxray-structure?piece=&date=&asin=&country=`；
`查运营节奏` → `/timemachine-traffic?asin=&piece=&date=&country=`。
`isMore=true` 时多一项 `查推荐专栏` → `/recommend?asin=&country=`，且顺序变为 反查流量词 / 查运营节奏 / 查流量结构 / 查广告架构 / 查推荐专栏。
来源：`38.fba11644.js@323640` 起的操作列模板 + `goSearch` / `reverse` / `goAdxray` / `visitTrack` / `goRc` 方法体。

顶部下拉「下载搜索结果」（`funDown` 组件）：主按钮触发 `batchDownAsin`；下拉项在 `isMore` 时是 `对比流量结构`（→ `/compare-structure`）/ `对比流量词`，非 `isMore` 时是 `查流量结构 / 反查流量词 / 查广告架构 / 查运营节奏`（整批 ASIN 一起跳，`handleClick("2".."5")`）；关键词模式下拉项为 `关键词竞争格局` → `/compete?keyword=`。

「批量操作」（`banthDown` 组件）：`批量加入产品库` / `批量复制ASIN`。加入产品库走 `/api/user/focus/handle`（`{type:1|2, asins:[...]}`，`type=2` 是移出，二次确认文案「将此商品ASIN移出产品库，是否继续？」）。

## 3. 交互流程

1. 落地。`created` 读 URL `?asin=`，有值就写入 `searchValue` / `params.asins` 并置 `isSearch=true`；`mounted` 读 `?utm=`、算 `siteCurrency` / `countryUrl`，若有 `asin` 立即调 `searchBtn`，随后上报埋点（`campaign:"Sales", operation:"landing"`）。
2. 点搜索（ASIN 模式，单个 ASIN）。`searchBtn` → 归一化输入 → `resetState()`（时间回落到 `latelyDay/30`、`pageNum=1`、`desc=true`、`sortBy=""`）→ 置 `paramsPolar.asins`、`dimension="asin"`、`searchOptionValue="asin"`、`singleSon=params.asins[0]` → **并行**发两个请求：`getPolar()`（折线图）与 `getData()`（表格，且先 `resetSortTable()`）。
   多个 ASIN 时 `getData` 换成 `/api/search/bought/multiAsin`（`params.asins.length>1`）。
3. 切换折线图维度（不同变体/Color/Size）。`handleSearchOptionChange` → `selType(code)` → `paramsPolar.dimension=code`、`pageNum=1` → 重新 `getPolar()`。表格不动。
4. 折线图翻页。`handleCurrentChangePolar` → `paramsPolar.pageNum` → `getPolar()`，并滚到 `#table-scroll`。
5. 表格翻页。`handleCurrentChange` → `params.pageNum` → `getData()`，滚到 `#table-scroll2`。
6. 表格排序。`handleSortChange` 冒泡 → 更新 `params.sortBy` / `params.desc` → `getData()`。⚠️ 具体的 `sortChange` 外层处理器代码未定位到，按前端 sortEnum 推断。
7. 改时间粒度。`timeValueChange` 写 `params.timePieceType` / `timePieceValue` 后调 `searchBtn()`（整页重查）。
8. 切到关键词模式。`changeDay("keyword")` 清空输入换 placeholder；搜索时走 `getDataKey()`（`/api/search/bought/keyword`），带 `source:"sales"`；此时 `isMore=true`，表格展开评论数/评分/属性等列，折线图区块不展示。
9. 下载。`batchDownAsin` → `/api/updown/boughtByAsin/download`（传 `params` + `source`）；`batchDownKeyword` → `/api/updown/boughtByKeyword/download`（`{keyword,sortBy,desc,source}`）；`downPolor` → `/api/updown/boughtListingHistory/download`（`{asins}`）。三者都走 `handleBoughtDownload`，超额时弹会员弹窗（`memberDialog`）。

## 4. 接口契约表

**已实测**：全部为 `POST`，业务参数走 JSON body，`country` / `_t` 走 query string，响应信封 `{code, data, commonMsg}`，`code:1` 成功。必填参数通过空 body 校验报错反查确认。

| 方法 | 路径 | 请求参数 | 响应字段（`code==1` 时读 `data`） | 触发场景 |
|---|---|---|---|---|
| POST | `/api/search/bought/asin` | 必填 `asins[]`（空 body 报 `asins不能为空`）；可选 `pageNum, pageSize, sortBy, desc, timePieceType, timePieceValue` | `total`, `isParentAsin`, `features[]`(string[]), `vaiantsNum`, `nbVaiantsNum`, `boughtMonth`, `asins[]`；行含 `asin, title, img, ratingNum, ratingNumBest, price, priceBest, score, scoreBest, star, features[]{code,feature,value,boughtInPastMonthBest}, boughtInPastMonth(string 分档), boughtInPastMonthBest, boughtHistoryDates[](40 个 YYYY-MM), boughtHistory[](int/null), pasinBoughtHistory[](实测空数组), isFocus, isVaiant, brand, brandHref, firstAvailableDay, snapshotUpdateTime` + 6 个 keepa 相关字段（实测恒 null） | ASIN 模式单/首个 ASIN 搜索、翻页、排序（`getData`，`b.t`） |
| POST | `/api/search/bought/multiAsin` | 同上，必填 `asins[]` | 同上（实测 `topKeys` 完全一致） | ASIN 模式且 `params.asins.length>1`（`getData`，`b.zb`） |
| POST | `/api/search/bought/listingHistory` | 必填组合（空 body 报 `参数错误`）：`asins[], pageNum, pageSize, dimension` | `features[]`(`{name,code,fetching}`), `total`, `boughtInPastMonth`(string), `pasinBoughtInPastMonth`(string，实测 `"800+"`), `boughtHistoryDates[]`, `pasinBoughtHistory[]`, `chars[]`；`chars[]` 含 `dimVal, boughtList[]{bought,ratio,boughtInPastMonthBest}, img, price, features[], boughtInPastMonthBest` | 折线图初次加载、维度切换、图表翻页（`getPolar`，`b.A`） |
| POST | `/api/search/bought/keyword` | 必填 `keyword`（空 body 报 `keyword不能为空`）；可选 `pageNum, pageSize, sortBy, desc, source, timePieceType, timePieceValue`；`listedSinceRange/listedSinceMonth` 仅时光机 | 与 `bought/asin` 同结构；实测 `brand` / `firstAvailableDay` 在此有值（ASIN 模式为 null），`isParentAsin` / `vaiantsNum` / `nbVaiantsNum` 为 `null` | 关键词模式搜索、翻页、上架时间筛选（`getDataKey`，`b.sb`） |
| POST | `/api/user/searchRecord/search` | `{searchType}`，取值 `boughtByAsin` / `boughtByKeyword` / `boughtMultiAsin` | `total`, `record[]`；每项 21 个字段：`id`(32 hex), `content`, `imgs[]`, `isExample`, `isMonitor`, `isFocus`, `isPasion`, `searchTime`, `updateAt`, `name`, `groups`, `asin`, `title`, `img`, `ratingNum`, `isBestSeller`, `price`, `score`, `star`, `features`, `asinScore` | 展开搜索面板时拉历史/示例（`searchRecord`，`b.Db`） |
| POST | `/api/user/commit/brandListedRefresh` | `{asin}`（第二参传站点） | `isSuccess`, `message` | 点「更新父子体关系」（`getFather`，`o.bb`）。⚠️ 未实测，会触发真实抓取任务 |
| POST | `/api/user/focus/handle` | `{type: 1\|2, asins: [asin]}`（第二参站点） | 只读 `code` / `message` | 单行或批量加入/移出产品库（`focus`，`h.cb`）。⚠️ 未实测，会改动账号数据 |
| POST | `/api/updown/boughtByAsin/download` | `{...params, source}` | **实测 `content-type: application/octet-stream`，响应体以 `PK\x03\x04` 开头 + 含 `_rels/.rels`，即 XLSX（zip）文件流** | 「下载搜索结果」（ASIN 模式，`b.u`） |
| POST | `/api/updown/boughtByKeyword/download` | `{keyword, sortBy, desc, source}`（+ 时光机字段） | 同上，实测确认为 XLSX | 「下载搜索结果」（关键词模式，`b.tb`） |
| POST | `/api/updown/boughtListingHistory/download` | `{asins}` | 同上，实测确认为 XLSX | 「下载图表」（`downPolor`，`b.B`） |

实测补充的接口行为：
- **`country` 非必填但影响数据**：不带 `country` 实测仍返回 `total:3`（有默认站点）；带 `country=DE` 返回不同价格与销量。
- **`sortBy` 有白名单**：非法值返回 `{"message":"参数错误","code":-1}`，可据此穷举（结果见 dict 4.4）。
- **`timePieceType:"week"` 在本域不可用**：实测两个合法格式周值均返回 `{"message":"服务异常，请稍后重试","code":0}`。
- **时间参数不改变返回的历史序列**：无论传 `month`/`latelyDay30`/不传，`boughtHistoryDates` 恒为 40 个月（`2023-05`~`2026-08`）、`boughtHistory` 内容不变；时间参数只决定 `boughtInPastMonth` 取哪一格（逐月实测对照见 dict 二章）。
- **`/api/search/rec/getVariantsInfoApi` 已下线**：实测返回 Spring 404（`"path":"/api/search/rec/getVariantsInfoApi"`）。sales.txt 里这个端点是失效项。
- **`/api/search/asinScoreOverview` 实测可用但不属本页面**：必填 `asin + timePieceType + timePieceValue`，返回的是流量得分结构（`nfScore`/`adScore`/`spScore`/`sbScore`/`sbvScore` 及各自 `{score,scoreRatio,scoreChange,scoreChangeRatio,contriChangeRatio}` 子对象），是「查流量结构」域的数据，`/Sales` 代码路径未调用。

同 chunk 里存在但属于 `isCompare=true`（`/compare-sales`）分支，本页面不触发：
`/api/compare/bought/multiAsin`（`b.L`）、`/api/compare/bought/listingHistory`（`b.M`）、`/api/updown/boughtMultiListingHistory/download`（`b.rb`）。

`source` 参数取值：`boughtSource(){return this.ifTimemachine?"timemachine":"sales"}` → `/Sales` 下恒为 `"sales"`。

**与分派清单的差异（重要，已实测印证）**：`docs/raw/domains/sales.txt` 里的 22 个端点在 38 号 chunk 中只出现了 `/api/search/pageAsinVariants`（作为模块导出 `Ab`，但本组件代码路径未见调用）与 `/api/focus/asin/group/extcmp_list` 等公共 API 模块成员——它们是同一 API 模块 `cIs/` 里的其他导出，被别的页面用。`/Sales` 真正依赖的核心接口是上表的 `/api/search/bought/*` 与 `/api/updown/bought*`，这些**不在** sales.txt 清单里。实测进一步确认：`/api/search/rec/getVariantsInfoApi` 已返回 404 下线；`/api/search/asinScoreOverview` 返回的是流量得分而非销量数据。

## 5. 空状态、加载态、错误态

| 类型 | 文案 / 表现 | 来源 |
|---|---|---|
| 空状态 | `Empty` 组件，`reasons:["站点选择错误","输入的ASIN 子体/父体销量<50"]`；折线图区 `totalPolar===0 && !firstFetch` 时显示，表格区 `total===0 && !firstFetch` 时显示 | `emptyReasons:["站点选择错误","输入的ASIN 子体/父体销量<50"]`；实测 `B07VXWBBBC` 返回 `total:0, features:[], asins:[]` 触发此态 |
| 服务异常 | `服务异常，请稍后重试`（`code:0`）。实测传 `timePieceType:"week"` 时后端返回此错 | 实测 `{"message":"服务异常，请稍后重试","code":0}` |
| 参数校验失败 | `code:-1` + 具体缺失字段名，如 `asins不能为空` / `keyword不能为空` / `参数错误` | 实测空 body 探测 |
| 变体被过滤提示 | `另有{nbVaiantsNum}个变体因月{text}而未展示`，`text` 默认 `"销量<50"` | `text:"销量<50"` + 计数文案模板 |
| 全屏 loading | `fullscreenLoading`（表格），`chartBarLoading`（折线图），`loadingAll`（首次搜索） | `data()` 三个布尔位 |
| 下载 loading | `$loading({text:"文件打包中", spinner:"el-icon-loading"})` | `batchDownAsin` / `batchDownKeyword` / `downPolor` |
| 网络异常 | `网络异常，请稍后重试`（`type:"warning"`，catch 分支且 `!err.response` 时） | `getData` / `getDataKey` catch 块 |
| ASIN 格式错误 | `您输入的ASIN格式不正确` | `searchBtn` / `getFather` |
| 关键词超限 | `搜索超限制，最多支持搜索1个关键词` | `searchBtn` keyword 分支 |
| 对比模式输入不足 | `请输入多个 ASIN` | `searchBtn`（`isCompare` 且只 1 个 ASIN） |
| 试用/会员限制 | `code==1103` 或 `1104` → 清空结果、`clearSearchQueryParams()`、`handleTrialLimitDialog(res)`，否则 toast `res.message` | `getData` / `getDataKey` 的 `1103==a.code||1104==a.code` 分支 |
| 其他失败码 | `limitToast(res)` | `getData` else 分支 |
| 抓取中 | 常量 `"抓取中"`（用于概览指标的占位） | `38.fba11644.js > a=(n("MT78"),"抓取中")` |
| 数据全空 | `isNull = boughtHistory.every(v=>v===null)` 传给迷你图，控制「暂无数据」渲染 | `getData` 内 `e.isNull=n.every(...)` |
| 首次未搜索 | `isSearch=false` 时整个结果区不渲染（`e.isSearch?...:e._e()`） | 模板条件 |
| 顶部引导提示 | `点击这里返回查看数据`；可关闭提示存 `Storage.tipsFolSales` | `knowTips:function(){this.tipsFol=!0,T.a.set("tipsFolSales",!0)}` |

## 6. 本页面不确定清单（实测后修订）

### 已由实测解决（原疑问 → 实测结论）

1. ~~HTTP 方法未知~~ → **全部 POST**，GET 会报 `Request method 'GET' not supported`。
2. ~~`boughtHistoryDates[]` 格式未知~~ → **实测恒为 `YYYY-MM`**，固定 40 项 `2023-05` ~ `2026-08`。
3. ~~`row.features[]` 有三套键名~~ → **实测是三个不同层级的不同字段**：行内 `features[]` 恒为 `{code,feature,value,boughtInPastMonthBest}` 对象数组（`code` 与 `feature` 值相同）；顶层 `data.features` 是属性名字符串数组；折线图接口的 `data.features` 是 `{name,code,fetching}` 对象数组。不存在冲突。
4. ~~`star` 与 `score` 关系不明~~ → **实测 `star = round(score*2)/2`**（半星取整），40 行样本 100% 成立。`score` 是真实评分（4.8），`star` 是半星展示值（5.0）。表格列 prop 用 `star` 排序、取值用 `score` 是有意为之。
5. ~~`boughtInPastMonth` 是滚动窗口值~~ → **实测它就是月序列在所选月份的取值**（逐月对照：请求 `2025-12` → 返回 `"500+"` = 序列该月的 `500`）。且**实测类型是 string 分档串**（`"200+"` / `"<50"` / `"10,000+"`，带千分位逗号），不是 int。
6. ~~`pasinBoughtHistory` 用途不明~~ → **实测 ASIN 与关键词两种模式均返回空数组 `[]`**，本域用不到。`pasinBoughtInPastMonth` 在折线图接口实测有值（`"800+"`），但前端无渲染点。
7. ~~时间粒度支持哪些~~ → **实测本域只有月粒度实际可用**：`month`+`YYYY-MM` ✅；`latelyDay`+`30` ✅（等同不传）；`latelyDay`+`7` 返回空；`week` 返回 `服务异常`。
8. ~~`/api/search/pageAsinVariants` 归属~~ → 实测该接口可用且返回的是**流量得分维度**的变体信息（`score` 是浮点流量得分 2859.33、`ratio` 占比），与 `/Sales` 的销量数据无关。归属别域。
9. ~~下载接口返回什么~~ → **实测 XLSX 文件流**（`application/octet-stream`，`PK\x03\x04` + `_rels/.rels`）。
10. ~~`brandName` 字段~~ → **实测排序键叫 `brandName`，响应字段叫 `brand`**，两者不同名。

### 仍然不确定

11. **父体分支未取到样本。** 实测 5 个 ASIN（含 3 个变体组成员）`isParentAsin` 全为 `false`/`null`。父体命中时响应是否多出字段无法验证，`当前搜索的是父体` 这条 UI 分支未实际触发过。需要一个已知父体 ASIN 补测。
12. **`week` 粒度报 `服务异常` 的原因不明。** 是本域不支持、后端 bug、还是缺参数，从外部无法区分。前端时间选择器却提供了「选择某周」选项。
13. **`boughtList[].ratio` 恒 null。** 两种维度、全部 40 点都是 null，语义无法确定。
14. **写操作未实测**（`/api/user/focus/handle` 会改账号产品库、`/api/user/commit/brandListedRefresh` 会触发真实抓取）。参数名来自静态代码，响应结构只知前端读 `code`/`message`。
15. **`dimension` 参数的非法值静默降级。** 实测传小写 `color`（非法）不报错，静默按 `asin` 维度返回。前端默认值 `featuresList:[{name:"color"},{name:"size"}]` 是小写、接口返回的是首字母大写 `Size`，这个不一致是否导致首屏渲染 bug 未验证。
16. **`total` 与分页的关系。** 实测 `pageSize:5` 返回 5 行但 `total:6`，`pageSize:100` 返回 6 行 `total:6`。未做多页翻页验证。
17. **`sortChange` 的外层处理器未定位。** 子表格 `$emit("sortChange", e)` 有证据，父组件接哪个方法没读到代码（但排序参数 `sortBy` 白名单已实测穷举）。
18. **`chartType` 状态用途不明。** 被 `searchBtn` 置 0 后未见其他写入点。
19. **`snapshotUpdateTime` 恒 null**，可能只在时光机分支填充。
20. **销量的量纲（件数 vs 订单数）。** 代码里「销量」「子体月订单量」「子体月销量」三种中文文案共存；实测值全是 100/200/500/1000 整档，无法从数值反推量纲。页面声明数据源是亚马逊前台 `bought in past month`，按亚马逊定义应为「购买次数」，但这属于外部知识不算实测证据。
21. **`freeExampleFirstValue:"B01NBNDC1"` 只有 9 位。** 实测 `searchRecord` 返回的示例 ASIN 是 `B01NBNDC1T`（10 位），说明静态代码里那个值确实少了尾字符 `T`——是前端常量写错或素材截断，实际走接口取示例时不受影响。

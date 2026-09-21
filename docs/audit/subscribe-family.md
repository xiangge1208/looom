# sif.com「查坑位/推排名」订阅制功能族审计

审计日期：2026-09-21
方法：SPA 静态分析（webpack bundle: app.b278f717.js + 页面 chunk 44/49/55，前端版本 1.6.23）+ 已登录 JWT 实测。
红线遵守情况：全程未调用任何创建/扣积分接口的成功路径；对创建接口仅发送空 body / 缺参 body 各一次（`/api/user/subs/handle`、`/api/monitor/user/handle`），未用完整参数创建任何订阅；未触碰 pay 相关接口。

---

## 功能族总览（三个页面同源设施的证据）

导航结构（来源：app.js 路由表）：

```
{label:"查坑位/推排名", path:"/snapshot", activeUrls:["/snapshot","/dailyrank","/hourlyrank"],
 items:[{label:"坑位快照",path:"/snapshot"},{label:"每日排名",path:"/dailyrank"},{label:"小时排名",path:"/hourlyrank"}]}
```

| 页面 | 路由 | 页面 chunk | 官方 model 名 | 订阅任务性质 |
|---|---|---|---|---|
| 坑位快照 | /snapshot | chunk44（组件模块 `Wo2z`） | `monitorSnapshotKeyword` | 关键词级，固定参数（每小时/前3页/15天/42积分） |
| 每日排名 | /dailyrank | chunk49（组件模块 `mMUn`） | `subscribeSearch` | 关键词级，每天 9 点前更新一次 |
| 小时排名 | /hourlyrank | chunk55（组件模块 `/LW7`） | `monitorKeyword`（内部名"定时查坑位"） | ASIN×关键词对，可自定义频率/页数/时长 |

同源证据：

1. **共用 API 模块**：每日排名（chunk49）与小时排名（chunk55）打包了同一个 API 模块 `NcO7`（`/api/monitor/user/handle`、`/api/monitor/batch/handle`、`/api/search/monitor/*`、`/api/monitor/user/delete`、`/api/search/subscribe/v2` 等 14 个函数，两个 chunk 中逐字一致）。每日排名页也用它停止监控（`monitor/user/delete`）。
2. **共用 HTTP 封装**：模块 `DcyJ`（app.js）——`a`=GET、`b`=POST（JSON body），拦截器自动给所有 URL 追加 `?country=<站点>`（来源：app.js `A.interceptors.request.use`），所以下文所有接口实际请求都带 `?country=US`。
3. **同一套积分体系**：小时排名添加监控前先调积分试算（`/api/property/integral/calcMonitor`，同款 payload 返回 `data.integral`）；坑位快照固定文案 42 积分；每日排名用词数配额（`userSubsInfo.limit`）而非按次计费。
4. **数据同源**：每日排名的 rankInfo 里 `isSubscribe` 标志、`listingRankHistory` 与小时排名矩阵同为关键词×ASIN 排名序列，只是采样粒度不同（天 vs 小时）。

---

## 官方介绍原文（来源：GET /api/sys/modelIntroduce/search?country=US&model=xxx）

### 1. 每日排名（model=subscribeSearch）

- headline：**"每日排名"有什么用？**
- 妙可文案："$每天早上9点^查看今日最新的关键词排名"
- 使用前必读（mustRead.list）：
  1. 每日排名是$整合所有变体排名之后的数据^，方便确认获得曝光的变体
  2. 每日排名$每天9:00前更新^
  3. **高级会员总共可添加50个词，旗舰会员总共可200个词**（配额官方数字）
  4. 每日排名的关键词可从反查页面添加，也可以在本页面手动添加
- 推荐阅读：feishu《深度解读：每天9点前更新排名的魅力与逻辑》

### 2. 小时排名/定时查坑位（model=monitorKeyword）

- headline：**"定时查坑位"有什么用？**
- 妙可文案："$定时监控^自然排名和广告排名"
- 使用前必读：
  1. 小时排名可以监控$自然排名和SP广告排名^
  2. 小时排名可自定义抓取频率（**最快可每小时更新一次**），还可以**自定义每次抓取的页面数量**
  3. 小时排名使用 Sif 的爬虫资源进行抓取，不是调用您的浏览器进行抓取
  4. 监控之后的数据可以以产品视角进行查看，也可以以关键词视角进行查看（搜索框上方可切换）
- 页面内定价 tooltip（chunk55 原文）：**"监控 1 个ASIN在 1 个关键词下的排名，每次监控 3 页，每 1 小时监控 1 次，连续监控 1 周（7天），消耗 20 个积分。"**

### 3. 坑位快照（model=monitorSnapshotKeyword）

- headline：**"坑位快照"有什么用？**
- 妙可文案："1.精准卡位：小时级排名+定位广告活动"
- 使用前必读：
  1. 坑位快照默认$每小时抓取^，每次抓取$前3页^，每次持续时间$15天^，消耗$42个积分^。
  2. Sif 的$广告抓取率稳定在95%左右，远超行业平均水平^。少量坑位为空是由于多次重试后依然没有获取到广告位。
- 页面内同款文案（chunk44）：抓取成功提示 `"监控成功，已扣除42个积分"`

注：`model=snapshot`、`hourlyRank`、`dailyRank`、`monitorSnapshot` 等猜测名均返回 null，三个模块的真实 model 名以上述为准。

---

## 订阅创建参数 schema（反推，未真正创建）

### 坑位快照 — POST /api/monitorSnapshot/handle?country={site}

来源：chunk44 调用点 `Object(f.a)({keyword, type:1}, site)`。**未实测**（创建接口，仅静态反推）。

```json
{ "keyword": "<关键词，支持逗号分隔批量粘贴>", "type": 1 }
```

固定参数在服务端写死：每小时、前3页、15天、42积分/词。

### 每日排名 — POST /api/user/subs/handle?country={site}

实测（空 body 一次）→ `{"message":"type不能小于1","code":-1}`，证明 **type 为必填且 >=1**。
调用点（chunk49，模块 1wZi 导出 jb → fn B → `/api/user/subs/handle`）：

```json
{ "asin": "<ASIN>", "keywords": ["kw1","kw2"], "type": 1 }   // type:1 = 批量添加（textarea）
{ "asin": "<ASIN>", "keywords": ["kw"],     "type": 2 }      // type:2 = 单个关键词操作（结合 stopUpdate 推断为停止订阅）
```

配额前置校验：GET /api/user/search/userSubsInfo（实测 `{limit:200, addNum:0, remainNum:200}`，本账号为 shark/trial 旗舰试用，对应"旗舰会员200词"档）。

### 小时排名 — POST /api/monitor/user/handle

实测（空 body 一次）→ `{"message":"服务异常","code":0}`（未再重试）。
完整 schema 来源：chunk55 添加监控对话框（组件 `OZ3m`）的 payload 构造原文：

```js
{ type: 1|3,                    // dialogtype：1=新增监控，3=续费
  asinKeywords: { "<asin>": "<keyword>" },
  duration: 7|14|28,            // timeOptions：7天/14天/28天
  period: 1|2|3|6|12,           // rateOptions：每1/2/3/6/12小时
  pages: 3|7,                   // pageOptions：3页/7页（后端另支持 -1=全部页，见"全部页"渲染分支）
  isAutoProceed: true|false }   // renewOptions：到期自动续费 是/否
```

UI 定价规则 tooltip：1 ASIN×1词×3页×每1小时×7天 = 20 积分（线性可推其他档位）。
配套试算：POST /api/property/integral/calcMonitor（同款 payload）→ `{data:{integral}}`（app.js 定义；见下文"积分定价"的 404 备注）。
批量版：POST /api/monitor/batch/handle（同模块，payload 未反推）。

---

## 数据读取接口结构

### 坑位快照（小时级矩阵）

| 接口 | 方法 | 参数 | 实测响应 |
|---|---|---|---|
| /api/monitorSnapshot/queryList?country= | POST | `{keyword, startTime?, endTime?}`（endTime/startTime 为查看历史时才传，initTime 默认 undefined） | `{flag:2, searchTime:"2026-09-21 03:00:00", searchTimeUTC:"2026-09-20T19:00:00Z", countrySearchTime, chinaSearchTime, serverTimeMs, table:[], recFeatures, range, message:"未监控该词"}` |
| /api/monitorSnapshot/queryTrend?country= | POST | `{adType:"nf"/"sp"/"sb"/"sbv"/"rec", keyword, startTime, endTime, searchAsins[]}` | `{}` 入参报"服务异常"（需已监控词） |
| /api/monitorSnapshot/rankHistory | POST | `{isAll:true, asin, keyword, timePieceType, timePieceValue}`（来源：chunk49 趋势弹窗调用点） | 未监控词报"服务异常" |
| /api/monitorSnapshot/queryKeywords?country= | POST | `{}` | `{monitoring:[], expireIn7Days:[], stopped:[]}` —— 本账号快照订阅三态列表（空） |
| /api/monitorSnapshot/suggestion?country= | GET | `?keyword=` | `{total:0, record:[]}` —— 搜索建议/历史 |
| /api/monitorSnapshot/querySearchAsin?country= | POST | 未反推 | 未实测 |
| /api/monitorSnapshot/queryListDownload?country= | POST | 同 queryList（blob） | 未实测 |

要点：**searchTime 精确到小时（整点 03:00:00）**，`flag` 区分数据状态（2=未监控该词），`table[]` 为该小时整页快照矩阵（含 nf/sp/sb/sbv/rec 五种广告位类型，来源：chunk44 表格列与 adType 切换器）。持续 15 天即每词保留 15×24 个小时切片。

### 每日排名（按天）

**列表主接口：POST /api/search/subscribe/v2?country=US**（前端线索里的 "POST/GET /api/subscribe/v2" 实为该路径；GET 方式不存在，返回 404）

实测必需 body（缺 `asin` 或 `isExample` 均报 `参数错误`）：

```json
{ "filterAsin": "", "granularity": "week", "asin": "B0BMW2985V", "endDay": null,
  "pageNum": 1, "pageSize": 200, "interval": 7,
  "sortBy": "estSearchesNum", "desc": true, "isListingSearch": true, "isExample": true }
```

- `asin` 取自 subsAsin 列表第一项；`isExample` 取自 subsAsin 响应（无真实订阅时为 true，展示示例数据）
- `granularity`: week/month（页面"周/月"切换）；`interval: 7` 固定；`pageSize: 200` 对应旗舰配额上限

实测响应结构（示例数据）：

```json
{ "asinNum": 0, "keywordNum": 0, "total": 5, "isExample": false,
  "minDay": "2025-05-08", "maxDay": "2026-09-20",
  "dates": ["2026-09-20", "...共7天"],
  "asins": ["B0BMW2985V", "...11个示例ASIN"],
  "keywords": [ {
      "keyword": "...", "translateKeyword": "...",
      "estSearchesNum": 16474, "searchesRank": 15984,
      "estSearchesNumHistory": { "date":[], "estSearchesNum":[], "searchesRank":[],
        "searchesNumChangeRatio":[], "searchesRankChangeRatio":[], "festivals":[], "selectDate":null },
      "estSearchesNumHistoryPrev": { "...去年同期同结构": "" },
      "listingRankHistory": { "date":[], "rank":[], "adRank":[] },
      "rankInfo": [ /* 与 dates 一一对齐 */
        { "nf": { "asin":"B0D6RDPT9M", "rank":19, "rankStr":"p2,3/16",
                  "updateTime":"2026-09-20", "changeType":"up", "isSubscribe":true },
          "sp": { "asin":"B0BMW2985V", "rank":null, "rankStr":null,
                  "updateTime":"2026-09-20", "changeType":"noChange", "isSubscribe":true } } ] } ] }
```

- `rankInfo[i]` 按日期下标对齐 `dates[i]`，每项 nf（自然）/sp（SP广告）两分支，与已知线索完全一致
- `minDay` 为可回溯的最早日期；`festivals` 内置节日/大促标注（情人节、Prime Day 等）
- 配套：GET /api/search/user/subsAsin?country=&pageNum=&pageSize=（**必填 pageNum、pageSize**，缺一分别报"缺少必填参数"）→ `{isExample, total, asins:[{asin,title,img,price,score,star,ratingNum}]}`
- 导出：POST /api/updown/userSubs/download（blob）

### 小时排名（卡片 + 产品/关键词双视角）

| 接口 | 方法 | 参数 | 实测响应 |
|---|---|---|---|
| /api/search/monitor/keyword/overview?country= | POST | `{type:1, pageNum:1, pageSize:24, isActive:true, sortBy:"createdAt", desc:true}` | `{total:0, monitorTotal:0, keywords:[]}`（关键词视角卡片列表；type:1=监控中/2=已停止，对应 UI "查看正在监控中的数据/查看已停止监控的数据"） |
| /api/search/monitor/asin/overview?country= | POST | `{type:1, pageNum:1, pageSize:24, isActive:true}` | `{total:0, monitorTotal:0, asins:[]}`（产品视角卡片） |
| /api/search/monitor/keyword/detail?country= | POST | `{keyword, type}` | `{}` 报"参数错误" |
| /api/search/monitor/asin/detail?country= | POST | `{asin, type}` | `{}` 报"参数错误" |
| /api/monitor/user/delete | POST | `{asin, keywords[]}`（来源：chunk55 删除对话框 `{asin:e.delAsin, keywords:e.checkedCities}`） | 未实测 |
| /api/updown/monitorAsinKeyword/download | POST | blob 导出 | 未实测 |

要点：矩阵/卡片数据在 detail 接口，视角切换只是 overview 换 asin/keyword 两个端点；`monitorTotal` 为监控中总数。

---

## 积分定价

| 项 | 官方数字 | 来源 |
|---|---|---|
| 小时排名 | 1 ASIN×1词×3页×每1小时×7天 = **20 积分**（duration 档 7/14/28 天、period 档 1/2/3/6/12 小时、pages 档 3/7 页） | chunk55 添加监控 tooltip + modelIntroduce(monitorKeyword) |
| 坑位快照 | **42 积分/词**（每小时、前3页、15天，参数不可调） | modelIntroduce(monitorSnapshotKeyword) + chunk44 文案与成功提示 |
| 每日排名 | 不按积分，按**词数配额**：高级会员 50 词 / 旗舰会员 200 词 | modelIntroduce(subscribeSearch) |
| 试算接口 | POST /api/property/integral/calcMonitor、POST /api/property/integral/calcBatchMonitor（app.js 模块 1wZi；与 handle 同 payload，返回 `data.integral`） | app.js 定义 |
| 积分余额 | GET /api/user/conch/info（实测返回的是用户档案/顾问信息，非余额）；GET /api/user/search/consumeIntegralHistory（消费历史，app.js） | 实测 + app.js |
| VIP 档位 | GET /api/user/vip/overview 实测：`{vipLevel:"shark", vipLevelSec:"trial", typeAppendPrice:{shark:1888.0, high:888.0}}`（shark=旗舰 1888 元档，high=高级 888 元档） | 实测 |
| 不存在的接口 | GET /api/user/conch/price、GET /api/subscribe/price → **404**，站点无独立定价接口，定价走 calcMonitor 试算 + 前端写死文案 | 实测 |

**备注（版本差异）**：`/api/property/integral/calcMonitor`、`/api/property/integral/calcBatchMonitor`、`/api/monitor/search/keywordAsinRule` 在 www.sif.com 实测 404（Spring "No message available"），但前端 1.6.23 bundle 正常引用。疑似挂在另一网关/服务（`isApiHost` 封装开关的存在佐证），审计时按 app.js 定义记录，未深究。

---

## 对 Looom M14 实现的建议

1. **三表一体的订阅域模型**：sif 用三套 API 覆盖同一"关键词×ASIN×时间粒度"模型。Looom M14 建议统一为一张 `rank_monitor` 任务表：`{country, asin, keyword, granularity(hour/day/snapshot), period_hours, pages, duration_days, integral_cost, status(monitoring/stopped/expired), expire_at}`，快照=固定参数(1h/3页/15天)的特例，每日排名=day 粒度特例，避免三套表。
2. **先试算后扣费**：创建流程照抄 sif 的两段式——`calc(payload) → 展示积分 → 确认创建`，积分规则参数化（每 ASIN×词×页×次）。每日排名类订阅改用配额制（`userSubsInfo {limit, addNum, remainNum}` 三元组）更省积分引擎。
3. **数据结构对齐**：每日排名响应值得直接借鉴——`dates[] + rankInfo[i]` 按下标对齐、nf/sp 分支、`rankStr`（如 "p2,3/16" 表示坑位)、`changeType`、`isSubscribe`、`minDay` 回溯边界；小时矩阵要有 `searchTime`（整点切片）+ `flag` 数据状态字，空数据要能区分"抓取中/未监控/超出筛选范围"三态（chunk44 的 noDataReason 三条文案）。
4. **快照抓 5 种广告位**：nf/sp/sb/sbv/rec（自然、SP、SB、SBV、推荐位），M14 若只做 nf/sp 可预留 adType 枚举；sif 广告抓取率约 95%，坑位为空要允许"多次重试仍无广告位"的语义。
5. **参数边界**：页数上限受亚马逊 306 条结果约束（48/页×7页 或 16/页×20页，sif tooltip 原文），频率最短 1 小时；订阅时长 7/14/28 天与到期自动续费（isAutoProceed）是转化抓手，M14 应保留。
6. **错误语义**：sif 的报错很粗糙（"参数错误"/"服务异常"混用），M14 应做结构化错误码；缺参探测显示其对 pageNum/pageSize 逐字段校验（"缺少必填参数: pageNum"→"缺少必填参数: pageSize"），值得学习。

## 附：本次实测接口清单

| # | 请求 | 结果 |
|---|---|---|
| 1 | GET /api/sys/modelIntroduce/search?model=subscribeSearch / monitorKeyword / monitorSnapshotKeyword | 三段官方介绍全文 |
| 2 | GET /api/search/user/subsAsin?country=US&pageNum=1&pageSize=20 | `{isExample:true,total:3,asins[3]}` 示例数据 |
| 3 | POST /api/search/subscribe/v2?country=US（多轮缺参→补齐 asin+isExample） | `参数错误`→完整示例响应 |
| 4 | GET /api/user/search/userSubsInfo?country=US | `{limit:200,addNum:0,remainNum:200}` |
| 5 | POST /api/user/subs/handle（空 body 一次） | `type不能小于1` |
| 6 | POST /api/monitor/user/handle（空 body 一次） | `服务异常`（就此打住） |
| 7 | POST /api/search/monitor/keyword/overview、asin/overview（空与全参） | `{total:0,monitorTotal:0,...}` 空列表 |
| 8 | POST /api/monitorSnapshot/queryList / queryKeywords、GET suggestion | 见上文，本账号无快照订阅 |
| 9 | GET /api/user/vip/overview、/api/user/conch/info | VIP shark/trial 档位 |
| 10 | GET /api/user/conch/price、/api/subscribe/price | 404（无此接口） |

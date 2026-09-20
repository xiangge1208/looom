# 查推荐专栏 / 竞品对比 —— 页面与接口契约

数据来源：**实时接口实测**（已登录态，代理 `localhost:9958`）+ bundle chunk 静态素材。
实测日期数据版本 `commonMsg.version = 1.6.23`。

> ⚠️ **端点清单勘误**：`docs/raw/domains/recommendations.txt` 里 11 个端点**全部是「查销量」域的
> bought 接口**，与「查推荐专栏」无关（唯一沾边的 `/api/search/rec/getVariantsInfoApi` 实测 404）。
> 真正的推荐专栏端点在 `docs/raw/_probe/chunks/39.6ac987ab.js` 里，共 8 个 `/api/search/rec/*`
> + 4 个 `/api/updown/rec/*` 下载接口。本文档按**实测到的真实端点**编写。

---

# 第一节：查推荐专栏

## 路由与标题

| 路由 | 权威标题 |
|---|---|
| `/recommend` | 查推荐专栏 |
| `recommend`（无斜杠，另一条记录） | Prime Day「推荐专栏」爆单攻略 |

> `ROUTES_TITLES.md` 里 `/recommend` 与 `recommend` 是两条记录，后者标题带 Prime Day 营销语。
> 推测是同一页面的活动期换肤标题，⚠️ 未实测确认。

## 业务含义（实测推导）

「推荐专栏」= 亚马逊商品详情页上那些**推荐位板块**（如 "Customers frequently viewed"
"Seen on social media"）。本页回答：**我的 ASIN 出现在了哪些推荐专栏里、通过哪些关键词、
被哪些广告 campaign 带上去的、占比多少、趋势如何**。

三层钻取结构（实测确认）：

```
专栏(recTitle) ──┬── 关键词(keyword) ──── campaign
                 └── campaign ──────────── 关键词
```

**同一份数据有两个入口方向**：`recView/keywords` 是「专栏→词→campaign」，
`recView/campaigns` 是「专栏→campaign→词」。两者 `ratio` 值不同（前者 0.441，后者 0.571），
说明**占比是在各自维度内归一化的**。

## 区块拆解

| 区块 | 接口 | 内容 |
|---|---|---|
| 顶部概览卡 | `rec/overview` | 3 个计数：专栏数 / campaign 数 / 关键词数 |
| 专栏视角表 | `rec/recView` | 按专栏一行，含日趋势迷你图（`campaignCntTrends` / `keywordCntTrends`） |
| └ 专栏行展开（词） | `rec/recView/keywords` | 该专栏下的关键词 + 每词的 campaign 明细 |
| └ 专栏行展开（campaign） | `rec/recView/campaigns` | 该专栏下的 campaign + 每 campaign 的词明细 |
| 关键词视角表 | `rec/keywordView` | 按关键词一行，横向铺开各专栏（`recTitles` 是动态列头） |
| Campaign 视角表 | `rec/campaignView` | 按 campaign 一行，横向铺开各专栏 |
| 趋势图 | `rec/trends` | 跨月趋势，`recTrends` 按专栏名分组 |

**关键交互特性**：`keywordView` / `campaignView` 返回的 `recTitles` 数组是**动态表头** ——
前端根据这个数组生成列，列数随 ASIN 变化。这是本页最重要的渲染特征。

## 控件

| 控件 | 参数 | 实测取值 |
|---|---|---|
| ASIN 输入 | `asin` | 单个 ASIN（**单数**，非数组） |
| 时间粒度 | `timePieceType` | `month` ✅ / `week` ❌（全站不可用，见 LIVE_PROBE.md） |
| 时间值 | `timePieceValue` | `YYYY-MM`，如 `2026-03` |
| 趋势图粒度 | `timeDim` | `month`（**注意 trends 用 `timeDim` 不是 `timePieceType`**） |
| 专栏筛选 | `recTitle` | 明细接口必填，值是**英文标题原文**（如 `Recently bought and rated`） |
| 分页 | `page` / `pageSize` | 页码分页 |
| Campaign 类型开关 | — | 响应 `campaignTypeEnable: false` 控制是否显示 campaign 类型列（权限位） |

## 接口契约表

| 方法 | 路径 | 请求参数 | 响应字段 | 触发场景 | 实测状态 |
|---|---|---|---|---|---|
| POST | `/api/search/rec/overview` | `asin`, `timePieceType`, `timePieceValue` | `recCnt`, `campaignCnt`, `keywordCnt` | 页面加载 | ✅已验证 |
| POST | `/api/search/rec/recView` | `asin`, `timePieceType`, `timePieceValue` | `dates[]`, `list[]`, `campaignTypeEnable` | 专栏视角表 | ✅已验证 |
| POST | `/api/search/rec/recView/keywords` | + `recTitle` | `list[]`（词+campaignDetails） | 专栏行展开 | ✅已验证 |
| POST | `/api/search/rec/recView/campaigns` | + `recTitle` | `list[]`（campaign+keywordDetails） | 专栏行展开 | ✅已验证 |
| POST | `/api/search/rec/keywordView` | `asin`, `timePieceType`, `timePieceValue`, `page`, `pageSize` | `total`, `list[]`, `recTitles[]`, `dates[]` | 切关键词视角 | ✅已验证 |
| POST | `/api/search/rec/campaignView` | 同上 | `total`, `remarked`, `list[]`, `recTitles[]`, `dates[]` | 切 campaign 视角 | ✅已验证 |
| POST | `/api/search/rec/trends` | `asin`, **`timeDim`** | `dates[]`, `recTrends{}` | 趋势图 | ✅已验证 |
| POST | `/api/search/rec/getVariantsInfoApi` | — | — | — | ❌404已下线 |
| POST | `/api/updown/rec/recView/download` | 同 recView | blob | 导出 | ⚠️未测（只读纪律，不触发导出） |
| POST | `/api/updown/rec/keywordView/download` | 同 keywordView | blob | 导出 | ⚠️未测 |
| POST | `/api/updown/rec/campaignView/download` | 同 campaignView | blob | 导出 | ⚠️未测 |
| POST | `/api/updown/rec/trends/download` | 同 trends | blob | 导出 | ⚠️未测 |

### `recView` 行字段（实测）

| 字段 | 实测值 | 类型 | 说明 |
|---|---|---|---|
| `recTitle` | `"Recently bought and rated"` | string | **专栏英文标题原文，即业务主键** |
| `ratio` | `1` | number | 该专栏占比（0-1） |
| `manualRatio` | `0` | number | 手动投放占比 |
| `autoRatio` | `0` | number | 自动投放占比 |
| `campaignCnt` | `2` | int | campaign 数 |
| `keywordCnt` | `5` | int | 关键词数 |
| `campaignCntTrends` | `[null,...,2,null...]` | (int\|null)[] | **逐日数组，长度 = `dates` 长度（31）** |
| `keywordCntTrends` | `[null,...,5,null...]` | (int\|null)[] | 同上 |
| `lastCampaignCnt` | `2` | int | 末次有值的 campaign 数 |
| `lastKeywordCnt` | `5` | int | 末次有值的关键词数 |

> **关键发现：`dates` 是逐日数组**（`2026-03-01`…`2026-03-31`），
> 即传 `timePieceType=month` 但**返回日粒度序列**。推荐专栏是「月请求 + 日明细」混合粒度。
> 且趋势数组**极度稀疏**（31 天里只有 1 天有值）—— 建表用长表只存非 null 天，
> 不要按数组下标存 31 行。

### `keywordView` 行字段（实测）

| 字段 | 实测值 | 类型 | 说明 |
|---|---|---|---|
| `keyword` | `"240gb ssd"` | string | 关键词 |
| `translateKeyword` | `"240GB固态硬盘"` | string | 中文翻译 |
| `ratio` | `0.44100084` | number | 该词占比 |
| `recCnt` | `1` | int | 该词命中的专栏数 |
| `recDetail[]` | — | object[] | 嵌套：`recTitle`, `campaignCnt`, `appearDays`, `totalDays`, `ratio`, `campaignDetails[]` |
| `recTrends{}` | `{"<recTitle>":[{campaignCnt,ratio},...]}` | object | **按专栏名 key 的日序列** |

> ⚠️ `keywordView` 行内**没有 `keywordId`**（对比 `asinKeywordList` 有）。
> 建表关联 `dim_keyword` 时只能按 `(keyword, country)` 匹配，或需二次查询补 ID。
> 这与 NAMING.md 裁定的 `keyword_id` 主键有冲突，见「不确定清单」。

### `campaignView` 行字段（实测）

| 字段 | 实测值 | 类型 | 说明 |
|---|---|---|---|
| `campaignId` | `"A09505632OVRRRNQVKWIU"` | string | 亚马逊广告 campaign ID（20 位） |
| `maskCampaignId` | `"KWIU"` | string | **脱敏后 4 位**（前端默认展示这个） |
| `campaignName` | `null` | string/null | 名称（需绑定广告账号才有值 → ⚠️需授权权限） |
| `campaignColor` | `null` | string/null | 前端标色 |
| `campaignProductType` | `null` | string/null | 产品类型 |
| `campaignType` | `null` | string/null | 投放类型（受 `campaignTypeEnable` 权限位控制） |
| `ratio` | `0.77098869` | number | 占比 |
| `recCnt` | `1` | int | 命中专栏数 |
| `recDetail[]` | — | object[] | `recTitle`, `keywordCnt`, `appearDays`, `totalDays`, `ratio`, `keywordDetails[]` |
| `recTrends{}` | `{"<recTitle>":[{keywordCnt,ratio},...]}` | object | 日序列 |

> `maskCampaignId` 是 `campaignId` 末 4 位 —— 原站对未授权账号做脱敏。
> 顶层 `remarked: 0` 是「已备注 campaign 数」，关联 `markKeyword`/adNote 类功能。

### `trends` 响应（实测）

```json
{ "dates": ["2025-12-01","2026-01-01","2026-02-01","2026-03-01","2026-04-01"],
  "recTrends": {
    "4 stars and above": [
      {"recTitle":"4 stars and above","score":77.34,"ratio":0.14795182,
       "scoreChangePre":77.34,"ratioChangePre":null,"changeContri":0.14795182},
      null, null, ... ] } }
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `dates` | string[] | **月份以月初日期表示**（`2026-03-01` 代表 2026-03） |
| `recTrends` | object | key = 专栏英文标题；value = 与 `dates` 等长数组 |
| `└ score` | number/null | 流量得分 |
| `└ ratio` | number/null | 占比 0-1 |
| `└ scoreChangePre` | number | 环比得分变化（**可负**，如 `-77.34`） |
| `└ ratioChangePre` | number/null | 环比占比变化 |
| `└ changeContri` | number | 变化贡献度（可负） |

> **数组元素整体可为 `null`**（该月无数据），不是字段级 null。前端渲染须判空。

## 空 / 加载 / 错误态

| 态 | 实测表现 |
|---|---|
| 空（ASIN 无推荐数据） | `overview` 返回 `{recCnt:0,campaignCnt:0,keywordCnt:0}`；`recView` 返回 `{dates:null,list:null,campaignTypeEnable:false}` —— **`dates` 和 `list` 都是 `null` 不是 `[]`** |
| 空（ASIN 完全无数据） | `trends` 返回 `data: null`（实测 `B07D998212`） |
| 空（列表类） | `keywordView` / `campaignView` 返回 `total:0, list:null, recTitles:null` |
| 参数缺失 | `{"message":"asin不能为空;timePieceType不能为空;timePieceValue不能为空","code":-1}` |
| 数据量过大 | 静态素材含文案「数据量太大，加载超时，请稍后尝试」（chunk 39） |
| 加载态 | 素材未覆盖（未抓到骨架屏组件） |

> **对复刻的强约束**：原站空态一律返回 `null` 而非空数组。前端必须 `(list \|\| [])` 兜底。

---

# 第二节：竞品对比

## 路由与标题

| 路由 | 权威标题 |
|---|---|
| `/compare-sales` | 对比销量-多产品对比 |
| `/compare-traffic` | 对比流量词-多产品对比 |
| `/compare-structure` | 对比流量结构-多产品对比 |
| `/compete` | 流量位竞争格局-关键词竞争分析 |
| `/asin-relatedness` | 多竞品拓词并自动筛查-拓词&筛查相关性 |
| `/keyword-relatedness` | 批量导入关键词筛查-拓词&筛查相关性 |
| `/root-relatedness` | 以词拓词并筛查-拓词&筛查相关性 |
| `/niche-relatedness` | 细分品类拓词并筛查-拓词&筛查相关性 |

## 关键实测发现：两套并行的 compare 接口，`/api/compare/*` 整体不可用

| 前缀 | 实测结果 |
|---|---|
| `/api/search/compare/*` | ✅ 可用（4/5 通） |
| `/api/compare/*` | ❌ **6 个端点全部 `{"message":"服务异常","code":0}`**，穷举参数名无一通过 |

`/api/compare/*` 失败的端点：`summary/multiAsin`、`multiAsinKeywords`、
`keywordAsinsRankHistory`、`compareMyKeywords`、`bought/listingHistory`（`参数错误`）。
唯一通的是 `compare/bought/multiAsin` ✅。

尝试过的参数组合（全部 `服务异常`）：`asins`/`asinList`、
`timePieceType`/`timeDim`/`granularity`、加/不加分页、单个/多个 ASIN。
`服务异常` 与参数校验错误 `参数错误`(code:-1) **是不同错误码**，说明参数已过校验、
在服务端内部炸了 → **不是参数名猜错，是服务端问题或权限缺失**。

> 与 LIVE_PROBE.md 的 week 粒度失败同一模式（`服务异常` code:0）。
> 从外部无法区分「未上线 / 需更高会员 / 服务端 bug」。**需主 Agent 裁决是否复刻。**

## `asinMagic` 功能已实测明确：ASIN 归一化（变体折叠）

名字看不出功能，实测一次即明：**把输入的 ASIN 列表映射成「流量更大的同组变体」**，
是多产品对比的**前置校正步骤**。

```json
// 请求 {asins:["B01N5IB20Q","B01N0TQPQB"]}
{ "isChanged": true,
  "before": ["B01N5IB20Q","B01N0TQPQB"],
  "affter":  ["B01N0TQPQB","B01N0TQPQB"],   // 原站拼写错误 affter = after
  "beforeNum": 163, "affterNum": 121,
  "variantExNum": null, "pasins": [] }
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `isChanged` | boolean | 是否发生了替换（true 时前端弹「是否使用推荐 ASIN」确认） |
| `before` | string[] | 用户原始输入 |
| `affter` | string[] | **建议替换后的 ASIN**（原站拼错，应为 `after`） |
| `beforeNum` | int | 替换前的关键词/流量总数 |
| `affterNum` | int | 替换后的数量 |
| `variantExNum` | int/null | 变体扩展数 |
| `pasins` | string[] | 父 ASIN 列表 |

> **注意 `affterNum` (121) < `beforeNum` (163)**，且两个不同 ASIN 被折叠成同一个
> （去重后只剩 1 个）—— 这是**有损操作**，复刻时必须保留用户确认环节，不能静默替换。
> **`asinMagic` 无需时间参数**（传与不传结果一致，实测）。

## 对比 ASIN 数量上限：**10 个，服务端硬校验**

实测 `asinMagic`（二分定位）：

| ASIN 数 | 结果 |
|---|---|
| 2 / 5 / 10 | ✅ `code:1` 正常 |
| **11** / 20 / 21 / 30 / 31 / 50 / 60 | ❌ `{"message":"参数错误","code":-1}` |

> **上限确定为 10**。校验报错未明说数字（只说「参数错误」），
> 但 10 通 11 断的边界是确定的。前端校验规则：`asins.length >= 1 && <= 10`。
> ⚠️ 未在 `asinSummary` 上复现（该接口传 60 个也返回 `code:1` 但 `total:0`，
> 说明**不同接口校验不一致**，`asinSummary` 无数量校验）。

## `asinSummary` 实测：结构与 `bought/multiAsin` 高度重合，且当前无数据

```json
{"total":0,"isParentAsin":null,"vaiantsNum":null,"nkVaiantsNum":null,
 "pasins":null,"boughtMonth":null,"asins":[]}
```

**实测穷举**（有效 ASIN、单个/多个、带/不带时间参数、带 `pasins`）**均返回 `total:0`**，
但 `code:1` 且信封正常 —— 接口活着，只是取不到数据。

对比 `/api/compare/bought/multiAsin`（✅ 有真实数据）返回的**完全相同的顶层结构**：
`total`, `isParentAsin`, `features`, `vaiantsNum`, `nbVaiantsNum`, `boughtMonth`, `asins`。

> 差异：`asinSummary` 是 `nkVaiantsNum` + `pasins`，`bought/multiAsin` 是 `nbVaiantsNum` + `features`。
> ⚠️ `nk` vs `nb` 前缀语义均未确认（LIVE_PROBE.md 对 `nbVaiantsNum` 也标了待确认）。
> **推断 `asinSummary` 是 `bought/multiAsin` 的旧版/别名**，⚠️ 未能证实。

## 决定性发现：对比接口有独有的 `*Best` 标记字段

`/api/compare/bought/multiAsin` 实测行内字段（**这是判断「是否需要独立表」的关键**）：

```json
{"asin":"B01N0TQPQB", "title":"Kingston 480GB A400...", "img":"https://m.media-amazon.com/...",
 "ratingNum":203395, "ratingNumBest":true,
 "price":106.99,    "priceBest":true,
 "score":4.8,       "scoreBest":true,
 "star":5.0,
 "features":[{"code":"Size","feature":"Size","value":"480 GB","boughtInPastMonthBest":null}],
 "boughtInPastMonth":"200+", "boughtInPastMonthBest":true,
 "boughtHistoryDates":[...]}
```

| 独有字段 | 类型 | 说明 |
|---|---|---|
| `ratingNumBest` | boolean | 该 ASIN 的评价数是否为本次对比组内最高 |
| `priceBest` | boolean | 价格是否最优 |
| `scoreBest` | boolean | 评分是否最高 |
| `boughtInPastMonthBest` | boolean | 销量是否最高 |

> **`*Best` 是「组内相对最优」标记，不是 ASIN 的固有属性** ——
> 换一组对比对象，同一 ASIN 的 `*Best` 值会变。这是**查询期计算结果，不是可持久化的事实**。

另注：`features` 在此接口是**对象数组** `[{code,feature,value,boughtInPastMonthBest}]`，
而 `/api/search/bought/asin` 的行内 `features` 是**字符串数组** `["240 GB"]`（见 LIVE_PROBE.md）。
**同名字段两种结构**，复刻时须按接口区分。

## `estSearchesNumHistory` 实测（唯一有完整数据的对比接口）

请求 `{keywords:['240gb ssd'], timeDim:'month'}` ——**参数是 `keywords` 数组 + `timeDim`**。

```json
{"estSearchesNumHistory": { "240gb ssd": {
   "date":["2020-07", ... 73 项 ... ,"2026-07"],
   "estSearchesNum":[...,1691,2853,1666],
   "searchesRank":[...,932704,574042,919329],
   "searchesNumChangeRatio":[],       // 实测空数组
   "searchesRankChangeRatio":[],      // 实测空数组
   "festivals":[[{"name":"母亲节","startDate":"2026-05-09","endDate":"2026-05-09"}],
                [{"name":"父亲节",...},{"name":"Prime Day会员日","startDate":"2026-06-23","endDate":"2026-06-26"}],
                null],
   "selectDate":null } } }
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `date` | string[73] | `YYYY-MM`，**2020-07 ~ 2026-07（73 个月）** |
| `estSearchesNum` | int[73] | 预估搜索量 |
| `searchesRank` | int[73] | 搜索排名（数值大 = 排名靠后，如 932704） |
| `searchesNumChangeRatio` | number[] | ⚠️ 实测**空数组** |
| `searchesRankChangeRatio` | number[] | ⚠️ 实测**空数组** |
| `festivals` | (object\|null)[73] | **节日标注，用于趋势图打点** |
| `└ name` | string | **中文节日名**：母亲节 / 父亲节 / Prime Day会员日 |
| `└ startDate` `endDate` | string(date) | 起止日 |
| `selectDate` | null | 选中日期回显 |

> **重要**：73 个月的完整区间与 `timeRanges` 声明的 `2020-07 ~ 2026-08` 吻合，
> 但**与销量域的 40 个月（2023-05 起）不同**（LIVE_PROBE.md）。
> **各域历史深度不一致**，seed 不能统一按一个长度造。
>
> `festivals` 是**独立可复用的节日字典**，与 ASIN/关键词无关，值得单独建 `dict_festival`。

## 接口契约表

| 方法 | 路径 | 请求参数 | 响应字段 | 触发场景 | 实测状态 |
|---|---|---|---|---|---|
| POST | `/api/search/compare/asinMagic` | `asins[]`（≤10） | `isChanged`, `before[]`, `affter[]`, `beforeNum`, `affterNum`, `variantExNum`, `pasins[]` | 提交对比前的 ASIN 归一化 | ✅已验证 |
| POST | `/api/search/compare/asinSummary` | `asins[]` (+`timePieceType`,`timePieceValue` 可选) | `total`, `isParentAsin`, `vaiantsNum`, `nkVaiantsNum`, `pasins`, `boughtMonth`, `asins[]` | 对比概览 | ⚠️接口通但 `total:0` 恒为空 |
| POST | `/api/search/compare/estSearchesNumHistory` | `keywords[]`, `timeDim` | `estSearchesNumHistory{}`（见上） | 关键词搜索量对比趋势 | ✅已验证 |
| POST | `/api/search/compare/asinKeywords` | ⚠️ 参数未破解 | — | 对比流量词 | ⚠️`参数错误`，穷举未通 |
| POST | `/api/search/compare/keywordAsins` | ⚠️ 参数未破解 | — | 关键词下的 ASIN 对比 | ⚠️`参数错误`，穷举未通 |
| POST | `/api/search/competePattern` | ⚠️ 参数未破解 | — | `/compete` 竞争格局 | ⚠️`参数错误`，穷举未通 |
| POST | `/api/search/competeAsinAssay` | ⚠️ 参数未破解 | — | `/compete` 竞品剖析 | ⚠️`参数错误`，穷举未通 |
| POST | `/api/compare/bought/multiAsin` | `asins[]`, `timePieceType`, `timePieceValue` | `total`, `isParentAsin`, `features[]`, `vaiantsNum`, `nbVaiantsNum`, `asins[]`（含 `*Best`） | `/compare-sales` | ✅已验证 |
| POST | `/api/compare/summary/multiAsin` | 同上 | — | `/compare-sales` 概览 | ❌`服务异常`(code:0) |
| POST | `/api/compare/multiAsinKeywords` | 同上 | — | `/compare-traffic` | ❌`服务异常`(code:0) |
| POST | `/api/compare/keywordAsinsRankHistory` | 同上 | — | 排名历史 | ❌`服务异常`(code:0) |
| POST | `/api/compare/compareMyKeywords` | 同上 | — | 我的词对比 | ❌`服务异常`(code:0) |
| POST | `/api/compare/bought/listingHistory` | 同上 | — | Listing 历史 | ❌`参数错误`(code:-1) |
| POST | `/api/compare/markKeyword` | — | — | 标记关键词 | ⚠️**未测（写操作，只读纪律禁止）** |
| POST | `/api/updown/*/download`（6 个） | 同对应查询接口 | blob | 导出 | ⚠️未测（只读纪律） |

> `/api/updown/*` 导出端点清单：`compareMyKeywords/download`、`multiAsinKeywords/download`、
> `summary/multiAsin/download`、`competeAsinAssay/download`、`competePattern/download`、
> `compareEstSearchesNumHistory/download`（后者带 `?country=` 在 URL 上，实测自 chunk 26）。

## 空 / 加载 / 错误态

| 态 | 实测表现 |
|---|---|
| 空（`asinSummary`） | `total:0`, `asins:[]`（**这里是空数组，与 rec 域的 `null` 不同**） |
| 空（`bought/multiAsin`） | `features:[]`, `vaiantsNum:0` |
| 超上限（>10 ASIN） | `{"message":"参数错误","code":-1}`，**未告知上限数字** |
| 参数缺失 | `asins不能为空`(code:-1) 或笼统 `参数错误`(code:-1) |
| 服务端故障 | `{"message":"服务异常","code":0}` —— `/api/compare/*` 6 端点常态 |
| 加载态 | 素材未覆盖 |

---

# 不确定清单

1. ⚠️ **`/api/compare/*` 6 个端点全线 `服务异常`** —— 是未上线、需更高会员，还是服务端 bug？
   外部不可区分。这直接决定 `/compare-sales` `/compare-traffic` 能否复刻。
2. ⚠️ **`competePattern` / `competeAsinAssay` 参数未破解** —— 只返回笼统 `参数错误`，
   不像其他接口会列出缺失字段名。试过 `asin`/`asins`/`keyword`/`keywords`/`keywordId`/
   `keywordIds`/`searchTerm` × 时间参数组合。`/compete` 页面契约因此不完整。
3. ⚠️ **`compare/asinKeywords` / `compare/keywordAsins` 参数未破解** —— 同上。
4. ⚠️ **`asinSummary` 恒返回 `total:0`** —— 接口活着但无数据。是否已被
   `compare/bought/multiAsin` 取代？（结构高度重合，推断是旧版，未证实）
5. ⚠️ **`keywordView` 行内无 `keywordId`** —— 与 NAMING.md 裁定的 `dim_keyword` 主键
   `(keyword_id)` 冲突。推荐专栏域只能按 `(keyword, country)` 关联，需主 Agent 裁决
   是否给 `dim_keyword` 加 `(keyword, country)` 唯一索引作为备用关联键。
6. ⚠️ **`nkVaiantsNum`（asinSummary）vs `nbVaiantsNum`（bought/multiAsin）** —— `nk`/`nb`
   前缀语义均未确认。
7. ⚠️ **`campaignName` / `campaignType` / `campaignColor` 恒为 `null`** ——
   需绑定亚马逊广告账号授权才有值，当前账号无此权限，字段类型只能按 string 推断。
8. ⚠️ **`recommend` vs `/recommend` 两条路由记录**（后者标题带 Prime Day）—— 是否同页换肤未确认。
9. ⚠️ **`searchesNumChangeRatio` / `searchesRankChangeRatio` 实测为空数组** ——
   无法确认元素类型，按 number 推断。
10. ⚠️ **ASIN 上限 10 未在所有接口一致** —— `asinMagic` 硬校验 10，
    `asinSummary` 传 60 也不报错。前端应统一按 10 卡。
11. ⚠️ **专栏英文标题的中文展示名只有 8 个有映射**（见 dict 文档），
    实测已发现 17+ 个标题，多数无中文名，前端 fallback 显示「其它」。
    复刻是否需要补齐中文翻译？需产品决策。
12. ⚠️ **导出接口全部未测**（只读纪律）—— 返回 blob 格式（xlsx/csv）未确认。
13. ⚠️ **`markKeyword` 未测**（写操作）—— 功能语义按名称推断为「标记关键词」，未证实。

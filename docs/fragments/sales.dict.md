# 查销量（/Sales）数据字典片段

**素材与验证方式**
- 静态：`docs/raw/_probe/chunks/38.fba11644.js`（`/Sales` 路由 chunk）—— 用于确认参数名、表格列中文语义、前端渲染逻辑。
- 实测：本地代理 + 已登录身份实调接口（方法见 `docs/raw/LIVE_PROBE.md`），测试 ASIN `B01N5IB20Q`（Kingston SSD，3 变体）、`B0BHJJ9Y77`（Samsung 990 PRO，6 变体，双属性）、`B09B8V1LZ3`（Color + Configuration），站点 `US` / `DE`。
- 响应信封实测：`{code, data, commonMsg}`，`code:1` 成功；失败 `{message, code:-1|0}`。
- 标记约定：**未标 ⚠️ 的类型均为实测确认值**（看真实返回值判定）。⚠️ 仅保留在实测无法覆盖处，并在末尾清单说明原因。

---

## 一、基础实体

### 1.1 `dim_asin`（ASIN 商品主档）

用途：一个站点下一个 ASIN（子体）的静态/慢变属性。表格「ASIN 信息」列、折线图图例都读它。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `asin` | char(10) | ASIN 码。实测均为 10 位大写字母数字 | 实测 `/api/search/bought/asin > data.asins[].asin = "B01N5IB20Q"` |
| `country` | char(2) | 站点码，**走 query string 不在 body**。实测 `US` / `DE` 同一 ASIN 返回不同 `price`(74.95 vs 76.16) 与销量(`100+` vs `<50`），确认站点是独立数据维度 | 实测 `?country=US` vs `?country=DE` 对比 |
| `title` | varchar / null | 标题。实测长度 90+ 字符 | 实测 `title:"240GB A400 SATA 3 2.5\" Internal SSD SA400S37/240G - HDD Replacement for Increase Performance"` |
| `img` | varchar / null | 主图 URL，亚马逊 CDN `m.media-amazon.com` | 实测 `img:"https://m.media-amazon.com/images/I/81+9rUcRVTL._AC_UY218_.jpg"` |
| `brand` | varchar / null | 品牌名。**实测字段名是 `brand`，不是排序键的 `brandName`**。ASIN 模式返回 null，关键词模式返回真实值 | 实测：`bought/asin` → `brand:null`；`bought/keyword` → `brand:"Samsung"` |
| `brandHref` | varchar / null | 品牌链接。实测 ASIN 模式恒 null | 实测 `brandHref:null` |
| `firstAvailableDay` | date (`YYYY-MM-DD`) | 上架时间。ASIN 模式 null，关键词模式有值 | 实测 `firstAvailableDay:"2022-11-01"`；排序实测返回 `2016-10-11` / `2016-11-28` |
| `ratingNum` | int | 评价数 | 实测 `ratingNum:203395` |
| `price` | number(double) / null | 价格，站点货币 | 实测 `price:74.95`（US）/ `76.16`（DE） |
| `score` | number(1 位小数) | **评分星级（4.0-5.0）**。这是表格「评分」列实际取值字段 | 实测 `score:4.8`；关键词模式 40 行取值全在 4.4-5.0 |
| `star` | number(0.5 步进) | **`score` 的半星取整展示值**。实测 40 行样本 `round(score*2)/2 === star` 100% 成立（0 处不符），如 4.7→4.5、4.8→5.0、4.4→4.5 | 实测：`/api/search/bought/keyword` 40 行全量校验，`halfRoundMismatches: []` |
| `isBestSeller` | boolean / null | 是否 BestSeller | 实测 `searchRecord` / `pageAsinVariants` 返回该字段 |
| `isFocus` | boolean | 是否已在用户产品库 | 实测 `isFocus:false` |
| `isVaiant` | boolean | **是否为「同组变体」行**（非搜索命中的兄弟变体）。搜索 `B079XC5PVV` 返回 3 行，命中行 `false`，另 2 行 `true` | 实测 `rows:[["B079XC5PVV",...,false],["B01N0TQPQB",...,true],["B01N5IB20Q",...,true]]` |
| `snapshotUpdateTime` | ⚠️ datetime | 快照更新时间。实测恒 null（见不确定清单 1） | 实测 `snapshotUpdateTime:null` |

实测确认恒为 null 的 keepa 相关字段（`/Sales` 不用，时光机才填）：`diffAvailableDays`、`diffAvailableDaysDateFormat`、`diffAvailableDaysNumberFormat`、`datasourceFlag`、`keepaLoaded`、`brandRefreshable`、`listedRefreshable`、`refreshable`。
来源：实测 `/api/search/bought/asin` 完整行对象。

主键建议 `(asin, country)` —— **实测确认必要**：同 ASIN 跨站点价格与销量都不同。

关系：`dim_asin` 1:N `dim_asin_feature`；1:N `fact_asin_bought_monthly`；N:M `user`（产品库）。

### 1.2 `dim_asin_variant_group`（父子体变体组）

用途：把同父体下的子体聚成一组，支撑「其余 N 个为同组变体」提示。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `child_asin` | char(10) | 子体 ASIN | 实测 `data.asins[].asin` |
| `parent_asin` | ⚠️ char(10) | 父体 ASIN。**实测证实响应体不含此字段**：只有布尔 `isParentAsin` 和计数。5 个 ASIN 实测 `isParentAsin` 全为 `false`/`null`，未取到父体分支样本（见不确定清单 2） | 实测 `isParentAsin:false`（`B01N5IB20Q`/`B01N0TQPQB`/`B079XC5PVV`/`B0BHJJ9Y77`/`B09B8V1LZ3`） |
| `refreshed_at` | ⚠️ datetime | 父子关系刷新时间。业务规则明写「每周更新一次」，但字段未在任何响应里暴露 | 静态 `38.fba11644.js@51680 > "Sif每周更新一次父体与子体关系"` |

组内派生量（**属于查询结果，不是表字段**，实测确认）：

| 字段 | 类型 | 实测语义 | 来源 |
|---|---|---|---|
| `isParentAsin` | boolean / null | 搜的是否父体。关键词模式返回 `null` | 实测 |
| `vaiantsNum` | int / null | 同组其他变体数。实测 `B0BHJJ9Y77` → `5`（总 6 行，命中 1 + 兄弟 5）；`B01N0TQPQB` 无变体 → `0` | 实测 |
| `nbVaiantsNum` | int / null | 因销量过低被过滤掉的变体数。实测 `B01N5IB20Q` → `1` | 实测 |
| `total` | int | 结果总数。⚠️ 实测 `B0BHJJ9Y77` 返回 `total:6` 且确实 6 行；但 `pageSize:5` 时只回 5 行仍报 `total:6`，即 `total` 是组内全量而非当页数 | 实测对比 `pageSize:5` 与 `pageSize:100` |

关系：1 父体 : N 子体（实测 `B079XC5PVV` 组含 3 个 ASIN、`B0BHJJ9Y77` 组含 6 个）。

### 1.3 `dim_asin_feature`（ASIN 变体属性值）

用途：子体的变体属性。既是表格「属性」列/动态属性列，也是折线图维度切换的依据。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `asin` | char(10) | 所属子体 | 实测 `data.asins[].features` 挂在行上 |
| `country` | char(2) | 站点 | query string |
| `code` | varchar | 属性代码。**实测与 `feature` 值完全相同**（`code:"Size"`, `feature:"Size"`），是同一个值的两个键 | 实测 `{"code":"Size","feature":"Size","value":"240 GB","boughtInPastMonthBest":null}` |
| `feature` | varchar | 属性展示名，同上 | 同上 |
| `value` | varchar | 属性值。实测 `"240 GB"` / `"2TB"` / `"990 PRO w/ Heatsink"` | 实测多 ASIN |
| `boughtInPastMonthBest` | boolean / null | 该属性值是否「最畅销属性」。实测最畅销行的两个属性项均为 `true`，其余行为 `null`（**不是 `false`**） | 实测 `B0BHJJ9Y77`：`["Style=990 PRO/best:true","Size=2TB/best:true"]`，其余 5 行全 `best:null` |

**实测推翻了原先的「三套键名」疑问**：`data.asins[].features` 恒为 `{code,feature,value,boughtInPastMonthBest}` 对象数组；顶层 `data.features` 才是字符串数组（属性名清单，见 4.2）；`pageAsinVariants` 的 `features` 是另一个接口的字符串数组。三者是不同层级的不同东西，非同一字段的三种形态。

⚠️ 建表键：`(asin, country, code)`。实测每个 ASIN 每个属性名只出现一次。

关系：`dim_asin` 1:N `dim_asin_feature`。实测双属性商品（`Style` + `Size`）每行 2 条。

---

## 二、时序快照

### 关键结论（实测后修订）

原先我按「月序列」与「近30天窗口」拆两张表。**实测证明这是错的，应合并为一张月度表**：

逐月实测 `/api/search/bought/asin`（`B01N5IB20Q`）：

| 请求 `timePieceValue` | 返回 `boughtInPastMonth` | 同月序列值 `boughtHistory[indexOf(月)]` |
|---|---|---|
| `2026-08` | `"200+"` | `200` |
| `2026-07` | `"200+"` | `200` |
| `2025-12` | `"500+"` | `500` |
| `2024-02` | `"2,000+"` | `2000` |
| `2023-10` | `"1,000+"` | `1000` |

**`boughtInPastMonth` 就是月序列在所选月份上的取值，只是套了个分档字符串外壳。** 它不是独立的滚动窗口聚合，因此不需要独立的窗口快照表。

同时实测澄清粒度：
- `timePieceType:"month"` + `YYYY-MM` → 正常。
- `timePieceType:"week"` + `2026-09-06_2026-09-12` → **`{"message":"服务异常，请稍后重试","code":0}`**（两个不同周值都失败）。
- `timePieceType:"latelyDay"` + `"30"` → 正常返回（与不传时间参数结果一致）；`"7"` → `total:0` 空结果。
- 不传时间参数 → 正常，等同 `latelyDay/30`。
- **无论传什么时间参数，`boughtHistoryDates` 恒为 40 个月（`2023-05` ~ `2026-08`）、序列内容不变。** 时间参数只改变 `boughtInPastMonth` 取哪一格。

所以 `/Sales` 的销量数据**只有月粒度一种**。协调员给的「month + week 双粒度」结论来自 `/api/search/keyword/timeRanges`（关键词/排名域），在本域的 `bought/*` 接口上周粒度实测不可用。

### 2.1 `fact_asin_bought_monthly`（ASIN 月度销量快照）—— 本域唯一时序表

用途：变体维度销量折线图、表格「月销量趋势」迷你图、以及「子体近30天销量」列，**全部由这一张表供数**。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `asin` | char(10) | 子体 ASIN | 实测 |
| `country` | char(2) | 站点，**进主键**（实测跨站点数据不同） | 实测 US/DE 对比 |
| `stat_month` | char(7) `YYYY-MM` | 统计月份。实测恒为 `YYYY-MM` 格式，范围 `2023-05` ~ `2026-08`（40 个月固定窗口，**比 `timeRanges` 的 `2020-07` 起点短**） | 实测 `boughtHistoryDates:["2023-05","2023-06",...,"2026-08"]`，长度 40 |
| `bought` | int，可 NULL | 该月销量。实测为**整数且已分档**：观测到的取值只有 `0,200,400,500,1000,2000`（无 137、843 这类精确数），说明后端存的就是分档下界 | 实测 `boughtHistory:[0,0,0,0,0,1000,1000,1000,1000,2000,2000,...,200,200,200,200]` |
| `bought_label` | varchar(16) | 分档展示串，即 `boughtInPastMonth`。实测取值集合：`"<50"`,`"100+"`,`"200+"`,`"300+"`,`"400+"`,`"500+"`,`"1,000+"`,`"2,000+"`,`"3,000+"`,`"4,000+"`,`"5,000+"`,`"6,000+"`,`"8,000+"`,`"10,000+"`。**带千分位逗号，是 string 不是 number** | 实测 `boughtInPastMonth:"200+"`；40 行 `boughtTypes:["string"]` |
| `ratio` | ⚠️ number / null | 占比。实测**恒为 null**（`dimension=asin` 与 `dimension=Size` 两种维度、全部 40 个点都是 null），无法确定语义 | 实测 `boughtList:[{"bought":0,"ratio":null,...}]` |
| `boughtInPastMonthBest` | boolean / null | 是否组内最畅销。实测最畅销行 `true`，其余 `null`（非 false） | 实测 `B0BHJJ9Y77` 首行 `bBest:true`，其余 5 行 `null` |
| `pasin_bought` | int，可 NULL | 父体口径月序列（`pasinBoughtHistory[]`）。实测 ASIN 模式与关键词模式**均返回空数组 `[]`**，不是 null | 实测 `pasinBoughtHistory:[]`、`pasinLen:0` |

**主键：`(asin, country, stat_month)`。** 不需要 `time_piece_type` / `time_piece_value` 进主键 —— 实测证明时间参数不改变存储粒度，只是查询期的「取哪个月」选择器。

存储形态：接口返回**并行数组**（`boughtHistoryDates[]` 共享横轴 + 每行 `boughtHistory[]` / 每 char `boughtList[]`），落库须拆成 `(asin, country, stat_month, bought)` 长表。

数据来源口径（实测印证）：页面声明「销量数据源自于亚马逊前台」「最近30天销量是亚马逊在前台展示的：xxx+ bought in past month」。实测 `bought` 全是 100/200/500/1000 的整档值、`bought_label` 带 `+` 后缀，**完全印证这是抓取前台分档展示值，不是精确销量**。

⚠️ 建议同时存 `bought`(int 下界) 与 `bought_label`(原始串)：`"<50"` 无法用整数无损表达（下界是 0 还是 1？），且 `"10,000+"` 的上界未知。

关系：`dim_asin` 1:N `fact_asin_bought_monthly`。

### 2.2 `fact_asin_listing_snapshot`（ASIN Listing 指标快照）

用途：表格价格/评分/评论数三列。

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `asin` | char(10) | | 实测 |
| `country` | char(2) | 进主键 | 实测 |
| `price` | number(double) / null | 价格 | 实测 `74.95` / `389.99` / `1999.99` |
| `score` | number(1 位小数) | 评分 | 实测 `4.8` |
| `star` | number(0.5 步进) | `score` 半星取整（见 1.1） | 实测 |
| `ratingNum` | int | 评论数 | 实测 `203395` / `273127` |

⚠️ **实测确认响应里没有快照日期字段**，也没有历史序列接口（本域只有销量有历史）。如果只保留最新值，这三个字段应直接并入 `dim_asin`，不单独建快照表。倾向于后者。

**`*Best` 系列不建列**（实测确认是查询期组内比较结果）：`priceBest` / `scoreBest` / `ratingNumBest` / `boughtInPastMonthBest`。实测 `B01N5IB20Q` 单独查时 `ratingNumBest:true`、`scoreBest:true`、`priceBest:null`；同一 ASIN 在 `B079XC5PVV` 组里查时标记会变。取值是 `true` / `null` 两态，**没有 `false`**。

---

## 三、关系实体

### 3.1 `rel_user_asin_focus`（用户产品库收藏）

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `user_id` | ⚠️ bigint | 由 JWT token 隐式确定，不在请求/响应体（见不确定清单 5） | 请求体只有 `{type, asins}` |
| `asin` | char(10) | 请求参数 `asins:[...]`（数组，支持批量） | 静态 `38.fba11644.js > Object(h.cb)({type:t,asins:[e.asin]},i.currentSite)` |
| `country` | char(2) | 作为第二参传入 | 同上 |
| `action_type` | tinyint | `1`=加入，`2`=移出 | 静态 `38.fba11644.js@357359 > 2==(e.isFocus?2:1)?$confirm("将此商品ASIN移出产品库，是否继续？")...:i.focus(e,1,n)` |
| `group_id` | ⚠️ bigint | 产品库分组。加入后弹 `choiceGroup` 选分组，分组接口 `/api/user/group/product` 属公共域，本次未实测 | 静态 + 文案「从产品库选择」 |

⚠️ 未实测写操作 —— 会真实改动账号数据（见不确定清单 4）。字段来自静态代码。

反向印证：`/api/user/searchRecord/search` 响应里带 `isFocus` / `isMonitor` / `groups` 字段，说明收藏与分组确实存在（实测 `isFocus:false, groups:null`）。

### 3.2 `rel_user_search_record`（用户搜索历史）

用途：搜索面板历史记录与免费示例。**实测字段远多于静态代码推断的 2 个。**

| 字段名 | 类型 | 说明 | 来源 |
|---|---|---|---|
| `id` | char(32) | 记录 ID，32 位 hex | 实测 `id:"211edfb2988fa528544b2c624d219609"` |
| `content` | varchar | 搜索内容（ASIN 串或关键词） | 实测 `content:"B01N5IB20Q"` |
| `asin` | char(10) / null | 解析出的 ASIN | 实测 `asin:"B01N5IB20Q"` |
| `imgs` | varchar[] | 缩略图 URL 数组 | 实测 `imgs:["https://m.media-amazon.com/images/I/81+9rUcRVTL._AC_UY218_.jpg"]` |
| `isExample` | boolean | 是否系统内置示例 | 实测 `isExample:false` |
| `isMonitor` | boolean | 是否已加入监控 | 实测 `isMonitor:false` |
| `isFocus` | boolean | 是否已加入产品库 | 实测 `isFocus:false` |
| `isPasion` | boolean | ⚠️ 语义不明（疑似 `isPasion`=父体拼写错误 或 passion）。实测恒 `false` | 实测 `isPasion:false` |
| `searchTime` | datetime `YYYY-MM-DD HH:mm:ss` | 搜索时间 | 实测 `searchTime:"2026-09-18 14:13:51"` |
| `updateAt` | ⚠️ datetime / null | 实测恒 null | 实测 |
| `name` / `groups` | ⚠️ / null | 分组名与分组列表，实测恒 null（该 ASIN 未收藏） | 实测 |
| `search_type` | varchar | **请求参数**，本域取值 `boughtByAsin` / `boughtByKeyword` / `boughtMultiAsin` | 静态 `38.fba11644.js > n="boughtByAsin",e.isCompare?n="boughtMultiAsin":"keyword"==e.isSearchType&&(n="boughtByKeyword")`；实测 `boughtByAsin` 返回 `total:2` |

冗余商品快照字段（实测存在但本例全 null，疑似给别的 searchType 用）：`title`、`img`、`ratingNum`、`isBestSeller`、`price`、`score`、`star`、`features`、`asinScore`。

关系：`user` 1:N 记录，按 `search_type` 分场景。

---

## 四、枚举字典

### 4.1 `enum_time_piece`（时间粒度）—— 本域实测结论与全站不同

| value | label | 本域 `bought/*` 实测结果 |
|---|---|---|
| `latelyDay` + `"30"` | 最近30天 | ✅ 正常，等同不传参数 |
| `latelyDay` + `"7"` | 最近7天 | ⚠️ 返回 `total:0` 空结果（接口通但无数据） |
| `month` + `YYYY-MM` | 选择某月 | ✅ 正常，实测 `2026-08`/`2026-07`/`2025-12`/`2024-02`/`2023-10` 均返回；`2023-05` 返回空 |
| `week` + `YYYY-MM-DD_YYYY-MM-DD` | 选择某周 | ❌ **实测报错** `{"message":"服务异常，请稍后重试","code":0}`，两个不同周值都失败 |

前端选项常量（静态，4 项）：`38.fba11644.js > b=[{groupid:"latelyDay7",groupName:"最近7天"},{groupid:"latelyDay30",groupName:"最近30天"},{groupid:"week",groupName:"选择某周"},{groupid:"month",groupName:"选择某月"}]`。
拆参规则：`timePieceType ∈ {latelyDay, month, week}`，`timePieceValue` = 去 `latelyDay` 前缀的数字或对应格式值。

**本域结论：销量数据实际只有月粒度可用。** `latelyDay30` 与 `month` 都只是在同一份 40 个月序列上取不同格子。

### 4.2 `enum_sales_dimension`（折线图维度）—— 实测为动态枚举

| value | 来源 | 实测 `chars[].dimVal` 返回 |
|---|---|---|
| `asin` | 前端硬编码 `unshift({code:"asin",name:"变体"})` | ASIN 码，如 `"B01N0TQPQB"` / `"B01N5IB20Q"` / `"B079XC5PVV"` |
| 属性名（如 `Size`） | 接口 `data.features[]` 下发 | 属性值，如 `"240 GB"` / `"480 GB"` / `"960 GB"` |

实测观测到的属性名（`data.features`，**字符串数组**）：`["Size"]`、`["Style","Size"]`、`["Color","Configuration"]`。
折线图接口的 `data.features` 是对象数组：`[{"name":"Size","code":"Size","fetching":false}]`（多了 `fetching` 布尔位，实测 `false`）。

**实测重要发现**：`dimension` 参数大小写敏感且必须匹配 `features` 里的值。传 `dimension:"Size"` → 正确按属性值聚合（`dimVal:"240 GB"`）；传小写 `dimension:"color"`（非法值）→ **不报错，静默退化成 asin 维度**（`dimVals:["B01N0TQPQB","B01N5IB20Q","B079XC5PVV"]`）。前端默认值 `featuresList:[{name:"color"},{name:"size"}]` 是小写，与接口返回的首字母大写不一致。

按属性维度聚合时，`chars[].features` 实测为 `null`（属性值已在 `dimVal` 里）。

⚠️ 建库时必须做成字典表，不能硬编码 color/size 两列。

### 4.3 `enum_search_granularity`（搜索粒度）

| groupid | groupName | 来源 |
|---|---|---|
| `asin` | ASIN查产品 | 静态 `38.fba11644.js > options:[{groupid:"asin",groupName:"ASIN查产品"},{groupid:"keyword",groupName:"关键词查产品"}]`；实测两条链路分别打 `bought/asin` 与 `bought/keyword` |
| `keyword` | 关键词查产品 | 同上，实测 `keyword:"ssd"` 返回 `total:187` |

### 4.4 `enum_sort_field`（表格排序字段）—— 实测逐值验证

后端对非法值报 `{"message":"参数错误","code":-1}`，据此可穷举白名单。实测结果：

| value | 实测 | 说明 |
|---|---|---|
| `boughtInPastMonth` | ✅ `["10,000+","8,000+","6,000+"]` | 默认排序键，`desc:true` |
| `boughtInMonth` | ✅ 结果与上一致 | **实测接口接受，但响应体无此字段**；排序效果同 `boughtInPastMonth` |
| `star` | ✅ `[5,5,5]` | |
| `score` | ✅ `[5,5,5]` | 实测 `score` 也被接受（静态 sortEnum 里没有） |
| `price` | ✅ `[1999.99,1494.99,1459.99]` | |
| `ratingNum` | ✅ `[273127,203395,203386]` | |
| `brandName` | ✅ 接口通，但返回行 `brand` 为 null | **排序键叫 `brandName`，响应字段叫 `brand`** |
| `firstAvailableDay` | ✅ `["2016-10-11","2016-11-28","2017-01-03"]` | |
| 任意非法值 | ❌ `{"message":"参数错误","code":-1}` | 实测 `sortBy:"bogusField"` |

静态排序枚举：`38.fba11644.js@306333 > J={price,star,ratingNum,boughtInPastMonth,boughtInMonth,brandName,firstAvailableDay}`，默认 `defaultSort:{sortBy:"boughtInPastMonth",desc:!0}`。

### 4.5 `enum_bought_source`（调用来源标记）

| value | 说明 | 来源 |
|---|---|---|
| `sales` | 从 `/Sales` 发起 | 静态 `boughtSource(){return this.ifTimemachine?"timemachine":"sales"}`；实测传 `source:"sales"` 正常 |
| `timemachine` | 从时光机-产品页发起 | 同上 |

⚠️ 调用方标识，非数据实体属性。实测不传 `source` 也能返回结果，说明非必填。

### 4.6 `enum_bought_bucket`（销量分档）—— 实测新增枚举

实测 `bought_label` 的完整观测取值（`/api/search/bought/keyword` 40 行 + 多 ASIN）：
`"<50"`, `"100+"`, `"200+"`, `"300+"`, `"400+"`, `"500+"`, `"1,000+"`, `"2,000+"`, `"3,000+"`, `"4,000+"`, `"5,000+"`, `"6,000+"`, `"8,000+"`, `"10,000+"`

对应 `bought` 整数值实测：`0`(=`<50`), `200`, `400`, `500`, `1000`, `2000`。
分档规律：50 以下归 `<50`；100-1000 区间按 100 档；1000 以上按 1000 档。⚠️ `"7,000+"` / `"9,000+"` 未观测到，档位是否连续未验证。

配套过滤规则（实测印证）：月销量 `<50` 的变体不进结果，被计入 `nbVaiantsNum`。前端空状态文案硬编码阈值 50（`emptyReasons:["站点选择错误","输入的ASIN 子体/父体销量<50"]`、`text:"销量<50"`）。实测 `B01N5IB20Q` 返回 `nbVaiantsNum:1`，即该组有 1 个变体被此规则过滤。

### 4.7 空状态原因（前端固定文案，非后端枚举）

`["站点选择错误","输入的ASIN 子体/父体销量<50"]` —— 静态 `38.fba11644.js > emptyReasons`。
实测印证：查 `B07VXWBBBC` 返回 `total:0`、`features:[]`、`boughts:[]`，即命中第二条原因。

---

## 五、实体关系总览（实测修订版）

```
dim_asin_variant_group  (父子体组；⚠️ 父体码字段未暴露)
    └─1:N─> dim_asin (asin, country)
                ├─1:N─> dim_asin_feature           (code+value，动态属性；实测 Size/Style/Color/Configuration)
                ├─1:N─> fact_asin_bought_monthly   (asin, country, stat_month) ← 本域唯一时序表
                │                                    折线图 + 迷你趋势图 + 「近30天销量」全部由它供数
                ├─(1:1)─ Listing 指标 (price/score/star/ratingNum)
                │         ⚠️ 无快照日期，建议直接并入 dim_asin 而非独立快照表
                └─N:M─> user  via rel_user_asin_focus

user ─1:N─> rel_user_search_record  (id, search_type, content, searchTime, ...)
```

---

## 六、剩余 ⚠️（实测无法覆盖的部分及原因）

1. **`snapshotUpdateTime`** —— 实测在所有请求下恒 `null`。可能只在时光机（`ifTimemachine`）分支或特定权限下填充。无法确定类型与语义。
2. **父体 ASIN 字段 / `isParentAsin:true` 的分支** —— 实测 5 个 ASIN（含 3 个变体组的组内成员）`isParentAsin` 全为 `false`/`null`，**没能构造出父体命中样本**。父体分支下响应结构是否多出字段（父体码、父体销量）无法验证。需要一个已知的父体 ASIN 才能补测。
3. **`ratio`（`boughtList[].ratio`）** —— 实测 `dimension=asin` 与 `dimension=Size` 两种维度、全部 40 个数据点均为 `null`。前端 `t.boughtRatio.push(e.ratio)` 收集后也无消费点。可能是废弃字段或需特定条件才填。
4. **产品库写操作（`/api/user/focus/handle`）的响应结构** —— 未实测，因为会真实修改账号的产品库数据。`type`/`asins` 参数名与 `1`/`2` 取值来自静态代码，可信；返回体只知前端读 `code`/`message`。同理未测 `/api/user/commit/brandListedRefresh`（会触发真实抓取任务）与 `/api/user/group/product`。
5. **`user_id`** —— 由 JWT 隐式携带，不出现在任何请求/响应体。类型只能推断。
6. **`isPasion`（searchRecord 字段）** —— 实测恒 `false`，字段名疑似拼写错误（`isPasion` vs `isParent`?），语义无法判定。
7. **`bought` 分档是否连续** —— 观测到 `1,000+` ~ `6,000+`、`8,000+`、`10,000+`，缺 `7,000+` / `9,000+`。可能是样本不足，也可能档位本身不连续。需更大样本才能定分档表。
8. **`"10,000+"` 的上界** —— 无法从前台分档值反推真实销量上限。
9. **Listing 指标是否有历史** —— 本域接口只返回当前值，没有 price/score 历史序列接口。是「后端不存历史」还是「本域不查历史」无法区分。
10. **`week` 粒度报 `服务异常`的原因** —— 实测两个合法格式周值（`2026-09-06_2026-09-12`、`2026-08-30_2026-09-05`）都返回 `code:0` 服务异常。是本域不支持周粒度、还是后端 bug、还是需要额外参数，无法从外部区分。
11. **`total` 与实际行数的关系** —— 实测 `pageSize:5` 时返回 5 行但 `total:6`，`pageSize:100` 时返回 6 行 `total:6`。`total` 看起来是组内全量数，但分页语义（是否真按 pageNum 翻页）未做多页验证。

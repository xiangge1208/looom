# 广告页面域规格片段

> 素材：`docs/raw/_probe/app.js`（路由表+adNote 服务层）、
> `chunks/30.e24ae056.js`（查广告架构）、`chunks/36.9da811f2.js`（查广告组）、
> `chunks/42.125218d4.js`（查广告词）、`chunks/52.d9d2ec66.js`（查ASIN定位广告）、
> `chunks/63.a6cfa9ac.js`（实时查产品竞价）、`chunks/48.045baa06.js`（查关键词竞价）、
> `chunks/83.3a556eb9.js`（批量备注提交）、`chunks/62.045c5214.js`（备注管理）、
> `chunks/124.24894769.js`（查投放变体，空壳）。
> 全部为 webpack 压缩产物，**非接口响应样例**。类型列几乎无证据，绝大部分标 ⚠️。

## 0. 本域全貌

产品线名称在导航里叫 **广告透视仪**（`app.js @312164` 一级菜单 label `查广告打法`，
`path:"/adxray-structure"`）。功能定位来自 `app.js @314371`：
`{label:"广告透视仪",moduleId:9,tip:"洞察竞品的广告架构"}`。

核心用法：**输入一个 ASIN（竞品或自己的），逆向推测它在亚马逊上跑了哪些广告、
投在哪些词上、各拿了多少流量**。数据来自 Sif 自己爬搜索结果页的广告位，
不是卖家后台授权数据 —— 所以所有 ID 都是 Sif 生成的代号（见 §4 加密 ID）。

### 二级菜单（app.js @312164）

| label | path | 路由 title（app.js @484507 起） | chunk |
|---|---|---|---|
| 查广告架构 | `/adxray-structure` | 查广告架构-广告透视仪\|Sif | 30 |
| 查广告组 | `/adxray-adgroup` | 查广告组-广告透视仪\|Sif | 36 |
| 查广告词 | `/adxray-searchterm` | 查广告词-广告透视仪\|Sif | 42 |
| 查推荐专栏 | `/recommend` | （不属本域） | — |

### “更多”菜单（app.js @314123）

| label | path | 路由 title | chunk |
|---|---|---|---|
| 前台广告位溯源后台广告活动（批量备注） | `/ad-multiNotes-submit` | 批量备注广告活动\|Sif | 83 |
| 管理已备注的广告活动 | `/ad-multiNotes-view` | 查看已备注的广告活动\|Sif | 62 |
| 实时查产品竞价 | `/cpc-realtime` | 实时查产品竞价-Sif | 63 |
| 查ASIN定位广告 | `/adxray-productTarget` | 查ASIN定位广告-广告透视仪\|Sif | 52 |

另有两条不在导航里：

- `/adxray-variation`（title `查投放变体-广告透视仪|Sif`）——
  chunk 124 全文只有 `console.log(this.$route)` 和一个写死的 `查投放变体` div。
  **未实现的占位路由**，本次不产出规格。
- `/cpc-browsetree`（title `查关键词竞价-Sif`，chunk 48）——
  在“选词”菜单下（`app.js @313158`），与 `/cpc-realtime` 共用 cpc 服务层。

## 1. 亚马逊广告层级 —— Sif 怎么组织的（重要，与常识不同）

代码里有一段**权威定义**，来自 `chunks/30.e24ae056.js @481008`（模块 `hfXk` 导出 `a`）：

```
r={content:"投放小组(Product Ad)是亚马逊根据每个广告组(AdGroup)中投放变体的数量创建的更小的广告单位，
           亚马逊投放广告时以变体为单位进行流量的分配与展示",
   linkName:"了解投放小组"}
```

据此，Sif 的层级是 **4 层，不是常识里的 3 层**：

```
广告活动 Campaign        → campaignId / encryptCampaignId / fakeCampaignId
  └ 广告组 AdGroup       ← ⚠️ Sif 前端不建模这一层，见下
      └ 投放小组 Product Ad → adId / encryptAdId / fakeAdId / adShowId
          └ 变体 Variant      → asin
              └ 搜索词 keyword
```

**关键结论：Sif 把「广告组」这个词用在了两个不同层级上，必须区分：**

1. `/adxray-adgroup`（查广告组）页面里，中文“广告组”**指的是投放小组 Product Ad**。
   证据 `chunks/36.9da811f2.js @124321` 模板：
   `投放小组 + t.fakeAdId` / `属于广告活动 + t.fakeCampaignId` / `投放 + t.asin`，
   以及 `@77660` 排序项 `{value:"1",label:"以投放小组为单位"}`。
   页面标题叫“查广告组”，但内部实体是 ad（`adShowId` / `encryptAdId` / `fakeAdId`）。
2. `/adxray-searchterm`（查广告词）页面里，**同时出现“广告活动”和“广告组”两个计数**。
   证据 `chunks/42.125218d4.js @93209`：
   `campaignIdTotalNum 个广告活动、adIdTotalNum 个广告组、variantTotalNum 个变体`
   —— 这里“广告组”对应 `adIdNum`，也就是投放小组。
   所以 **Sif 全站 `adId` = 投放小组 Product Ad，从来不是 Amazon AdGroup**。

**真正的 Amazon AdGroup 层在 Sif 前端没有任何字段**。素材未覆盖 AdGroup 的
id / 名称 / 任何接口。建库时不要凭 “Campaign → AdGroup → Keyword” 常识建 AdGroup 表。

### 广告类型枚举（代码内部值，任务重点 2）

三处独立定义，值一致，可交叉验证：

**主枚举**（`chunks/30.e24ae056.js @481008`，模块 `hfXk` 导出 `d`，即代码里的 `X.d`）：

```
{1:"SP", 2:"SB", 3:"SBV", 4:"SBBV"}
```

**筛选下拉**（同处，导出 `b` 即 `X.b`，字符串型）：

```
[{label:"全部",value:""},{label:"SP",value:"1"},{label:"SB",value:"2"},
 {label:"SBV",value:"3"},{label:"SB+SBV",value:"4"}]
```

**switch 分支**（`chunks/30.e24ae056.js @189854` `funAdType`，`@248556` `addClassType`，
`chunks/62.045c5214.js @8948` `funAdType`）：`case 1/"1"→SP`、`2→SB`、`3→SBV`、`4→SB+SBV`。
注意 switch 同时匹配 number 和 string，说明**后端返回类型不稳定** ⚠️。

| 值 | 主枚举名 | UI 显示 | CSS class（@248556） |
|---|---|---|---|
| 1 | SP | SP | `adType` |
| 2 | SB | SB | `sb_type` |
| 3 | SBV | SBV | `sbv_type` |
| 4 | SBBV | SB+SBV | `sbbv_type` |

**重要：这套 1-4 枚举里没有“SP常规 / SP推荐”的区分。**
SP 常规 vs 推荐是**另一套流量类型枚举**，见下。

### 流量类型枚举（`chunks/63.a6cfa9ac.js @79699`，模块导出 `q`/`c`）

```
w={total:"total", nf:"nf", ad:"ad", allSp:"allSp", sp:"sp", spRec:"spRec",
   allSb:"allSb", sb:"sb", sbv:"sbv"}
S={total:"全部流量", nf:"自然流量", ad:"广告流量", allSp:"SP广告流量",
   sp:"SP(常规)流量", spRec:"SP(推荐)流量", allSb:"SB广告流量",
   sb:"SB(常规)流量", sbv:"SBV流量"}
```

`k` 是把上面每个 label 去掉“流量”后缀得到的短名字典（同处 reduce）。
`/adxray-searchterm` 用 `adTypeName:z.c` + `trafficType:z.q` 组合渲染表头
（`chunks/42.125218d4.js @65227` data()，`@56128` 模板 `e.adTypeName[e.trafficType.sp]`）。

**所以“SP常规 / SP推荐”的代码值是 `"sp"` / `"spRec"`（字符串），
与 adType 的 1/2/3/4 是两个正交维度。** 建议数据字典分两个枚举表。

### 数据回溯起点

`adOverview` / `asinAdKeywordNum/chart` 响应带 `spTraceBackTime` / `sbTraceBackTime`
（`chunks/30.e24ae056.js @203302`、`chunks/36.9da811f2.js @93384`）。
模板文案（`chunks/36 @120375`）：
`SP广告数据最早追溯到{spTraceBackTime}，SB广告(含SB、SBV、SB+SBV)最早追溯到{sbTraceBackTime}`。
另有硬编码下限 `new Date("2022-4-27")`（`chunks/30 @164180` `pickerOptionsGlobal.disabledDate`），
日期选择器不允许早于 2022-04-27。

## 2. /adxray-structure 查广告架构（chunk 30，608 KB，本域最大页面）

### 页面标题
`查广告架构-广告透视仪|Sif`。埋点配置（`app.js @287276`）：
`{page:"ad-structute", parentTab:"广告透视仪", childTab:"查广告架构"}`（`structute` 是源码里的拼写错误）。

### 区块拆解

1. **搜索区** — ASIN 输入框 + 站点切换 + 示例 ASIN + 历史 ASIN。
   走公共组件 `AsinSearchPanel` / `CommonSearch`；ASIN 校验 `/^[A-Z0-9a-z]{10}$/`。
   支持从产品库选（`ProductSelect` 组件，`chunks/30 @455249`，`/api/user/group/product`）。
2. **ASIN 信息卡** — `getAsinDetail()` 调 `/api/search/asinDetail`（`V.hb`），
   取 `res.data.info`（`chunks/30 @188380`）。
3. **概览统计条** — `overviewsBaseData`（`chunks/30 @162472`）：
   ```
   [{type:"sp",num:"spNum",name:"SP"},{type:"sb",num:"sbNum",name:"SB"},
    {type:"sbv",name:"SBV",num:"sbvNum"},{type:"sbSbv",name:"SB+SBV",num:"sbSbvNum"}]
   ```
   对应文案 `个SP、`/`个SBV、`（chunk30 独有中文串）。
   配色 `canvasColors:["#009f52","#b76e22","#af6acd","#5b709f"]`（同处），
   分别对应 SP/SB/SBV/SBBV。
4. **总流量趋势画布（TotalTrafficCanvas）** — 4 条（SP/SB/SBV/SB+SBV），
   `totalCanvasFlows`；`sbSbvTotalNum` 为 0 时隐藏第 4 条（`chunks/30 @237814`）。
   可放大：`放大所有广告活动流量趋势` / `放大流量趋势`。
5. **营销日历叠加层（marketingCalendar）** — `marketingCalendar.eventsByDate`，
   文案 `营销日历` / `未来营销日历` / `亚马逊广告投放分析报告 (点击图标查看报告详情)`。
   含一批 `开发预览：…` 文案（家居/服饰/消费电子类目报告等），是内部预览态，
   ⚠️ 与广告数据无关，不要建表。
6. **广告活动列表（主表 tableData）** — 每行一个 campaign，行内嵌 `ads`（投放小组）
   和 `flows`（分期流量）。列见 §2 接口契约的 `chart` 响应。
7. **投放小组详情抽屉（el-drawer）** — 点投放小组打开，含气泡图 + 关键词表 + 词频。
8. **备注编辑弹窗** — 见 §5 adNote。
9. **下载** — `actionDownload` / `downloadAll` / `downloadHistory`。

### 控件

| 控件 | 变量 | 选项来源 |
|---|---|---|
| 粒度 | `dayValue` | `[{groupid:"week",groupName:"按周"},{groupid:"month",groupName:"按月"}]`（@164676） |
| 广告类型筛选 | `filterType` → `params.conditions.adType` | `campaignTypeList:X.b`（§1 枚举） |
| 排序 | `sortType`（默认 `"1"`） | `sortTypeList:X.c`，6 项，见下 |
| 广告活动下拉 | `campaignValue` | `campaignAdIds` 响应的 `campaign[]`，含 `{fakeCampaignId:"全部",encryptCampaignId:""}` 兜底（@195357） |
| 变体下拉 | `variantValue` | 同接口，`[{name:"全部",asin:""}]` 兜底 |
| 日期区间 | `dateValue` / `flowValue` | `pickerOptionsGlobal`，下限 2022-04-27 |
| 后台广告活动 ID 搜索 | `campaignIdValue` → `conditions.campaignId` | 输入框 placeholder `后台广告活动ID，只支持SP`（@245334） |

排序枚举（`chunks/30 @481008` 导出 `c`）：

```
1 按广告活动时间倒序 / 2 按广告活动时间正序 / 3 按投放小组时间倒序
4 按投放小组时间正序 / 5 广告活动流量大到小 / 6 广告活动流量小到大
```

`params.sortBy` 默认 `"campaign"`（@164180）；`flow` 排序时 `desc` 会被翻转（@195357）。
`doubleClick()` 双击表头重置为排序 `"1"`（文案 `双击可取消排序`）。

### 交互

- **图表点击下钻**：点柱子 → `viewCampaign({type,dataIndex,date})` →
  `resetParams()` + 设 `flowValue=[date,date]` + `conditions.adType=Number(filterType)`
  → 重查（@172221）。文案 `点击柱子可查看贡献本期流量的广告活动`。
- **点投放小组 → 抽屉**：`clickAdGroup(e)` 发 `openDetail({date,fakeAdId,encryptAdId})`（@140100）。
- **抽屉内切换投放小组**：`changeSifGroup()` 换 `paramsDetail.encryptAdId` 并重取
  `getHistory` + `getDetail`（@189854）。
- **时间轴点广告活动**：`selFakeCampaignId()` 把该批 `encryptCampaignId` 推进
  `conditions.encryptCampaignIds[]`（数组，@187199）。

### 空状态

`emptyReasons`（@162472）：
```
["产品未开启关键词搜索广告","搜索的广告曝光少","没有符合当前所有筛选条件的广告"]
```
图表无数据文案 `暂无图表数据`。

### 加载态

`fullscreenLoading` / `fullscreenLoading1..4` / `fullscreenLoadingTimeout` /
`fullscreenLoadingWord` / `groupLoading{}` / `groupAllLoading{}` /
`optionsGroupLoading` / `campaignLoading`（@162472、@164676）。
分区块独立 loading，不是全页一个。

### 错误态

- 超时：`catch` 里判 `t0.isTimeout` → `fullscreenLoadingTimeout=true`（@203302）。
  文案 `数据量太大，加载超时，请稍后尝试`（在 cpc chunk，公共）。
- `code===1103 || 1104` → 视为会员/额度限制，`isSearch=false` +
  `pageApi.clearSearchQueryParams()` + `limitToast()`（@207566）。
- `optionsGroupError` — 投放小组下拉单独的失败态（@215588）。
- `handleTrialLimitDialog(n)` — 试用受限弹窗，否则 `$message` 展示 `n.message`。
- 业务返回约定：**`code===1` 表示成功**（全域一致），不是 0 也不是 200。
- 输入校验文案：`请正确输入广告活动编号` / `输入亚马逊以A开头的广告活动编号`。
- 提示条：`“查广告架构”目前仅支持“按周”或“按月”固定周期维度查看数据，
  所以跟“{N}天活跃广告活动”统计值可能不一致`（@167110，从首页跳过来时提示）。

## 3. /adxray-adgroup 查广告组（chunk 36，437 KB）

### 页面标题
`查广告组-广告透视仪|Sif`。会员门槛：`TrialGate level:"shark" featureName:"查广告组"
model:"asinAdKwNum"`（`chunks/36 @125697`）—— 旗舰会员（shark）专享。

### 区块拆解

1. **搜索区** + **ASIN 信息卡**（同 §2）。
2. **回溯提示条** — `SP广告数据最早追溯到… SB广告(含SB、SBV、SB+SBV)最早追溯到…`
   \+ 插件引导 `在前台广告位逆向还原后台广告活动` / `安装插件还可以完全自动同步`
   \+ `安装插件`按钮 → `openInstall()`（`@120375`）。
3. **筛选条**（4 个 `down-sel`，`@120375`）：
   `广告类型`(filterType/campaignTypeList) · `广告活动`(campaignValue/campaignList) ·
   `投放小组`(campaignGroup/campaignGroupList) · 排序。
4. **左侧投放小组标签列（leftDays）** — 每项一个色块，含（`@124321` 模板 + `@93384` 构造）：
   `funAdType(adType)` 徽标 / `投放小组{fakeAdId}` / `属于广告活动{fakeCampaignId}` /
   `投放{asin}` / 缩略图 `img` / 单条下载图标 `downloadAidi(t)`。
   序号是前端生成的：`group:"投放小组"+((pagePorNum-1)*pagePorSize+n+1)`。
   颜色 `I.j.adxrayColorFun(t.campaignSeq)` —— **按 campaignSeq 上色，
   所以同一广告活动下的投放小组同色**（对应 chunk30 文案 `不同颜色对应不同的投放小组`
   与 `相同颜色对应相同的投放小组` 语义）。
5. **气泡图（ECharts，ref `adGroupRef`）** — X 轴时间、Y 轴投放小组、气泡大小=指标。
   提示 `点击气泡可查看广告搜索词，并推测投放词和匹配模式`（storageKey `adViewGroup`）。
   指标切换 `optionClass`（`@77660`）：
   `[{groupid:1,groupName:"SP广告词数量"},{groupid:2,groupName:"SP广告流量"}]`（变量 `radioClass`）。
6. **分页** — `pagePorSize:100` / `pagePorNum`，`el-pagination`。
7. **关键词抽屉** — 标题模板 `投放小组{adName}在{today}—{nextDay}这一{dayChinese}的广告关键词`
   （`@125697`），内含 `Bubble` 组件 + `detail_table` + 词频 `WordFreq`。
8. **时间范围快捷** — chunk36 独有文案 `最近3个月` / `最近6个月` / `最近1年` / `最近2年`
   → 对应 `params.lastMonths`（默认 6，`@77660`）。

### 控件与请求参数（`chunks/36 @77660` data()）

```js
params: { lastMonths:6, adShowId:"", campaignShowId:"", granularity:"week",
          asin:"", desc:true, groupByCampaign:false, pageNum:1, pageSize:100,
          conditions:{ from:null, to:null, asin:"", campaignId:"",
                       encryptCampaignId:"", encryptAdId:"" } }
paramsDetail: { granularity:"week", asin:"", adShowId:"", endDay:"",
                desc:true, pageNum:1, pageSize:100, sortBy:"" }
```

**排序开关同时切换聚合粒度**（`@91371` `changeSort`）：

| sortValue | label | 效果 |
|---|---|---|
| `"1"` | 以投放小组为单位 | `groupByCampaign=false` |
| `"2"` | 合并展示同一个广告活动 | `groupByCampaign=true` |

这是本页唯一的“聚合层级”开关 —— 前端用一个 bool 在 ad 粒度和 campaign 粒度间切。

### 空状态
`Empty` 组件 + `emptyReasons`（与 chunk30 同构，chunk36 未单独定义新文案）；
`0==total && isSearch && !firstFetch` 才显示（`@124321`），避免首屏闪空。

### 加载态
`fullscreenLoading` / `fullscreenLoading1` / `listDownLoading` /
`showLoading()`+`hideLoading()`（`@93384`）。
特殊逻辑：`flagSearch>0 && flagSearch<=3 && allDates.length==0`
→ 自动把 `lastMonths` 置 null 重查（放宽时间范围重试，`@93384`）。

## 4. /adxray-searchterm 查广告词（chunk 42，253 KB）

### 页面标题
`查广告词-广告透视仪|Sif`。埋点 model `asinAdKwView`（`chunks/42 @65227` computed `speModel`）。

### 语义（关键区分，来自 `@91486` 模板）

```
该Listing在所选时间段内总共有{total}个 [SP]广告 搜索词( 不是投放词 )，
分布在{campaignIdTotalNum}个广告活动和{adIdTotalNum}个投放小组和{variantTotalNum}个变体
```

**这页查的是「广告搜索词」（customer search term，买家真实搜的词），
不是「投放词」（keyword/targeting，卖家设置的词）。** 页面明确标注 `不是投放词`。
投放词只能靠气泡图去“推测”（见 §3 提示文案 `推测投放词和匹配模式`）。

第二段摘要（`@93209`，带 `etymaInfo` 时）：
```
{etymaInfo.total}个，为该Listing贡献了SP广告流量中的{etymaInfo.kwsSpScoreRatio}，
这些搜索词在{etymaInfo.campaignIdTotalNum}个广告活动、{etymaInfo.adIdTotalNum}个广告组、
{etymaInfo.variantTotalNum}个变体上获得了曝光，{topGranularity}搜索量之和大概为
{etymaInfo.estSearchesTotalNum}
```

### 主表列（`searchTermTable`，`chunks/42 @56128` 起，逐列解析）

| prop | 表头 | 表头 tooltip |
|---|---|---|
| （无，`hoverImg`） | `{adTypeName[trafficType.sp]}搜索词({total})` | — |
| `spScoreRatio` | 该词为Listing贡献的{SP}流量占比 | 计算所选时间区间内每个词分别为该Listing贡献的{SP}广告曝光流量占比 |
| （无 prop） | Listing在该词下的… | 计算所选时间区间内这个Listing在这个词下的{SP}… |
| `campaignIdNum` | 有曝光的广告活动 | 所选时间区间内有曝光的广告活动数量 |
| `adIdNum` | 有曝光的广告组 | 所选时间区间内有曝光的广告组数量 |
| `variantNum` | 有曝光的变体 | 所选时间区间内有曝光的变体数量 |
| （无 prop） | 关键词转化率数据是 / 市场平均 | — |
| （无 prop） | 多变体综合 | 该排名趋势是将Listing下的所有变体在这个搜索词下获得的SP排名综合之后展示的趋势，不同的颜色代表不同的变体。 |
| `estSearchesNum` | （搜索量） | — |

默认排序 `spScoreRatio`（`@56128` `default-sort`，`sort-orders:["descending","ascending"]`）。
占比渲染规则（`@56712`）：`>=1e-4` 显示百分比；`<1e-4` 或 `==0` 显示 `<0.01%`；否则 `无`。

### 请求参数（`chunks/42 @65227` data()）

```js
params: { asin:"", timePieceType:"latelyDay", latelyDay:7, month:"", week:"",
          sortBy:"spScoreRatio", desc:false, pageNum:1, pageSize:100, searchKeyword:"" }
paramsDetail: { asin:"", keyword:"", timePieceType:"", latelyDay:0, month:"", week:"" }
```

**时间模型与 §2/§3 不同**：这页用 `timePieceType` + `latelyDay|week|month`
三选一，不用 `granularity` + 日期区间。选项（`@65227`）：

```
[{groupid:"latelyDay7",groupName:"最近7天"},{groupid:"latelyDay30",groupName:"最近30天"},
 {groupid:"week",groupName:"选择某周"},{groupid:"month",groupName:"选择某月"}]
```

校验：选了 week/month 但没选具体日期 → `请选择周的时间` / `请选择月的时间`（`@72640`）。

### 交互

- 点占比单元格 → `openAd(row)` → `/api/search/variantAsinAdKeywords/detail`
  取 `res.data.adInfo`，打开抽屉（`@82726`）。
  抽屉内每条按 `campaignSeq` 上色（`b.j.adxrayColorFun`），
  排名趋势 `spRankHistoryPolar` 由 `spHistory` 构造；`rankStr` 里的 `,` 会被替换成 `:`。
- 抽屉空态：`0==detailData.length` → `暂无广告组`（`@99576`）。
- 排序：`handleSortChange({prop,order})` → `sortBy=prop`，`desc = order==="descending"`。
- 下拉次操作 `筛查相关性并加入词库` → `goReleve()`：
  把当前 params 存 localStorage key `asinAdKwView`，新开
  `/keyword-relatedness?type=asinAdKwView`（`@67986`）。

### 空状态
`emptyReasons`（`@65227` 上方 data）：
```
["未投放过广告","没有符合当前所有筛选条件的广告","ASIN 输入不正确"]
```

## 5. 三个页面之间的跳转关系（任务重点）

三页**互相平级跳转，不是层层下钻**。都通过 `$router.push` + query 传参，
且**只传 asin 和站点，不传 campaign/ad 上下文**。

### 查广告架构 → 查广告组 / 查广告词（`chunks/30 @177773`）

```js
goAdgroup(){ this.params.asin
  ? this.$router.push({path:"/adxray-adgroup",
      query:{asin:this.params.asin, country:this.currentSite,
             piece:this.params.granularity, tabAd:true}})
  : this.$router.push({path:"/adxray-adgroup", query:{country:this.currentSite}}) }

goSearchterm(){ this.params.asin
  ? this.$router.push({path:"/adxray-searchterm",
      query:{asin:this.params.asin, country:this.currentSite, tabAd:true}})
  : ... }
```

注意 `goAdgroup` 多传一个 `piece:granularity`，`goSearchterm` 不传 —— 与 §4 时间模型不同吻合。

### 查广告词 → 查广告架构 / 查广告组（`chunks/42 @67986`）

```js
goStructure(){ ...push({path:"/adxray-structure", query:{asin, country, tabAd:true}}) }
goAdgroup(){   ...push({path:"/adxray-adgroup",   query:{asin, country, tabAd:true}}) }
```

### query 参数约定

| 参数 | 含义 | 消费方 |
|---|---|---|
| `asin` | 目标 ASIN | 各页 `searchValue`，自动触发查询 |
| `country` | 站点码 | `countryCode` store |
| `tabAd` | 标记“从域内 tab 跳来” | 控制 ASIN 卡片入场动画是否跳过（`chunks/30 @188380` `if(!e.tabAd){...动画}`） |
| `piece` | 粒度 `week`/`month`/`latelyDay` | `chunks/30 @167110` 解析：`latelyDay+7→week`，`latelyDay+30→month`，`week`/`month` 原样 |
| `date` | 配合 `piece` 的具体日期/天数 | 同上，`week`/`month` 时构造 `dateValue` 区间并 `changeDate(false)` |
| `campaignId` | 预选广告活动 | `chunks/30 @195357`：匹配 `campaignList[].encryptCampaignId` 后设 `campaignValue` |
| `campaignType=active` | 只看活跃 | `chunks/30 @167110`：设 `sortBy="flow"` 并显示口径差异提示 |
| `type` | 广告类型名（大小写不敏感） | `chunks/30 @167110`：反查 `X.b` label → 设 `filterType` |
| `from=plugin` / `from=multiNotes` | 来源标记 | `chunks/30 @207566`：自动 `scrollIntoView` 到内容区 |

### 结论：能不能下钻？

**不能真正下钻。** 三页共享的只有 ASIN 和时间口径，
`campaignId` 仅在“查广告架构”被消费（且只认 `encryptCampaignId`）。
从广告架构点某个具体投放小组，**不会跳到查广告组页面**，而是在**本页开抽屉**
（`clickAdGroup` → `openDetail`，`chunks/30 @140100`）。
`/adxray-adgroup` 和 `/adxray-searchterm` 都不接收 `encryptAdId` query 参数。

⚠️ 例外：`chunks/36 @91371` `searchBtn()` 接收 `{adShowId, campaignShowId, adId, filterType}`
作为**函数参数**并写入 `params.adShowId` / `params.campaignShowId`，
且 `@93384` 里读 `I.j.qs("fromPaign")` —— 说明**可能存在**从别处带
`adShowId`/`campaignShowId` 进来的入口。素材未覆盖谁在这么调用 → 进不确定清单。

## 6. adNote 系列 —— 是什么功能（任务重点，已核实）

**结论：是「前台广告位 ↔ 后台广告活动」的人工对应表，本质是用户私有备注 + 颜色标签。**
不是打标签分类，也不是系统字典。

### 为什么存在

Sif 爬到的是**亚马逊前台**广告位，前台只暴露一个纯数字 ID；
卖家在**后台**看到的是 `A` 开头的 campaign ID 和自己起的名字。两者无法自动对应。
证据文案（`chunks/30` 独有中文串）：

```
前台广告位溯源后台广告活动（批量备注）      ← 菜单 label
前台纯数字ID如何快速对应后台的广告活动？      ← 引导问句
后台广告活动ID，只支持SP                    ← 搜索框 placeholder
对应前后台广告活动，名称更有用
请输入亚马逊后台广告活动名称，仅自己可见      ← 关键：仅自己可见
备注广告活动信息 / 批量备注 / 管理备注
```

`chunks/62 @37190` 印证：`前台纯数字ID：` / `后台A开头ID：` /
`在Sif无法对应广告活动的两种情况` / `请输入亚马逊后台广告活动名称，仅自己可见`。

所以三个 ID 并存：

| 概念 | 字段 | 来源 |
|---|---|---|
| 前台纯数字 ID | `fakeCampaignId` / `campaignIdNum` / `encryptCampaignIdNum` | Sif 爬取，全站可见 |
| Sif 内部加密 ID | `encryptCampaignId` / `encryptAdId` | Sif 生成的主键代号 |
| 后台 A 开头 ID | `campaignIdA0` / `idA0` / `encryptCampaignIdA0` | **用户手工录入**，`/^A[0-9a-zA-Z]+$/` |

### 接口逐个说明

服务层全在 `app.js @73536–74437`（8 个 fn 连续定义），页面在 chunk 83 / 62 / 30。

| 接口 | 用在哪 | 载荷（已核实） | 功能 |
|---|---|---|---|
| `POST /api/user/adNote/upsert` | 查广告架构页备注弹窗（`chunks/30 @174521`，`M.d`） | `{type:"campaign", name, id, productType:"mine"\|"rival", colorid, idA0}` | 单条新增/更新备注。`id` 传 `encryptCampaignId` |
| `POST /api/user/adNote/batchUpsert` | 批量备注页（`chunks/83 @3391` confirmEdit，`h.h`） | `{ads:[{idA0, name, colorid, country}, …]}` | 批量提交，一次多行 |
| `GET /api/user/adNote/extraInfo` | 批量备注页（`chunks/83 @1461`，`h.b`） | `{campaignIdA0, country}` | **按后台 ID 反查站点**。响应 `data.countrys[]`；长度 1 则自动选中，多个则让用户手选（`未查到该广告活动的站点信息，请手动选择站点`） |
| `POST /api/user/adNote/id` | 提交前查重（`chunks/83 @3391`，`h.b` 同名调用） | `{campaignIdA0}` | 存在性检查。响应 `data.id` + `data.name`；命中则提示 `该广告活动编号已存在，请勿重复输入` 并回填 `usedname` |
| `POST /api/user/adNote/list` | 备注管理页（`chunks/62 @42952`，`g.c`） | `{searchValue, sortBy, desc, pageNum:1, pageSize:20, productType:"mine", country:null, adStatus:"ENABLED"}` | 分页列表。响应 `{notes:[], total}` |
| `POST /api/user/adNote/delete` | 两处（`chunks/62 @39874` `g.a`；`chunks/30 @173553` `M.a`） | 管理页 `{ids:[id]}`；架构页 `{ads:[{id:encryptCampaignId}]}` | ⚠️ **两种载荷形态不一致**，同一路径 |
| `POST /api/user/adNote/batchUpdateColor` | 管理页批量改色（`chunks/62 @40065`，`g.g`） | `{ids:[...], colorid}` | 只改颜色 |
| `POST /api/user/adNote/updateByid` | `app.js` 导出 `.nb` | 素材未覆盖调用点 | 按 id 更新 |

配色池来自**另一个接口** `M.w` / `g.w` / `h.w`（`chunks/30 @176266`、`62 @38241`、`83 @416`），
响应 `data.colors[] = [{id, color}, …]`。⚠️ 该路径不在 ads.txt 清单里，未能定位，进不确定清单。

### 校验规则（`chunks/62 @45164` + `chunks/83 @1461`）

- `idA0` 必须 `/^A[0-9a-zA-Z]+$/`，纯数字则报 `请正确输入广告活动编号`。
- `valueNum`（前台纯数字）必须 `/^\d+$/`，否则 `请正确输入纯数字ID`。
- `name` 非空 → 否则 `请至少输入一个备注字符` / `请先输入广告活动名称`。
- 备注名长度：架构页限 **40** 字符（`最多输入40个字符`，`isA0ExceedLimit`）；
  管理页 `nameMaxLength:200`（`chunks/62 @37190`）。⚠️ 两处不一致。
- `colorid` 必填 → `请选择备注背景色`。
- 同一批次内 `idA0` 不可重复（`chunks/83 @1461` `inputList.some(...)`）。

### 管理页表格列（`chunks/62 @60777` `_m(1)` 静态表头）

```
序号(3%) | 广告活动名称(13%) | 广告活动编号(14%) | 投放的产品(8%) |
所属站点(5%) | 备注时间(8%) | 操作(5%)
```

批量操作下拉（`@51529`）：`批量修改背景色` / `批量添加更多备注` / `批量删除`。
状态筛选（`@37190` `optionsSel`）：
`[{label:"查看进行中的广告活动",value:"ENABLED"},{label:"查看全部广告活动",value:null}]`
→ `params.adStatus`。产品归属：`productType` `"mine"`(我的产品) / `"rival"`(竞品)，
UI 变量 `myProduct` 用 `"1"`/`"2"` 映射（`chunks/30 @176266`）。

空态（`chunks/62 @37190`）：
```
["暂无备注任何广告活动信息","请检查站点选择是否正确","请检查搜索广告活动名称、编号是否有误"]
```

### 删除后前端清空的字段（`chunks/30 @173553`，反推备注写回主表的字段集）

```
campaignName, campaignColor, campaignColorid, productType, campaignIdA0Note
```

即：备注会把 5 个字段挂到 campaign 行上。⚠️ 注意 `campaignIdA0Note`（备注里的 A0）
与 `campaignIdA0`（campaign 自带的 A0）是**两个字段**（`chunks/30 @176266`
`valueA0 = e.campaignIdA0Note || ""`，而 `curActid = e.campaignIdA0`）。

### 自动同步（浏览器插件）

`chunks/83` 文案：`开启广告活动同步功能` / `设置增量自动同步` /
`去广告活动管理页完成首次全量同步` / `下载最新版插件` / `第一步/第二步/第三步`。
`chunks/30` 文案：`使用插件自动同步` / `同步所有广告活动` / `手动对应` / `插件预览效果`。
说明备注可由插件从卖家后台抓取后批量灌入，不只手工录。素材未覆盖插件用的接口。

## 7. /api/search/cpc/* 十个端点是什么（任务重点）

**结论：是「查亚马逊建议竞价（Suggested Bid）」，一个异步任务型功能。
与广告架构/广告组/广告词三页没有任何数据关联，是独立子功能。**

两个页面共用同一套服务层（chunk 63 与 chunk 48 的 cpc 端点集完全相同）：

| 路由 | title | chunk | 入口 |
|---|---|---|---|
| `/cpc-realtime` | 实时查产品竞价-Sif | 63 | 广告透视仪“更多”菜单 |
| `/cpc-browsetree` | 查关键词竞价-Sif | 48 | “选词”菜单 |

导航 tip（`app.js @314371`）：`{label:"查竞价",moduleId:14}`。

### 为什么是异步任务

亚马逊的建议竞价必须实时问亚马逊广告接口，拿不到就得排队。
证据（`chunks/63 @35755` 模板）：

```
您有新任务正在执行，预计{waitingTime}秒后返回结果   +  [刷新状态]
任务创建成功，请稍候刷新查看
```

`t.finish` 为真才显示 `再次查询 / 查看 / 删除` 三个操作。

### 端点契约（fn 映射由 `chunks/63` 模块导出表解出）

| 导出 | 方法 | 路径 | 载荷（已核实） | 触发场景 |
|---|---|---|---|---|
| `_.d` | GET | `/api/search/cpc/createCheck` | `{}` | 点“创建查询任务”前置检查。响应 `data.role_integral_limit`（积分/次数上限，默认 2）。`code===4705` → 弹会员框（`@14176`） |
| `_.c` | POST | `/api/search/cpc/create` | `{type, asin, keywords[]}` | 提交任务。`type`：`0`=自动推荐，`1`=手动关键词（`@sureChoice`：`taskType==1 ? 0 : 1`，⚠️ UI 值与接口值反着的） |
| `_.k` | POST | `/api/search/cpc/list` | `{pageNum, pageSize:100, searchKeyword, asin}` | ASIN 任务列表主表。响应 `{total, asins:[]}` |
| `_.m` | GET | `/api/search/cpc/asinTaskList` | `{asin}` | 某 ASIN 的多次查询历史。响应 `data.tasks:[{id, createdAt}]`，填“查询时间”下拉（`@18866`）。文案 `的多次查询历史` / `对比多次查询` |
| `_.f` | POST | `/api/search/cpc/detail` | `{id, adType:"sp", granularity:"week", searchKeyword, pageNum, pageSize:100, sortBy, desc}` | 打开详情抽屉。响应 `{keywords:[], total, globalKeywordNum}`（`globalKeywordNum` 缺省兜底 1e6） |
| `_.b` | POST | `/api/search/cpc/detailKeyword` | 素材未覆盖显式载荷 | 关键词维度详情 |
| `_.l` | POST | `/api/search/cpc/refreshTaskStatus` | `{id: unfinishId, searchKeyword}` | 点“刷新状态”。成功文案 `状态刷新成功` |
| `_.e` | GET | `/api/search/cpc/deleteTask` | `{asin}` | 删除该 ASIN 全部任务。二次确认 `确认删除该ASIN查询的所有时间段的的竞价数据吗？`（原文有重复“的”） |
| `_.a` | POST | `/api/search/cpc/category` | 素材未覆盖 | **类目竞价**。文案 `选择要展示竞价的类目` / `类目节点` / `全部类目` / `该类目下关键词` |
| `_.j` | POST | `/api/search/cpc/categoryId/list` | 素材未覆盖 | 类目 ID 列表，供上面选择器 |

导出型下载三个：`_.g`=`/api/updown/cpcCategory/download`、
`_.h`=`/api/updown/cpcDetail/download`、`_.i`=`/api/updown/cpcKeywordDetail/download`
（全部 `responseType:"blob"`）。
按钮文案 `下载建议竞价` / `下载详情建议竞价` / `下载关键词建议竞价` / `下载关键词排名趋势`。

第 11 个相关端点 `/api/search/focusKeywords/cpcCategory`（`chunks/30` 导出 `V.R`）
在**查广告架构**页被引用，⚠️ 素材未覆盖它在该页的具体用途。

### 竞价矩阵（6 种，`chunks/63 @18866` `headType`）

抽屉表头是 6 列的竞价矩阵，2 种出价策略 × 3 种匹配模式：

| `sort` 值 | 表头（含 `<br/>`） | 短名（`@79699` 常量 `f`） |
|---|---|---|
| `autoExact` | 提升与降低 / 精准 | `autoForSales_exact` → 提降·精准 |
| `autoPhrase` | 提升与降低 / 词组 | `autoForSales_phrase` → 提降·词组 |
| `autoBroad` | 提升与降低 / 广泛 | `autoForSales_broad` → 提降·广泛 |
| `legacyExact` | 仅降低/固定 / 精准 | `legacyForSales_exact` → 固定·精准 |
| `legacyPhrase` | 仅降低/固定 / 词组 | `legacyForSales_phrase` → 固定·词组 |
| `legacyBroad` | 仅降低/固定 / 广泛 | `legacyForSales_broad` → 固定·广泛 |

⚠️ `headType[].sort`（`autoExact`）与常量 `f[].type`（`autoForSales_exact`）
是**两套命名**，前者用于排序参数，后者用于展示。对应关系是我按语义配的，
代码里没有显式映射表 → 进不确定清单。

`legacy`/`auto` 对应亚马逊的 legacyForSales / autoForSales 竞价策略；
`ForSales` 后缀说明是「以销量为目标」的策略族。

### 匹配模式枚举（`chunks/63 @79699` 常量 `g`）

```
[{groupid:"0",groupName:"全部"},{groupid:"Exact",groupName:"精准匹配"},
 {groupid:"Phrase",groupName:"词组匹配"},{groupid:"AllMatch",groupName:"广泛匹配"},
 {groupid:"sameNichId",groupName:"相同市场筛选"}]
```

⚠️ 注意「广泛匹配」的值是 `AllMatch` 而不是 `Broad`；
`sameNichId` 不是匹配模式而是混进来的筛选项（拼写也可疑，可能是 `Niche`）。

### 图表模式（`chunks/63 @79699` 常量 `y`）

```
[{type:"nfAd",name:"自然-广告"},{type:"exposurePosition",name:"曝光位置"}]
```

### 任务创建弹窗（`chunks/63 @36718`）

- 标题 `创建查询任务`
- `任务类型：` 两个互斥按钮 → `taskType`
  - `1` = `查询亚马逊自动推荐的广告词`，提示 `自动推荐亚马逊最多返回200个关键词`
  - `2` = `手动输入关键词`，textarea 提示 `多个关键词可换行；或直接从Excel按列批量复制粘贴`，
    限制 `仅支持输入200个关键词`
- ASIN 输入框；从已有任务点“再次查询”时 `isDisabled=true` 锁定 ASIN，
  并用 `e.lastKeywords.join(",")` 回填上次的词（文案 `已自动帮您填充上次查询的关键词，您可以增加或者删除`）
- 文本清洗（`@14176`）：`\t`/`\n` → `,`，全角 `，` → `,`，压缩多空格

### 空/错误态（chunk 63）

- `暂无查询任务，请创建`（无 asin 筛选时）
- `暂无该ASIN查询任务，请创建`（带 asin 筛选时）
- `暂无符合条件的关键词`（关键词搜索无结果）
- `您输入的ASIN格式不正确` / `请输入ASIN` / `请输入关键词`
- `该关键词未进入ABA`（单元格级）
- `旗舰会员专享功能` / `当前功能为会员功能，请开通旗舰会员`
- chunk 48 额外：`暂无竞价数据` / `查关键词竞价功能仅基础/旗舰会员专享，暂不支持积分使用。`

## 8. 其他两个页面（简要）

### /adxray-productTarget 查ASIN定位广告（chunk 52）

标题 `查ASIN定位广告-广告透视仪|Sif`。与 chunk 30/36 端点集高度重叠
（同样引用 `asinAdCampaignView/*` 全部 10 个）。独有文案（`chunk52 only`）：

```
查ASIN定位广告 / 在投放小组{X} 下为变体 / 变体在该词下的… /
{N}个投放小组、{N}个变体、{N}个广告搜索词 /
在该广告活动下贡献的广告流量占比： / 贡献的关键词广告流量占比： /
按周查看 / 按月查看 / 从历史到现在 / 从现在到历史 /
请输入广告活动编号 / 您输入的广告活动编号有误 /
输入的广告活动编号有误，请参考搜索框下方的提示复制 /
暂无列表数据 / 暂无广告搜索词数据 / 请核实是否选择了正确的站点
```

**入口不是 ASIN 而是广告活动编号**（`请输入广告活动编号`），
方向是「给定一个 campaign，看它定向了哪些 ASIN / 变体 / 搜索词」——
与 §2-§4 的「给定 ASIN 看广告」方向相反。
⚠️ 素材未覆盖它独立的接口（复用 asinAdCampaignView 系列），未做逐控件拆解。

### /adxray-variation 查投放变体（chunk 124）

`chunks/124.24894769.js` 全文 375 字节：

```js
{data(){return{}},methods:{},mounted(){console.log(this.$route)}}
// 模板：<div>查投放变体</div>
```

**空壳，未实现。** 不产出规格，不建表。

## 9. 接口契约表

### asinAdCampaignView 系列（查广告架构主力，chunk 30 服务层 @435211–437044）

`s.a` = GET，`s.b` = POST（依 `app.js` axios 封装两个导出的用法区分）。

| 方法 | 路径 | 请求参数 | 响应字段（已见证） | 触发场景 |
|---|---|---|---|---|
| POST | `/api/search/asinAdCampaignView/chart` (`V.q`) | `{granularity, asin, pageNum, pageSize, isAsinSearch, sortBy, desc, conditions:{from,to,asin,campaignId,encryptCampaignId,encryptCampaignIds[],adType}, flowTimeDis:{begin,end}}` | `campaigns[]`(主表), `dates[]`, `total`, `adNum`, `spNum`, `sbNum`, `sbvNum`, `sbSbvNum`, `spTraceBackTime`, `sbTraceBackTime` | 页面主查询 `getPolarData()`（@203302） |
| GET | `/api/search/asinAdCampaignView/campaignBrief` (`V.E`) | `{}` + 第二参（config） | 素材未覆盖 | 广告活动摘要 |
| POST | `/api/search/asinAdCampaignView/adOverview` (`V.k`/`V.l`) | 素材未覆盖显式载荷 | `overviews[]`, `ads[][]`（二维：ad × 时间点，元素 `{score, fakeAdId, encryptAdId}`） | 概览趋势图（@159105 `formatOverviewsData`/`setPolarData`） |
| POST | `/api/search/asinAdCampaignView/campaignKeywords` (`V.F`) | `{campaignId:encryptCampaignId, adType, desc, endDay, granularity, searchKeyword, sortBy:"searchWeightByAmzMode", wordModel}` | 素材未覆盖 | 抽屉内广告活动关键词（@140100 `getListServiceFn`） |
| POST | `/api/search/asinAdCampaignView/campaignAdIds` (`V.D`) | `{asin, isAsinSearch, granularity}` | `campaign[]`（每项含 `fakeCampaignId`,`encryptCampaignId`）, 变体列表 | 填充广告活动/变体下拉（@195357 `getListDown`） |
| POST | `/api/search/asinAdCampaignView/adList` (`V.j`) | 素材未覆盖 | 素材未覆盖 | 投放小组列表 |
| POST | `/api/search/asinAdCampaignView/adDetail` (`V.f`) | `{granularity, asin, encryptAdId, endDay, desc, pageNum, pageSize, sortBy, searchKeyword, isAsinSearch, adType, encryptCampaignIdA0, encryptCampaignIdNum}` | `total`, `keywords[]`（每项 `keyword, spScoreRatio, estSearchesNum, estSearchesNumHistory{date[],estSearchesNum[]}, estSearchesNumHistoryPrev, searchesRank, clickPurchaseRatio, purchaseVolume, asinFeatures[]{asin}, img`；前端派生 `passHourAsins`,`endDate`） | 抽屉关键词表 `getDetail()`（@216476） |
| POST | `/api/search/asinAdCampaignView/adHistory` (`V.g`) | `{encryptAdId, granularity, adType, isAsinSearch, asin, encryptCampaignIdA0, encryptCampaignIdNum}` | `dates[]` + 时序数据 | 抽屉气泡图 `getHistory()`（@214664） |
| POST | `/api/search/asinAdCampaignView/conditions` (`V.e`) | 素材未覆盖 | 素材未覆盖 | 筛选项元数据 |
| POST | `/api/search/asinAdCampaignView/chartFlowRatio` (`V.G`) | `{granularity, asin, pageNum, pageSize, conditions{}, flowTimeDis{begin,end}, sortBy, desc, isAsinSearch}` | 素材未覆盖 | 流量占比图 `getFlowData()`（@207566） |
| POST | `/api/search/adCampaignView` (`V.c`) | 素材未覆盖 | 素材未覆盖 | ⚠️ 与上面 `asinAdCampaignView` 是**不同**端点，无 `asin` 前缀 |
| POST | `/api/search/adCampaignView/detail` (`V.T`) | 素材未覆盖 | 素材未覆盖 | 同上系列的详情 |
| POST | `/api/search/adIdDetailWordFrq` (`V.h`) | 素材未覆盖 | 素材未覆盖 | 投放小组词频（`wordFrqTypeKey:"adIdDetailWordFrq"`，@162472） |

导出：`/api/updown/asinAdCampaignViewAdDetail/download`(`V.p`)、
`…/downloadAll`(`V.o`)、`/api/updown/asinAdCampaignViewKeywords/download`(`V.X`)、
`…/downloadAll`(`V.U`)、`/api/updown/adCampaignViewDetail/download`、
`/api/updown/adIdDetailWordFrq/download`(`V.i`)。全部 `responseType:"blob"`。
按钮文案 `下载本期关键词` / `下载全部关键词`（对应 download vs downloadAll）。

### asinAdKeywordNum 系列（查广告组，chunk 36 导出 `.m/.n/.Q`）

| 方法 | 路径 | 请求参数 | 响应字段 | 触发场景 |
|---|---|---|---|---|
| POST | `/api/search/asinAdKeywordNum/chart` (`.m`) | 见 §3 `params` | `adInfo[]`（每项 `fakeAdIdOrg, fakeCampaignIdOrg, adType, adShowId, fakeAdId, fakeCampaignId, asin, img, campaignSeq, history[][ts,value]`）, `allDates[]`, `total`, `spNum`, `sbNum`, `sbvNum`, `spTraceBackTime`, `sbTraceBackTime`, `campaignTotal`, `adCount` | 页面主查询（@93384） |
| POST | `/api/search/asinAdKeywordNum/detail` (`.n`) | 见 §3 `paramsDetail` | 素材未覆盖 | 关键词抽屉 |
| POST | `/api/search/asinAdKeywordNum/conditions` (`.Q`) | 素材未覆盖 | 素材未覆盖 | 筛选项元数据 |

导出：`/api/updown/asinAdKwNumDetail/download`(`.s`)、`/api/updown/asinAdKeywords/download`(`.r`)。

### variantAsinAdKeywords 系列（查广告词，chunk 42 导出 `x.Ib/x.Jb`）

| 方法 | 路径 | 请求参数 | 响应字段 | 触发场景 |
|---|---|---|---|---|
| POST | `/api/search/variantAsinAdKeywords/list` (`x.Ib`) | 见 §4 `params` | `keywords[]`(主表，字段见 §4 列表), `campaignIdTotalNum`, `adIdTotalNum`, `variantTotalNum`, `etymaInfo{total, kwsSpScoreRatio, campaignIdTotalNum, adIdTotalNum, variantTotalNum, estSearchesTotalNum}` | 主查询 `getListData()`（@72640） |
| POST | `/api/search/variantAsinAdKeywords/detail` (`x.Jb`) | `{asin, keyword, timePieceType, latelyDay, month, week}` | `adInfo[]`（每项 `campaignSeq, spHistory{date[], <各变体>:[{rankStr,…}]}, asin, features[], fakeAdId`；前端派生 `color`,`spRankHistoryPolar`） | 点占比开抽屉 `openAd()`（@82726） |

导出：`/api/updown/variantAsinAdKeywordsList/download`(`x.Lb`，载荷
`{asin,searchKeyword,timePieceType,latelyDay,month,week,sortBy,desc}`)、
`…Detail/download`(`x.Kb`，载荷 `{asin,keyword,timePieceType,latelyDay,month,week}`)。

### adNote 系列 / cpc 系列
见 §6 / §7 的表格。

## 10. 公共约定（本域观察到的）

- **成功码是 `1`**：全域 `1==res.code` 判成功。`1103`/`1104` = 搜索额度限制，
  `4705` = 需开会员（cpc createCheck）。
- **会员分级**：`shark`（旗舰）/ `vip`（基础）。`TrialGate` 组件
  `level:"shark"` 门禁；`speInfo:{isValidShark:true}`。
  查广告组明确 `level:"shark" featureName:"查广告组" model:"asinAdKwNum"`。
- **`isAsinSearch`** 布尔量被塞进多个请求（`chart`/`adDetail`/`adHistory`/
  `campaignAdIds`/`chartFlowRatio`），区分“按 ASIN 查”还是其他入口。
- **空值清理**：`flowTimeDis` 的 begin/end 都空时会被 `delete` 掉再发请求（@203302）。
- **粒度值**：`{day:"day", week:"week", month:"month"}`（`chunks/63 @79699` 常量 `v`）。
- 站点通过 `countryCode` store + query `country` 传递，所有跳转都带。

## 11. 本域不确定清单

### 层级与实体

1. **Amazon AdGroup 层完全缺失。** Sif 的 `adId` = Product Ad（投放小组）。
   素材里没有任何 AdGroup 的 id/名称/接口。是后端没采集，还是前端不展示？无法判断。
2. `campaignSeq` 的语义。用于上色（`adxrayColorFun(campaignSeq)`）和
   `Math.max(...campaignSeqs)` 求 `totalAd`（`chunks/36 @93384`），
   看起来是**广告活动在结果集内的序号**（1..N），但是否跨请求稳定、
   是否与 campaign 一一对应，无证据。
3. `fakeAdIdOrg` / `fakeCampaignIdOrg` 与 `fakeAdId` / `fakeCampaignId` 的差别。
   只在 `chunks/36 @93384` 同时出现，`Org` 后缀疑为“原始值”，用途未见。
4. `encryptCampaignIdA0` / `encryptCampaignIdNum` 是 campaign 自带字段还是
   备注派生字段。它们随 `adDetail`/`adHistory` 请求发出（`chunks/30 @202938`），
   但取自 `e.encryptCampaignIdA0`（campaign 行对象），不是备注对象。
5. `adShowId` vs `encryptAdId` —— chunk 36 用 `adShowId`，chunk 30 用 `encryptAdId`，
   是同一标识的两种编码还是两个不同 ID，无证据。
6. `/api/search/adCampaignView` 与 `/api/search/asinAdCampaignView/*` 的关系。
   前者无 `asin` 前缀，两者被同一批 chunk 引用，但调用点未见。

### 枚举

7. `adType=4` 的两种写法：主枚举写 `SBBV`，UI 显示 `SB+SBV`。
   是「同时投了 SB 和 SBV」还是「SB 视频广告的一种」？文案
   `SB广告(含SB、SBV、SB+SBV)` 暗示 4 是 2 和 3 的并集，但未确证。
8. cpc 竞价矩阵两套命名（`autoExact` vs `autoForSales_exact`）的映射，
   代码里无显式对照表，§7 表格里的对应是我按语义推的。
9. `sameNichId` 混在匹配模式枚举里，语义和拼写都可疑。
10. 流量类型枚举 9 个值里 `allSp` / `allSb` 是聚合值还是独立值（是否
    `allSp = sp + spRec`），无证据。

### adNote

11. **颜色池接口路径未定位。** `M.w` / `g.w` / `h.w` 返回 `data.colors[{id,color}]`，
    但该路径不在 `docs/raw/domains/ads.txt` 里，我未在本域素材中找到它。
    可能属于别的域（用户配置类）。
12. `/api/user/adNote/delete` 两种载荷（`{ids:[]}` vs `{ads:[{id}]}`）指向
    同一路径，后端是否兼容两种、`ads[].id` 传的是 `encryptCampaignId` 而
    `ids[]` 传的是备注自增 id —— **两者是不同的键**，这点很可疑。
13. `/api/user/adNote/updateByid` 无调用点，功能与 `upsert` 的区别不明。
14. `/api/user/adNote/id` 用 POST 但语义是查询（存在性检查），
    响应 `{id, name}`。为什么不用 GET，无从判断。
15. 备注名长度限制 40（架构页）vs 200（管理页）不一致，哪个是后端真实约束不明。
16. `productType` 的 `"mine"`/`"rival"` 是**用户主观标记**还是系统判定
    （比如与产品库归属联动）。`chunks/30 @176266` 从 `e.productType` 读回，
    说明存在服务端，但谁写入不确定。

### cpc

17. `/api/search/cpc/category` 和 `/api/search/cpc/categoryId/list` 的载荷/响应
    完全未覆盖，只能从 chunk 48 文案（`选择要展示竞价的类目`/`类目节点`）推功能。
18. `/api/search/cpc/detailKeyword` 无显式调用载荷。
19. `/api/search/focusKeywords/cpcCategory` 在**查广告架构**页被引用（`V.R`），
    但那页与竞价无关，用途不明。
20. cpc `create` 的 `type` 值 UI/接口反向映射（`taskType==1 ? 0 : 1`）
    是笔误还是有意，无法判断。风险：若照抄会把两种任务类型搞反。

### 页面

21. `/adxray-productTarget`（chunk 52）未做逐控件拆解 —— 它复用
    `asinAdCampaignView` 全部端点但入口是 campaign 编号，
    请求参数与 §2 的差异未验证。
22. `chunks/36 @91371` `searchBtn({adShowId, campaignShowId, adId, filterType})`
    和 `qs("fromPaign")` 说明存在带广告上下文进入查广告组页的入口，
    但**没有任何页面在这么调用**（§5 的 `goAdgroup` 只传 asin）。
    可能是插件或旧版入口。
23. 首页“7天广告活动”卡片跳来时会带 `campaignType=active`，
    并弹口径差异提示 —— 说明存在**第三套统计口径**（按天活跃），
    与本域的按周/按月不一致。该口径的数据源未在本域素材中出现。
24. `chunks/30` 里成批的 `开发预览：xxx报告` 文案（营销日历/节日报告），
    是未上线功能的预览态，不清楚是否已有对应接口。











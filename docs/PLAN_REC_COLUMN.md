# 「查推荐专栏」开发实现计划

对标原站 `https://www.sif.com/recommend?country=US&asin=<ASIN>`。
本文所有结论来自 2026-09-22 对原站的实测抓包与本库的实际查询，不是推测。

> ## ⛔ 开工前必读：数据侧核查未通过
>
> 2026-09-22 对 Doris 逐表核查，结论是**当前不具备实现条件**。
> 详见 `AUDIT_REC_COLUMN_DATA.md`，两条硬阻断：
>
> 1. `fact_asin_rec_column_period` **零条真实数据**（64 行全是 `B0SEED*` seed）
> 2. `rel_rec_column_campaign_keyword` 词覆盖**无一个 ASIN 达到 10 词**
>    （2036 个 ASIN，平均 2.2 词，最大 8 词；原站单个专栏就有 32 词）
>
> 本文第二节写的"我们库 4 专栏 3 活动 7 词"偏乐观：7 是行数，
> **distinct 词只有 3，distinct 活动只有 2**。
>
> 另有两处本文当作既定事实、实际**尚未验证**的前提：
>
> - 那 214 对 ratio 在 Doris 里**找不到**（`fact_asin_traffic_channel`
>   只有 `spRec` 渠道汇总，不拆到专栏），应在 PG 源侧，Doris 未落。
> - 步骤 1 依赖的 `allRankHistory.recRanks` 是逐日数组这一点，
>   因 `.env` 缺 `PG_PASSWORD` **未能验证**，目前仍是推断。
>
> 视觉与接口契约规格另见 `SPEC_REC_COLUMN_UI.md`（已完成，含 5 个接口的
> 真实响应体、设计 token、伪类状态、Dialog/Drawer 实测结构）。

---

## 一、原站到底是什么

一个**三视角互为转置**的钻取页。核心实体三个：推荐专栏、广告活动、广告词。
页面让你从任一个入口出发看另外两个。

```
                  ┌── 推荐专栏视角（默认表）
ASIN ── 推荐专栏 ─┼── 广告活动视角  campaign → 各专栏 → 各词
                  └── 广告词视角    keyword  → 各专栏 → 各活动
```

版面自上而下：

| 区 | 内容 |
|---|---|
| 0 | **科普横幅**（橙色）：11 个常见专栏的说明 + 「安装插件同步广告活动名称」按钮 |
| 1 | **长周期趋势图**：堆叠面积图，图例分页 `1/3`，底部 dataZoom 缩放条，纵轴「7天流量得分」 |
| 2 | 计数卡三连：获得的推荐专栏 5 / 广告活动数量 3 / 广告词数量 35 |
| 3 | 专栏表（默认展示），表头上方有「所选时间段内该产品在关键词搜索页获得了 5 个推荐专栏」 |
| 4 | 视角 tab：**广告活动视角 / 广告词视角**，各自带行内二级子表 |

> ⚠️ 区 1 在区 2 之上 —— 图表在计数卡**前面**。我第一版把顺序写反了。

### 页面控件（第一版全漏了，这里补全）

我第一版只截了一张全页图就去读 DOM，结果这些控件全没记录。原因有两个：
图表是 canvas（ECharts），图例/分页/缩放条都在 canvas 内绘制，DOM 里读不到；
筛选器和单选按钮在页面下半部分，全页缩略图里看不清。

| 控件 | 位置 | 候选值 | 对应参数 |
|---|---|---|---|
| 时间范围 | 页头 | 最近7天 / 最近30天 / **选择某周** / **选择某月** | `timePieceType` + `timePieceValue` |
| 图表时间粒度 | 图表区「图表可点击切换时间」 | 点击图表切换 | `trends` 的 `timeDim` |
| 筛选推荐专栏 | 视角 tab 右侧 | 全部 + 该 ASIN 实际有的专栏 | `recTitle`（空=全部） |
| 筛选广告类型 | 视角 tab 右侧 | 全部广告 / 自动广告 / 手动广告 | `campaignType`（空=全部） |
| 趋势列指标 | 子表「广告推荐专栏获得趋势」表头 | 广告词数量 ↔ 流量占比 | 纯前端切换，两个 tab 各一组 |
| 下载 | 三处 | 下载图表 / 下载搜索结果 ×2 | 导出 |

时间选择器有 4 档而不是固定 7 天，这点影响后端接口签名 —— 必须接受
`timePieceType ∈ {latelyDay, week, month}`，不能只做近 7 天。

### 实测到的 5 个接口

四个用公共入参 `{asin, timePieceType, timePieceValue}`，`trends` 例外。

| 接口 | 入参 | 返回 |
|---|---|---|
| `overview` | 公共 | `{recCnt, campaignCnt, keywordCnt}` |
| `trends` | **`{asin, timeDim:"week"}`** ← 独立签名 | `{dates[144], recTrends{专栏: [...]}}` |
| `recView` | 公共 | `{dates[7], list[], campaignTypeEnable}` |
| `campaignView` | 公共 | `{total, list[], recTitles[], dates[]}` |
| `keywordView` | 公共 + 分页排序筛选 | `{total, list[], recTitles[], dates[]}` |

实测两个 ASIN 的返回（B07N7GDB6Q 与你的截图逐项吻合）：

```
             B01NBNDC1T          B07N7GDB6Q
overview     6 / 6 / 610         5 / 3 / 35
recView      6 个专栏            5 个专栏，ratio 70% / 12% / 11% / 7.2% / 0.32%
```

`keywordView` 额外带分页排序参数，是唯一真正分页的接口：

```json
{"asin":"...","timePieceType":"latelyDay","timePieceValue":"7",
 "recTitle":"","campaignType":"","pageNum":1,"pageSize":100,
 "desc":true,"sortBy":"ratio"}
```

### 三张表的字段（原站表头原文，含 tooltip 释义）

**专栏表**

| 列 | 原站 tooltip |
|---|---|
| 推荐专栏名称 | — |
| 流量占比 | 该产品获得所有推荐专栏流量中不同推荐专栏的流量占比 |
| 广告活动数量 | 该产品在推荐专栏上获得曝光的广告活动合并去重后的数量 |
| 广告词数量 | 该产品在推荐专栏上获得曝光的广告词合并去重后的数量 |
| 广告活动类型占比(手动-自动) | — |
| 获得该推荐专栏的 广告活动数量及趋势 | 行内迷你趋势 |
| 获得该推荐专栏的 广告词数量及趋势 | 行内迷你趋势 |

**广告活动视角**：广告活动 / 贡献流量占比 / 类型数量 / (广告词数量·出现天数·流量占比) / 获得趋势 / 操作

**广告词视角**：广告搜索词 / 贡献流量占比 / 专栏数量 / (广告活动数量·出现天数·流量占比) / 获得趋势 / **周搜索趋势**

> 广告词视角的 tooltip 明确了一个纵向口径：
> 「该广告词在不同推荐专栏上获得的流量占比，**所有推荐专栏流量占比纵向相加为 100%**」。
> 这与我们在查流量结构踩过的「行内构成比 vs 列内占比」是同一类陷阱，实现时必须照此校验。

### 响应里的时间对齐约定

`recView.list[].campaignCntTrends` 与 `keywordCntTrends` 长度等于 `dates`，
序列里会出现 `null`，含义是**那天该专栏没有曝光**，不是 T+1 延迟。
（我最初只看了一个 ASIN，末位恰好是 null，误判成延迟；换 B07N7GDB6Q 复核发现
`campaignCntTrends: [3,3,3,3,3,3,3]` 末位有值，而 null 出现在中间。）
实测：

```
B07N7GDB6Q, dates [09-14 … 09-20]

Customers frequently viewed   campaignCntTrends [3,3,3,3,3,3,3]        全 7 天都有
Picks from Amazon Influencers campaignCntTrends [1,2,2,null,1,1,null]  17 日、20 日无曝光
Seen on social media          campaignCntTrends [null,1,2,3,3,3,3]     14 日无曝光
```

前端画迷你趋势要**断线不补零**（null 是「没曝光」，补 0 会画成一条贴底的线，
看起来像「有数据但为 0」）；`lastXxxCnt` 是最近有效值，
用它显示行尾那个当前数，不要取数组末位（末位可能是 null）。

---

## 二、我们的数据够不够（决定计划形态的关键）

**这是本计划最重要的一节。** 前后端照抄不难，难在数据。

| 库表 | 行数 | 结论 |
|---|---|---|
| `dim_recommend_column` | 143 | ✅ 够用，专栏字典 |
| `rel_rec_column_campaign_keyword` | 9,091 | ⚠️ **只有关系，没有度量** |
| `fact_asin_rec_column_period` | 64 | ❌ **8 个 ASIN 全是 `B0SEED*` seed 数据** |

`rel_rec_column_campaign_keyword` 的列：

```
asin, country, rec_title, keyword, encrypt_campaign_id,
keyword_id, mask_campaign_id, created_at
```

缺 `ratio` / `stat_date` / `appear_days` / `keyword_cnt` / `campaign_cnt` —— 
也就是说**三层钻取的「谁连着谁」有了，但「占多少、哪天出现、出现几天」全没有**。

整体覆盖面看着够：2,027 个 ASIN / 115 个专栏 / 3,438 个活动 / 3,553 个词。

### 但逐 ASIN 对照原站，词覆盖只有约 1/5

用 B07N7GDB6Q 逐项比（这是必做的一步 —— 总量够不代表单个 ASIN 够）：

| | 专栏 | 活动 | 词 |
|---|---|---|---|
| 原站 | 5 | 3 | **35** |
| 我们库 | 4 | 3 | **7** |

专栏和活动基本对得上，**词只有 1/5**。我们库里该 ASIN 的明细：

```
Picks from Amazon Influencers      活动2 词3
Customers frequently viewed        活动1 词2      ← 原站这个专栏就有 32 词
Explore Decorative Home Accents    活动1 词1
Seen on social media               活动1 词1
（缺 4 stars and above）
```

这意味着即便补上度量，**「广告词数量」这列的值也会明显小于原站**。
不是算错，是采集侧抓的词本身少。计划里凡是涉及词数的列，都要接受这个偏差，
或者先补采集 —— 见第六节。

### 一个已被前人记录的硬约束

`scripts/etl_module3_reccolumn.py` 第 12-13 行：

> 只有 `ratio` 有 214 个 (asin,recTitle) 对。硬造 `stat_date=fetched_at` 会让
> 「某天的专栏流量占比」变成假的时间序列。该表已有 64 行既有数据，保持不动。

**即 `ratio` 的日期维度在源里不存在，之前是有意跳过的。** 我复核确认了这个判断：
`fact_asin_rec_column_period` 只有 2 个 distinct 日期（2026-08-05 / 08-17），
且全部属于 seed ASIN。

### 但按天维度并非完全没有

现有 ETL 的源是 `sif_asin_keyword.raw->'allRankHistory'->'recRanks'`，
而它**本身就是逐日数组**，与同级 `date[]` 按下标对齐：

```
allRankHistory: {
  date:     ["2026-07-29", "2026-07-30", ...],
  recRanks: [null, {"Customers frequently viewed": {campaignId, maskCampaignId}}, ...]
}
```

所以「某专栏在某天是否出现、由哪个活动带来」**可以从源里算出来**，
当前 ETL 只是把日期轴丢掉了。这能支撑：

- `appearDays` / `totalDays`（出现天数 —— 数非 null 元素即可）
- `campaignCnt` / `keywordCnt` 的按天序列（迷你趋势）
- 计数卡三个数

**不能**支撑的是 `ratio`（流量占比）—— 源里没有按天的占比。

---

## 三、据此划定范围

把原站功能按「数据支不支持」分三类，避免做出一个数字是假的页面：

| 能力 | 可行性 | 依据 |
|---|---|---|
| 计数卡（专栏/活动/词数） | ✅ 直接可做 | `rel_` 表 COUNT DISTINCT（词数会偏小） |
| 专栏表的活动数/词数 | ✅ | 同上 |
| 出现天数 appearDays/totalDays | ✅ 需扩 ETL | `recRanks` 逐日数组 |
| 活动数/词数的按天迷你趋势 | ✅ 需扩 ETL | 同上 |
| 三层钻取（专栏↔活动↔词） | ✅ | `rel_` 表已是三元组 |
| 广告词视角的周搜索趋势 | ✅ | 复用 `fact_keyword_metric_snapshot` |
| 两个筛选器（专栏 / 广告类型） | ✅ 专栏可做 / ⚠️ 广告类型不行 | 广告类型依赖插件同步，同下 |
| 4 档时间范围（7天/30天/周/月） | ✅ | 后端接口必须接受三种 `timePieceType` |
| **流量占比 ratio** | ⚠️ **仅 214 对有值，无按天** | 源缺失 |
| 长周期趋势折线（144 点 + 缩放条） | ⚠️ 依赖 ratio | 同上 |
| 广告活动类型占比(手动-自动) | ⚠️ 原站也算不出 | 见下，是**插件门控**不是数据缺失 |

> **这条我第一版判断错了，已纠正。**
>
> 我原先写「`manualRatio`/`autoRatio` 恒 `0.0`，连原站自己都没数据，照抄只会得到一列 0」。
> 实测该列的单元格文案是：
>
> ```
> 需自动同步后台广告活动才能计算   [一键自动同步]
> ```
>
> 即这是个**功能门控**：要用户装浏览器插件把亚马逊后台的广告活动同步上来，
> 才能判定每个活动是手动还是自动投放。`manualRatio=0.0` 是「未同步」的表现，
> 不是源里没有这个字段。
>
> 对我们的影响：这列**不该删**，应做成「功能未开通」的占位提示
> （我们没有插件，写明「需同步后台广告活动，暂不支持」）。
> 删掉会让对照原站的人以为我们漏实现了；而填 0 则是错的。

### ratio 缺失怎么处理

三个选项，我建议 B：

- **A. 不做占比列** —— 最诚实，但页面失去主排序依据，专栏表只能按词数排
- **B. 做占比列，但口径换成「词数占比」并明示** —— 用 `该专栏词数 ÷ 全部专栏词数之和`
  替代真实流量占比，列名写「广告词数量占比」而不是「流量占比」，
  不冒用原站的语义。可排序、可对比，且每个数都是真的。
- **C. 照抄「流量占比」列名，值用现有 214 对** —— **不可接受**：
  2,027 个 ASIN 里只有约 10% 有值，其余显示空白或 0，
  用户无法分辨「真的是 0」还是「我们没数据」。这正是审计里反复出现的缺陷模式。

选 B 的同时，把真实 ratio 作为**可选增强**列出（见第六节），等采集侧补数据再切换。

---

## 四、实施步骤

按依赖排序，每步都可独立验证。

### 步骤 1：扩 ETL，补出度量（前置，无此步后面都是空表）

**改** `scripts/etl_module3_reccolumn.py`，**新建** 一张按天事实表。

```sql
-- db/schema-08-rec-column.sql
CREATE TABLE looom.fact_rec_column_daily (
  asin                VARCHAR(16)  NOT NULL COMMENT 'ASIN',
  country             VARCHAR(8)   NOT NULL COMMENT '站点',
  rec_title           VARCHAR(255) NOT NULL COMMENT '推荐专栏英文原文',
  stat_date           DATE         NOT NULL COMMENT '日期（来自 allRankHistory.date，非推断）',
  campaign_cnt        INT          NULL COMMENT '该日该专栏的去重活动数',
  keyword_cnt         INT          NULL COMMENT '该日该专栏的去重词数',
  created_at          DATETIME     NOT NULL
) ENGINE=OLAP
UNIQUE KEY(asin, country, rec_title, stat_date)
COMMENT '推荐专栏按天计数。⚠️ 不含 ratio：源 recRanks 只有「哪天出现/由哪个活动带来」，没有按天占比，硬造会得到假时间序列（见 etl_module3_reccolumn.py 的说明）'
DISTRIBUTED BY HASH(asin) BUCKETS 4
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");
```

ETL 要点：

- 遍历 `allRankHistory.recRanks[i]`，`date[i]` 就是日期，**不要用 `fetched_at` 推断**
- `recRanks[i]` 为 `null` 表示当天该 ASIN 没有专栏曝光，跳过（不要写 0 行）
- 同一天同一专栏可能有多个活动，去重后计数
- 验收：`stat_date` 的 distinct 数应远大于 2（当前 seed 只有 2 个）

同时给 `rel_rec_column_campaign_keyword` **加两列**（Doris `ADD COLUMN` 是异步
SCHEMA_CHANGE，必须等 FINISHED 再做下一个 ALTER，这个坑 schema-07 踩过）：

```sql
ALTER TABLE looom.rel_rec_column_campaign_keyword
  ADD COLUMN appear_days INT NULL COMMENT '该(专栏,词,活动)组合在窗口内出现的天数';
-- 等 SHOW ALTER TABLE COLUMN 显示 FINISHED
ALTER TABLE looom.rel_rec_column_campaign_keyword
  ADD COLUMN total_days INT NULL COMMENT '窗口总天数，与 appear_days 配对显示 "6/7"';
```

### 步骤 2：后端 —— 新建 `RecColumnService`

`apps/api/src/business/rec-column.service.ts`，5 个方法对应原站 5 个接口。

```
GET /business/rec-column/overview     → {recCnt, campaignCnt, keywordCnt}
GET /business/rec-column/rec-view     → 专栏表 + 按天迷你趋势
GET /business/rec-column/campaign-view→ 活动视角（含 recDetail 二级）
GET /business/rec-column/keyword-view → 词视角（分页 + 排序 + 周搜索趋势）
GET /business/rec-column/trends       → 长周期趋势（见第六节，先只出计数）
```

必须遵守的既有约定（都是本仓库踩过的）：

1. **时间窗口按 ASIN 取，不能取全站最新** —— `traffic/keywords/sales/insights`
   四处都犯过这个错，症状是「上期有数据显示成无数据」
2. 分页用 `buildPage`/`encodeCursor` 游标，不要 COUNT；`keyword-view` 的
   `total=610` 可以给，但翻页靠游标
3. 排序字段走 `SORT_COLUMNS` 白名单映射，不要把参数拼进 SQL
4. 数值口径分开命名：`ratio`（行内构成比）与 `share`（列内占比）不要复用同一个 key
5. 空值给 `null` 而不是 `0`，让前端能区分「真的是 0」和「没数据」

### 步骤 3：前端 —— 新建页面与路由

- 路由 `apps/web/src/router/index.ts` 增 `{ path: 'rec-columns', name: 'rec-columns' }`
- 页面 `apps/web/src/views/RecColumnView.vue`
- 类型与 api `apps/web/src/api/business.ts` 增 `recColumnApi` + 接口类型
- **补上查流量结构里那个按钮**：`TrafficView.vue` 的推荐专栏栏目前没有按钮，
  因为当时路由不存在（我确认过 `rec-columns` 不在路由表里，放了就是 404）；
  本页做完后把按钮加回去

页面结构：

```
计数卡 ×3
长周期趋势折线（指标切换：广告词数量 / 广告活动数量 / [占比]）
专栏表
视角 tab（广告活动视角 / 广告词视角）+ 二级展开
```

复用已有组件：`AsinSearchBar`、`QuerySkeleton`、`BaseChart`、`Sparkline`
（行内迷你趋势正是 `Sparkline` 的用途，查销量已经在用）。

### 步骤 4：验证

- 计数卡与 `SELECT COUNT(DISTINCT ...)` 对数
- 广告词视角纵向占比相加是否 100%（原站 tooltip 明示的口径）
- 迷你趋势末位 null 断线不补零
- 边界：取一个 `rel_` 表里没有的 ASIN，页面应显示空态不报错
- 边界：`ratio` 为 null 的行显示「—」而非 0
- 前后端 typecheck + build；控制台 0 错误

---

## 五、工作量与顺序

| 步骤 | 内容 | 前置 |
|---|---|---|
| 1 | 建 `fact_rec_column_daily` + 扩 ETL + 灌数 | 无 |
| 2 | 后端 5 接口 | 步骤 1 |
| 3 | 前端页面 + 路由 + 补按钮 | 步骤 2 |
| 4 | 联调验证 | 步骤 3 |

步骤 1 必须先做：没有它后面接口全返回空，页面做完也看不出对错。

---

## 六、明确不做 / 待定

**不做，但保留占位提示（不是删列）**

- 广告活动类型占比(手动-自动)：原站也算不出，需用户装插件同步后台广告活动。
  我们照原站那样在该列显示说明文案，不填数、不删列。
- 筛选广告类型（全部/自动/手动）：同上依赖插件数据，做成禁用态并注明原因。
- 「一键自动同步」「手动备注名称」「管理已备注的广告活动」：插件与备注体系，
  本期不做。

**待你定（4 项）**

1. **占比口径** —— 最关键。按第三节选项 B（改成「广告词数量占比」并明示）
   还是 A（不做占比列）？我建议 B。
2. **词覆盖只有原站 1/5** 怎么办（第二节实测 7 vs 35）。
   照现状做，页面数字会明显小于原站；还是先补采集再开工？
3. **长周期趋势图**：原站是堆叠面积图 + 图例分页 + dataZoom 缩放条，
   数据依赖 ratio。可以先用「按天词数/活动数」出图（数据真实），
   等 ratio 补齐再加指标切换。是否接受先出计数版？
4. **是否一并安排采集侧**：要与原站一致需采集 `rec/recView` + `rec/trends`
   的原始响应入 PG。这是采集侧工作，不在本计划范围 —— 要不要一起排？

---

## 七、第一版探查的疏漏（自查记录）

第一版我只用一张全页截图 + 一次 DOM 读取就下了结论，漏了 6 处、错了 1 处。
记下原因，避免下次重犯：

| 疏漏 | 为什么漏 |
|---|---|
| 时间范围 4 档（含选择某周/某月） | 只看了默认的 `latelyDay=7`，没点开选择器 |
| 两个筛选下拉（专栏 / 广告类型） | 在页面下半部，全页缩略图里看不清 |
| 趋势列的指标单选（词数 ↔ 占比） | 同上 |
| 图表的图例分页 `1/3` + dataZoom 缩放条 | 图表是 canvas，DOM 里读不到 |
| 顶部科普横幅 + 三个下载按钮 | 没通读页面文案 |
| 图表在计数卡之前（我写反了顺序） | 凭印象写版面，没核对 |
| **错判**「广告活动类型占比」为无数据 | 只看接口值恒 `0.0` 就下结论，没读单元格文案 |

最后一条是实质性错误：值为 0 有两种可能 ——「源里没有」和「功能未开通」，
我选了前者却没去验证。单元格里写着「需自动同步后台广告活动才能计算」，
读一眼就能避免。**接口返回的零值不能直接等同于数据缺失。**

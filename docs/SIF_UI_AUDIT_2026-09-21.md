# sif 真实页面核对报告（2026-09-21）

> **方法**：Playwright 接入已登录的 sif 会话，逐页访问 + 实际查询 + 抓 XHR 响应 + 读 DOM 表头；
> 第五轮起由 4 个并行子代理直接调 API / 逆向前端 bundle（产出见 `docs/audit/`）；
> 第六轮改用 **Doris 实测数据反向核对本文档自身**（见 §11），纠正了 5 处数字错误。
> **最终状态：20/20 个页面核对完毕，五轮共推翻 ROADMAP 的 28 处设计判断**（§0 汇总表）。
> 凡本文档与 ROADMAP / M13_PROBE_FINDINGS 冲突，**以本文档为准**；
> 本文档内部若有冲突，**以轮次更晚的为准**（§11 > §8e > §8d > §8c > §8b > §1~§7）。

---

## 0. 28 处被推翻的判断（按轮次分组，按严重度排序）

| # | 我原来的理解 | 真实情况 | 影响 |
|---|---|---|---|
| **1** | 竞价 = 关键词 × 6 种投放类型 | **关键词 × 类目 × 匹配方式 × auto/legacy**（4 层嵌套，每词每类目 18 个值） | ⛔ **已建的 `fact_keyword_bid_estimate` 表丢了类目维，必须重建** |
| **2** | 坑位快照 = 静态数据表 + seed | **用户创建的监控任务**：每小时抓取、前 3 页、持续 15 天、**扣 42 积分** | ⛔ M14 从「查询页」变成「任务型功能」，要建任务表 + 接积分 |
| **3** | 流量位竞争格局 = 关键词级度量 | **ASIN 列表 × 流量位份额**（谁在占哪类流量位）。页面 **6 列**，响应 **8 个** `*ScoreRatio`（多出的 er/tr 存疑，见 §11.2） | ⚠️ M13 该页的数据模型和 UI 全要改 |
| **4** | 拓词 7 页 = 7 个独立查询页 | **一条词库构建流水线**：多竞品拓词→词根拓词→品类拓词，终点是词库 | ⚠️ M12 要按流水线设计，不是 7 个平行页 |
| **5** | 词库 = 简单的关注列表 | **两级结构 + 有效/否定词库配对 + 17 列度量 + 阶段性推广词库** | ⚠️ M15 工作量远超估算的 5.5 人日 |
| **6** | ACOS 的 start/median/end 是「悲观/中位/乐观」 | 竞价的 start/median/end 是**递增**的（0.37/0.49/0.61），与 ACOS 的递减**方向相反**，是两种不同指标 | ⚠️ 已写进 DDL 注释的语义要改 |

### 第二轮核对又发现 5 处（§8b）

| # | 我原来的理解 | 真实情况 | 影响 |
|---|---|---|---|
| **7** | 产品时光机 = 按 ASIN 查日粒度价格/BSR 曲线 | **按关键词查历史畅销产品榜**（12 列商品属性表，可回溯 720 天） | ⛔ M11 设计全错，但**省掉一张 157 万行新表** |
| **8** | 每日排名 = 🟢 源已结构化可直接 ETL | **订阅制**（`subscribe/v2`），没订阅就没数据 | ⛔ M14 需要订阅关系表，不是纯 ETL |
| **9** | 小时排名 = 独立的排名查询页 | 自称「**定时查坑位**」，与坑位快照同族，共用监控基础设施 | ⚠️ M14 三页合并为一套设施 + 三种呈现 |
| **10** | M10 三页 / M12 七页 = 独立页面 | **都是同一页的多个 Tab** | ⚠️ 页面数减少，单页复杂度上升 |
| **11** | 产品库放最后做 | **是 M10/M12 的输入源**（拓词竞品库/对标竞品库/ASIN定投库） | ⛔ M15 要拆两半，库管理提前 |

### 第三轮（逐页实际输入查数据）又发现 4 处（§8c）

| # | 我原来的理解 | 真实情况 | 影响 |
|---|---|---|---|
| **12** | 相关性评分无源，要自己设计启发式算法 | **= 自然位前 4/8/16/32/48 占位率 + 用户设阈值**，纯数据计算不是 NLP | ✅ **M12 最大风险解除**，且数据我们已有 |
| **13** | 对比流量词 = 固定列表格 | **动态列**（每 ASIN 一列）+ 首个 ASIN 为基准显示「比我少 N%」+ 4 接口并发聚合 | ⚠️ M10 前端复杂度翻倍 |
| **14** | ACOS 直接查库返回 | **前端按用户填的「自定义毛利率」实时算** | ⚠️ service 不该直接返回 acos 列 |
| **15** | `max/min_kw_price` 用途不明（待确认项） | 就是「产品均价」列的 min/avg/max 三档 | ✅ 解答待确认项 |

### 第四轮（并行 API 直查 + 词库/对比补完）又发现 6 处（§8d）

| # | 我原来的理解 | 真实情况 | 影响 |
|---|---|---|---|
| **16** | 拓词模式 = 精准/词组/广泛 | 还有「**下拉框 DropDownBox**」= 亚马逊搜索下拉联想词（`matchTypes` 数组，含 AllMatch） | ⚠️ M12 词的「收录面」要多一维，建表加 match_types 列 |
| **17** | 词根拓词和品类拓词同构 | **品类拓词字段更少**：无 relevance/matchTypes/cpc/clickPurchaseRatio，品类页操作列只有「标记相关性」 | ⚠️ 两接口不能共用一张宽表，共用会留大量空列 |
| **18** | 搜索趋势只有近 37 周 | 还有 `estSearchesNumHistoryPrev` = **去年同期 53 周**（同比对照） | ✅ M12 图表可直接做同比，无需额外查 |
| **19** | 对比销量 = 静态数字对比 | 每行带 **31 个月逐月销量序列** `boughtHistory`（桶状估值 500/1000/2000…）+ 组内最优标记 | ✅ M10 销量趋势迷你图数据齐全 |
| **20** | 对比流量结构没实查过 | `flowResources{rec/bs/natural/sp/sb}` = **命名流量位清单**（"4 stars and above"、"Today's deals"…）+ 10 类流量位计数 + 每计数一个组内最优标记 | ⚠️ M10 该 Tab 要建「流量位来源」明细，不是简单计数 |
| **21** | 词库转化率口径自己定 | 官方注明「**关键词转化率数据是关键词下所有产品的平均点击转化率，来源于后台商机探测器**」 | ✅ 数据口径有官方出处，照抄进我们文档 |

### 第五轮（4 个并行子代理 API 直查）又发现 7 处

判 **22~28** 的完整表格在 **§8e**，此处不重复。摘要：
AI 工具是 WebSocket 管道子应用（判 22）｜小时排名参数与定价反推完成（判 23）｜
每日排名是配额制不扣积分（判 24）｜实时竞价是旗舰专享任务制（判 25）｜
sif 有公开 MCP 网关可替代爬虫（判 26）｜「更多」菜单归属记录错了（判 27）｜
27 个模块官方口径全集已采集（判 28）。

### 第六轮（Doris 实测反查本文档）纠正 5 处数字 —— 见 §11

不推翻设计判断，但本文档与 schema-06 里 **5 处行数/填充率/值域写错**，
会让实现者按错误的数据量做可行性判断。全部已修，明细见 §11。

---

## 1. 导航结构实测（顶部 12 项）

```
查销量 → /Sales                      ✅ 已实现
查流量(词) → /reverse                ✅ 已实现（注意是 /reverse 不是 /keywords）
运营时光机 → /timemachine-traffic     ✅ 已实现
查广告打法 → /adxray-structure        ✅ 已实现
多产品对比 → /compare-traffic         ❌ M10
产品时光机 → /timemachine-product     ❌ M11
拓词&筛查 → /asin-relatedness         ❌ M12
选词 → /conversion-rate               ❌ M13
查坑位/推排名 → /snapshot             ❌ M14
产品库/词库 → /product                ❌ M15
AI工具 → /skill/keywords-library      ❌ 计划里没有！见 §8
更多 → /ad-multiNotes-submit          ❌ 计划里没有！见 §8
```

⚠️ **「选词」的侧栏分组与我的模块划分不一致**。实际侧栏把这些放在一组：
```
产品时光机        ← 我归到 M11
关键词转化率      ← M13
流量位竞品数量    ← M13
  「竞争视角选词」（分组标题）
  流量位竞争格局  ← M13
查关键词竞价      ← M13
坑位快照          ← 我归到 M14
```
即原站把「产品时光机」和「坑位快照」也算作选词工具。
**建议**：模块划分（后端/ETL）保持按数据源切分，但**前端导航按原站的分组**，
两者不必一致 —— 用户认的是导航，不是我们的模块号。

---

## 2. `/compete` 流量位竞争格局 —— 数据模型完全不同

**接口**：`POST /api/search/competePattern`（我文档里记「CLI 实测返回空」，实际有数据，117KB 响应）

**实测表头 13 列**：
```
# | 图片 | ASIN 信息 | 价格 | 评论 | 月销量趋势
| 自然流量 | SP(常规)流量 | SP(推荐)流量 | SB(常规)流量 | SBV流量 | AC推荐流量 | 操作
```
返回 100 行 ASIN（`total: 457`）。

**响应结构**（`data.asins[]`，每个元素）：
```
asin, title, img, ratingNum, price, score, star
boughtInPastMonth: "6,000+"          ← 分档串
boughtHistoryDates[40], boughtHistory[40]   ← 月销量趋势（并行数组）
nfScoreRatio, spScoreRatio, vedioAdScoreRatio, brandAdScoreRatio,
acScoreRatio, erScoreRatio, trScoreRatio, spRecScoreRatio   ← 8 个流量位份额
isFocus, hasVaiants, acDates[], ac
```

⚠️ **注意拼写**：源字段是 `vedioAdScoreRatio`（video 拼错成 vedio）、`hasVaiants`（variants 拼错）。
ETL 里必须照抄这个拼写，不要「修正」它。

**与我设计的差异**：
- 我以为这页是「关键词的竞品数量统计」→ 实际是「该词下的 ASIN 及其流量位构成」
- 落表应该是 `rel_keyword_asin_traffic_share`（关键词 × ASIN × 8 个份额），
  而不是往 `fact_keyword_metric_snapshot` 加列
- 「默认以自然流量份额排序」（页面说明）

**操作列有 5 个跳转**：查订单量 / 查流量结构 / 反查流量词 / 查广告架构 / 查运营节奏
—— 这是跨页联动，说明各页之间以 ASIN 为纽带互相跳转。我们的实现也该有这个。

---

## 3. `/amount` 流量位竞品数量 —— 这才是我以为的那页

**接口**：`POST /api/search/competeAsinAssay`

**实测表头 13 列**：
```
# | 关键词 | 搜索趋势(周/月切换) | 在售产品数 | 自然流量产品数 | 广告流量产品数
| SP(常规)产品数 | SP(推荐)产品数 | SB(常规)产品数 | SBV产品数 | ABA Top3 集中度 | 操作
```

**实测一行数据**（`stocking stuffers`）：
```
搜索趋势: 17,656 (同比-78%)  排名 14,678
在售产品数: 279,877          ← 注意量级！
自然流量产品数: 208
广告流量产品数: 183
SP(常规): 91   SP(推荐): 56   SB(常规): 85   SBV: 11
ABA Top3 集中度: 点击 8.6% / 转化 3.9%
操作: 查看竞争格局           ← 跳 /compete
```

**响应字段**（`data.keywords[]`）：
```
keyword, translateKeyword, estSearchesNum, searchesRank, saleNum, updateTime
estSearchesNumHistory / estSearchesNumHistoryPrev  ← 并行数组 + festivals
nfAsinNum: 267        spAsinNum: 80      brandAsinNum: 112
videoAsinNum: 17      acAsinNum: 0       ppcAsinNum: 206
recommendedAsinNum: 41                   spRecommendedAsinNum: 94
erAsinNum: null       trAsinNum: null
conversionShared: 0.1045   clickShared: 0.1351   isFocus: false
```

### 对已建表的三处修正

1. **漏了 `videoAsinNum`**（SBV 产品数，实测 17）—— 我的 schema-06 没建这列，**要补**
2. **`saleNum` 语义搞错了**：我的 DDL 写「关键词带来的总销量」，页面显示成
   **「在售产品数」279,877**。这是该词下的在售商品数量，不是销量。**COMMENT 要改**
3. **`clickShared`/`conversionShared` 是「ABA Top3 集中度」**，不是我理解的份额。
   页面把两者合并成一列显示「点击:8.6% 转化:3.9%」

### 交互模式：批量词 → keywordsId

输入框是 **textarea（多行，支持批量词）**，不是单行 input。
提交后 URL 变成 `?keywordsId=546c4dc0ab30d55c1e1139b0cf74b001` —— 
**先把词列表换成一个 hash ID，再用 ID 查**。
响应里也回传 `keywordsid`。

⚠️ 我的 `WordPickQueryDto` 设计的是单个 `keyword` 参数，**要加批量模式**。
这个 keywordsId 机制在 `/asin-relatedness` 等页也在用（见 §5），是全站通用的。

---

## 4. `/cpc-browsetree` 查关键词竞价 —— 已建表必须重建

**接口**：`POST /api/search/cpc/category`

**页面自带的四条说明**（直接回答了我的疑问）：
```
1. 建议竞价与产品无关，与品类强相关的，且与产品的权重没有关系
2. 建议竞价的大小取决于该品类的产品数量以及对每个产品的预期广告成本
3. SP的竞价策略，仅降低和固定模式的建议竞价差别非常小，
   所以我们将仅降低和固定合并为"仅降低/固定"
4. 以周ABA为数据源，每月更新一次竞价数据
```
第 1 条直接否定了我的表设计 —— **类目是这个指标的核心维度，不能没有**。

**真实嵌套结构**（四层）：
```
data.keywords[]  (16 个词)
  keyword, translateKeyword, inAba, clickShared, conversionShared,
  estSearchesNum, searchesRank, estSearchesNumHistory(Prev), imgs[]
  categorys[]  ← 每词 4~14 个类目，均值 10.3
    categoryId, categoryName, categoryHref, saleNum
    matchTypes
      phrase / exact / broad          ← 3 种匹配方式
        auto / legacy                 ← 2 种策略
          { start, median, end }      ← 3 档
```
**每词每类目 18 个竞价值**（3 × 2 × 3）。

### 与已建表的冲突

我建的 `fact_keyword_bid_estimate` 主键是 `(keyword, country, stat_week, match_type)`，
match_type 用的是 `autoForSales_broad` 这种拼接名 —— 那是
`web-keyword-conversion` 的 ACOS/CPA 字段结构，**和竞价不是一回事**：

| | web-keyword-conversion | cpc/category |
|---|---|---|
| 指标 | ACOS / CPA | 建议竞价（$） |
| 维度 | 关键词 × 6 种拼接类型 | 关键词 × **类目** × 匹配 × 策略 |
| start/median/end 方向 | **递减**（39.87 → 9.19 → 4.17） | **递增**（0.37 → 0.49 → 0.61） |
| 更新频率 | 每周（ABA 周） | **每月**（页面说明第 4 条） |

**结论**：这是**两张表**，不是一张。
- `fact_keyword_acos_estimate`（已灌 33,019 行，保留，只改名和 COMMENT）
- `fact_keyword_bid_estimate` **重建**，主键改
  `(keyword, country, category_id, match_type, bid_strategy, stat_month)`

⚠️ 竞价的源 endpoint `search/cpc/category` **不在爬虫的 41 个 endpoint 里**，
所以这张新表**本期确实没有真实数据源**，要走 seed —— 回到了计划最初的判断，
但表结构必须按真实响应建。

---

## 5. `/snapshot` 坑位快照 —— 不是查询页，是监控任务

**页面说明**：
```
1. 坑位快照默认每小时抓取，每次抓取前 3 页，每次持续时间 15 天，消耗 42 个积分。
2. Sif 的广告抓取率稳定在 95% 左右。少量坑位为空是由于多次重试后依然没有获取到广告位。
```

这彻底改变了 M14 的设计：

| 我的计划 | 真实情况 |
|---|---|
| 建 `fact_keyword_slot_snapshot` 表塞 seed | 需要**任务表**（谁、什么词、何时开始、剩几天） |
| 纯查询接口 | 需要**创建/停止任务**的写接口 |
| 不扣积分 | **扣 42 积分**，要接 `CreditsService` |
| — | 需要「前 3 页 × 每小时」的时序数据模型 |

⚠️ 这是本计划里**第一个要扣积分的业务功能**。
现状是全仓只有 `ai_analysis` 扣分（`credits.controller.ts:34-52` 明确记录），
加这个功能要往 `system_configs` 插 `credit.cost.slot_snapshot = 42` 并更新 `/pricing`。

---

## 6. `/asin-relatedness` 拓词筛查 —— 是流水线不是独立页

**页面说明**：
```
1. 强烈建议按照 多竞品拓词 → 词根拓词 → 品类拓词 的顺序搭建词库
   (先自动，再批量，后手动)
2. 多竞品拓词建议搭配插件且至少输入 48 个 ASIN，收集竞品更高效，相关性判断更准确
3. 多次维护同一词库时，建议使用"同一词库预筛查"，减少重复工作量
```
宣传语：「1 分钟自动且精准判定 5000 个关键词的相关性」「三步拓词、筛词」

**修正**：
- 7 个页面是**一条有顺序的流水线**，终点是词库（M15），不是 7 个平行查询页
- 「相关性」是原站的核心能力（1 分钟判 5000 词），我们无源 ——
  ROADMAP §M12 里「自己算启发式分」的决定**依然成立且更有必要**，
  但要在 UI 上明确标注算法来源，别让用户以为是 sif 那套
- 输入是 **ASIN 批量**（建议 ≥48 个），不是单 ASIN
- M12 和 M15 强耦合：**M12 的产出直接进 M15 的词库**，
  当前排期把 M12 放第 5 期、M15 放第 6 期，顺序是对的

---

## 7. `/words` 关键词库 —— 远比计划复杂

**实测表头 17 列**：
```
# | 关键词 | 搜索趋势(周/月) | 相关性 | 最近7天自然流量Top10产品 | 周点击量 | 周购买量
| 市场平均点击转化率 | 建议竞价 | PPC广告竞品数 | TOP3集中度 | 搜索需求分类
| 自定义标签 | 关键词已加入的所有词库 | 添加时间 | 操作
```

**页面说明揭示的结构**：
```
1. 每个产品词库都有一对【有效词库】和【否定词库】（两者一一对应）
2. 词库有【两级结构】：
   第一级 = 产品词库（加入词库默认进这里）
   第二级 = 阶段性推广词库，分【新品期/成长期/成熟期/衰退期】
3. 相关性的标准默认继承自添加词库时的标记，也可以在词库中手动修改
```

**工具栏**：需求洞察 / 管理词库 / 下载词库 / 词频统计 / 批量操作 / 选择词库 / 高级筛选
**行内操作**：移出该词库 / 复制到其他词库 / 移动到其他词库 / 添加标签 / 重新标记（相关性）

**修正**：
- 我的计划把 M15 当成「简单的关注列表 + 一个 `user_favorites` 表」，
  实际需要：词库表（两级 + 有效/否定配对）、词库成员表、自定义标签表、相关性标记
- 「建议竞价」这列**一个词显示 3 个类目的竞价**（`Internal Solid State Drives $1.04` 等）
  → 印证了 §4 的类目维度
- 工作量估算 **5.5 人日严重偏低**，实际更接近 12~15 人日

---

## 8. 计划完全漏掉的两个菜单

### 「AI工具」→ `/skill/keywords-library`

顶部导航第 11 项，我的 ROADMAP **完全没提**。
路径 `/skill/*` 说明底下还有多个 skill 子页。
⚠️ 我的计划里写「AI 工具菜单 = 我们散在各页的 6 个 AI 插入点」——
实际原站有**独立的 AI 工具入口**。需要单独调研这个菜单下有几个功能。

### 「更多」→ `/ad-multiNotes-submit`

第 12 项，同样没提。`ROUTES_TITLES.md` 里有两条相关路由：
`/ad-multiNotes-submit`（批量备注广告活动）、`/ad-multiNotes-view`（查看已备注的广告活动）。
数据库里**已有 `sys_user_ad_note` 表**（空壳，完整 CRUD 设计）——
说明早期调研发现过这个功能但 ROADMAP 漏了。

---

## 8b. 第二轮核对（补完 §9 的待办）

第一轮看了 6 页，第二轮补看 10 页。又发现 **5 处重要修正**。

### 8b.1 ⛔ M11 产品时光机 —— 整个设计推翻

`/timemachine-product` 的页面说明写的是「**流量时光机**」，输入框是「**输入关键词搜索**」
（不是 ASIN），配时间段选择（最近7天 / 选择周 / 选择月）。

**实测表头 12 列**（查 `travel gifts` 返回 100 行）：
```
# | 图片 | ASIN 信息 | 属性 | 品牌 | 上架时间 | 评论数 | 评分 | 价格
| 子体近30天销量 | 月销量趋势 | 操作
```
一行样例：
```
B0CNJS15T4 | Color: Blue Size: 40"x65" | BEDELITE
上架时间: 2023-11-16 (2年零10个月)
评论 1,209 | 评分 4.6 | $16.99 | 6,000+
操作: 反查流量词 查运营节奏 查流量结构 查广告架构 查推荐专栏
```
URL 形态：`?keyword=travel%20gifts&type=2&asin=travel%20gifts`

**真实语义**：**「某关键词在某历史时间段的畅销产品榜」**，
用途是「以自然流量大小排序，可用于**查找历史畅销产品**」，可回溯 **720 天**。

**我的设计全错了**：ROADMAP §M11 设计的是「按 ASIN 查该产品的日粒度价格/BSR/评分曲线」，
并为此规划了新表 `fact_asin_listing_daily`（日粒度 157 万行）。
实际这页**根本不是按 ASIN 查，也不是画曲线**，而是关键词驱动的商品榜单。

**修正后的设计**：
- **不需要** `fact_asin_listing_daily` 这张新表
- 数据源变成「关键词 × 时间段 → ASIN 列表 + 商品属性快照」，
  与 `/compete` 的形态接近（都是关键词→ASIN 列表），可复用 `dim_asin` + `dim_asin_feature`
  + `fact_asin_bought_monthly`
- 工作量从 5 人日降到约 3 人日（无需新建大表和新 ETL）

⚠️ 「属性」列（`Color: Blue Size: 40"x65"`）来自 `dim_asin_feature`（已有 43,716 行真实数据）。

### 8b.2 ⛔ 每日排名也是订阅制

`/dailyrank` 的接口是 `POST /api/search/subscribe/v2`，配套
`GET /api/search/user/subsAsin`（订阅的 ASIN 列表）和 `modelIntroduce?model=subscribeSearch`。
即**每日排名和坑位快照、小时排名同属「订阅/监控」这一族**，不是即时查询。

**实测表头**（7 天横向日期列）：
```
# | 关键词 | 搜索趋势(周/月) | 排名趋势 | 排名类型
| 2026-09-20 (美西时间) | 2026-09-19 | ... | 2026-09-14
```
每个日期格里是 `排名 + 页码位置 + ASIN`，例如 `19 第2页, 3/16 B0D6RDPT9M`。
「排名类型」列是**两行并排**：`自然排名→` / `SP排名→`。

**响应结构**（`subscribe/v2`）：
```
data.asinNum / keywordNum / total / isExample
    minDay: "2025-05-08"   maxDay: "2026-09-20"     ← 可回溯一年多
    dates: [7 个日期]
    keywords[]:
      keyword, translateKeyword, estSearchesNum, searchesRank
      estSearchesNumHistory / Prev                   ← 同其他页的并行数组
      listingRankHistory: { date[7], rank[7], adRank[7] }   ← Listing 级
      rankInfo[7]:                                   ← 按 dates 下标对齐
        nf: { asin, rank, rankStr, updateTime, changeType, isSubscribe }
        sp: { asin, rank, rankStr, updateTime, changeType, isSubscribe }
    asins: [11 个 ASIN]
```
`changeType` 取值：`up` / `down` / `noChange` —— 这是「排名趋势」列的数据来源。
`rankStr` 格式 `p3,42/48`（与 `fact_keyword_rank_history` 已有的解析逻辑一致）。

**页面还有这些控件**：多变体排名切换、查看全部排名/仅订阅、
「编辑关键词」「下载排名」「更新父子体关系」「查看更早/更晚的 7 天」。

**修正**：ROADMAP 把每日排名判为 🟢「源已结构化，直接 ETL」，
实际它需要**订阅关系表**（用户订阅了哪些 ASIN × 关键词）才有意义 ——
没有订阅就没有数据（页面显示「暂无数据，请先添加产品及关键词」）。
这是应用层功能，不是纯 ETL。

### 8b.3 小时排名 = 「定时查坑位」，与坑位快照同族

`/hourlyrank` 的页面标题虽是「小时排名」，但说明文字自称「**定时查坑位**」：
```
1. 小时排名可以监控自然排名和 SP 广告排名
2. 可自定义抓取频率（最快每小时一次），还可以自定义每次抓取的页面数量
3. 使用 Sif 的爬虫资源进行抓取，不是调用您的浏览器
4. 监控之后的数据可以以产品视角查看，也可以以关键词视角查看（搜索框上方可切换）
```
UI 是**卡片**（「卡片数据默认展示最近两天，方便快速发现排名波动」），不是表格。
空态提示「暂无数据，请先 添加产品及关键词」。

**结论**：`/snapshot`（坑位快照）、`/hourlyrank`（小时排名）、`/dailyrank`（每日排名）
**三页共用一套订阅/监控基础设施**：任务配置（频率、页数、时长）+ 积分扣费 + 爬虫调度 + 双视角查看。
M14 应该先建这套基础设施，三个页面是它的三种呈现。

### 8b.4 三族页面其实都是 Tab 结构

实测发现**同一族的多个路由是同一页的多个 Tab**，不是独立页面：

| 族 | Tab 项 | 证据 |
|---|---|---|
| 多产品对比 | 对比销量 / 对比流量结构 / 对比流量词 | `/compare-sales` 页顶部就有这三个 Tab |
| 拓词&筛查 | 相似竞品拓词&自动筛查 / 以词拓词&筛查 / 品类拓词&筛查 / 手动批量导入&筛查 | `/niche-relatedness` 页顶部有这四个 Tab |
| 选词 | （侧栏分组，非 Tab） | 见 §1 |

**影响前端工作量估算**：M10 的 3 页 → 1 页 3 Tab；M12 的 7 页 → 约 2 页（4 Tab + 独立的筛查结果页）。
比 ROADMAP 估的页面数少，但单页复杂度高。

各页输入框类型实测：
- `/asin-relatedness` → 输入 ASIN（建议至少 48 个，搭配插件）
- `/root-relatedness` → 输入关键词 + 周/月选择
- `/niche-relatedness` → **输入类目搜索**（不是关键词）
- `/keyword-relatedness` → 手动批量导入

### 8b.5 ⛔ 产品库是其他功能的输入源，不能放最后做

`/product` 的页面说明：
```
1. 产品库可用于收藏您关注的产品，可建立
     拓词竞品库（在多竞品拓词中使用）
     对标竞品库（在多竞品对比中使用）
     ASIN 定投库（做商品投放时使用）
2. 产品库目前的数量限制是 500 个
```

**实测表头 17 列**：
```
# | 图片 | ASIN 信息 | 月订单量 | 流量来源 | 全部流量词 | 自然流量词 | 广告流量词
| SP广告词 | SP(常规)广告词 | SP(推荐)广告词 | SB广告词 | SB(常规)广告词
| SBV广告词 | AC推荐词 | 添加时间 | 操作
```
另有「下载产品库 / 管理产品库 / 批量操作 / 筛选产品库」四个操作入口，
支持**分组**（空态文案是「当前分组无数据」）。

**修正排期**：ROADMAP 把 M15 排在**最后一期**，理由是「要往所有列表页插关注按钮，
放最后避免反复改动」。但实测产品库是 **M10（对比）和 M12（拓词）的输入源** ——
用户先把竞品收进产品库，再在对比/拓词页选用这个库。

**建议改排期**：M15 的「库管理」部分（建库、分组、增删）提到 **M10 之前**，
「插关注按钮到各页」的部分仍可放最后。即 M15 拆成两半。

### 8b.6 「AI工具」与「更多」菜单实测

**AI工具** → `/skill/keywords-library`，标题「**关键词调研**」：
```
AI 驱动的关键词自动化调研，30秒出结果
输入框：输入一个或多个 ASIN
站点选择：🇺🇸 美国 ▾
```
这是个 **AI Agent 式功能**（输入 ASIN，自动跑完整调研链路出报告），
与我们已有的 6 个「AI 插入点」形态不同 —— 那些是「页面内解读」，
这个是「独立的自动化任务」。路由前缀 `/skill/` 暗示还有其他 skill。

**更多** 菜单下的完整项（实测抓 DOM 链接）：
```
/ad-multiNotes-submit   前台广告位溯源后台广告活动（批量备注）
/ad-multiNotes-view     管理已备注的广告活动
/cpc-realtime           实时查产品竞价
/datacenter             API 数据服务        ⚠️ 归属见下
/mcp                    MCP 服务            ⚠️ 归属见下
/mcp-console?tab=secret MCP 密钥            ⚠️ 归属见下
/recharge /infor /team /vipInfor /integral /purchaseRecords /ltevent   账户类
```

> ⚠️ **本清单的菜单归属已被第五轮判 27 部分推翻。**
> 这一轮是「抓 DOM 链接」拿到的路由集合，没有区分它们挂在哪个顶部菜单下。
> 第五轮实测确认 `/datacenter`、`/mcp`、`/mcp-console` 三项实际挂在
> **「AI工具」** 菜单下，不在「更多」下；「更多」的真实四项是
> 批量备注、管理备注、实时查产品竞价、**查ASIN定位广告**（`/adxray-productTarget`，
> 本轮漏抓）。导航建模按判 27 的归属，不按本清单。

`/ad-multiNotes-submit` 实测：两种同步方式（① Sif 浏览器插件自动同步 ② 从亚马逊后台手动复制粘贴），
手动方式是一张「广告活动名称 + 广告活动编号」的 10 行表格，可「+添加新行」。
⚠️ **方式 ① 依赖浏览器插件**，而 goal.md 明确「只复刻 Web 后台，不做浏览器插件」，
所以我们只能做方式 ②（手动批量备注）。
数据库侧已有 `sys_user_ad_note` 表（空壳，完整 CRUD 设计），正好对应这个功能。

---

## 8c. 第三轮：逐页实际输入 ASIN/关键词查出数据

前两轮有几页只看了空态和说明文字。第三轮逐页真查，**又发现 4 处关键修正**。

⚠️ 方法教训：用 `page.evaluate` 直接给 input 赋值 + dispatchEvent **不触发 Vue 的响应式更新**，
必须用 Playwright 的 `fill` / `click`（走真实事件）。第一轮几页「查不出数据」是这个原因，
不是页面本身没数据。

### 8c.1 ⛔ 对比流量词：动态列 + 基准 ASIN，比设计复杂得多

`/compare-traffic?asins=B0CNJS15T4,B0BMW2985V,B0H2YM86Z9`（逗号分隔，与我的设计一致）

**实测表头（动态列）**：
```
# | 流量词 | [B0CNJS15T4] | [B0BMW2985V] | [B0H2YM86Z9] | 关键词共享率
| 自然排名对比 | SP(常规)排名对比 | 周搜索趋势 | 建议竞价 | 关键词点击转化率
| 竞品数 | ABA Top3 集中度 | 最近7天自然流量Top 10产品 | 操作
```
**每个 ASIN 一列**，列名就是 ASIN 本身。另有一套带「我的流量竞争力」列的变体表头
（切换「对比我关注的重点流量词 / 重点广告词」时出现）。

**实测一行**（`travel blanket`，周搜索量 20,419）：
```
B0CNJS15T4: 11% 我          ← 第一个 ASIN 是基准，标注「我」
B0BMW2985V: 0 比我少11%      ← 其余显示与基准的差值
B0H2YM86Z9: 0 比我少11%
关键词共享率: 1/3            ← 3 个 ASIN 里 1 个有这个词
周搜索趋势: 20,419 / 12,197
建议竞价: $0.71 $0.92 $1.22  ← 三档
点击转化率: 6.6%   竞品数: 210,536
ABA Top3 集中度: 点击 40% / 转化 21%
操作: 加入词库 对比排名 查看竞争格局 查看竞品数量 下载搜索趋势
```

**4 个接口协同**（不是我以为的单接口）：
```
POST /api/search/compare/asinSummary      ASIN 概要
POST /api/search/compare/asinMagic
POST /api/compare/multiAsinKeywords       主接口：多 ASIN 关键词矩阵
POST /api/compare/compareMyKeywords       我关注的词
```

**`multiAsinKeywords` 响应里每个 ASIN 带 30+ 个得分字段**：
```
totalScore / nfScore / adScore / spScore / spRecScore / recScore
/ sbSbvScore / sbScore / sbvScore        ← 9 个得分
每个各配 Rank / Ratio / DifferRatio 三个变体
外加 differRatio / ratioScore / compareScore / compareScoreRank
/ compareScoreRatio / compareScoreBest
```
**`compareScoreBest` 确实存在**（值 `true`/`null`）—— 印证了 ROADMAP §M10 的判断
「组内最佳是相对当前对比组算出来的、不落库、每次现算」。✅ 这一条我原来是对的。

还有个 `indicator` 对象是「关键词共享率」列的数据源：
```
{ missing:1959, exclusive:996, top:38, upper:4, middle:0, lower:6, bottom:1, total:3004 }
```
即把对比组的关键词按「谁排名更高」分档统计。

⚠️ 响应里还带 `durations[]` 数组，是后端各阶段耗时（`查询ck=486ms`、
`>>>> 异步任务：TOP10 Asin列表=150ms` 等 18 项）。说明原站这页是**多个异步任务并发聚合**，
总耗时 700ms。我们实现时也该并发查而不是串行。

### 8c.2 对比流量结构：16 列 + 两种展示模式

`/compare-structure` 实测表头：
```
# | 图片 | 变体ASIN | 流量来源 | 全部流量词 | 自然流量词 | 广告流量词
| SP广告词 | SP(常规)广告词 | SP(推荐)广告词 | SB广告词 | SB(常规)广告词
| SBV广告词 | AC推荐词 | 操作
```
顶部有「**流量词 / 流量分**」切换 —— 同一张表两种度量（词数 vs 得分）。
与 `/product`（产品库）的表头**几乎完全一致**，说明两页共用同一套列定义。

页面说明补充了口径：「Sif 的流量是指**搜索页的有效曝光流量**，不是订单量或销量，
也不是亚马逊后台的曝光量」、「以最新一周 ABA 关键词为数据源，每天更新，每次抓取前 3 页」。

### 8c.3 ⛔ 相关性不是算法，是「自然位前 N 占位率」+ 用户设阈值

这是本轮最有价值的发现，**直接解决了 ROADMAP §M12 里我拿不准的「相关性评分无源」问题**。

`/asin-relatedness` 输入 3 个 ASIN 后，**实测表头 11 列**：
```
# | 关键词 | 相关性 | 自然位前4 占位率 | 自然位前8 占位率 | 自然位前16 占位率
| 自然位前32 占位率 | 自然位前48 占位率 | 搜索趋势
| 自然流量Top 5产品（根据热销产品的图片快速识别关键词与您的产品是否相关） | 操作
```

**相关性的判定机制**（从隐藏对话框的文案挖出来）：
```
「设置相关性高低标准」—— 友情提示：不同品类的产品建议设置不同的相关性判定标准
「将剩余的自动标记正确的关键词保存到词库」
「同一词库过滤」—— 将已在某些词库及其否定词库内的关键词隐藏掉，
    您只需标记那些从未标记过的。"me 将帮您隐藏掉 0 个关键词，您只需标记剩下的 4,665 个"
```

**结论：相关性 = 用户设定阈值 + 系统按「自然位前 N 占位率」自动判定 + 人工复核**。
不是 NLP 语义算法，是**纯数据计算** —— 一个词如果你的产品在它的自然搜索结果前 4/8/16 名里
占位率高，就是高相关词。

**这改变了 M12 的可行性判断**：
- ROADMAP 说「相关性评分无源，建议自算启发式（词根重合度+品类一致性）」→ **不需要了**
- 真实做法是用排名数据算占位率，我们**已有 `fact_keyword_rank_history` 117,740 行真实排名数据**
- 「自然流量Top 5产品」列的图片是给人工复核用的（「根据热销产品的图片快速识别是否相关」），
  数据源是 `rel_keyword_top_asin`（Doris 实测 **56,795** 行 = top 46,451 + conv 10,344，
  §11 已纠正本文档此前写的 46,881）

页面还有完整的工作流控件：`设置相关性高低标准` / `将剩余的自动标记正确的关键词保存到词库`
/ `下载标记结果` / `批量操作` / `查转化率` / `高级筛选` / `同一词库过滤`，
以及统计行「共 3 个目标产品（**加入拓词竞品库**），按 Listing 拓展后总共 N 个变体，
合并去重后总共反查出 N 个关键词」—— 再次印证产品库是前置依赖（§8b.5）。

### 8c.4 关键词转化率：34 行真实数据，ACOS 是前端实时算的

`/conversion-rate` 查 `travel gifts` → URL 变 `?keywordsId=79032906756208882832f856d218d837`，
返回 **34 行**。

**实测表头 13 列**：
```
# | 关键词 | 搜索量 | 点击量 | 购买量 | 点击转化率 | 建议竞价 | CPA
| 产品均价[自定义价格] | ACOS[自定义毛利率] | ABA Top3 单变体点击转化率
| ABA Top3 集中度 | 操作
```

**实测一行**（`travel gifts for men`）：
```
搜索量 1,529 | 点击量 267 | 购买量 20 | 点击转化率 7.5% / 1.3%
建议竞价: $0.77 $1.02 $1.27      ← 三档，递增
CPA:      $10.28 $13.62 $16.96   ← 三档，递增
产品均价: $5.37 $18.38 $59.99    ← min/avg/max
ACOS:     254% 74% 23%           ← 三档，递减（与竞价方向相反 ✅ 印证 §0 第 6 条）
ABA Top3 单变体点击转化率: B0CVSG8L9Q: 13%  B07SRRQS5B: 7.5%
ABA Top3 集中度: 点击 10% / 转化 9.5%
```

**两处重要修正**：

1. **「自定义价格」和「自定义毛利率」是用户输入项** —— ACOS 那三档是
   **根据用户填的毛利率前端实时算**的，不是查库得来。
   所以 `fact_keyword_acos_estimate` 存的应该是计算所需的基础值，
   ACOS 本身在前端算。这与我 service 里直接返回 acos 列的做法不同。

2. **建议竞价在这页也出现了** —— 说明竞价数据不只 `/cpc-browsetree` 用，
   转化率页、对比流量词页都要用。它是个共享度量，不该只服务一个页面。

3. `max_kw_price` / `min_kw_price` 的用途找到了 ——
   就是「产品均价」列的 `$5.37 $18.38 $59.99`（min/avg/max）。
   ✅ 解答了 M13_PROBE_FINDINGS §4 的待确认第 1 项。

## 8d. 第四轮：以词拓词/品类拓词实查 + 对比销量/流量结构实查 + 两个库

> 方法升级：抽出登录 JWT 后由 4 个并行子代理直接调 sif API（详见 `docs/audit/`），
> 浏览器只留给必须走 UI 的页面。本节是主会话实查结果。

### 8d.1 `/root-relatedness` 以词拓词 —— 实查 `travel gifts`，拓出 22 词

接口：`POST /api/search/relevanceScreen/keywordExtendKeyword`（country=US）
返回：`{ total: 22, snapId: "d23f8ebc...", globalKeywordNum: 1000000, groupFilterNum: 0, groupValidNum: 22, keywords: [...] }`

**每个词的字段（12 个）**：

| 字段 | 实测值（首行 travel gifts） | 说明 |
|---|---|---|
| `keyword` / `translateKeyword` | travel gifts / 旅行礼物 | 中文翻译直接随行返回 |
| `relevance` / `confirmRelevance` | **均 null** | 拓词时不判相关性，标记后才落值 |
| `matchTypes` | [Exact, **DropDownBox**, Phrase, AllMatch] | **拓词模式**：词出现在哪些收录面。DropDownBox=亚马逊搜索下拉联想 |
| `estSearchesNum` / `searchesRank` | 2,318 / 140,772 | |
| `estSearchesNumHistory` | 37 周（2025-12-28 → 2026-09-06） | 周搜索量+排名+环比三数组 |
| `estSearchesNumHistoryPrev` | **53 周去年同期**（2024-12-29 起） | 同比对照，前端可直接画双线图 |
| `imgs` | 3-10 个 `{asin, img, title, price}` | 自然流量 Top 产品卡 |
| `clickPurchaseRatio` | null（本次） | |
| `cpc` | `{autoForSales_exact/phrase/broad, legacyForSales_exact/phrase/broad}` | 内嵌竞价，本次为空数组 |

**表格渲染**：`# | 关键词(中文) | 拓词模式 | 周搜索趋势 | 建议竞价 | 关键词点击转化率 | 自然流量Top 10产品 | 操作`
操作列：**标记相关性 | 以词拓词&筛查（对单词递归拓词）| 产品时光机（跳转）**。

### 8d.2 `/niche-relatedness` 品类拓词 —— 实查类目 `Blankets & Throws`，**66,989 词**

交互链：输入类目名 → `GET /api/search/category/suggestion?country=US&s=blanket` 联想 →
选中「Blankets & Throws」→ 弹「是否过滤已标记过的关键词」对话框 →
`POST /api/search/relevanceScreen/keywordByCategory`，返回 100 条/页，total=66,989。

**与词根拓词的字段差异（判 17 的证据）**：品类版只有 8 个字段 ——
`keyword, translateKeyword, confirmRelevance, estSearchesNum, searchesRank,
estSearchesNumHistory(+Prev), imgs`。
**没有** relevance / matchTypes / cpc / clickPurchaseRatio。
表格也简化为 5 列：`# | 关键词 | 周搜索趋势 | 自然流量Top 10产品 | 操作(标记相关性)`。

### 8d.3 `/compare-sales` 对比销量 —— 实查 3 ASIN

接口：`POST /api/compare/bought/multiAsin`（+ `POST /api/compare/bought/listingHistory` 展开用）。

表格 10 列：`# | 图片 | ASIN 信息 | 属性 | 评论数 | 评分 | 价格 | 子体近30天销量 | 月销量趋势 | 操作`

每 ASIN 返回（实测 B0CNJS15T4）：
- `ratingNum: 1209, price: 16.99, score: 4.6, star: 4.5`
- `features[]`: `[{code:"Color", value:"Blue"}, {code:"Size", value:"40\"x65\""}]`
- `boughtInPastMonth: "6,000+"`（**字符串**，来自亚马逊前台徽标）+ `boughtInPastMonthBest: true`（**组内最优标记，现算**）
- **`boughtHistoryDates` + `boughtHistory`：2024-02 → 2026-08 共 31 个月逐月销量**
  （值是桶状估值：500/1000/2000/4000…，不是精确值）
- `pasinBoughtHistory`（父体销量序列）、`isFocus`、`isVaiant`、`diffAvailableDays`（上架天数差）

操作列 5 个跳转：**反查流量词 | 查运营节奏 | 查流量结构 | 查广告架构 | 查推荐专栏**。

### 8d.4 `/compare-structure` 对比流量结构 —— 实查 3 ASIN

接口：`POST /api/compare/summary/multiAsin`。
返回：`{ total, isParentAsin, vaiantsNum, nkVaiantsNum, pasins[], boughtMonth, asins[] }`。

每 ASIN 的核心（实测 B0BZR6YBHK）：
- **`flowResources`**：`{rec["4 stars and above","Today's deals","Recently bought and rated",...8项], bs[], natural[], sp[], sb[]}`
  —— 流量来源是**命名位清单**，不是数字
- **10 类流量位计数**：`total 1198 / natural 1136 / ad 274 / spRec 188 / sp 132 / rec 142 / brandVedio 124 / brand 124 / vedio 0 / ac 0 / er 0 / tr 0`
- 每个计数配 `*Best` 布尔（`totalBest/naturalBest/...`，组内最优现算）
- `rankHistory{date,rank,adRank}`（本次空）、`isBestSeller: true`、`brandName`、变体信息

### 8d.5 `/product` 产品库 —— 空库但结构齐全

18 列表头：`# | 图片 | ASIN 信息 | 月订单量 | 流量来源 | 全部流量词 | 自然流量词 | 广告流量词 |
SP广告词 | SP(常规)广告词 | SP(推荐)广告词 | SB广告词 | SB(常规)广告词 | SBV广告词 | AC推荐词 | 添加时间 | 操作`

- 默认库「我的产品」（类型=我的产品库），共关注 0 个
- 「管理产品库」对话框：`产品库名 | 产品库类型 | 操作`，可**+ 新建产品库**、按创建时间/名称排序
- 顶部：下载产品库、批量操作、筛选产品库（下拉选库）
- 官方说明原文：产品库可建**拓词竞品库（多竞品拓词用）、对标竞品库（多产品对比用）、ASIN定投库（商品投放用）**，上限 500 个

### 8d.6 `/words` 关键词库 —— 有 1 个种子词（ssd），17 列全可见

表头：`# | 关键词 | 搜索趋势(周/月切换) | 相关性 | 最近7天自然流量Top 10产品 | 周点击量 | 周购买量 |
市场平均点击转化率 | 建议竞价 | PPC广告竞品数 | TOP3 集中度 | 搜索需求分类 | 自定义标签 |
关键词已加入的所有词库 | 添加时间 | 操作`

新发现的 3 个字段/机制：
1. **搜索需求分类** —— 词的需求类型标签
2. **自定义标签** —— 用户自建标签体系（管理对话框里有「配置自定义标签」）
3. **关键词已加入的所有词库** —— 多对多归属展示；批量操作有 **移出词库 / 复制到其他词库 / 移动到其他词库**

相关性筛选值为「高 / 中」（低档存在与否待定）；「管理词库」支持增/删/改词库 + 配置自定义标签。

**官方口径（tooltip 原文）**：「关键词转化率数据是关键词下所有产品的平均点击转化率，**来源于后台商机探测器**」。
另外词库页「建议竞价」悬浮显示的是**按类目分列的竞价**（如 `Internal Solid State Drives $1.04 / External Solid State Drives $1.32 / Computer Internal Components $1.71`）
—— 再次印证竞价的类目维。

### 8d.7 全站通用交互（第二轮已发现，本轮再证实）

- 批量词查询先换 `keywordsId` hash 再查（`/amount` 与 `/conversion-rate` 同词集**共用同一 hash**——按词集合缓存）
- 跨页跳转以 ASIN 为纽带，操作列普遍 5 个跳转入口
- 查询前统一弹「词库预筛」对话框（拓词族）


## 9. 要补的调研（状态：全部完成或进行中）

| 页面 | 状态 |
|---|---|
| `/timemachine-product` | ✅ 第二轮已实查（§8b，100 行商品榜） |
| `/compare-sales` `/compare-structure` `/compare-traffic` | ✅ 第三、四轮已实查（§8c/§8d.3/8d.4） |
| `/dailyrank` `/hourlyrank` | ✅ 第二轮已抓结构（§8b）；订阅参数 schema 由并行代理补（`docs/audit/subscribe-family.md`） |
| `/skill/keywords-library` | 🔄 并行代理探查中（`docs/audit/skill-keywords-library.md`） |
| 「更多」菜单 4 项 | 🔄 并行代理探查中（`docs/audit/more-menu.md`） |
| 全站模块官方介绍 | 🔄 并行代理采集中（`docs/audit/model-introductions.md`） |
| `/root-relatedness` `/niche-relatedness` `/keyword-relatedness` `/asin-relatedness` | ✅ 第三、四轮已实查（§8c/§8d.1/8d.2） |
| `/product` `/words` | ✅ 第四轮已实查（§8d.5/8d.6） |

---

## 8e. 第五轮：4 个并行子代理 API 直查（产出 `docs/audit/` 四份专项文档）

> 方法：从请求转储抽出登录 JWT，4 个子代理并行直接调 sif API / 逆向前端 bundle，
> 各自落盘：`skill-keywords-library.md`、`more-menu.md`、`subscribe-family.md`、
> `model-introductions.md`。本节只记**修正判断的结论**，细节看四份原文。
> 注：审计后期服务端会话失效（401），`more-menu.md` 部分 schema 来自前端代码反推，已标注。

| # | 我原来的理解 | 真实情况 | 影响 |
|---|---|---|---|
| **22** | AI 工具 = 页面查询 + AI 解读 | **独立 Vite 子应用 + WebSocket 管道**（`wss://sif/ws/pipeline`）：输入 ≤100 ASIN → 8 步流水线，第 2/4 步**人工确认**（竞品列表 ≥48、相关性阈值 `{high,mid,low}` 可调），输出四级相关性 + xlsx | ⛔ M16 是「带人机回环的任务编排」，协议骨架 `step_*`/`input_required`/`input_response` 可复刻 |
| **23** | 小时排名参数未反推 | `POST /api/monitor/user/handle`：`{type(1新增/3续费), asinKeywords{asin:kw}, duration 7/14/28天, period 1/2/3/6/12小时, pages 3/7, isAutoProceed}`；定价 **1 ASIN×1词×3页×每小时×7天=20积分**，创建前 `calcMonitor` 试算 | ✅ M14 参数 schema 齐了 |
| **24** | 每日排名也是积分制 | **配额制不扣积分**：`userSubsInfo {limit, addNum, remainNum}`，高级 50 词/旗舰 200 词；主接口 `POST /api/search/subscribe/v2`（body 需 `asin`+`isExample`，`granularity` week/month） | ✅ M14 两套计费模型：任务扣积分 vs 配额 |
| **25** | 实时查产品竞价 = 即时查询 | **旗舰会员专享的任务制**：`/api/search/cpc/*` 8 接口，两种任务（自动投放 ≤200 词 / 手动词），并发上限 `role_integral_limit` 默认 2，异步排队「查询时间依任务量而变」 | ⚠️ M13 竞价族再多一个任务型页面，排 M13 之后 |
| **26** | sif 数据只能从 Web 端点爬 | **MCP 公开网关**：`GET /mcp-api/catalog` 无需登录，**7 大类 32 个工具**（含 `analyze_traffic_anomaly` 场景诊断），网关 `mcp.sif.com`，注册赠 2 万点，单密钥体系 | ✅ **Loom 的数据获取新选项**：对接 sif MCP 拿结构化数据，比爬 Web 端点正规 |
| **27** | 「更多」= 4 项 | 实为：批量备注、管理备注、**实时查产品竞价、查ASIN定位广告**；**API数据服务/MCP服务挂在「AI工具」下**（我们此前的菜单归属记录是错的） | ⚠️ 导航建模要按真实归属 |
| **28** | 菜单/口径按我们文档的推测 | **27 个 model 官方口径全集**已采集（`model-introductions.md`）：销量=订单量不含退款（回溯 2023.05）、流量=搜索页有效曝光流量（不含详情页关联流量）、广告组=「投放小组」+客户搜索词（仅 SP）、竞价=建议竞价非 CPC、转化率=商机探测器独立口径 | ✅ 全部照抄进 Loom 各页的「数据口径」说明 |

**顺手拿到的事实**：积分余额字段 `integral`（该账号实测 100.0）；VIP 双档 shark(旗舰1888元)/high(高级888元)+trial；会员门两档（`vip`=拓词筛查、`shark`=广告族/时光机）；每日排名 `rankStr` 格式 `p2,3/16` 表示坑位；产品库/词库 model 名为 `focusAsins`/`focusKeywords`；`keywordsLibrary` 这个 model **不存在**（AI 关键词调研没进官方介绍体系，它是独立子应用）。

---

## 10. 对已完成工作的影响

第 0 期（前置修复）**不受影响**，分区和守卫都是基础设施，与业务语义无关。

第 1 期 M13 的数据层**部分要返工**：

| 已做的 | 状态 |
|---|---|
| `fact_keyword_metric_snapshot` 加 10 列 | ⚠️ 补 `video_asin_num`，改 `sale_num` 的 COMMENT |
| `fact_keyword_bid_estimate` 33,019 行 | ⛔ **改名** `fact_keyword_acos_estimate`（它装的是 ACOS/CPA 不是竞价），竞价另建表 |
| `rel_keyword_top_asin` 加 2 列 | ✅ 没问题 |
| `fact_keyword_conversion_funnel` 加 1 列 | ✅ 没问题 |
| `wordpick.service.ts` 的 `listConversion` | ✅ 没问题（转化率页核对无偏差） |
| ETL 脚本 4 个步骤 | ⚠️ 加 `videoAsinNum` 字段，其余不变 |

**没有白做的工作** —— ACOS/CPA 那 33,019 行是真实数据且页面确实要用（
`/conversion-rate` 页会用到），只是表名和语义要纠正。

> ✅ **上表的返工已于 2026-09-21 执行完毕**，见 `db/schema-07-m13-rework.sql`
> 与 §11.5 的执行记录。

---

## 11. 第六轮：用 Doris 实测数据反查本文档

前五轮都是「看原站页面 → 纠正我们的设计」。这一轮反过来：
**连 Doris 查已落表的真实数据，核对本文档和 schema-06 写的行数、填充率、值域**。
不推翻设计判断，但揪出 5 处数字错误 —— 这类错误比设计错误更隐蔽，
因为它们会被当成事实引用去支撑可行性判断。

连接：`120.24.248.175:9030`，库 `looom`。

### 11.1 ⛔ `rel_keyword_top_asin` 行数三处不一致，且三处全错

| 出处 | 写的 | 实测 |
|---|---|---|
| `schema-06:130`、本文档 §8c.3、`MODULE_DATA_FLOW.md:1191` | 46,881 | ❌ |
| `ROADMAP:582` | 57,225 | ❌ |
| **Doris 实测** | — | **56,795**（top 46,451 + conv 10,344） |

两个错数的来历：
- **46,881** 是加 `asin_role='conv'` 行**之前**的旧行数，ETL 跑完后没更新文档
- **57,225** 是 ETL 脚本的 `w.total`（写入次数），**不等于表行数** ——
  `run_topasin` 先回填 top 行再写 conv 行，同 ASIN 的 conv 会覆盖 top（主键不含 role），
  所以写入 57,225 次最终只剩 56,795 行

ROADMAP:582 用这个数支撑「M12 相关性自算的数据已有」，虚高 430 行不致命，
但两份文档互相矛盾会让实现者不知道信哪个。**已全部改为 56,795**。

⚠️ 顺带发现一个实现要注意的点：conv 的 10,344 行里**只有 430 行带 `rank_position`/`title`**
（只有能对上既有 top 行的才继承，conv 响应本身没有 title）。
做「自然流量 Top 5 产品」那列时，用 `asin_role='top'` 筛，别混 conv。

### 11.2 ⚠️ `ac_asin_num` 实测 318 行全为 0

判 3 说 `/compete` 是「ASIN × **6** 个流量位份额」，ROADMAP:19 照抄成
「ASIN×6 流量位份额矩阵」。但 AC 位那列在 metric 表里 **318 行全是 0**
（`MAX(ac_asin_num) = 0`），schema-06:65 当时已标注「无区分度」。

**裁决（2026-09-21 用户确认）：保留该列。**
理由：AC（Amazon Choice）本身是稀缺标，当前样本没有带 AC 标的词属正常，
换品类或换周可能出现非 0。值恒 0 ≠ 字段无意义。

⚠️ **但前端必须区分「0」与「无数据」** —— 该列有值就显示 0，
不能因为是 0 就渲染成空白，否则用户无法判断是「没有 AC 竞品」还是「没查到」。

另外响应里有 **8 个** `*ScoreRatio` 而页面只展示 6 列，多出的
`erScoreRatio` / `trScoreRatio` 用途未确认（对应的 `erAsinNum`/`trAsinNum`
在 `/amount` 实测 0% 填充）。新表 `rel_keyword_asin_traffic_share` 建了列但标注存疑，
真实 ETL 跑过再决定去留。

### 11.3 ⚠️ ACOS 表的 6 种组合不是每词都全，且 13% 重复

判 1 只说了「竞价表要拆类目维」，没提 ACOS 表自身的数据分布问题。实测：

```
5,118 词  auto + legacy 齐全（6 行）
  409 词  只有 auto（3 行）
  362 词  只有 legacy（3 行）
```
即 **13% 的词拿不到 6 格全满的矩阵**。前端按 2×3 渲染要容忍整行缺失。

更微妙的是：5,117 个可配对的 `exact` 组合里，**673 对（13%）auto 与 legacy
数值逐位完全相同**。这不是 ETL bug，是源数据特征 ——
原站 `/cpc-browsetree` 页面说明第 3 条自己写了「仅降低和固定模式的建议竞价
差别非常小，所以我们将仅降低和固定合并」，同源的合并逻辑。
**别把它当数据质量问题去「修」。**

### 11.4 ⛔ schema-06 的 COMMENT 把「源侧填充率」写成了「落表填充率」

这是最容易误导实现的一类错误。schema-06 的注释写的是 200 条响应采样里的
填充率与值域，但注释挂在 Doris 列上，读者会理解成表里的情况。**两者差 70 倍**：

| 列 | schema-06 注释 | Doris 实测 |
|---|---|---|
| `nf_asin_num` | 「100% 填充」 | **318/22,320 = 1.4%** |
| `sale_num` | 0~424,204 | **80~298,323** |
| `click_shared` | 81.3%，0~0.6396 | **264/318**，0~**0.5472** |
| `sp_recommended_asin_num` | 0~270 | **0~284** |
| `cpa_end` | 1.333~366.7 | **0.7136~6,290.91**（差 17 倍） |

「源侧 100%」和「落表 1.4%」的落差有正当理由 ——
`web-compete-keyword` 只覆盖 789 个词，与 metric 表 22,320 行的词级交集是 318
（ETL `run_compete` 的说明）。但注释不写清楚，就会有人以为 22,320 行都能查到竞品数。

**已在 schema-07 全部改为「落表实际 + Doris 实测值域」。**

### 11.5 ✅ `sale_num` 语义纠正 + `max/min_kw_price` 待确认项关闭

- `sale_num`：schema-06 写「关键词带来的总销量」，§3 已发现实际是
  **「在售产品数」**（该词下的在售商品数量）。schema-07 已改 COMMENT。
- `max_kw_price` / `min_kw_price`：schema-06:150 挂着「176 字段采样里没出现，
  待确认」。§8c.4 已确认是「产品均价」列的 min/avg/max 三档，
  Doris 实测 5,875 行 **100% 填充**，0.87~35,690.36。**待确认项关闭。**

### 11.6 ⚠️ 词根拓词的 `relevance` 与 `cpc` 字段存在但值全空

校验 `docs/audit/fixtures/root-extend-travel-gifts.json`（22 个词）：

```
matchTypes 并集: {Exact, Phrase, AllMatch, DropDownBox}   ← 判 16 ✅ 成立
relevance        非空 0/22
confirmRelevance 非空 0/22
cpc              6 个键全是空数组
```

判 17 说「品类拓词无 relevance/matchTypes/cpc」，我核对品类 fixture
（`category-extend-blankets-throws.json`）确认字段**精确是 8 个，无多无少**，判 17 成立。

但**词根拓词的这几个字段虽然存在、值也全空**。这不影响 M12 的相关性自算方案
（本来就是自算），但如果实现时打算「先读源 `relevance`，读不到才自算」，
会发现这条路根本走不通 —— 至少在当前样本里拿不到任何源侧相关性值。
**M12 直接按占位率自算，不要写 fallback 逻辑。**

### 11.7 执行记录

返工 SQL 落在 `db/schema-07-m13-rework.sql`（332 行），已对 Doris 执行：

| 动作 | 结果 |
|---|---|
| `fact_keyword_bid_estimate` → `fact_keyword_acos_estimate_v1` | ✅ 改名 |
| 新建 `fact_keyword_acos_estimate`（拆 `match_type` × `bid_strategy`） | ✅ 迁移 33,019 → 33,019 行，6 组合行数逐一对应 |
| `metric_snapshot` 补 `video_asin_num` | ✅ |
| 14 处 COMMENT 修正 | ✅ |
| 新建 `rel_keyword_asin_traffic_share` | ✅ 空表待 ETL |
| 新建 `fact_keyword_bid_estimate`（真正的竞价，类目维） | ✅ 空表待 seed |
| `dict_traffic_channel` 补 `rec`（推荐位） | ✅ 实查确认字典 12 行里只有 `spRec` 没有 `rec` |
| `user_favorites` 重建主键 | ✅ `UNIQUE KEY(id)` → `(user_id, favorite_type, target_type, target_value, country)`。表是空的且代码无引用，零成本 |
| `fact_keyword_acos_estimate_v1` | ⏸ **保留待人工确认后手动 DROP** |
| `user_favorites_old_pk` | ⏸ 同上（空表） |

⚠️ Doris 踩坑两处，记下来免得重犯：
1. **只改 COMMENT 时不能带类型声明** ——
   `MODIFY COLUMN x INT NULL COMMENT '...'` 报 `Nothing is changed`，
   必须写 `MODIFY COLUMN x COMMENT '...'`（省略类型）。
2. **`ADD COLUMN` 是异步 SCHEMA_CHANGE**，紧跟其后的 ALTER 会报
   `state(SCHEMA_CHANGE) is not NORMAL`。同一个表连续 ALTER 要么分批执行，
   要么先 `SHOW ALTER TABLE COLUMN` 等到 `FINISHED`。

代码侧同步改动：
- `scripts/etl_module13_wordpick.py` —— `run_bid` 改写新表名并拆维（`mt.split('ForSales_')`）；
  `run_compete` 加 `videoAsinNum` 字段。dry-run 通过（321 词命中 / 33,097 行 ACOS）
- `apps/api/src/business/dto/query.dto.ts` —— `MATCH_TYPES` 从 6 个拼接值改为
  `['broad','phrase','exact']`，新增 `BID_STRATEGIES`；拆出 `AcosEstimateQueryDto`
  与 `BidEstimateQueryDto`（后者多 `categoryId` + `statMonth`）
- `apps/api/src/business/wordpick.service.ts` —— 表名引用改正；类注释里
  「4 页全是真实数据」的旧结论改为「3 页真实 + 1 页 seed」；补 ACOS 前端实时算的口径
- `tsc --noEmit` 通过

### 11.8 ⛔ `top3_click_shared` / `top3_conversion_shared` 不要建 —— 已在表里

`DORIS_SCHEMA_GAP_ANALYSIS.md` §2.2 把「ABA Top3 集中度」列为 metric 表的缺失列，
要新建 `top3_click_shared` / `top3_conversion_shared` 两列。**这会造出重复列。**

这两个值**已经在表里了**，就是 schema-06 建的 `click_shared` / `conversion_shared`
（落表 264 行）。当时按源字段名 `clickShared`/`conversionShared` 理解成「份额」，
所以后来看到页面上的「ABA Top3 集中度」以为是另一回事。

PG 实查对上了：

```
gag gifts for men                   clickShared 0.1907  conversionShared 0.1547
butterfly baby shower decorations   clickShared 0.2271  conversionShared 0.0455
christmas mugs                      clickShared 0.1276  conversionShared 0.0286
```
量级与 §3 实测页面显示的「点击 8.6% / 转化 3.9%」一致。
**schema-07 已把这两列 COMMENT 改正为「ABA Top3 点击/转化集中度（非份额）」。**

⚠️ 那份文档里的 sif MCP 取数方案（`market_get_keyword_history` 返回
313 周 `top3_click_shares[]` 序列）**仍有价值** —— 但用途是给这两列**补历史序列**，
不是新建当期列。既有列只有单周值，做趋势图才需要序列。

### 11.9 ⚠️ `/compete` 的源确实存在，但覆盖面只有 9 个词

§0「开工前探源待办」要求确认 `competePattern` 有无 PG 日志。已查（PG `sif_api_log`）：

```
web-compete-keyword   674 条请求 / 379 ok
web-compete-pattern   753 条请求 /  82 ok
```

⚠️ **82 条 ok 不等于 82 条有数据**。逐条查 `resp.data.asins` 的类型：

```
asins = null   60 条    ← 73% 的成功响应是空的
asins = array  22 条    ← 合计 1,637 行 ASIN，覆盖 9 个去重关键词
```

有数据的那 22 条，字段结构与我建的 `rel_keyword_asin_traffic_share`
**完全吻合**，包括两处源侧拼写错误：

```
8 个份额字段: nfScoreRatio, spScoreRatio, spRecScoreRatio, brandAdScoreRatio,
             vedioAdScoreRatio, acScoreRatio, erScoreRatio, trScoreRatio
其他字段:     asin, title, img, price, ratingNum, star, score,
             boughtInPastMonth, boughtHistory, boughtHistoryDates,
             ac, acDates, hasVaiants, isFocus, createdAt
请求参数:     { keyword, pageNum, pageSize }   ← 按词分页查，每页 50
```

**结论：🟡 真实但覆盖极窄**，不是 🟢。9 个词的数据够验证 ETL 和前端渲染，
但演示时会有大量词查不到东西。建议真实 ETL + seed 补覆盖，
`source` 列（已在 DDL 里）区分 real / seed，前端据此显示「模拟数据」标记。

⚠️ 这一条纠正了另一份并行审计给出的「🟢 web-compete-pattern 82 条 ok，真实 ETL」判断 ——
82 这个数字本身没错，但它是 `ok=true` 的计数，不是有数据的计数。
**以后判断就绪度不要只看 `SUM(ok)`，要看目标数组的 `jsonb_typeof`。**

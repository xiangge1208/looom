# Sif.com 全站模块官方说明手册（modelIntroduce 接口全量采集）

> 采集日期：2026-09-21 ｜ 站点：www.sif.com ｜ 接口：`GET /api/sys/modelIntroduce/search?country=US&model=<model>`（需登录 JWT）
> 本文档汇总 Sif 全站 27 个功能模块的官方介绍文案（headline / 必读口径 / 推荐阅读 / 视频课），供 Looom 竞品审计使用。

---

## 采集方法

1. **入口逆向**：下载 `https://www.sif.com/` 首页 HTML，提取 `<script src>` 得到主 bundle `app.b278f717.js` 与 `manifest.e95d6ed3.js`。
2. **model 名来源**：`app.js` 中仅封装了 API 调用（`/api/sys/modelIntroduce/search`），带 model 参数的调用分布在 117 个懒加载路由 chunk 中。解析 `manifest.js` 的 webpack chunk id→hash 映射（懒加载 chunk 命名为 `<id>.<hash>.js`，无 `chunk-` 前缀），批量下载全部 117 个 chunk（限速约 3 req/s），grep 出两类关键信息：
   - `model:"xxx"` 字面量（TrialGate 付费门组件的 6 处调用）；
   - **路由→model 映射表**（chunk 53 中三份 `y/g/x` 映射对象 + 路由→中文名映射 `b`），这是最完整、最可靠的 model 清单来源。
3. **批量验证**：合并映射表 33 个 model + 任务给定已知名 + 猜测名共约 75 个，逐一调用接口（限速 ≤3 req/s）。判活标准：响应中 `data.model` 非空才算真实命中（`data` 为全 null 对象即"不存在"）。注意：该接口对任意未配置的 model 都返回 `code:1`，不能只看 HTTP 状态码。
4. **结果**：**27 个 model 真实命中**；`keywordsLibrary`（用户猜测的"AI关键词调研"）经多轮验证**不存在**（返回全 null），前端代码中也无此字符串。另有 5 个仅出现在前端映射表但后端未配置介绍的 model：`boughtMultiAsin`、`summaryMultiAsin`、`boughtByKeyword`、`typeKey`、`multiNotes`。

**响应结构**：`data.{model, headline, content, introduce:{headline, recommendList[], miaokeList[], thanks[], detailed...}, mustRead:{headline, faq{link,name}, list[{titleInner, name, link}]}}`。所有模块 `content` 均为 null，核心文案在 `introduce.headline`（"XX有什么用"）与 `mustRead.list[].titleInner`（口径/频率/积分等硬信息，用 `$…^` 标记重点词）。

---

## 全站模块介绍总表（按功能族分组）

### 一、销量族

| model | 功能页(路由) | 中文名 | 官方介绍要点 |
|---|---|---|---|
| `asinBought` | /Sales、/compare-sales | 查销量 | 数据来自亚马逊前台 "xxx+ bought in past month"，最早可追溯至 2023.05；**实际含义是订单量**（不含取消/退款/部分促销订单）；**月订单量每月初更新**；视频：查询精准销量并评估什么属性更畅销 |

### 二、流量结构 / 反查 / 时光机族（Sif 核心赛道）

| model | 功能页(路由) | 中文名 | 官方介绍要点 |
|---|---|---|---|
| `summaryAsin` | /search、/compare-structure | 查流量结构 | 流量=搜索页**有效曝光流量**（非订单/销量、非后台曝光量）；以**最新一周 ABA** 为数据源，**每天更新**，每次抓取**前3页**；用途：了解 listing 流量构成、找最畅销变体 |
| `asinKeywords` | /reverse | 反查流量词 | 同上口径（ABA 周数据、每天更新、抓前3页）；用途：反查 listing 找差距、看关键词流量大小、记录每天排名变化 |
| `compare` | /compare-traffic | 多竞品对比 | 数据源自单个 ASIN 反查结果的横向对比，同为有效曝光流量；**每次最多对比 10 个 ASIN** |
| `flowHistory` | /timemachine-traffic | 运营时光机（流量时光机） | 仅含搜索页有效曝光流量，**不含详情页关联流量**；柱高默认为全部流量，可按标签筛选流量类型；部分站点**最早可回溯至 2020.12**；数据按**天/周/月**维度更新；Lenry、门与路、Martin、何轩、Miki 等近 20 位赞助商深度参与设计 |
| `summaryKeyword` | /timemachine-product | 流量时光机-产品/关键词 | 除搜索词趋势外，关注**以搜索词为词根的所有关键词**综合搜索趋势，**可回溯近 2 年(720天)**；按时间段加载产品数据、以自然流量排序，可**查找历史畅销产品** |
| `asinMultiNfTrend` | /multi-variants | 查多变体自然位 | 定位关键词下多变体自然位，开拓新增流量阵地；配套深度观察文章"同一个关键词下多个变体自然位" |

### 三、广告透视仪族（AdXray）

| model | 功能页(路由) | 中文名 | 官方介绍要点 |
|---|---|---|---|
| `asinAdCampaign` | /adxray-structure | 查广告架构 | 可查 listing 维度 **SP/SB/SBV 广告的关键词投放**及在搜索页有曝光的商品投放；抓取的不是后台广告组，而是亚马逊隐藏最小投放单位"**投放小组**"；抓取关键词为**客户搜索词，不是投放词** |
| `asinAdKwNum` | /adxray-adgroup | 查广告组（广告透视仪） | 只含 **SP 广告**（**不含 SB、SD**）；同样基于"投放小组"和客户搜索词；有"特别感谢"栏（冬离等贡献数据结构设计）；配套指标详解文档 |
| `asinAdKwView` | /adxray-searchterm | 查广告词（广告透视仪） | 口径同上（仅 SP、投放小组、客户搜索词）；用途：快速挖掘竞品广告词投放策略 |
| `adCampaignView` | /adxray-productTarget | 查 ASIN 定位广告 | ASIN 定位广告可投放到关键词搜索页、也能提升自然排名、可在广告活动层级否词；查询需**从亚马逊后台复制广告活动编号** |
| `asinAdRec` | /recommend | 查推荐位（推荐专栏） | 打开推荐专栏黑盒，解锁稳定占据推荐专栏流量；"Prime Day 流量入口"主题文章 |
| `adBatchNote` | /ad-multiNotes-submit | 备注广告活动（插件） | 通过浏览器插件在前台广告位溯源后台广告活动；支持自动同步广告活动 + 手动批量备注 |

### 四、关键词调研 / 拓词筛查族（四 Tab 工作流）

| model | 功能页(路由) | 中文名 | 官方介绍要点 |
|---|---|---|---|
| `variantKeywordRelevanceScreen` | /asin-relatedness | 多竞品拓词并自动筛查（相似竞品拓词&筛查，VIP 权限） | 官方词库 SOP：按 **多竞品拓词→词根拓词→品类拓词** 顺序搭建（先自动、再批量、后手动）；**搭配插件至少输入 48 个 ASIN**，相关性判断更准确；多次维护用"同一词库预筛查"；宣传：1 分钟自动精准判定 5000 个关键词相关性 |
| `keywordSearchKeyword` | /root-relatedness | 以词拓词并筛查（词根拓词） | 同一套 SOP（拓词顺序 / 48 ASIN / 预筛查）；用途：根据核心词拓展相关词 |
| `keywordByCategory` | /niche-relatedness | 细分品类拓词并筛查 | 同一套 SOP；用途：细分品类拓词 |
| `keywordRelevanceScreen` | /keyword-relatedness | 导入关键词筛查-筛查相关性 | 同一套 SOP；用途：快速过滤不相关流量词 |
| `keywordConversion` | /conversion-rate | 点击转化率 | 关键词的**平均点击转化率**，无法与具体产品绝对值对比；**数据完全源于商机探测器**，是独立计算方式，与其他模块口径不完全一致；结合 CPC+CPA+ACOS+均价测算利润 |

### 五、竞争分析族

| model | 功能页(路由) | 中文名 | 官方介绍要点 |
|---|---|---|---|
| `competeAsinAssay` | /amount | 关键词竞品数量 | 搜索使用类似亚马逊的**词组匹配模式**；**默认展示最近 7 天数据**；用途：找到流量词下最具性价比的推广位置 |
| `competePattern` | /compete | 流量位竞争格局 | 按所选时间段加载产品数据，**默认以自然流量份额排序** |

### 六、竞价族（CPC）

| model | 功能页(路由) | 中文名 | 官方介绍要点 |
|---|---|---|---|
| `cpcCategory` | /cpc-browsetree | 查关键词竞价（类目竞价） | 建议竞价**与产品无关、与品类强相关**，与产品权重无关；大小取决于**该品类产品数量**及**每个产品的预期广告成本**；"仅降低"与"固定"模式建议竞价差别极小，合并为"仅降低/固定"；**以周 ABA 为数据源，每月更新一次** |
| `cpcList` | /cpc-realtime | 实时查产品竞价 | 查询的是产品在关键词下的**建议竞价**——不是点击 CPC，也不是卖家出价；查询时间依据同时查询任务量而变化（需等待）；"仅降低/固定"同样合并 |

### 七、排名监控族

| model | 功能页(路由) | 中文名 | 官方介绍要点 |
|---|---|---|---|
| `subscribeSearch` | /dailyrank | 每日排名（订阅排名） | **整合所有变体排名之后的数据**；**每天 9:00 前更新**；**高级会员可添加 50 个词，旗舰会员 200 个词**；可从反查页添加或手动添加；70 多位梦想赞助商贡献该功能 |
| `monitorKeyword` | /hourlyrank | 小时排名（坑位监控） | 可监控**自然排名和 SP 广告排名**；抓取频率自定义（**最快每小时一次**）、每次抓取页数自定义；**使用 Sif 自己的爬虫资源**（非用户浏览器）；支持产品视角/关键词视角切换 |
| `monitorSnapshotKeyword` | /snapshot | 坑位快照 | **默认每小时抓取、每次抓前 3 页、每次持续 15 天、消耗 42 个积分**；**广告抓取率稳定在 95% 左右**（远超行业平均），空坑位是多次重试仍无广告位 |

### 八、资产库族

| model | 功能页(路由) | 中文名 | 官方介绍要点 |
|---|---|---|---|
| `focusAsins` | /product | 产品库 | 收藏关注产品，可建**拓词竞品库**（多竞品拓词用）、**对标竞品库**（多竞品对比用）、**ASIN 定投库**（商品投放用）；**数量上限 500 个** |
| `focusKeywords` | /words | 在线词库 | 每个产品词库有**一对有效词库和否定词库**；**两级结构**：一级产品词库，二级阶段性推广词库（**新品期、成长期、成熟期、衰退期**）；相关性标准继承添加时标记，可手动修改 |

---

## 硬信息摘录（积分 / 频率 / 数据口径 · 原文引用）

**数据口径**

- asinBought：「该销量的实际含义是**订单量**，不是产品销量，并且**取消、退款订单和部分促销订单未计入在内**」；「数据来源于亚马逊前台展示的 xxx+ bought in past month，**最早可追溯至 2023.05**」
- asinKeywords / summaryAsin：「Sif的流量是指搜索页的**有效曝光流量**，不是订单量或者销量，也不是亚马逊后台的曝光量」；「以**最新一周 ABA** 关键词为数据源，**每天**更新，每次抓取**前 3 页**」
- compare：「多竞品对比数据源自于单个 ASIN 反查的数据的横向对比……目前**每次最多支持对比 10 个 ASIN**」
- flowHistory：「运营时光机仅包含在搜索页的有效曝光流量，**不包含详情页的关联流量**」；「部分站点数据**最早可回溯至 2020.12**」
- asinAdKwNum / asinAdKwView：「可查询 **SP 广告**的关键词投放，和在关键词搜索页有曝光的商品投放，但**不包含 SB、SD 广告类型**」；「Sif 抓取的广告组并不是亚马逊后台的广告组，而是亚马逊隐藏的最小投放单位"**投放小组**"」；「Sif 抓取的关键词为**客户搜索词，不是投放词**」
- keywordConversion：「转化率数据**完全源于商机探测器**，是一套独立的计算方式，与其他模块之间的数据口径不完全一致」
- competeAsinAssay：「输入关键词后的搜索使用类似亚马逊的**词组匹配模式**」；「**默认展示最近 7 天的数据**」
- cpcList：「准确的讲，查询的是产品在关键词下的**建议竞价**，不是点击的 CPC，也不是卖家的出价」
- cpcCategory：「建议竞价与产品无关，**与品类强相关的，且与产品的权重没有关系**」；「建议竞价的大小取决于**该品类的产品数量**以及对**每个产品的预期广告成本**」

**更新频率 / 回溯深度**

- asinBought：「**月订单量数据每个月初更新**」
- subscribeSearch：「每日排名**每天 9:00 前更新**」；文档标题「每天 9 点前更新排名的魅力与逻辑」
- cpcCategory：「以周 ABA 为数据源，**每月更新一次**竞价数据」
- flowHistory：「数据以**天、周、月**维度数据更新」
- summaryKeyword：「可回溯**近 2 年(720 天)**数据」（时间选择组件同款提示：「可回溯最近 2 年(720)天的数据」）

**积分 / 配额**

- monitorSnapshotKeyword：「坑位快照默认**每小时抓取**，每次抓取**前 3 页**，每次持续时间 **15 天**，消耗 **42 个积分**」；「Sif 的**广告抓取率稳定在 95% 左右**，远超行业平均水平」
- subscribeSearch：「**高级会员总共可添加 50 个词，旗舰会员总共可 200 个词**」
- focusAsins：「产品库目前的**数量限制是 500 个**」
- monitorKeyword：「小时排名可自定义抓取频率（**最快可每小时更新一次**）」；「使用 **Sif 的爬虫资源**进行抓取，不是调用您的浏览器」
- 拓词族（4 个模块共用）：「多竞品拓词建议搭配插件且**至少输入 48 个 ASIN**」；「强烈建议按照**多竞品拓词→词根拓词→品类拓词**的顺序搭建词库（**先自动，再批量，后手动**）」

**会员门槛（TrialGate 付费门，来自前端代码）**

| featureName | model | 门槛等级 |
|---|---|---|
| 查广告组 | asinAdKwNum | shark |
| 查广告架构 | asinAdCampaign | shark |
| 查广告词 | asinAdKwView | shark |
| 查ASIN定位广告 | adCampaignView | shark |
| 运营时光机 | flowHistory | shark |
| 相似竞品拓词&筛查 | variantKeywordRelevanceScreen | **vip** |

---

## 验证结论：不存在 / 未配置的 model

- `keywordsLibrary`：**不存在**（返回全 null，前端 117 个 chunk 中亦无此字符串）。Sif 的"AI 关键词调研"若存在，实际对应的是拓词筛查四模块（`variantKeywordRelevanceScreen` / `keywordSearchKeyword` / `keywordByCategory` / `keywordRelevanceScreen`）。
- 前端映射表出现但后端未配置介绍（接口返回全 null）：`boughtMultiAsin`、`summaryMultiAsin`、`boughtByKeyword`、`typeKey`、`multiNotes`——对应功能页复用其他 model 的介绍（如 /compare-sales 复用 asinBought、/conversion-rate 复用 keywordConversion）。
- 任务猜测中未命中的名字：`sales/bought/reverse/trafficStructure/adxray/timemachine*/compareTraffic/compareStructure/*Relatedness(单独形式)/keywordExtendKeyword/conversionRate/competeKeyword/cpc/cpcBrowseTree/cpcRealtime/snapshot/dailyRank/hourlyRank/productLibrary/wordLibrary/skill` 等——Sif 使用的是上文 27 个驼峰命名，猜测名均返回空。

---

## 对 Looom 的实现提示

1. **直接可抄的产品骨架**：Sif 用一张「路由→model」映射表驱动所有模块的介绍弹层（headline + 必读 + 推荐阅读/视频）。Looom 可复制该模式：每个功能页配置一个 `moduleKey`，统一拉取介绍/FAQ/教程，降低运营内容维护成本。
2. **口径即壁垒，必须显式声明**：Sif 在每个模块"使用前必读"里写死数据口径（订单量≠销量、有效曝光流量≠后台曝光、客户搜索词≠投放词、建议竞价≠CPC）。Looom 的销量/反查/竞价模块应内嵌同级别的口径说明，避免用户因数据"对不上"而流失，也是对齐竞品信任度的最低配置。
3. **数据源与频率是核心卖点**：反查/流量结构以"最新一周 ABA、每天更新、抓前 3 页"为口径；竞价类目表每月更新、实时竞价异步排队；每日排名 9:00 前更新、小时排名最快每小时且用平台自有爬虫。Looom 排期时应把"抓取基建（前 3 页深度、小时级频率、95% 广告抓取率）"当作独立的技术里程碑，而非功能附带品。
4. **积分体系锚点**：坑位快照 = 42 积分/15 天任务（每小时 1 次、前 3 页）是唯一公开的定价锚点；配额类锚点：产品库 500 个、每日排名 50 词（高级）/200 词（旗舰）、对比上限 10 ASIN、多竞品拓词 ≥48 ASIN 建议。Looom 设计积分/套餐时可按此量级对标，会员分层的功能门（shark/vip 双档）也值得沿用。
5. **转化率数据来源差异化**：Sif 点击转化率完全依赖亚马逊商机探测器（独立口径、不可与单产品对比）——Looom 若自建转化率需明确告知口径差异，或直接复用商机探测器以降低合规与数据成本。
6. **词库工作流是粘性设计**：多竞品拓词→词根→品类→导入筛查四 Tab + 在线词库两级结构（产品词库/阶段词库×4 阶段）+ 有效/否定词库成对 + 产品库三类用途（拓词竞品库/对标竞品库/ASIN 定投库），构成"调研→筛查→沉淀→投放"闭环。Looom 做关键词模块时建议按此链路设计数据模型（词库表需支持阶段标签与正/负双向标记）。
7. **时光机回溯深度是差异化王牌**：流量侧部分站点回溯至 2020.12、关键词侧 720 天，Looom 若日志留存不足，可在 UI 明示回溯范围并渐进补数据，避免正面硬刚。

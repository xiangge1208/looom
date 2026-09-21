-- =====================================================================
-- M13 数据层返工（ROADMAP §0.5 期）
--
-- 触发原因：2026-09-21 五轮 sif 页面审计推翻了 schema-06 的 3 处判断，
--   外加本轮用 Doris 实测数据核对 DDL 注释，发现 4 处值域/填充率写错。
--   审计原文 docs/SIF_UI_AUDIT_2026-09-21.md §0 判 1/判 3/判 6 + §11。
--
-- 本文件做 4 件事：
--   1. ACOS/CPA 表改名并**拆维**：match_type 的 6 值拼接键拆成
--      match_type(broad/phrase/exact) × bid_strategy(auto/legacy) 两列
--   2. metric_snapshot 补 video_asin_num（审计发现漏建的 SBV 产品数）
--   3. 修正 schema-06 里 4 处与实测不符的 COMMENT
--   4. 新建 rel_keyword_asin_traffic_share（/compete 的真实数据模型）
--
-- ⚠️ 幂等性：本文件含 RENAME 和 INSERT SELECT，**不是无条件幂等**。
--   重复执行时 RENAME 会报 "Unknown table"，INSERT 因 Unique Key 覆盖而安全。
--   init-db.mjs / setup-doris.sh 按「Unknown table 视为已执行，跳过」处理。
--
-- 执行顺序：必须在 schema-06 之后。
-- =====================================================================

USE looom;


-- =====================================================================
-- 1. ACOS/CPA 表：改名 + 拆维
--
-- ## 为什么改名
--
-- schema-06 把这张表叫 fact_keyword_bid_estimate（竞价预估），但审计实测
-- 原站 /cpc-browsetree「查关键词竞价」的真实结构是
--   关键词 × 类目 × 匹配方式 × auto/legacy → {start,median,end}
-- 而本表装的是 web-keyword-conversion 的 ACOS/CPA，**没有类目维**，
-- 两者是不同指标（AUDIT §4 的对比表）：
--   | 指标 | start/median/end 方向 | 更新频率 |
--   | ACOS/CPA | 递减（实测 33,019 行 100% 满足 start>median>end） | 每周 |
--   | 建议竞价 | 递增（0.37→0.49→0.61） | 每月 |
-- 所以本表正名 fact_keyword_acos_estimate，fact_keyword_bid_estimate
-- 这个名字留给真正的竞价表（无源，走 seed，在本文件 §4 之后另建）。
--
-- ## 为什么拆维
--
-- 原 match_type 列存 'autoForSales_exact' 这种拼接值，是照抄源 JSON 键名。
-- 但新竞价表的主键要设计成 (..., match_type, bid_strategy, ...) 两维分开，
-- 两张表风格不一致会让 service 层写两套解析。既然改名要动一次表，顺手拆齐。
--
-- 拆分规则（实测 SPLIT_PART 与 LIKE 在 Doris 4.1 可用）：
--   'autoForSales_exact'   → match_type='exact',  bid_strategy='auto'
--   'legacyForSales_broad' → match_type='broad',  bid_strategy='legacy'
--
-- ## 实测数据特征（决定了列的 NULL 约束与前端渲染）
--
-- 33,019 行 / 5,849 个去重关键词 / 6 个 ABA 周（2026-07-26 ~ 2026-08-30）
--   ⚠️ **不是每词都有 6 种组合**：
--        5,118 词有 auto+legacy 齐全（6 行）
--          409 词**只有 auto**（3 行）
--          362 词**只有 legacy**（3 行）
--     前端按 2×3 矩阵渲染时必须容忍整行缺失，不能假设 6 格全满。
--   ⚠️ **auto 与 legacy 有 13% 完全同值**：5,117 个可配对的 exact 组合里
--        673 对 acos/cpa 数值逐位相同。这是源数据特征不是 ETL bug
--        （原站页面说明第 3 条：「仅降低和固定模式的建议竞价差别非常小，
--        所以我们将仅降低和固定合并」—— 同源的合并逻辑）。
-- =====================================================================

-- 1.1 改名。Doris 的 ALTER TABLE ... RENAME 只改元数据，不搬数据，秒级完成。
ALTER TABLE looom.fact_keyword_bid_estimate
  RENAME fact_keyword_acos_estimate_v1;

-- 1.2 建拆维后的新表
CREATE TABLE IF NOT EXISTS looom.fact_keyword_acos_estimate (
  keyword       VARCHAR(128)   NOT NULL COMMENT '关键词原文（主键）。ETL 需 btrim(lower()) 归一',
  country       VARCHAR(8)     NOT NULL COMMENT '站点。⚠️ 必须进主键：keyword_id 跨站点不唯一',
  stat_week     DATE           NOT NULL COMMENT 'ABA 周起始日（周日）。源 data.weekDate，实测 6 个值 2026-07-26~2026-08-30',
  match_type    VARCHAR(16)    NOT NULL COMMENT '匹配方式：broad=广泛 / phrase=词组 / exact=精准。由源键名 *ForSales_<x> 拆出',
  bid_strategy  VARCHAR(16)    NOT NULL COMMENT '投放策略：auto=自动投放 / legacy=手动投放。由源键名前缀拆出。⚠️ 实测 13% 的词两者同值（源侧合并所致，非 ETL 问题）',
  keyword_id    BIGINT         NULL     COMMENT '原站关键词 ID（普通列，仅供对账）',
  acos_start    DOUBLE         NULL     COMMENT 'ACOS 悲观档（三档中值最大）。实测 33,019 行满档，0.0847~1433.13',
  acos_median   DOUBLE         NULL     COMMENT 'ACOS 中位档。实测 0.0154~232.07',
  acos_end      DOUBLE         NULL     COMMENT 'ACOS 乐观档（三档中值最小）。实测 0.0003~76.25。⚠️ 100% 满足 start>median>end，按区间端点渲染会画反',
  cpa_start     DECIMAL(12,4)  NULL     COMMENT 'CPA 悲观档。实测 0.4541~5145.45',
  cpa_median    DECIMAL(12,4)  NULL     COMMENT 'CPA 中位档。实测 0.5838~5718.18',
  cpa_end       DECIMAL(12,4)  NULL     COMMENT 'CPA 乐观档。实测 0.7136~6290.91。⚠️ CPA 方向与 ACOS 相反，是递增的',
  created_at    DATETIME       NOT NULL COMMENT '入库时间',
  INDEX idx_acos_kw (keyword) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(keyword, country, stat_week, match_type, bid_strategy)
COMMENT 'ACOS/CPA 三档预估（关键词×周×匹配×策略）。源 web-keyword-conversion。ACOS 递减、CPA 递增，非区间端点。原名 fact_keyword_bid_estimate（该名现留给真正的建议竞价表）'
DISTRIBUTED BY HASH(keyword) BUCKETS 4
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 1.3 迁移数据并拆列
INSERT INTO looom.fact_keyword_acos_estimate
  (keyword, country, stat_week, match_type, bid_strategy, keyword_id,
   acos_start, acos_median, acos_end, cpa_start, cpa_median, cpa_end, created_at)
SELECT keyword, country, stat_week,
       SPLIT_PART(match_type, '_', 2)                            AS match_type,
       IF(match_type LIKE 'auto%', 'auto', 'legacy')             AS bid_strategy,
       keyword_id, acos_start, acos_median, acos_end,
       cpa_start, cpa_median, cpa_end, created_at
FROM looom.fact_keyword_acos_estimate_v1;

-- 1.4 旧表保留待人工确认后再删。
--   确认方式：SELECT COUNT(*) 两表应同为 33,019；
--   且 SELECT COUNT(DISTINCT CONCAT(match_type,bid_strategy)) = 6。
-- DROP TABLE looom.fact_keyword_acos_estimate_v1;   ← 核对无误后手动执行


-- =====================================================================
-- 2. metric_snapshot 补 video_asin_num
--
-- 审计 §3 实测 /amount「流量位竞品数量」页有「SBV产品数」列（实测值 17），
-- 源字段 videoAsinNum 在 web-compete-keyword 响应里存在，但 schema-06
-- 建了 7 个 *AsinNum 列时漏掉了它。
--
-- ⚠️ 源字段拼写是 videoAsinNum（正确拼写），但同一响应的
--   /compete 页份额字段是 vedioAdScoreRatio（video 拼错成 vedio）。
--   ETL 里两处都要照抄源侧拼写，不要「修正」，见 §4 的注释。
-- =====================================================================
ALTER TABLE looom.fact_keyword_metric_snapshot
  ADD COLUMN video_asin_num INT NULL
  COMMENT 'SBV（品牌视频广告）位竞品数。源 videoAsinNum，页面列名「SBV产品数」，实测样例 17。ETL 补灌后再回填值域';


-- =====================================================================
-- 3. 修正 schema-06 的 COMMENT —— 4 处与 Doris 实测不符
--
-- 根因：schema-06 的注释写的是**源 JSON 里的填充率与值域**（200 条响应采样），
-- 但注释挂在 Doris 列上，读者会理解成**表里的填充率**。两者差 70 倍：
--   源侧 nfAsinNum 100% 填充 ≠ 表里 100% 填充
--   表里只有 318/22,320 = 1.4% 有值，因为 web-compete-keyword 只覆盖 789 词，
--   与 metric 表 22,320 行的词级交集是 318（ETL 脚本 run_compete 的说明）。
--
-- 修正原则：填充率一律写「落表实际」，值域一律写「Doris 实测」，
--   源侧采样值域如有参考价值则另注明。
-- =====================================================================

-- 3.1 七个竞品数列：填充率 100% → 318 行；值域按 Doris 实测
ALTER TABLE looom.fact_keyword_metric_snapshot
  MODIFY COLUMN nf_asin_num
  COMMENT '自然位竞品数。源 nfAsinNum。⚠️ 落表仅 318/22,320 行（1.4%）——compete 源只覆盖 789 词，与本表词级交集 318。实测 47~440';

ALTER TABLE looom.fact_keyword_metric_snapshot
  MODIFY COLUMN ppc_asin_num
  COMMENT '广告位竞品数（SP+SB+SBV 合计）。源 ppcAsinNum。落表 318 行，实测 21~365';

ALTER TABLE looom.fact_keyword_metric_snapshot
  MODIFY COLUMN sp_asin_num
  COMMENT 'SP 广告竞品数。源 spAsinNum。落表 318 行，实测 0~179';

ALTER TABLE looom.fact_keyword_metric_snapshot
  MODIFY COLUMN sp_recommended_asin_num
  COMMENT 'SP 推荐位竞品数。源 spRecommendedAsinNum。落表 318 行，实测 0~284';

ALTER TABLE looom.fact_keyword_metric_snapshot
  MODIFY COLUMN recommended_asin_num
  COMMENT '推荐位竞品数。源 recommendedAsinNum。落表 318 行，实测 0~145';

ALTER TABLE looom.fact_keyword_metric_snapshot
  MODIFY COLUMN brand_asin_num
  COMMENT 'SB（品牌）位竞品数。源 brandAsinNum。落表 318 行，实测 0~179';

-- ⚠️ AC 位保留（2026-09-21 用户确认）。值恒 0 不代表字段无意义 ——
--   AC（Amazon Choice）本身是稀缺标，样本里没有带 AC 标的词属正常，
--   换品类/换周可能出现非 0。前端渲染时该列要能显示 0 而非空白。
ALTER TABLE looom.fact_keyword_metric_snapshot
  MODIFY COLUMN ac_asin_num
  COMMENT 'AC（Amazon Choice）位竞品数。源 acAsinNum。落表 318 行但**实测 318 行全为 0**（AC 是稀缺标，当前样本无 AC 词）。保留该列：换品类/周后可能出现非 0，前端需区分「0」与「无数据」';

-- 3.2 sale_num：语义错 + 值域错
--   schema-06 写「关键词带来的总销量」，但审计 §3 实测页面列名是
--   「在售产品数」279,877（该词下的在售商品数量，不是销量）。
ALTER TABLE looom.fact_keyword_metric_snapshot
  MODIFY COLUMN sale_num
  COMMENT '⚠️ 语义是「在售产品数」（该关键词下的在售商品数量），**不是销量**——schema-06 原注释写错，审计 §3 已纠正。源 saleNum，落表 318 行，实测 80~298,323';

-- 3.3 两个份额列：填充率与值域
--   审计 §3 另澄清：这两列是「ABA Top3 集中度」，页面合并为一列显示
--   「点击 8.6% / 转化 3.9%」，不是我们原以为的「份额」。
ALTER TABLE looom.fact_keyword_metric_snapshot
  MODIFY COLUMN click_shared
  COMMENT 'ABA Top3 点击集中度（非「份额」，审计 §3 纠正）。源 clickShared，落表 264/22,320 行，实测 0~0.5472。页面与 conversion_shared 合并显示为「点击 x% / 转化 y%」';

ALTER TABLE looom.fact_keyword_metric_snapshot
  MODIFY COLUMN conversion_shared
  COMMENT 'ABA Top3 转化集中度（非「份额」）。源 conversionShared，落表 264 行，实测 0~0.75';

-- 3.4 conversion_funnel 的 max/min_kw_price：待确认项已解答
--   schema-06:150 写「这两列在 176 字段采样里没有出现，记入待确认」。
--   审计 §8c.4 已确认：就是 /conversion-rate 页「产品均价」列的 min/avg/max 三档
--   （页面实测 $5.37 / $18.38 / $59.99）。Doris 实测 5,875 行 100% 填充。
ALTER TABLE looom.fact_keyword_conversion_funnel
  MODIFY COLUMN min_kw_price
  COMMENT '该关键词下产品均价的最低档。页面「产品均价」列三档之一。落表 5,875 行（100%），实测最低 0.87';

ALTER TABLE looom.fact_keyword_conversion_funnel
  MODIFY COLUMN max_kw_price
  COMMENT '该关键词下产品均价的最高档。落表 5,875 行（100%），实测最高 35,690.36';

ALTER TABLE looom.fact_keyword_conversion_funnel
  MODIFY COLUMN click_purchase_ratio
  COMMENT '点击购买率（分母是点击数，区别于 search_purchase_ratio 的分母是搜索数）。源 clickPurchaseRatio，落表 5,875 行（100%），实测 0~0.3876';

-- 3.5 rel_keyword_top_asin 的 asin_role：补实测分布
ALTER TABLE looom.rel_keyword_top_asin
  MODIFY COLUMN asin_role
  COMMENT 'ASIN 角色：top=头部商品（源 topAsins[]）/ conv=有转化数据（源 asinsClickPurchaseRatio[]）。实测 top 46,451 行 + conv 10,344 行 = 56,795。⚠️ conv 行只有 430 行带 rank_position/title（主键不含 role，conv 覆盖同 ASIN 的 top 行时才继承）';


-- =====================================================================
-- 4. rel_keyword_asin_traffic_share（新建）—— /compete 流量位竞争格局
--
-- 审计 §0 判 3 + §2：我原以为这页是「关键词级的竞品数量统计」，
-- 实测是**「该关键词下的 ASIN 列表 × 各流量位份额」**——
-- 谁在占哪类流量位，默认按自然流量份额排序，单次返回 100 行（total 457）。
--
-- ## ⚠️ 源字段拼写照抄，不要「修正」
--
--   vedioAdScoreRatio   ← video 拼错成 vedio，SBV 广告流量份额
--   hasVaiants          ← variants 拼错，是否有变体
-- 改拼写会让 ETL 取不到值。列名用正确拼写、注释里记源侧拼写，两边都不丢。
--
-- ## 8 个份额字段与页面 6 列的对应
--
-- 页面表头只有 6 个流量位列（自然/SP常规/SP推荐/SB常规/SBV/AC推荐），
-- 但响应里有 8 个 *ScoreRatio。多出的 erScoreRatio / trScoreRatio
-- 在 /amount 页的对应字段（erAsinNum/trAsinNum）实测 0% 填充，
-- 这里一并建列但标注存疑，等真实 ETL 跑过再决定去留。
--
-- ## 数据源就绪度：⚠️ 待探
--
-- 源 endpoint 是 POST /api/search/competePattern。ROADMAP §0「开工前探源待办」
-- 要求先跑 PG SQL 确认 sif_api_log 里有无该 ep 的日志：
--     SELECT endpoint, COUNT(*), SUM(ok::int) FROM sif_api_log
--      WHERE endpoint LIKE '%compete%' GROUP BY 1;
-- 有 → 真实 ETL；无 → seed。表结构按真实响应建，两种情况都不用改。
-- =====================================================================
CREATE TABLE IF NOT EXISTS looom.rel_keyword_asin_traffic_share (
  keyword           VARCHAR(128)  NOT NULL COMMENT '关键词原文（主键）。ETL 需 btrim(lower()) 归一',
  country           VARCHAR(8)    NOT NULL COMMENT '站点。⚠️ 必须进主键',
  asin              VARCHAR(16)   NOT NULL COMMENT '占位的竞品 ASIN',
  rank_position     INT           NULL     COMMENT '在该词结果里的序号（页面「#」列）。默认按 nf_score_ratio 降序',
  title             VARCHAR(512)  NULL     COMMENT '商品标题。源 title',
  img               VARCHAR(512)  NULL     COMMENT '主图 URL。源 img',
  price             DECIMAL(12,2) NULL     COMMENT '价格。源 price',
  rating_num        INT           NULL     COMMENT '评论数。源 ratingNum',
  star              DECIMAL(3,1)  NULL     COMMENT '评分。源 star',
  score             DOUBLE        NULL     COMMENT '综合流量分。源 score',
  bought_in_past_month VARCHAR(32) NULL    COMMENT '⚠️ 月销量是**分档字符串**如「6,000+」，不是数值。源 boughtInPastMonth，照原样存，前端不要当数字算',
  nf_score_ratio    DOUBLE        NULL     COMMENT '自然流量份额。源 nfScoreRatio。页面「自然流量」列，默认排序键',
  sp_score_ratio    DOUBLE        NULL     COMMENT 'SP(常规)流量份额。源 spScoreRatio',
  sp_rec_score_ratio DOUBLE       NULL     COMMENT 'SP(推荐)流量份额。源 spRecScoreRatio',
  brand_ad_score_ratio DOUBLE     NULL     COMMENT 'SB(常规)流量份额。源 brandAdScoreRatio',
  video_ad_score_ratio DOUBLE     NULL     COMMENT 'SBV 流量份额。⚠️ 源字段拼写是 vedioAdScoreRatio（video 误拼 vedio），ETL 取值时照抄源侧拼写',
  ac_score_ratio    DOUBLE        NULL     COMMENT 'AC 推荐流量份额。源 acScoreRatio',
  er_score_ratio    DOUBLE        NULL     COMMENT '⚠️ 源 erScoreRatio，用途未确认。/amount 页的同族字段 erAsinNum 实测 0% 填充，本列存疑，真实 ETL 后再决定去留',
  tr_score_ratio    DOUBLE        NULL     COMMENT '⚠️ 源 trScoreRatio，同 er_score_ratio 存疑',
  has_variants      BOOLEAN       NULL     COMMENT '是否有变体。⚠️ 源字段拼写是 hasVaiants（variants 误拼）',
  is_focus          BOOLEAN       NULL     COMMENT '是否已收藏（源 isFocus）。⚠️ 这是**原站的用户态**，Loom 应从自己的产品库判断，ETL 不要灌这列',
  ac                VARCHAR(64)   NULL     COMMENT 'AC 标类型。源 ac',
  stat_date         DATE          NULL     COMMENT '⚠️ 普通列不进主键：源响应无周维度（同 metric 表的竞品数量列），只能记抓取日。语义是「最近一次抓取的竞争格局」，不是「某周的」',
  source            VARCHAR(32)   NULL     COMMENT '数据来源：real=competePattern 真实数据 / seed=生成器造。前端据此决定是否显示「模拟数据」标记',
  created_at        DATETIME      NOT NULL COMMENT '入库时间',
  INDEX idx_tshare_kw (keyword) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(keyword, country, asin)
COMMENT '关键词 × ASIN × 流量位份额（/compete 流量位竞争格局）。源 competePattern。默认按 nf_score_ratio 降序。⚠️ 无周维度，份额是最近一次抓取的快照'
DISTRIBUTED BY HASH(keyword) BUCKETS 8
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");


-- =====================================================================
-- 5. fact_keyword_bid_estimate（重建）—— 真正的「建议竞价」
--
-- 名字从 §1 腾出来了。这才是 /cpc-browsetree「查关键词竞价」的数据模型。
--
-- ## 原站页面的四条说明（直接决定了表结构）
--
--   1. 建议竞价与产品无关，**与品类强相关**，与产品权重无关
--   2. 大小取决于该品类的产品数量与对每个产品的预期广告成本
--   3. SP 竞价策略里「仅降低」和「固定」差别极小，原站**合并为「仅降低/固定」**
--   4. 以周 ABA 为数据源，**每月更新一次**
--
-- 第 1 条否定了 schema-06 的设计——类目是核心维度，不能没有。
-- 第 4 条决定主键用 stat_month 而非 stat_week。
--
-- ## 真实嵌套结构（源 POST /api/search/cpc/category，四层）
--
--   data.keywords[]                        16 个词
--     categorys[]                          每词 4~14 个类目，均值 10.3
--       matchTypes
--         phrase / exact / broad           3 种匹配
--           auto / legacy                  2 种策略
--             { start, median, end }       3 档
--   → 每词每类目 18 个竞价值（3×2×3）
--
-- ## ⚠️ 本表无真实数据源，走 seed
--
-- 源 endpoint search/cpc/category **不在爬虫已覆盖的 41 个 endpoint 里**，
-- 本期按 goal.md:26 的 seed 原则：表结构按真实响应建，数据用生成器造，
-- 真实源到位后只换 ETL，不改表不改前端。
--
-- ## 与 fact_keyword_acos_estimate 的区别（别搞混）
--
--   | | acos_estimate | bid_estimate（本表） |
--   |---|---|---|
--   | 指标 | ACOS / CPA | 建议竞价（$） |
--   | 类目维 | 无 | **有**（核心维度） |
--   | 时间粒度 | 周（ABA weekDate） | **月** |
--   | 三档方向 | ACOS 递减、CPA 递增 | **递增**（0.37→0.49→0.61） |
--   | 数据 | 真实 33,019 行 | seed |
-- =====================================================================
CREATE TABLE IF NOT EXISTS looom.fact_keyword_bid_estimate (
  keyword       VARCHAR(128)   NOT NULL COMMENT '关键词原文（主键）。ETL 需 btrim(lower()) 归一',
  country       VARCHAR(8)     NOT NULL COMMENT '站点。⚠️ 必须进主键',
  category_id   VARCHAR(32)    NOT NULL COMMENT '类目 ID（主键）。源 categorys[].categoryId。⚠️ 竞价与品类强相关，无类目维则数据无意义（页面说明第 1 条）',
  match_type    VARCHAR(16)    NOT NULL COMMENT '匹配方式：broad / phrase / exact。源 matchTypes 的键名',
  bid_strategy  VARCHAR(16)    NOT NULL COMMENT '投放策略：auto / legacy。⚠️ 原站已把「仅降低」与「固定」合并为一档（页面说明第 3 条），所以只有 2 个值',
  stat_month    VARCHAR(7)     NOT NULL COMMENT '统计月 YYYY-MM（主键）。⚠️ 用月不用周：源以周 ABA 为输入但**每月只更新一次**（页面说明第 4 条）',
  category_name VARCHAR(255)   NULL     COMMENT '类目名。源 categoryName',
  category_href VARCHAR(512)   NULL     COMMENT '类目链接。源 categoryHref',
  category_sale_num BIGINT     NULL     COMMENT '该类目在售产品数。源 categorys[].saleNum。竞价大小与之相关（页面说明第 2 条）',
  bid_start     DECIMAL(12,4)  NULL     COMMENT '建议竞价低档（$）。⚠️ 三档**递增**（实测样例 0.37→0.49→0.61），与 ACOS 的递减方向相反',
  bid_median    DECIMAL(12,4)  NULL     COMMENT '建议竞价中档（$）',
  bid_end       DECIMAL(12,4)  NULL     COMMENT '建议竞价高档（$）',
  source        VARCHAR(32)    NULL     COMMENT '数据来源：seed=生成器造（本期全部）/ real=cpc/category 真实数据。⚠️ 前端必须据此显示「模拟数据」标记',
  created_at    DATETIME       NOT NULL COMMENT '入库时间',
  INDEX idx_bid2_kw (keyword) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(keyword, country, category_id, match_type, bid_strategy, stat_month)
COMMENT '关键词建议竞价（关键词×类目×匹配×策略×月）。源 cpc/category，本期无真实数据走 seed。三档递增。与 fact_keyword_acos_estimate 是两个不同指标'
DISTRIBUTED BY HASH(keyword) BUCKETS 8
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");


-- =====================================================================
-- 6. dict_traffic_channel 补 rec（推荐位）
--
-- 来源：DORIS_SCHEMA_GAP_ANALYSIS.md §2.3 —— /compare-structure 对比流量结构页
-- 的 10 类流量位计数里 rec（推荐位）实测 142 非零，但字典里只有 spRec
-- （SP 推荐），没有独立的 rec。
--
-- 实查确认字典现有 12 行（ac/ad/allSb/allSp/bs/deal/nf/sb/sbv/sp/spRec/total），
-- 确实缺 rec。sort_order 取 7 会与 allSb 撞，故插在 spRec(6) 之后用 6.5 不可行
-- （INT 列），改排到末尾 13 —— 排序仅影响前端图例顺序，不影响语义。
-- =====================================================================
INSERT INTO looom.dict_traffic_channel (code, name_cn, name_en, sort_order, extra)
VALUES ('rec', '推荐位流量', 'recommend', 13, '#8C6FE6');


-- =====================================================================
-- 7. user_favorites 重建主键
--
-- 来源：DORIS_SCHEMA_GAP_ANALYSIS.md §2.4。
-- 现主键是 UNIQUE KEY(id)（雪花 ID），唯一性靠应用层保证 ——
-- COMMENT 里自己写了「应用层保证 (user_id,favorite_type,target_type,
-- target_value,country) 唯一」。M15 关注体系 + M14 每日排名订阅都会高频写这张表，
-- 靠应用层去重会在并发下漏。
--
-- ✅ 实查确认表是**空的（0 行）**，现在改零成本，等有数据再改就要迁移。
--
-- ⚠️ Doris 不能直接改 UNIQUE KEY，只能建新表 + 改名。因为表是空的，
--    不需要 INSERT SELECT 迁数据。
-- =====================================================================
ALTER TABLE looom.user_favorites RENAME user_favorites_old_pk;

CREATE TABLE IF NOT EXISTS looom.user_favorites (
  user_id       BIGINT       NOT NULL COMMENT '用户 ID（主键）',
  favorite_type VARCHAR(16)  NOT NULL COMMENT 'focus 关注 / monitor 监控 / subscribe 订阅（主键）',
  target_type   VARCHAR(16)  NOT NULL COMMENT 'asin / keyword（主键）',
  target_value  VARCHAR(255) NOT NULL COMMENT 'ASIN 或关键词文本（主键）。关键词需 btrim(lower()) 归一',
  country       VARCHAR(8)   NOT NULL COMMENT '站点（主键）',
  id            BIGINT       NULL     COMMENT '雪花 ID。⚠️ 降为普通列：原先是唯一键，但业务唯一性是那 5 个字段',
  keyword_id    BIGINT       NULL     COMMENT '关键词时填，关联 dim_keyword。仅供对账，不做关联键',
  library_id    BIGINT       NULL     COMMENT '归属库 ID，关联 user_library.id（M15a 建）。替代 group_name 的弱字符串关联 —— 改库名不必改这里每一行',
  group_name    VARCHAR(64)  NULL     COMMENT '⚠️ 旧的字符串分组，M15a 上线后把值迁成 library_id 即废弃。新代码不要写这列',
  note          VARCHAR(512) NULL     COMMENT '备注',
  notify_enabled TINYINT     NULL DEFAULT "0" COMMENT '仅 subscribe 用：排名变动是否通知',
  created_at    DATETIME     NOT NULL COMMENT '创建时间',
  INDEX idx_uf_user (user_id) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(user_id, favorite_type, target_type, target_value, country)
COMMENT '用户关注/监控/订阅。主键即业务唯一键（原先靠应用层保证，M14/M15 高频写会漏）。重复收藏靠 Unique Key 覆盖天然幂等'
DISTRIBUTED BY HASH(user_id) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 旧表是空的，确认后即可删：
-- DROP TABLE looom.user_favorites_old_pk;

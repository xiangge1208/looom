-- =====================================================================
-- M13 选词 / 关键词竞争分析（ROADMAP_UNBUILT_MODULES.md §M13）
--
-- 建表依据：docs/M13_PROBE_FINDINGS.md（2026-09-21 实测 200 条响应采样）
--   **不要按 ETL_GAP_ANALYSIS.md 的字段名建表** —— 那是早期采样，
--   本次探源发现的字段比它记的多（176 vs 文档里的十几个）。
--
-- 探源改变了计划的判定：原以为「查关键词竞价」无源（原站 /api/search/cpc/*
--   10 个接口全未爬），实测 web-keyword-conversion 一个 endpoint 里就带着
--   ACOS/CPA 六种投放类型的三档预估，填充率 91~92%。所以本模块 4 个页面
--   全部有真实数据源，只有「坑位」概念仍需 seed（那属于 M14）。
--
-- 幂等：全部 CREATE TABLE IF NOT EXISTS / ALTER TABLE ADD COLUMN（重复执行报
--   Duplicate 被 init-db.mjs 和 setup-doris.sh 按「跳过」处理）。
--
-- 关键词归一规则（ETL 侧必须执行）：keyword_norm = btrim(lower(keyword))
--   与 schema-04 保持一致。
-- =====================================================================

USE looom;

-- =====================================================================
-- 1. fact_keyword_metric_snapshot 加 7 列 —— 流量位竞品数量
--
-- 源：web-compete-keyword 的 data.keywords[].*AsinNum
-- 实测 8 个 *AsinNum 字段里 6 个有效、1 个恒 0、2 个全 NULL：
--   nfAsinNum 100% 47~440        ✅
--   ppcAsinNum 100% 16~365       ✅
--   spAsinNum 100% 0~179         ✅
--   spRecommendedAsinNum 100% 0~270 ✅
--   recommendedAsinNum 100% 0~145 ✅
--   brandAsinNum 100% 0~179      ✅
--   acAsinNum 100% 但恒 0        ⚠️ 建列观察，无区分度
--   erAsinNum / trAsinNum 0%     ❌ 不建
--
-- 为什么加在这张表而不新建：该表已是「关键词×周」粒度的度量快照
--   （22,320 行真实数据，granularity 恒 week），竞品数量是同粒度同主键的度量。
-- =====================================================================
ALTER TABLE looom.fact_keyword_metric_snapshot
  ADD COLUMN nf_asin_num INT NULL
  COMMENT '自然位竞品数。源 nfAsinNum，实测 100% 填充，47~440';

ALTER TABLE looom.fact_keyword_metric_snapshot
  ADD COLUMN ppc_asin_num INT NULL
  COMMENT '广告位竞品数（SP+SB+SBV 合计）。源 ppcAsinNum，实测 100%，16~365';

ALTER TABLE looom.fact_keyword_metric_snapshot
  ADD COLUMN sp_asin_num INT NULL
  COMMENT 'SP 广告竞品数。源 spAsinNum，实测 100%，0~179';

ALTER TABLE looom.fact_keyword_metric_snapshot
  ADD COLUMN sp_recommended_asin_num INT NULL
  COMMENT 'SP 推荐位竞品数。源 spRecommendedAsinNum，实测 100%，0~270';

ALTER TABLE looom.fact_keyword_metric_snapshot
  ADD COLUMN recommended_asin_num INT NULL
  COMMENT '推荐位竞品数。源 recommendedAsinNum，实测 100%，0~145';

ALTER TABLE looom.fact_keyword_metric_snapshot
  ADD COLUMN brand_asin_num INT NULL
  COMMENT '品牌位竞品数。源 brandAsinNum，实测 100%，0~179';

ALTER TABLE looom.fact_keyword_metric_snapshot
  ADD COLUMN ac_asin_num INT NULL
  COMMENT 'AC（Amazon Choice）位竞品数。⚠️ 源 acAsinNum 实测恒 0，无区分度，建列仅供观察';

-- 竞争格局页还需要这几个份额/销量列（源同上，当前表里没有）
ALTER TABLE looom.fact_keyword_metric_snapshot
  ADD COLUMN sale_num BIGINT NULL
  COMMENT '关键词带来的总销量。源 saleNum，实测 100%，0~424,204';

ALTER TABLE looom.fact_keyword_metric_snapshot
  ADD COLUMN click_shared DOUBLE NULL
  COMMENT '点击份额。源 clickShared，实测 81.3%，0~0.6396';

ALTER TABLE looom.fact_keyword_metric_snapshot
  ADD COLUMN conversion_shared DOUBLE NULL
  COMMENT '转化份额。源 conversionShared，实测 81.3%，0~0.75';


-- =====================================================================
-- 2. fact_keyword_bid_estimate（新建）—— ACOS / CPA 分档预估
--
-- 源：web-keyword-conversion 的 keywords[].acos.<type>[0].{start,median,end}
--     和 keywords[].cpa.<type>[0].{start,median,end}
--
-- 为什么不叫 fact_keyword_cpc_bid（计划里的名字）：实际数据不是「出价」
--   而是 ACOS 和 CPA 的预估区间，叫 bid_estimate 更准。
--
-- ⚠️ start/median/end 的语义（实测 start > median > end）：
--   这不是「区间下界到上界」，而是三档预估。以 autoForSales_broad 的 acos 为例：
--     start  0.0947 ~ 39.87   ← 值最大，悲观档
--     median 0.034  ~ 9.19    ← 中位档
--     end    0.0017 ~ 4.17    ← 值最小，乐观档
--   为与源字段名对齐仍用 start/median/end，含义写在 COMMENT 里。
--
-- 投放类型 6 种（match_type 列的取值）：
--   autoForSales_broad / autoForSales_phrase / autoForSales_exact
--   legacyForSales_broad / legacyForSales_phrase / legacyForSales_exact
--   auto=自动投放 legacy=手动投放；broad=广泛 phrase=词组 exact=精准
--
-- ⚠️ 每档的 categoryName / categoryid 实测 100% NULL，所以分档不区分类目，
--   本表不建类目列。
-- ⚠️ profitRate 的 6 个键实测全是空数组（len 0~0），无数据，不建列。
-- =====================================================================
CREATE TABLE IF NOT EXISTS looom.fact_keyword_bid_estimate (
  keyword       VARCHAR(128)   NOT NULL COMMENT '关键词原文（主键）。ETL 需 btrim(lower()) 归一',
  country       VARCHAR(8)     NOT NULL COMMENT '站点。⚠️ 必须进主键：keyword_id 跨站点不唯一',
  stat_week     DATE           NOT NULL COMMENT 'ABA 周起始日。源 data.weekDate，实测 100% 填充',
  match_type    VARCHAR(32)    NOT NULL COMMENT '投放类型：autoForSales_/legacyForSales_ × broad/phrase/exact 共 6 种',
  keyword_id    BIGINT         NULL     COMMENT '原站关键词 ID（普通列，仅供对账）',
  acos_start    DOUBLE         NULL     COMMENT 'ACOS 悲观档（值最大）。实测 91~92% 填充，0.0947~39.87',
  acos_median   DOUBLE         NULL     COMMENT 'ACOS 中位档。实测 0.034~9.19',
  acos_end      DOUBLE         NULL     COMMENT 'ACOS 乐观档（值最小）。实测 0.0017~4.17',
  cpa_start     DECIMAL(12,4)  NULL     COMMENT 'CPA 悲观档。实测 0.846~220.0',
  cpa_median    DECIMAL(12,4)  NULL     COMMENT 'CPA 中位档。实测 1.067~293.3',
  cpa_end       DECIMAL(12,4)  NULL     COMMENT 'CPA 乐观档。实测 1.333~366.7（故用 12,4 不用 10,2）',
  created_at    DATETIME       NOT NULL COMMENT '入库时间',
  INDEX idx_bid_kw (keyword) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(keyword, country, stat_week, match_type)
COMMENT '关键词 ACOS/CPA 分档预估。源 web-keyword-conversion。start/median/end 是悲观/中位/乐观三档，非区间端点'
DISTRIBUTED BY HASH(keyword) BUCKETS 4
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");


-- =====================================================================
-- 3. rel_keyword_top_asin 加 2 列 —— 区分头部 ASIN 与转化率 ASIN
--
-- 该表当时有 46,881 行真实数据（源 topAsins[]）。
-- ⚠️ 这是本文件执行**之前**的数。ETL 灌入 conv 角色行后，
--    Doris 实测 56,795 行（top 46,451 + conv 10,344）。见 schema-07 与 AUDIT §11.1。
-- 探源发现同一响应里还有 asinsClickPurchaseRatio[]（每词 0~3 个，100% 填充），
-- 语义是「有转化率数据的 ASIN」，与 topAsins 的「头部 ASIN」不同但字段重叠
-- （都含 asin/img/price）。合表 + role 列区分，避免建一张近乎重复的表。
-- =====================================================================
ALTER TABLE looom.rel_keyword_top_asin
  ADD COLUMN asin_role VARCHAR(8) NULL
  COMMENT 'ASIN 角色：top=头部商品（源 topAsins[]，每词 8~10 个）/ conv=有转化数据（源 asinsClickPurchaseRatio[]，每词 0~3 个）。历史行为 NULL，按 top 处理';

ALTER TABLE looom.rel_keyword_top_asin
  ADD COLUMN click_purchase_ratio DOUBLE NULL
  COMMENT '该 ASIN 在此关键词下的点击购买率。源 asinsClickPurchaseRatio[].clickPurchaseRatio，实测 0~1.3746。asin_role=top 的行为 NULL';


-- =====================================================================
-- 4. fact_keyword_conversion_funnel 加 1 列
--
-- 探源发现 clickPurchaseRatio（100% 填充，0~0.2877）未建列。
-- 注意它与已有的 search_purchase_ratio 不同：分母是点击数而非搜索数。
--
-- ⚠️ 该表已有的 max_kw_price / min_kw_price 两列在本次 176 字段采样里
--   **没有出现**。DDL 注释说实测 9.99~35,690.36，可能来自更大样本或别的
--   endpoint。已记入 M13_PROBE_FINDINGS.md §4 待确认，本次不动这两列。
-- =====================================================================
ALTER TABLE looom.fact_keyword_conversion_funnel
  ADD COLUMN click_purchase_ratio DOUBLE NULL
  COMMENT '点击购买率（分母是点击数，区别于 search_purchase_ratio 的分母是搜索数）。源 clickPurchaseRatio，实测 100%，0~0.2877';

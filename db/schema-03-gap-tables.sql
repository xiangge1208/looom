-- =====================================================================
-- Sif 后台复刻 —— 补缺表（Apache Doris）
--
-- 本文件补上 2026-09-20 JSON 深挖发现的三个 schema 缺口：
-- PG 侧有数据，但 schema-02-business.sql 的 43 张表里完全没有落点。
--
-- 依据：docs/MODULE_DATA_FLOW.md「PG 有数据但 Doris 无落点」一节
-- 所有字段的类型与宽度均按 PG 实测值域核定（见每张表的注释）
--
-- 幂等：全部 CREATE TABLE IF NOT EXISTS，可重复执行
-- =====================================================================

CREATE DATABASE IF NOT EXISTS looom;
USE looom;

-- =====================================================================
-- G1. 关键词 ABA 转化漏斗
--
-- 源：sif_api_log 的 web-keyword-conversion → data.keywords[]
-- 实测 9,038 个元素 / 5,746 个 distinct keyword
-- 11 个度量字段 100% 非空，conversionShared 79.9%
-- ⚠️ weekDate 实测 0%，不建列
-- =====================================================================

CREATE TABLE IF NOT EXISTS looom.fact_keyword_conversion_funnel (
  keyword_id             BIGINT         NOT NULL COMMENT '关键词 ID。⚠️ 源无 keywordId，需按 (country,keyword) 反查 dim_keyword',
  country                VARCHAR(8)     NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  stat_week              DATE           NOT NULL COMMENT 'ABA 周起始日。源 period，实测取值 2026-07-26~2026-08-30 共 6 个周期',
  keyword                VARCHAR(512)   COMMENT '关键词原文（冗余存，因 keyword_id 反查率低）。实测最大长度 66',
  search_volume          BIGINT         COMMENT '搜索量。实测 61 ~ 717,552',
  click_volume           BIGINT         COMMENT '点击量。实测 45 ~ 182,920',
  purchase_volume        BIGINT         COMMENT '购买量。实测 0 ~ 7,867',
  search_click_ratio     DOUBLE         COMMENT '搜索点击率。实测 0.0138 ~ 0.7979',
  search_purchase_ratio  DOUBLE         COMMENT '搜索购买率。实测 0.0 ~ 0.2838',
  click_shared           DOUBLE         COMMENT '点击份额。实测 0.0242 ~ 0.9194',
  conversion_shared      DOUBLE         COMMENT '转化份额。实测 0.0021 ~ 1.0，填充率 79.9%（唯一非 100% 的度量）',
  avg_kw_price           DECIMAL(12,2)  COMMENT '关键词平均价。实测 6.74 ~ 793.70',
  max_kw_price           DECIMAL(12,2)  COMMENT '关键词最高价。实测 9.99 ~ 35,690.36（故用 12,2 不用 10,2）',
  min_kw_price           DECIMAL(12,2)  COMMENT '关键词最低价。实测 0.87 ~ 59.90',
  source                 VARCHAR(16)    COMMENT '数据来源。实测恒为 mix，保留以防上游扩展',
  created_at             DATETIME       NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(keyword_id, country, stat_week)
COMMENT '关键词 ABA 转化漏斗。源 web-keyword-conversion，43 张原表无落点'
DISTRIBUTED BY HASH(keyword_id) BUCKETS 4
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- =====================================================================
-- G2. 关键词竞争格局快照
--
-- 源：sif_keyword_overview.raw（已结构化表，21,272 行）
-- ⚠️ 只建 6 个计数列 + 2 个总量列。实测 acAsinNum / erAsinNum / trAsinNum
--    全表恒为 0，demandRatio 全表恒 NULL，一律不建列
-- =====================================================================

CREATE TABLE IF NOT EXISTS looom.fact_keyword_competition_snapshot (
  keyword_id                BIGINT       NOT NULL COMMENT '关键词 ID。⚠️ 源表无此列，需反查 dim_keyword（实测命中率仅 15.14%）',
  country                   VARCHAR(8)   NOT NULL COMMENT '站点',
  stat_week                 DATE         NOT NULL COMMENT 'ABA 周起始日。源 aba_date，实测 2026-07-26~2026-09-06',
  stat_week_end             DATE         COMMENT 'ABA 周结束日。源 abaDateEnd，100% 填充（原 metric 表丢了这一列）',
  keyword                   VARCHAR(512) COMMENT '关键词原文（冗余）。实测最大长度 64',
  nf_asin_num               INT          COMMENT '自然位 ASIN 数。实测 max 573，非零率 52.5%',
  sp_ad_asin_num            INT          COMMENT 'SP 广告 ASIN 数。实测 max 205，非零率 51.6%',
  brand_ad_asin_num         INT          COMMENT '品牌广告 ASIN 数。实测 max 213，非零率 52.4%',
  ppc_ad_asin_num           INT          COMMENT 'PPC 广告 ASIN 数。实测 max 402，非零率 52.5%',
  search_recommend_asin_num INT          COMMENT '搜索推荐 ASIN 数。实测 max 180，非零率 51.9%',
  video_ad_asin_num         INT          COMMENT '视频广告 ASIN 数。实测 max 38。⚠️ 上游拼写为 vedioAdAsinNum',
  sale_num                  BIGINT       COMMENT '销量。实测 max 435,865，非零率 52.3%',
  global_keyword_num        BIGINT       COMMENT '全局关键词数。实测 max 1,000,000，填充率 100%',
  created_at                DATETIME     NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(keyword_id, country, stat_week)
COMMENT '关键词竞争格局快照。源 sif_keyword_overview.raw，43 张原表无落点'
DISTRIBUTED BY HASH(keyword_id) BUCKETS 4
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- =====================================================================
-- G3. 节假日日历维表
--
-- 源：sif_keyword_aba_trend.festivals（77,872 行非空 / 112,590+ 元素）
-- ⚠️ 这是小维表不是事实表：11 万个元素实测只表达 156 个
--    (节日, 站点, 起始日, 结束日) 组合，极度冗余，必须去重后存
-- ⚠️ 主键必须带 country：实测同一节日各站点窗口不同
--    例 Prime Day会员日 2026 年 JP 是 07-10~07-13，其余 6 站是 06-23~06-26
--       春季大促 2026 年 US 是 03-25~03-31，欧洲 5 站是 03-10~03-16
-- =====================================================================

CREATE TABLE IF NOT EXISTS looom.dim_festival (
  festival_name  VARCHAR(64)   NOT NULL COMMENT '节日名（中文）。实测 12 个闭合枚举，最大长度 12',
  country        VARCHAR(8)    NOT NULL COMMENT '站点。⚠️ 必须进主键，同节日各站窗口不同',
  start_date     DATE          NOT NULL COMMENT '节日窗口起始日',
  end_date       DATE          COMMENT '节日窗口结束日。实测 (name,country,start) 唯一确定 end，故不进主键',
  created_at     DATETIME      NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(festival_name, country, start_date)
COMMENT '节假日日历（12 节日 × 站点 × 年度窗口，实测 156 行）。源 sif_keyword_aba_trend.festivals'
DISTRIBUTED BY HASH(festival_name) BUCKETS 1
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

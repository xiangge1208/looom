-- =====================================================================
-- 方案 A 实施：关键词主键从 keyword_id 改为 (keyword, country)
--
-- 依据：docs/KEYWORD_ID_SCHEMA_PROPOSAL.md（用户 2026-09-20 裁决采纳方案 A）
--
-- 改动要点：
--   1. 18 张表的 UNIQUE KEY 里 keyword_id → keyword，并确保 country 在键内
--   2. keyword 统一 VARCHAR(128)（实测全库最大 128 字符，平均 23）
--   3. keyword_id 保留为普通 BIGINT NULL 列，供对账与日后升级用
--   4. 新增 keyword 的 INVERTED 索引，支持模糊搜索
--
-- 为什么能直接 DROP 重建：实测这 18 张表现有数据全部是种子数据
--   （ASIN 前缀 B0SEED），无生产数据。唯二例外是 2026-09-20 灌入真实数据的
--   fact_keyword_competition_snapshot(3,244) 与 fact_keyword_conversion_funnel(854)，
--   二者可由 scripts/ 下的 ETL 重灌，故一并重建。
--
-- 关键词归一规则（ETL 侧必须执行）：keyword_norm = btrim(lower(keyword))
--   实测三张源表当前均已小写且无首尾空格，此规则为防御性措施。
--
-- 幂等：DROP IF EXISTS + CREATE，可重复执行（会清空数据，由 ETL 重灌）
-- =====================================================================

USE looom;

-- =====================================================================
-- 1. dim_keyword —— 关键词主档
-- 原 UNIQUE KEY(keyword_id)，是跨站点冲突丢数据的根源
-- 实测反例：keyword_id=1120764 在 FR 是 pastille lave glace，在 US 是 halloween trays for food
-- =====================================================================
DROP TABLE IF EXISTS looom.dim_keyword;
CREATE TABLE looom.dim_keyword (
  keyword            VARCHAR(128)  NOT NULL COMMENT '关键词原文（主键，实测最大 128 字符）。ETL 需 btrim(lower()) 归一',
  country            VARCHAR(8)    NOT NULL COMMENT '站点。⚠️ 必须进主键：实测 keyword_id 跨站点不唯一',
  keyword_id         BIGINT        NULL     COMMENT '原站关键词 ID（降级为普通列）。实测仅 sif_asin_keyword 提供，覆盖率有限',
  translate_keyword  VARCHAR(512)  NULL     COMMENT '中文翻译（原站自带）',
  est_searches_num   BIGINT        NULL     COMMENT '预估搜索量',
  created_at         DATETIME      NOT NULL COMMENT '入库时间',
  updated_at         DATETIME      NULL     COMMENT '更新时间',
  INDEX idx_dim_kw_text (keyword) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(keyword, country)
COMMENT '关键词主档。主键 (keyword,country)——实测 keyword_id 跨站点不唯一，不可作单列主键'
DISTRIBUTED BY HASH(keyword) BUCKETS 4
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- =====================================================================
-- 2. fact_asin_keyword_snapshot —— ASIN×关键词 快照（反查流量词主表）
-- =====================================================================
DROP TABLE IF EXISTS looom.fact_asin_keyword_snapshot;
CREATE TABLE looom.fact_asin_keyword_snapshot (
  asin                 VARCHAR(16)   NOT NULL COMMENT 'ASIN 编号',
  country              VARCHAR(8)    NOT NULL COMMENT '站点',
  keyword              VARCHAR(128)  NOT NULL COMMENT '关键词原文（主键）',
  time_piece_type      VARCHAR(16)   NOT NULL COMMENT '时间粒度：month/week/day。⚠️ PG 源覆盖率仅 1.39%，ETL 需按抓取批次赋常量',
  time_piece_value     VARCHAR(32)   NOT NULL COMMENT 'month 格式 YYYY-MM；week 格式 YYYY-MM-DD_YYYY-MM-DD',
  is_listing_search    BOOLEAN       NOT NULL COMMENT 'Listing 维度还是单 ASIN 维度。⚠️ PG 源覆盖率仅 0.76%',
  keyword_id           BIGINT        NULL     COMMENT '原站关键词 ID（普通列）',
  is_core              BOOLEAN       NULL     COMMENT '是否核心词。⚠️ 实测源值 100% 为 false，无区分度',
  is_target            BOOLEAN       NULL     COMMENT '是否目标词。⚠️ 同上',
  piece_max_time       DATE          NULL     COMMENT '该时间片的数据截止日',
  nf_last_rank         INT           NULL     COMMENT '自然位最新排名',
  nf_last_rank_time    DATETIME      NULL     COMMENT '自然位排名时间。⚠️ 源是 epoch 毫秒，需转换',
  nf_last_rank_asin    VARCHAR(16)   NULL     COMMENT '自然位命中的变体 ASIN',
  sp_last_rank         INT           NULL     COMMENT 'SP 广告位最新排名',
  sp_last_rank_time    DATETIME      NULL     COMMENT 'SP 排名时间（epoch 毫秒转换）',
  sp_last_rank_asin    VARCHAR(16)   NULL     COMMENT 'SP 命中的变体 ASIN',
  sp_campaign_id       VARCHAR(64)   NULL     COMMENT '关联广告活动（跨域，应用层维护）',
  listing_score_ratio  DOUBLE        NULL     COMMENT '该词在整个 Listing 中的占比。⚠️ 实测无源',
  exposure_positions   VARCHAR(255)  NULL     COMMENT '曝光流量位，逗号分隔。⚠️ 源用 recSp，本库规范 spRec，ETL 需映射',
  est_searches_num     BIGINT        NULL     COMMENT '预估搜索量',
  created_at           DATETIME      NOT NULL COMMENT '入库时间',
  INDEX idx_fakst_kw (keyword) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(asin, country, keyword, time_piece_type, time_piece_value, is_listing_search)
COMMENT 'ASIN×关键词 流量与排名快照（反查流量词主表）'
DISTRIBUTED BY HASH(asin) BUCKETS 4
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- =====================================================================
-- 3. fact_asin_keyword_score —— ASIN×关键词×渠道 得分
-- ⚠️ channel 维度的源见 MODULE_DATA_FLOW.md 模块 5 的两处改判说明
-- =====================================================================
DROP TABLE IF EXISTS looom.fact_asin_keyword_score;
CREATE TABLE looom.fact_asin_keyword_score (
  asin                 VARCHAR(16)   NOT NULL COMMENT 'ASIN 编号',
  country              VARCHAR(8)    NOT NULL COMMENT '站点',
  keyword              VARCHAR(128)  NOT NULL COMMENT '关键词原文（主键）',
  time_piece_type      VARCHAR(16)   NOT NULL COMMENT '时间粒度',
  time_piece_value     VARCHAR(32)   NOT NULL COMMENT '时间片值',
  channel              VARCHAR(16)   NOT NULL COMMENT '渠道 code：nf/sp/spRec/sb/sbv 等，取值同 dict_traffic_channel',
  keyword_id           BIGINT        NULL     COMMENT '原站关键词 ID（普通列）',
  score                DOUBLE        NULL     COMMENT '流量得分',
  score_ratio          DOUBLE        NULL     COMMENT '占比，0-1 小数存储',
  score_change         DOUBLE        NULL     COMMENT '得分变化量',
  score_change_ratio   DOUBLE        NULL     COMMENT '得分变化率',
  contri_change_ratio  DOUBLE        NULL     COMMENT '贡献度变化率',
  created_at           DATETIME      NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(asin, country, keyword, time_piece_type, time_piece_value, channel)
COMMENT 'ASIN×关键词×渠道 流量得分长表'
DISTRIBUTED BY HASH(asin) BUCKETS 4
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- =====================================================================
-- 4. fact_asin_keyword_inout —— 前 3 页进出词
-- 源 sif_asin_traffic_change，kind: nf_in→in / nf_out→out（main 3,698 行本表不收）
-- =====================================================================
DROP TABLE IF EXISTS looom.fact_asin_keyword_inout;
CREATE TABLE looom.fact_asin_keyword_inout (
  asin         VARCHAR(16)   NOT NULL COMMENT 'ASIN 编号',
  country      VARCHAR(8)    NOT NULL COMMENT '站点',
  keyword      VARCHAR(128)  NOT NULL COMMENT '关键词原文（主键）',
  stat_date    DATE          NOT NULL COMMENT '统计日期（源列名 data_date）',
  change_type  VARCHAR(16)   NOT NULL COMMENT 'in=进入前3页 / out=跌出前3页。⚠️ 已进主键，防同日同词既 in 又 out 被覆盖',
  keyword_id   BIGINT        NULL     COMMENT '原站关键词 ID（普通列）',
  created_at   DATETIME      NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(asin, country, keyword, stat_date, change_type)
COMMENT 'ASIN 关键词进出前 3 页事件。change_type 已纳入主键（原设计遗漏，会静默覆盖）'
DISTRIBUTED BY HASH(asin) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- =====================================================================
-- 5. fact_keyword_metric_snapshot —— 关键词自身指标
-- 新增 stat_week_end（源 abaDateEnd 100% 填充，原设计丢失）
-- =====================================================================
DROP TABLE IF EXISTS looom.fact_keyword_metric_snapshot;
CREATE TABLE looom.fact_keyword_metric_snapshot (
  keyword               VARCHAR(128)   NOT NULL COMMENT '关键词原文（主键）',
  country               VARCHAR(8)     NOT NULL COMMENT '站点',
  granularity           VARCHAR(16)    NOT NULL COMMENT '粒度：week/month。⚠️ 实测无 day 粒度数据',
  stat_date             DATE           NOT NULL COMMENT '统计日期（周月粒度取区间起始日）',
  stat_date_end         DATE           NULL     COMMENT 'ABA 周结束日（源 abaDateEnd，100% 填充）',
  keyword_id            BIGINT         NULL     COMMENT '原站关键词 ID（普通列）',
  est_searches_num      BIGINT         NULL     COMMENT '预估搜索量',
  searches_rank         BIGINT         NULL     COMMENT 'ABA 搜索排名',
  cpc_bid               DECIMAL(12,2)  NULL     COMMENT '建议竞价。⚠️ 源 cpc 是 6 种投放组合的对象，需选投影',
  click_purchase_ratio  DOUBLE         NULL     COMMENT '点击转化率（源 clickPurchaseRatio）',
  created_at            DATETIME       NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(keyword, country, granularity, stat_date)
COMMENT '关键词自身指标快照（搜索量、CPC、点击转化率等，与 ASIN 无关）'
DISTRIBUTED BY HASH(keyword) BUCKETS 4
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- =====================================================================
-- 6. fact_keyword_search_trend —— 搜索量趋势
-- =====================================================================
DROP TABLE IF EXISTS looom.fact_keyword_search_trend;
CREATE TABLE looom.fact_keyword_search_trend (
  keyword         VARCHAR(128)  NOT NULL COMMENT '关键词原文（主键）',
  country         VARCHAR(8)    NOT NULL COMMENT '站点',
  granularity     VARCHAR(16)   NOT NULL COMMENT '粒度：week/month',
  stat_date       DATE          NOT NULL COMMENT '统计日期。⚠️ month 源格式 YYYY-MM 需补 -01',
  is_prev_period  BOOLEAN       NOT NULL COMMENT 'false=本期 true=上期对照（源 estSearchesNumHistoryPrev）',
  keyword_id      BIGINT        NULL     COMMENT '原站关键词 ID（普通列）',
  searches_num    BIGINT        NULL     COMMENT '搜索量。⚠️ ext_search_volume 与 keyword_search_vol 语义不同，勿混用',
  created_at      DATETIME      NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(keyword, country, granularity, stat_date, is_prev_period)
COMMENT '关键词搜索量趋势。is_prev_period 区分本期与上期（用于环比）'
DISTRIBUTED BY HASH(keyword) BUCKETS 4
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- =====================================================================
-- 7. fact_keyword_rank_history —— 排名历史
-- 三处按实测修正：rank_type 扩到 5 值、rank_position 改 DOUBLE、新增 slot/page_size 等列
-- 实测 sbRank/sbvRank 的 rank 100% 是小数，小数位编码版位（.1=top .5=middle .8=bottom .9=tail）
-- 用 INT 会静默截断，丢失 9,938 个元素的版位信息
-- =====================================================================
DROP TABLE IF EXISTS looom.fact_keyword_rank_history;
CREATE TABLE looom.fact_keyword_rank_history (
  asin              VARCHAR(16)   NOT NULL COMMENT 'ASIN 编号',
  country           VARCHAR(8)    NOT NULL COMMENT '站点',
  keyword           VARCHAR(128)  NOT NULL COMMENT '关键词原文（主键）',
  rank_type         VARCHAR(16)   NOT NULL COMMENT '排名类型：nf/sp/sb/sbv/recSp（原设计只有 nf/sp，漏 3 种）',
  stat_date         DATE          NOT NULL COMMENT '统计日期（按 allRankHistory.date[] 下标对齐）',
  keyword_id        BIGINT        NULL     COMMENT '原站关键词 ID（普通列）',
  rank_position     DOUBLE        NULL     COMMENT '全局排名。⚠️ 改 DOUBLE：sb/sbv 的 rank 100% 带小数编码版位',
  page_no           INT           NULL     COMMENT '页码，从 rankStr 的 ^p(\\d+) 解析。sb/sbv/recSp 无页码概念',
  page_size         INT           NULL     COMMENT '页容量，从 rankStr 的 /(\\d+)$ 解析。实测非固定 48（还有 16/49/47/46/40）',
  slot              VARCHAR(16)   NULL     COMMENT '版位：top/middle/bottom/tail。仅 sb/sbv 有，来自 rankStr 第 3 段',
  asin_order        INT           NULL     COMMENT '同位次内序号。实测 sb/sbv 100% 非空，nf/sp 100% NULL',
  campaign_id       VARCHAR(64)   NULL     COMMENT '广告活动 ID。实测 sp/sb/sbv 有值，nf 恒 NULL',
  mask_campaign_id  VARCHAR(16)   NULL     COMMENT '前台 4 位短码（源 maskCampaignId）',
  created_at        DATETIME      NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(asin, country, keyword, rank_type, stat_date)
COMMENT 'ASIN×关键词 排名历史（日粒度）。主源 sif_asin_keyword.raw->allRankHistory，92,824 个 nf 元素'
DISTRIBUTED BY HASH(asin) BUCKETS 4
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- =====================================================================
-- 8. fact_asin_multinf_keyword —— 多变体区间聚合
-- =====================================================================
DROP TABLE IF EXISTS looom.fact_asin_multinf_keyword;
CREATE TABLE looom.fact_asin_multinf_keyword (
  asin              VARCHAR(16)   NOT NULL COMMENT 'ASIN 编号',
  country           VARCHAR(8)    NOT NULL COMMENT '站点',
  keyword           VARCHAR(128)  NOT NULL COMMENT '关键词原文（主键）',
  time_piece_type   VARCHAR(16)   NOT NULL COMMENT '时间粒度',
  time_piece_value  VARCHAR(32)   NOT NULL COMMENT '时间片值',
  keyword_id        BIGINT        NULL     COMMENT '原站关键词 ID（普通列）。本表源 multiNfInfo 自带 ID，填充率高',
  avg_rank          DOUBLE        NULL     COMMENT '区间平均自然位排名。⚠️ 源无此字段，需 ETL 聚合自算',
  appear_days       INT           NULL     COMMENT '区间内出现天数。⚠️ 同上需自算',
  asin_cnt          INT           NULL     COMMENT '同时占位的变体数。⚠️ 同上需自算',
  created_at        DATETIME      NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(asin, country, keyword, time_piece_type, time_piece_value)
COMMENT 'ASIN×关键词 多变体区间聚合。源 asin-keyword-list.multiNfInfo'
DISTRIBUTED BY HASH(asin) BUCKETS 4
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- =====================================================================
-- 9. fact_asin_multinf_keyword_variant —— 关键词×变体 排名明细
-- 新增 4 列：源 asins[] 元素有 img/pageNum/pageRank/pageSize 本表原先无承接
-- =====================================================================
DROP TABLE IF EXISTS looom.fact_asin_multinf_keyword_variant;
CREATE TABLE looom.fact_asin_multinf_keyword_variant (
  parent_asin       VARCHAR(16)   NOT NULL COMMENT '父体/主查 ASIN',
  country           VARCHAR(8)    NOT NULL COMMENT '站点',
  keyword           VARCHAR(128)  NOT NULL COMMENT '关键词原文（主键）',
  variant_asin      VARCHAR(16)   NOT NULL COMMENT '变体 ASIN',
  time_piece_type   VARCHAR(16)   NOT NULL COMMENT '时间粒度',
  time_piece_value  VARCHAR(32)   NOT NULL COMMENT '时间片值',
  keyword_id        BIGINT        NULL     COMMENT '原站关键词 ID（普通列）',
  rank_position     INT           NULL     COMMENT '全局自然位排名（源 asins[].rank）',
  page_num          INT           NULL     COMMENT '页码（源 asins[].pageNum）。⚠️ 勿取上层 dateAsins[].pageNum，那层恒 NULL',
  page_rank         INT           NULL     COMMENT '页内位次（源 asins[].pageRank）',
  page_size         INT           NULL     COMMENT '页容量（源 asins[].pageSize）',
  img               VARCHAR(512)  NULL     COMMENT '变体主图（源 asins[].img）',
  variant_role      VARCHAR(16)   NULL     COMMENT '变体角色。⚠️ 实测无源，可按 rank 最小=主曝光变体推导',
  created_at        DATETIME      NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(parent_asin, country, keyword, variant_asin, time_piece_type, time_piece_value)
COMMENT '关键词×变体 自然排名明细。源 multiNfInfo.dateAsins[].asins[]，76,469 行明细'
DISTRIBUTED BY HASH(parent_asin) BUCKETS 4
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- =====================================================================
-- 10. fact_ad_search_term_exposure —— 搜索词曝光
-- ⚠️ 本表原先因 keyword_id 反查率仅 1.8% 而无法建。改文本键后主键可闭合
-- =====================================================================
DROP TABLE IF EXISTS looom.fact_ad_search_term_exposure;
CREATE TABLE looom.fact_ad_search_term_exposure (
  encrypt_ad_id        VARCHAR(64)   NOT NULL COMMENT '投放小组 ID',
  country              VARCHAR(8)    NOT NULL COMMENT '站点',
  keyword              VARCHAR(128)  NOT NULL COMMENT '买家搜索词原文（主键）。改文本键后不再受 1.8% 反查率限制',
  variant_asin         VARCHAR(16)   NOT NULL COMMENT '投放的变体 ASIN',
  stat_date            DATE          NOT NULL COMMENT '统计日期',
  keyword_id           BIGINT        NULL     COMMENT '原站关键词 ID（普通列）。⚠️ 源 web-variant-ad-keywords 不返回此字段',
  encrypt_campaign_id  VARCHAR(64)   NULL     COMMENT '所属广告活动（冗余便于聚合）',
  ad_type              TINYINT       NULL     COMMENT '广告类型 1=SP 2=SB 3=SBV 4=SBBV。⚠️ 实测无源',
  traffic_type         VARCHAR(16)   NULL     COMMENT '流量位类型：sp/spRec/sb/sbv',
  score                DOUBLE        NULL     COMMENT '流量得分',
  rank_position        INT           NULL     COMMENT '广告位排名',
  created_at           DATETIME      NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(encrypt_ad_id, country, keyword, variant_asin, stat_date)
COMMENT '搜索词曝光快照。⚠️ 存的是买家搜索词不是投放词。源成功率仅 11.8%，数据量小'
DISTRIBUTED BY HASH(encrypt_ad_id) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- =====================================================================
-- 11. rel_keyword_group —— 关键词分组（用户词库）
-- =====================================================================
DROP TABLE IF EXISTS looom.rel_keyword_group;
CREATE TABLE looom.rel_keyword_group (
  group_id    BIGINT        NOT NULL COMMENT '分组 ID',
  keyword     VARCHAR(128)  NOT NULL COMMENT '关键词原文（主键）',
  country     VARCHAR(8)    NOT NULL COMMENT '站点',
  keyword_id  BIGINT        NULL     COMMENT '原站关键词 ID（普通列）',
  created_at  DATETIME      NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(group_id, keyword, country)
COMMENT '关键词分组（用户词库）'
DISTRIBUTED BY HASH(group_id) BUCKETS 1
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- =====================================================================
-- 12. rel_keyword_top_asin —— 关键词头部 ASIN
-- 新增 img/title/price（源 topAsins[] 有 90,374 个元素带这三列，原先丢失）
-- =====================================================================
DROP TABLE IF EXISTS looom.rel_keyword_top_asin;
CREATE TABLE looom.rel_keyword_top_asin (
  keyword        VARCHAR(128)   NOT NULL COMMENT '关键词原文（主键）',
  country        VARCHAR(8)     NOT NULL COMMENT '站点',
  asin           VARCHAR(16)    NOT NULL COMMENT 'ASIN 编号',
  keyword_id     BIGINT         NULL     COMMENT '原站关键词 ID（普通列）',
  rank_position  INT            NULL     COMMENT '排名位置',
  img            VARCHAR(512)   NULL     COMMENT '商品主图（源 topAsins[].img，100% 非空）',
  title          VARCHAR(1024)  NULL     COMMENT '商品标题（源 topAsins[].title，100% 非空）',
  price          DECIMAL(12,2)  NULL     COMMENT '价格（源 topAsins[].price，99.99% 非空）',
  created_at     DATETIME       NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(keyword, country, asin)
COMMENT '关键词头部 ASIN。源 web-keyword-conversion.topAsins[]，90,374 个元素'
DISTRIBUTED BY HASH(keyword) BUCKETS 4
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- =====================================================================
-- 13. rel_rec_column_campaign_keyword —— 推荐专栏三层钻取
-- =====================================================================
DROP TABLE IF EXISTS looom.rel_rec_column_campaign_keyword;
CREATE TABLE looom.rel_rec_column_campaign_keyword (
  asin                 VARCHAR(16)   NOT NULL COMMENT 'ASIN 编号',
  country              VARCHAR(8)    NOT NULL COMMENT '站点',
  rec_title            VARCHAR(255)  NOT NULL COMMENT '推荐专栏英文原文',
  keyword              VARCHAR(128)  NOT NULL COMMENT '关键词原文（主键）',
  encrypt_campaign_id  VARCHAR(64)   NOT NULL COMMENT '广告活动 ID',
  keyword_id           BIGINT        NULL     COMMENT '原站关键词 ID（普通列）。本表源自带 ID，填充率 100%',
  mask_campaign_id     VARCHAR(16)   NULL     COMMENT '前台 4 位短码（源同元素的 maskCampaignId）',
  created_at           DATETIME      NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(asin, country, rec_title, keyword, encrypt_campaign_id)
COMMENT '推荐专栏→广告活动→关键词 三层钻取关系。源 recRanks[]，可落 1,002 行'
DISTRIBUTED BY HASH(asin) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- =====================================================================
-- 14. rel_asin_keyword_variant_exposure —— ASIN×关键词×变体 曝光
-- =====================================================================
DROP TABLE IF EXISTS looom.rel_asin_keyword_variant_exposure;
CREATE TABLE looom.rel_asin_keyword_variant_exposure (
  parent_asin       VARCHAR(16)   NOT NULL COMMENT '父体/主查 ASIN',
  variant_asin      VARCHAR(16)   NOT NULL COMMENT '变体 ASIN',
  keyword           VARCHAR(128)  NOT NULL COMMENT '关键词原文（主键）',
  country           VARCHAR(8)    NOT NULL COMMENT '站点',
  time_piece_type   VARCHAR(16)   NOT NULL COMMENT '时间粒度',
  time_piece_value  VARCHAR(32)   NOT NULL COMMENT '时间片值',
  keyword_id        BIGINT        NULL     COMMENT '原站关键词 ID（普通列）',
  score             DOUBLE        NULL     COMMENT '该变体在该词上的曝光得分',
  created_at        DATETIME      NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(parent_asin, variant_asin, keyword, country, time_piece_type, time_piece_value)
COMMENT 'ASIN×关键词×变体 曝光关系'
DISTRIBUTED BY HASH(parent_asin) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- =====================================================================
-- 15-16. 两张补缺表改造（2026-09-20 已灌真实数据，需重灌）
-- =====================================================================
DROP TABLE IF EXISTS looom.fact_keyword_competition_snapshot;
CREATE TABLE looom.fact_keyword_competition_snapshot (
  keyword                   VARCHAR(128) NOT NULL COMMENT '关键词原文（主键）',
  country                   VARCHAR(8)   NOT NULL COMMENT '站点',
  stat_week                 DATE         NOT NULL COMMENT 'ABA 周起始日（源 aba_date）',
  stat_week_end             DATE         NULL     COMMENT 'ABA 周结束日（源 abaDateEnd，100% 填充）',
  keyword_id                BIGINT       NULL     COMMENT '原站关键词 ID（普通列）',
  nf_asin_num               INT          NULL     COMMENT '自然位 ASIN 数。实测 max 573，非零率 52.5%',
  sp_ad_asin_num            INT          NULL     COMMENT 'SP 广告 ASIN 数。实测 max 205',
  brand_ad_asin_num         INT          NULL     COMMENT '品牌广告 ASIN 数。实测 max 213',
  ppc_ad_asin_num           INT          NULL     COMMENT 'PPC 广告 ASIN 数。实测 max 402',
  search_recommend_asin_num INT          NULL     COMMENT '搜索推荐 ASIN 数。实测 max 180',
  video_ad_asin_num         INT          NULL     COMMENT '视频广告 ASIN 数。实测 max 38（上游拼写 vedio）',
  sale_num                  BIGINT       NULL     COMMENT '销量。实测 max 435,865',
  global_keyword_num        BIGINT       NULL     COMMENT '全局关键词数。实测 max 1,000,000，填充 100%',
  created_at                DATETIME     NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(keyword, country, stat_week)
COMMENT '关键词竞争格局快照。改文本键后可灌 21,276 行（原 3,244 行 = 15.2%）'
DISTRIBUTED BY HASH(keyword) BUCKETS 4
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

DROP TABLE IF EXISTS looom.fact_keyword_conversion_funnel;
CREATE TABLE looom.fact_keyword_conversion_funnel (
  keyword                VARCHAR(128)   NOT NULL COMMENT '关键词原文（主键）。实测最大长度 66',
  country                VARCHAR(8)     NOT NULL COMMENT '站点',
  stat_week              DATE           NOT NULL COMMENT 'ABA 周起始日（源 period）',
  keyword_id             BIGINT         NULL     COMMENT '原站关键词 ID（普通列）。⚠️ 源 web-keyword-conversion 不返回此字段',
  search_volume          BIGINT         NULL     COMMENT '搜索量。实测 61 ~ 717,552',
  click_volume           BIGINT         NULL     COMMENT '点击量。实测 45 ~ 182,920',
  purchase_volume        BIGINT         NULL     COMMENT '购买量。实测 0 ~ 7,867',
  search_click_ratio     DOUBLE         NULL     COMMENT '搜索点击率。实测 0.0138 ~ 0.7979',
  search_purchase_ratio  DOUBLE         NULL     COMMENT '搜索购买率。实测 0.0 ~ 0.2838',
  click_shared           DOUBLE         NULL     COMMENT '点击份额。实测 0.0242 ~ 0.9194',
  conversion_shared      DOUBLE         NULL     COMMENT '转化份额。实测 0.0021 ~ 1.0，填充 79.9%',
  avg_kw_price           DECIMAL(12,2)  NULL     COMMENT '关键词平均价。实测 6.74 ~ 793.70',
  max_kw_price           DECIMAL(12,2)  NULL     COMMENT '关键词最高价。实测 max 35,690.36（故用 12,2）',
  min_kw_price           DECIMAL(12,2)  NULL     COMMENT '关键词最低价。实测 0.87 ~ 59.90',
  source                 VARCHAR(16)    NULL     COMMENT '数据来源。实测恒为 mix',
  created_at             DATETIME       NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(keyword, country, stat_week)
COMMENT '关键词 ABA 转化漏斗。改文本键后可灌 9,038 行（原 854 行 = 9.4%）'
DISTRIBUTED BY HASH(keyword) BUCKETS 4
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

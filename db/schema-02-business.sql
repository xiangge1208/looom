-- =====================================================================
-- Sif 后台复刻 —— 业务表（Apache Doris）
--
-- 本文件由 db/gen-business-schema.mjs 生成，请勿手工编辑。
-- 要改结构请改生成器，再重新生成，保证与数据字典一致。
--
-- 来源：docs/DATA_DICTIONARY.md B 节（已确认）
-- 实测依据：docs/raw/LIVE_PROBE.md
--
-- 用户已裁决的三项设计：
--   1. 时间粒度按原站（广告域 granularity 含 week，其余域 month，多变体 day）
--   2. 渠道用长表（channel 进主键），不用 45 列宽表
-- 3. 流量快照与运营事件拆两张表（粒度不同、稀疏稠密差异、覆盖 vs 追加语义不同）
--
-- 幂等：全部 CREATE TABLE IF NOT EXISTS，可重复执行
-- =====================================================================

CREATE DATABASE IF NOT EXISTS looom;
USE looom;

-- =====================================================================
-- B1. 基础实体表（dim_）
-- =====================================================================

-- ASIN 商品主档（4 个域共用）
CREATE TABLE IF NOT EXISTS looom.dim_asin (
  asin                 VARCHAR(16)    NOT NULL COMMENT 'ASIN 编号',
  country              VARCHAR(8)     NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  title                VARCHAR(1024)  COMMENT '商品标题',
  img                  VARCHAR(512)   COMMENT '主图地址（亚马逊 CDN）',
  price                DECIMAL(12,2)  COMMENT '价格',
  brand                VARCHAR(255)   COMMENT '品牌名',
  brand_href           VARCHAR(512)   COMMENT '品牌链接',
  score                DOUBLE         COMMENT '评分（真实值，如 4.8）',
  star                 DOUBLE         COMMENT '半星展示值。实测 star = round(score*2)/2，100% 成立',
  rating_num           BIGINT         COMMENT '评价数',
  is_best_seller       BOOLEAN        COMMENT '是否 BestSeller',
  is_parent_asin       BOOLEAN        COMMENT '是否父体。实测父体自身无销量数据',
  parent_asin          VARCHAR(16)    COMMENT '父体 ASIN（子体填）',
  first_available_day  DATE           COMMENT '上架日期',
  seller               VARCHAR(255)   COMMENT '卖家名',
  data_updated_at      DATETIME       COMMENT '数据更新时间（原站毫秒时间戳转换而来）',
  created_at           DATETIME       NOT NULL COMMENT '入库时间',
  updated_at           DATETIME       COMMENT '更新时间',
  INDEX idx_dim_asin_brand (brand) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(asin, country)
COMMENT 'ASIN 商品主档（4 个域共用）'
DISTRIBUTED BY HASH(asin) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 关键词主档。实测 keywordId 全局唯一（US/UK/DE 三站 ID 段不重叠），故主键不带 country
CREATE TABLE IF NOT EXISTS looom.dim_keyword (
  keyword_id         BIGINT        NOT NULL COMMENT '关键词 ID（实测全局唯一）',
  keyword            VARCHAR(512)  NOT NULL COMMENT '关键词原文',
  translate_keyword  VARCHAR(512)  COMMENT '中文翻译（原站自带）',
  country            VARCHAR(8)    COMMENT '所属站点（非主键，仅作标记筛选用）',
  est_searches_num   BIGINT        COMMENT '预估搜索量',
  created_at         DATETIME      NOT NULL COMMENT '入库时间',
  updated_at         DATETIME      COMMENT '更新时间',
  INDEX idx_dim_kw_text (keyword) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(keyword_id)
COMMENT '关键词主档。实测 keywordId 全局唯一（US/UK/DE 三站 ID 段不重叠），故主键不带 country'
DISTRIBUTED BY HASH(keyword_id) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 单词/词根主档。⚠️ 词频接口只返回 word 文本，无 ID 字段，只能用文本作键
CREATE TABLE IF NOT EXISTS looom.dim_word (
  word            VARCHAR(128)  NOT NULL COMMENT '单词/词根',
  country         VARCHAR(8)    NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  translate_word  VARCHAR(255)  COMMENT '中文翻译',
  created_at      DATETIME      NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(word, country)
COMMENT '单词/词根主档。⚠️ 词频接口只返回 word 文本，无 ID 字段，只能用文本作键'
DISTRIBUTED BY HASH(word) BUCKETS 1
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 变体属性。实测：父体 features 是维度名 ["Size","Color"]，子体是对应下标取值 ["Large","Dark Moss"]，入库需按下标 zip 对齐
CREATE TABLE IF NOT EXISTS looom.dim_asin_feature (
  asin           VARCHAR(16)   NOT NULL COMMENT 'ASIN 编号',
  country        VARCHAR(8)    NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  feature_name   VARCHAR(64)   NOT NULL COMMENT '属性维度名，如 Size / Color（来自父体 features）',
  feature_value  VARCHAR(255)  COMMENT '属性取值，如 Large / Dark Moss（来自子体 features 同下标）',
  created_at     DATETIME      NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(asin, country, feature_name)
COMMENT '变体属性。实测：父体 features 是维度名 ["Size","Color"]，子体是对应下标取值 ["Large","Dark Moss"]，入库需按下标 zip 对齐'
DISTRIBUTED BY HASH(asin) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 推荐专栏。实测裁定为动态实体而非固定枚举：前端硬编码仅 8 个短码但实测出 17 个标题且未收敛，新标题运行时 upsert 入库
CREATE TABLE IF NOT EXISTS looom.dim_recommend_column (
  rec_title        VARCHAR(255)  NOT NULL COMMENT '专栏英文原文（后端就用它做请求参数）',
  country          VARCHAR(8)    NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  short_code       VARCHAR(16)   COMMENT '前端硬编码短码：Media/4Star/fView/KOL/rBuy/Trend/New/tDeal/other',
  display_name_cn  VARCHAR(255)  COMMENT '中文展示名（原站无，需我们自造）',
  first_seen_at    DATETIME      COMMENT '首次观测到的时间',
  last_seen_at     DATETIME      COMMENT '最近观测到的时间'
) ENGINE=OLAP
UNIQUE KEY(rec_title, country)
COMMENT '推荐专栏。实测裁定为动态实体而非固定枚举：前端硬编码仅 8 个短码但实测出 17 个标题且未收敛，新标题运行时 upsert 入库'
DISTRIBUTED BY HASH(rec_title) BUCKETS 1
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 广告活动。⚠️ 三套 ID 并存：fake_campaign_id 前台 4 位短码 / encrypt_campaign_id 内部加密 / campaign_id_a0 用户录入的后台真实 ID
CREATE TABLE IF NOT EXISTS looom.dim_ad_campaign (
  encrypt_campaign_id  VARCHAR(64)   NOT NULL COMMENT 'Sif 内部加密活动 ID（主键）',
  country              VARCHAR(8)    NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  fake_campaign_id     VARCHAR(16)   COMMENT '前台短码，实测 4 位如 IW9V',
  ad_type              TINYINT       COMMENT '广告类型：1=SP 2=SB 3=SBV 4=SBBV',
  product_type         VARCHAR(32)   COMMENT '产品类型',
  strategy             VARCHAR(255)  COMMENT '投放策略。实测是后端算好的中文串，如「多广告组，多变体」',
  asin_num             INT           COMMENT '涉及 ASIN 数',
  ad_num               INT           COMMENT '投放小组数',
  campaign_created_at  DATE          COMMENT '活动创建日期',
  last_ad_created_at   DATE          COMMENT '最近新增投放小组日期',
  created_at           DATETIME      NOT NULL COMMENT '入库时间',
  updated_at           DATETIME      COMMENT '更新时间'
) ENGINE=OLAP
UNIQUE KEY(encrypt_campaign_id, country)
COMMENT '广告活动。⚠️ 三套 ID 并存：fake_campaign_id 前台 4 位短码 / encrypt_campaign_id 内部加密 / campaign_id_a0 用户录入的后台真实 ID'
DISTRIBUTED BY HASH(encrypt_campaign_id) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 投放小组(Product Ad)。⚠️ 不是 Amazon AdGroup —— 层级为 Campaign→AdGroup→ProductAd→变体→搜索词，而 AdGroup 层原站前端零字段故不建表
CREATE TABLE IF NOT EXISTS looom.dim_ad_product_ad (
  encrypt_ad_id  VARCHAR(64)  NOT NULL COMMENT 'Sif 内部加密投放小组 ID（主键）',
  country        VARCHAR(8)   NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  fake_ad_id     VARCHAR(16)  COMMENT '前台短码，实测 4 位如 FLDB',
  ad_created_at  DATE         COMMENT '投放小组创建日期',
  created_at     DATETIME     NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(encrypt_ad_id, country)
COMMENT '投放小组(Product Ad)。⚠️ 不是 Amazon AdGroup —— 层级为 Campaign→AdGroup→ProductAd→变体→搜索词，而 AdGroup 层原站前端零字段故不建表'
DISTRIBUTED BY HASH(encrypt_ad_id) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 供应商（1688 货源）。本期仅占位 UI + 表结构，不做任何采集/爬虫/对接
CREATE TABLE IF NOT EXISTS looom.dim_supplier (
  id             BIGINT         NOT NULL COMMENT '雪花 ID',
  supplier_name  VARCHAR(255)   COMMENT '供应商名称',
  offer_id       VARCHAR(64)    COMMENT '1688 货源 ID',
  title          VARCHAR(1024)  COMMENT '货源标题',
  img            VARCHAR(512)   COMMENT '主图',
  price          DECIMAL(12,2)  COMMENT '价格',
  min_order      INT            COMMENT '起订量',
  location       VARCHAR(128)   COMMENT '地区',
  created_at     DATETIME       NOT NULL COMMENT '入库时间',
  -- ⚠️ 没指定中文分词器，实测 MATCH_ANY '深圳' 返回 0 行（LIKE 可用）。
  -- 要用 MATCH_ANY 搜中文须加 PROPERTIES("parser" = "chinese") 重建索引。
  -- 详见 DATA_DICTIONARY C4-15。
  INDEX idx_supplier_name (supplier_name) USING INVERTED
) ENGINE=OLAP
UNIQUE KEY(id)
COMMENT '供应商（1688 货源）。本期仅占位 UI + 表结构，不做任何采集/爬虫/对接'
DISTRIBUTED BY HASH(id) BUCKETS 1
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");


-- =====================================================================
-- B2.1 时序快照 —— 月粒度（timePieceType=month）
-- =====================================================================

-- ASIN 月度销量。实测：序列固定 40 个月起点 2023-05；销量是字符串分档（"200+"/"<50"）故双列并存；父体无销量只存子体
CREATE TABLE IF NOT EXISTS looom.fact_asin_bought_monthly (
  asin                VARCHAR(16)  NOT NULL COMMENT 'ASIN 编号（只存子体，父体销量由应用层聚合）',
  country             VARCHAR(8)   NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  stat_month          VARCHAR(7)   NOT NULL COMMENT '统计月份 YYYY-MM',
  bought_lower_bound  BIGINT       COMMENT '分档下界整数，用于排序和计算',
  bought_label        VARCHAR(16)  COMMENT '原始分档串，用于展示。"<50" 无法用整数无损表达',
  created_at          DATETIME     NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(asin, country, stat_month)
COMMENT 'ASIN 月度销量。实测：序列固定 40 个月起点 2023-05；销量是字符串分档（"200+"/"<50"）故双列并存；父体无销量只存子体'
DISTRIBUTED BY HASH(asin) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- Listing 指标月度快照（价格、评分、评价数等随时间变化的指标）
CREATE TABLE IF NOT EXISTS looom.fact_asin_listing_snapshot (
  asin        VARCHAR(16)    NOT NULL COMMENT 'ASIN 编号',
  country     VARCHAR(8)     NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  stat_month  VARCHAR(7)     NOT NULL COMMENT '统计月份 YYYY-MM',
  price       DECIMAL(12,2)  COMMENT '当月价格',
  score       DOUBLE         COMMENT '当月评分',
  rating_num  BIGINT         COMMENT '当月评价数',
  bsr         BIGINT         COMMENT '当月 BSR 排名',
  created_at  DATETIME       NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(asin, country, stat_month)
COMMENT 'Listing 指标月度快照（价格、评分、评价数等随时间变化的指标）'
DISTRIBUTED BY HASH(asin) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- ASIN 分渠道流量（长表）。用户已裁决用长表：渠道是 9 个同构对象，宽表需 45 列且新增渠道要改表结构
CREATE TABLE IF NOT EXISTS looom.fact_asin_traffic_channel (
  asin                 VARCHAR(16)  NOT NULL COMMENT 'ASIN 编号',
  country              VARCHAR(8)   NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  time_piece_type      VARCHAR(16)  NOT NULL COMMENT '时间粒度：month 可用 / week 仅广告域可用',
  time_piece_value     VARCHAR(32)  NOT NULL COMMENT 'month 格式 YYYY-MM；week 格式 YYYY-MM-DD_YYYY-MM-DD',
  channel              VARCHAR(16)  NOT NULL COMMENT '渠道：total/nf/ad/allSp/sp/spRec/allSb/sb/sbv。⚠️ 响应里的 recSp 须归一为 spRec',
  score                DOUBLE       COMMENT '流量得分（实测为浮点，如 2859.33）',
  score_ratio          DOUBLE       COMMENT '占比，0-1 小数存储（前端负责乘 100 展示）',
  score_change         DOUBLE       COMMENT '得分变化量',
  score_change_ratio   DOUBLE       COMMENT '得分变化率，可为 NULL',
  contri_change_ratio  DOUBLE       COMMENT '贡献度变化率',
  created_at           DATETIME     NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(asin, country, time_piece_type, time_piece_value, channel)
COMMENT 'ASIN 分渠道流量（长表）。用户已裁决用长表：渠道是 9 个同构对象，宽表需 45 列且新增渠道要改表结构'
DISTRIBUTED BY HASH(asin) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- ASIN×关键词 流量与排名快照（反查流量词主表）
CREATE TABLE IF NOT EXISTS looom.fact_asin_keyword_snapshot (
  asin                 VARCHAR(16)   NOT NULL COMMENT 'ASIN 编号',
  country              VARCHAR(8)    NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  keyword_id           BIGINT        NOT NULL COMMENT '关键词 ID',
  time_piece_type      VARCHAR(16)   NOT NULL COMMENT '时间粒度：month 可用 / week 仅广告域可用',
  time_piece_value     VARCHAR(32)   NOT NULL COMMENT 'month 格式 YYYY-MM；week 格式 YYYY-MM-DD_YYYY-MM-DD',
  is_listing_search    BOOLEAN       NOT NULL COMMENT 'Listing 维度还是单 ASIN 维度',
  is_core              BOOLEAN       COMMENT '是否核心词',
  is_target            BOOLEAN       COMMENT '是否目标词',
  piece_max_time       DATE          COMMENT '该时间片的数据截止日',
  nf_last_rank         INT           COMMENT '自然位最新排名',
  nf_last_rank_time    DATETIME      COMMENT '自然位排名时间',
  nf_last_rank_asin    VARCHAR(16)   COMMENT '自然位命中的变体 ASIN',
  sp_last_rank         INT           COMMENT 'SP 广告位最新排名',
  sp_last_rank_time    DATETIME      COMMENT 'SP 排名时间',
  sp_last_rank_asin    VARCHAR(16)   COMMENT 'SP 命中的变体 ASIN',
  sp_campaign_id       VARCHAR(64)   COMMENT '关联广告活动（跨域外键，应用层维护）',
  listing_score_ratio  DOUBLE        COMMENT '该词在整个 Listing 中的占比',
  exposure_positions   VARCHAR(255)  COMMENT '曝光流量位，逗号分隔的渠道 code',
  est_searches_num     BIGINT        COMMENT '预估搜索量',
  created_at           DATETIME      NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(asin, country, keyword_id, time_piece_type, time_piece_value, is_listing_search)
COMMENT 'ASIN×关键词 流量与排名快照（反查流量词主表）'
DISTRIBUTED BY HASH(asin) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- ASIN×关键词×渠道 得分（长表）。对应响应里的 9 个 *ScoreInfo 嵌套对象
CREATE TABLE IF NOT EXISTS looom.fact_asin_keyword_score (
  asin                 VARCHAR(16)  NOT NULL COMMENT 'ASIN 编号',
  country              VARCHAR(8)   NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  keyword_id           BIGINT       NOT NULL COMMENT '关键词 ID',
  time_piece_type      VARCHAR(16)  NOT NULL COMMENT '时间粒度：month 可用 / week 仅广告域可用',
  time_piece_value     VARCHAR(32)  NOT NULL COMMENT 'month 格式 YYYY-MM；week 格式 YYYY-MM-DD_YYYY-MM-DD',
  channel              VARCHAR(16)  NOT NULL COMMENT '渠道 code，取值同 fact_asin_traffic_channel',
  score                DOUBLE       COMMENT '流量得分（实测为浮点，如 2859.33）',
  score_ratio          DOUBLE       COMMENT '占比，0-1 小数存储（前端负责乘 100 展示）',
  score_change         DOUBLE       COMMENT '得分变化量',
  score_change_ratio   DOUBLE       COMMENT '得分变化率，可为 NULL',
  contri_change_ratio  DOUBLE       COMMENT '贡献度变化率',
  created_at           DATETIME     NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(asin, country, keyword_id, time_piece_type, time_piece_value, channel)
COMMENT 'ASIN×关键词×渠道 得分（长表）。对应响应里的 9 个 *ScoreInfo 嵌套对象'
DISTRIBUTED BY HASH(asin) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- ASIN 关键词概览聚合（各渠道的关键词计数）
CREATE TABLE IF NOT EXISTS looom.fact_asin_keyword_overview (
  asin               VARCHAR(16)  NOT NULL COMMENT 'ASIN 编号',
  country            VARCHAR(8)   NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  time_piece_type    VARCHAR(16)  NOT NULL COMMENT '时间粒度：month 可用 / week 仅广告域可用',
  time_piece_value   VARCHAR(32)  NOT NULL COMMENT 'month 格式 YYYY-MM；week 格式 YYYY-MM-DD_YYYY-MM-DD',
  is_listing_search  BOOLEAN      NOT NULL COMMENT 'Listing 维度还是单 ASIN 维度',
  channel            VARCHAR(16)  NOT NULL COMMENT '渠道 code',
  keyword_cnt        BIGINT       COMMENT '该渠道的关键词数',
  created_at         DATETIME     NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(asin, country, time_piece_type, time_piece_value, is_listing_search, channel)
COMMENT 'ASIN 关键词概览聚合（各渠道的关键词计数）'
DISTRIBUTED BY HASH(asin) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 词频聚合。scope_type/scope_key 区分 ASIN 维度还是词库分组维度（两接口共用一张表）
CREATE TABLE IF NOT EXISTS looom.fact_word_frequency (
  scope_type        VARCHAR(16)   NOT NULL COMMENT '范围类型：asin / keyword_group',
  scope_key         VARCHAR(64)   NOT NULL COMMENT '范围键：ASIN 编号或分组 ID',
  country           VARCHAR(8)    NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  time_piece_type   VARCHAR(16)   NOT NULL COMMENT '时间粒度：month 可用 / week 仅广告域可用',
  time_piece_value  VARCHAR(32)   NOT NULL COMMENT 'month 格式 YYYY-MM；week 格式 YYYY-MM-DD_YYYY-MM-DD',
  word_model        VARCHAR(16)   NOT NULL COMMENT '词频模型：搜索量加权 / 出现次数',
  word              VARCHAR(128)  NOT NULL COMMENT '单词',
  frq               BIGINT        COMMENT '词频值',
  search_weight     DOUBLE        COMMENT '搜索量权重',
  created_at        DATETIME      NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(scope_type, scope_key, country, time_piece_type, time_piece_value, word_model, word)
COMMENT '词频聚合。scope_type/scope_key 区分 ASIN 维度还是词库分组维度（两接口共用一张表）'
DISTRIBUTED BY HASH(scope_type) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- ASIN×推荐专栏 曝光。⚠️ 混合粒度：实测传 month 但返回逐日 dates，且极度稀疏（31 天仅 1 天有值）→ 只存非 null 的天
CREATE TABLE IF NOT EXISTS looom.fact_asin_rec_column_period (
  asin          VARCHAR(16)   NOT NULL COMMENT 'ASIN 编号',
  country       VARCHAR(8)    NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  rec_title     VARCHAR(255)  NOT NULL COMMENT '推荐专栏英文原文',
  stat_date     DATE          NOT NULL COMMENT '统计日期（只存有值的天）',
  ratio         DOUBLE        COMMENT '流量贡献占比',
  campaign_cnt  INT           COMMENT '该专栏位的广告活动数',
  keyword_cnt   INT           COMMENT '该专栏位的关键词数',
  created_at    DATETIME      NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(asin, country, rec_title, stat_date)
COMMENT 'ASIN×推荐专栏 曝光。⚠️ 混合粒度：实测传 month 但返回逐日 dates，且极度稀疏（31 天仅 1 天有值）→ 只存非 null 的天'
DISTRIBUTED BY HASH(asin) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 搜索词曝光快照（广告域最细事实表）。⚠️ 存的是买家搜索词，不是投放词
CREATE TABLE IF NOT EXISTS looom.fact_ad_search_term_exposure (
  encrypt_ad_id        VARCHAR(64)  NOT NULL COMMENT '投放小组 ID',
  country              VARCHAR(8)   NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  keyword_id           BIGINT       NOT NULL COMMENT '搜索词 ID',
  variant_asin         VARCHAR(16)  NOT NULL COMMENT '投放的变体 ASIN',
  stat_date            DATE         NOT NULL COMMENT '统计日期（广告域用 granularity，按日/周落点）',
  encrypt_campaign_id  VARCHAR(64)  COMMENT '所属广告活动（冗余，便于聚合）',
  ad_type              TINYINT      COMMENT '广告类型 1=SP 2=SB 3=SBV 4=SBBV',
  traffic_type         VARCHAR(16)  COMMENT '流量位类型：sp/spRec/sb/sbv',
  score                DOUBLE       COMMENT '流量得分',
  rank_position        INT          COMMENT '广告位排名',
  created_at           DATETIME     NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(encrypt_ad_id, country, keyword_id, variant_asin, stat_date)
COMMENT '搜索词曝光快照（广告域最细事实表）。⚠️ 存的是买家搜索词，不是投放词'
DISTRIBUTED BY HASH(encrypt_ad_id) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");


-- =====================================================================
-- B2.2 时序快照 —— 日粒度
-- =====================================================================

-- 多变体自然位日快照。实测此接口无 timePiece 参数，直接返回逐日 dates 数组
CREATE TABLE IF NOT EXISTS looom.fact_asin_multinf_daily (
  asin              VARCHAR(16)  NOT NULL COMMENT 'ASIN 编号',
  country           VARCHAR(8)   NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  stat_date         DATE         NOT NULL COMMENT '统计日期',
  asin_cnt          INT          COMMENT '当日占位变体数',
  keyword_cnt       INT          COMMENT '当日关键词数',
  score             DOUBLE       COMMENT '自然位流量得分',
  extra_score       DOUBLE       COMMENT '多变体额外获得的自然流量得分',
  listing_asin_cnt  INT          COMMENT 'Listing 变体总数',
  created_at        DATETIME     NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(asin, country, stat_date)
COMMENT '多变体自然位日快照。实测此接口无 timePiece 参数，直接返回逐日 dates 数组'
DISTRIBUTED BY HASH(asin) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- ASIN×关键词 排名历史（日粒度）
CREATE TABLE IF NOT EXISTS looom.fact_keyword_rank_history (
  asin           VARCHAR(16)  NOT NULL COMMENT 'ASIN 编号',
  country        VARCHAR(8)   NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  keyword_id     BIGINT       NOT NULL COMMENT '关键词 ID',
  rank_type      VARCHAR(16)  NOT NULL COMMENT '排名类型：nf 自然 / sp 广告',
  stat_date      DATE         NOT NULL COMMENT '统计日期',
  rank_position  INT          COMMENT '排名位置',
  page_no        INT          COMMENT '所在页码',
  created_at     DATETIME     NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(asin, country, keyword_id, rank_type, stat_date)
COMMENT 'ASIN×关键词 排名历史（日粒度）'
DISTRIBUTED BY HASH(asin) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 关键词自身指标快照（搜索量、CPC、点击转化率等，与 ASIN 无关）
CREATE TABLE IF NOT EXISTS looom.fact_keyword_metric_snapshot (
  keyword_id            BIGINT         NOT NULL COMMENT '关键词 ID',
  country               VARCHAR(8)     NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  granularity           VARCHAR(16)    NOT NULL COMMENT '粒度：day/week/month',
  stat_date             DATE           NOT NULL COMMENT '统计日期（周月粒度取区间起始日）',
  est_searches_num      BIGINT         COMMENT '预估搜索量',
  searches_rank         BIGINT         COMMENT 'ABA 搜索排名',
  cpc_bid               DECIMAL(12,2)  COMMENT '建议竞价',
  click_purchase_ratio  DOUBLE         COMMENT '点击转化率',
  created_at            DATETIME       NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(keyword_id, country, granularity, stat_date)
COMMENT '关键词自身指标快照（搜索量、CPC、点击转化率等，与 ASIN 无关）'
DISTRIBUTED BY HASH(keyword_id) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 关键词搜索量趋势。is_prev_period 区分本期与上期（用于环比）
CREATE TABLE IF NOT EXISTS looom.fact_keyword_search_trend (
  keyword_id      BIGINT       NOT NULL COMMENT '关键词 ID',
  country         VARCHAR(8)   NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  granularity     VARCHAR(16)  NOT NULL COMMENT '粒度：day/week/month',
  stat_date       DATE         NOT NULL COMMENT '统计日期',
  is_prev_period  BOOLEAN      NOT NULL COMMENT 'false=本期 true=上期对照',
  searches_num    BIGINT       COMMENT '搜索量',
  created_at      DATETIME     NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(keyword_id, country, granularity, stat_date, is_prev_period)
COMMENT '关键词搜索量趋势。is_prev_period 区分本期与上期（用于环比）'
DISTRIBUTED BY HASH(keyword_id) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- ASIN 子类目 BSR 排名快照。⚠️ 原响应是动态 key 对象 {类目名:值}，入库须拆成行
CREATE TABLE IF NOT EXISTS looom.fact_asin_subbsr_snapshot (
  asin        VARCHAR(16)   NOT NULL COMMENT 'ASIN 编号',
  country     VARCHAR(8)    NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  cat_name    VARCHAR(255)  NOT NULL COMMENT '子类目名称（原为动态 key）',
  stat_date   DATE          NOT NULL COMMENT '统计日期',
  bsr         BIGINT        COMMENT 'BSR 排名',
  created_at  DATETIME      NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(asin, country, cat_name, stat_date)
COMMENT 'ASIN 子类目 BSR 排名快照。⚠️ 原响应是动态 key 对象 {类目名:值}，入库须拆成行。按月自动分区'
-- 按月自动分区 + BUCKETS 8（见 db/schema-05-partitions.sql §1）：
-- 全库最大表（165 万行），日粒度区间查询在单分区 2 桶下会全表扫描。
-- ⚠️ 本文件由 db/gen-business-schema.mjs 生成，该生成器尚未同步此改动，
--    重跑生成器会退回无分区版本，详见 ROADMAP_UNBUILT_MODULES.md §9。
AUTO PARTITION BY RANGE (date_trunc(stat_date, 'month')) ()
DISTRIBUTED BY HASH(asin) BUCKETS 8
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 运营动作事件。实测是系统识别的变化点（非用户标注）。与流量快照拆表：粒度不同（事件按天离散）、稀疏、且只追加不覆盖
CREATE TABLE IF NOT EXISTS looom.fact_asin_op_event (
  asin          VARCHAR(16)  NOT NULL COMMENT 'ASIN 编号',
  country       VARCHAR(8)   NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  stat_date     DATE         NOT NULL COMMENT '事件发生日期',
  event_type    VARCHAR(32)  NOT NULL COMMENT '事件类型：titleImg 改标题图片 / campaignId 新增广告活动 / 价格活动等',
  event_detail  TEXT         COMMENT '事件详情（如字符级 diff 区间、活动 ID）',
  created_at    DATETIME     NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(asin, country, stat_date, event_type)
COMMENT '运营动作事件。实测是系统识别的变化点（非用户标注）。与流量快照拆表：粒度不同（事件按天离散）、稀疏、且只追加不覆盖'
DISTRIBUTED BY HASH(asin) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");


-- =====================================================================
-- B2.3 时序快照 —— 区间聚合（非标准粒度）
-- =====================================================================

-- ASIN×关键词 多变体区间聚合（近7天/近30天/某周/某月）
CREATE TABLE IF NOT EXISTS looom.fact_asin_multinf_keyword (
  asin              VARCHAR(16)  NOT NULL COMMENT 'ASIN 编号',
  country           VARCHAR(8)   NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  keyword_id        BIGINT       NOT NULL COMMENT '关键词 ID',
  time_piece_type   VARCHAR(16)  NOT NULL COMMENT '时间粒度：month 可用 / week 仅广告域可用',
  time_piece_value  VARCHAR(32)  NOT NULL COMMENT 'month 格式 YYYY-MM；week 格式 YYYY-MM-DD_YYYY-MM-DD',
  avg_rank          DOUBLE       COMMENT '区间平均自然位排名',
  appear_days       INT          COMMENT '区间内出现天数',
  asin_cnt          INT          COMMENT '同时占位的变体数',
  created_at        DATETIME     NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(asin, country, keyword_id, time_piece_type, time_piece_value)
COMMENT 'ASIN×关键词 多变体区间聚合（近7天/近30天/某周/某月）'
DISTRIBUTED BY HASH(asin) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 关键词×变体 自然排名明细（多变体页弹层）
CREATE TABLE IF NOT EXISTS looom.fact_asin_multinf_keyword_variant (
  parent_asin       VARCHAR(16)  NOT NULL COMMENT '父体/主查 ASIN',
  country           VARCHAR(8)   NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  keyword_id        BIGINT       NOT NULL COMMENT '关键词 ID',
  variant_asin      VARCHAR(16)  NOT NULL COMMENT '变体 ASIN',
  time_piece_type   VARCHAR(16)  NOT NULL COMMENT '时间粒度：month 可用 / week 仅广告域可用',
  time_piece_value  VARCHAR(32)  NOT NULL COMMENT 'month 格式 YYYY-MM；week 格式 YYYY-MM-DD_YYYY-MM-DD',
  rank_position     INT          COMMENT '自然位排名',
  variant_role      VARCHAR(16)  COMMENT '变体角色：主曝光变体 / 搭子',
  created_at        DATETIME     NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(parent_asin, country, keyword_id, variant_asin, time_piece_type, time_piece_value)
COMMENT '关键词×变体 自然排名明细（多变体页弹层）'
DISTRIBUTED BY HASH(parent_asin) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- ASIN×关键词 前3页进出快照（运营时光机下钻）
CREATE TABLE IF NOT EXISTS looom.fact_asin_keyword_inout (
  asin         VARCHAR(16)  NOT NULL COMMENT 'ASIN 编号',
  country      VARCHAR(8)   NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  keyword_id   BIGINT       NOT NULL COMMENT '关键词 ID',
  stat_date    DATE         NOT NULL COMMENT '统计日期',
  change_type  VARCHAR(16)  COMMENT '变化类型：in 进入前3页 / out 跌出前3页',
  created_at   DATETIME     NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(asin, country, keyword_id, stat_date)
COMMENT 'ASIN×关键词 前3页进出快照（运营时光机下钻）'
DISTRIBUTED BY HASH(asin) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");


-- =====================================================================
-- B3. 关系表（rel_）—— Doris 无外键，全部由应用层维护，无级联删除
-- =====================================================================

-- 父子体变体组关系
CREATE TABLE IF NOT EXISTS looom.rel_asin_variant (
  parent_asin    VARCHAR(16)  NOT NULL COMMENT '父体 ASIN',
  child_asin     VARCHAR(16)  NOT NULL COMMENT '子体 ASIN',
  country        VARCHAR(8)   NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  display_order  INT          COMMENT '展示顺序（实测 order 字段，0=汇总行）',
  ratio          DOUBLE       COMMENT '该变体的流量占比',
  created_at     DATETIME     NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(parent_asin, child_asin, country)
COMMENT '父子体变体组关系'
DISTRIBUTED BY HASH(parent_asin) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 广告活动→投放小组（时序关系表）。⚠️ 实测 campaigns[].ads 是按日期分组的对象，同一活动各周包含的投放小组会变，故主键必须带 stat_date
CREATE TABLE IF NOT EXISTS looom.rel_ad_campaign_product_ad (
  encrypt_campaign_id  VARCHAR(64)  NOT NULL COMMENT '广告活动 ID',
  encrypt_ad_id        VARCHAR(64)  NOT NULL COMMENT '投放小组 ID',
  country              VARCHAR(8)   NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  stat_date            DATE         NOT NULL COMMENT '该关系成立的日期（周起始日）',
  created_at           DATETIME     NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(encrypt_campaign_id, encrypt_ad_id, country, stat_date)
COMMENT '广告活动→投放小组（时序关系表）。⚠️ 实测 campaigns[].ads 是按日期分组的对象，同一活动各周包含的投放小组会变，故主键必须带 stat_date'
DISTRIBUTED BY HASH(encrypt_campaign_id) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 推荐专栏→广告活动→关键词 三层钻取关系
CREATE TABLE IF NOT EXISTS looom.rel_rec_column_campaign_keyword (
  asin                 VARCHAR(16)   NOT NULL COMMENT 'ASIN 编号',
  country              VARCHAR(8)    NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  rec_title            VARCHAR(255)  NOT NULL COMMENT '推荐专栏英文原文',
  keyword_id           BIGINT        NOT NULL COMMENT '关键词 ID',
  encrypt_campaign_id  VARCHAR(64)   NOT NULL COMMENT '广告活动 ID',
  created_at           DATETIME      NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(asin, country, rec_title, keyword_id, encrypt_campaign_id)
COMMENT '推荐专栏→广告活动→关键词 三层钻取关系'
DISTRIBUTED BY HASH(asin) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 关键词分组（用户词库）
CREATE TABLE IF NOT EXISTS looom.rel_keyword_group (
  group_id    BIGINT      NOT NULL COMMENT '分组 ID',
  keyword_id  BIGINT      NOT NULL COMMENT '关键词 ID',
  country     VARCHAR(8)  NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  created_at  DATETIME    NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(group_id, keyword_id, country)
COMMENT '关键词分组（用户词库）'
DISTRIBUTED BY HASH(group_id) BUCKETS 1
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 关键词头部 ASIN（该词下排名靠前的商品）
CREATE TABLE IF NOT EXISTS looom.rel_keyword_top_asin (
  keyword_id     BIGINT       NOT NULL COMMENT '关键词 ID',
  country        VARCHAR(8)   NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  asin           VARCHAR(16)  NOT NULL COMMENT 'ASIN 编号',
  rank_position  INT          COMMENT '排名位置',
  created_at     DATETIME     NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(keyword_id, country, asin)
COMMENT '关键词头部 ASIN（该词下排名靠前的商品）'
DISTRIBUTED BY HASH(keyword_id) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- ASIN×关键词×变体 曝光关系
CREATE TABLE IF NOT EXISTS looom.rel_asin_keyword_variant_exposure (
  parent_asin       VARCHAR(16)  NOT NULL COMMENT '父体/主查 ASIN',
  variant_asin      VARCHAR(16)  NOT NULL COMMENT '变体 ASIN',
  keyword_id        BIGINT       NOT NULL COMMENT '关键词 ID',
  country           VARCHAR(8)   NOT NULL COMMENT '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR',
  time_piece_type   VARCHAR(16)  NOT NULL COMMENT '时间粒度：month 可用 / week 仅广告域可用',
  time_piece_value  VARCHAR(32)  NOT NULL COMMENT 'month 格式 YYYY-MM；week 格式 YYYY-MM-DD_YYYY-MM-DD',
  score             DOUBLE       COMMENT '该变体在该词上的曝光得分',
  created_at        DATETIME     NOT NULL COMMENT '入库时间'
) ENGINE=OLAP
UNIQUE KEY(parent_asin, variant_asin, keyword_id, country, time_piece_type, time_piece_value)
COMMENT 'ASIN×关键词×变体 曝光关系'
DISTRIBUTED BY HASH(parent_asin) BUCKETS 2
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");


-- =====================================================================
-- B4. 枚举字典表（dict_）—— 不带 country，枚举与站点无关
-- =====================================================================

-- 流量渠道类型。⚠️ 原站同一渠道有 5 套字段名，本表是对齐后的规范值
CREATE TABLE IF NOT EXISTS looom.dict_traffic_channel (
  code        VARCHAR(32)   NOT NULL COMMENT '枚举内部值',
  name_cn     VARCHAR(64)   COMMENT '中文展示名',
  name_en     VARCHAR(64)   COMMENT '英文名/原始值',
  sort_order  INT           COMMENT '展示顺序',
  extra       VARCHAR(255)  COMMENT '附加信息（颜色、别名等）'
) ENGINE=OLAP
UNIQUE KEY(code)
COMMENT '流量渠道类型。⚠️ 原站同一渠道有 5 套字段名，本表是对齐后的规范值'
DISTRIBUTED BY HASH(code) BUCKETS 1
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 时间粒度：day/month 可用，week 仅广告域可用
CREATE TABLE IF NOT EXISTS looom.dict_time_piece (
  code        VARCHAR(32)   NOT NULL COMMENT '枚举内部值',
  name_cn     VARCHAR(64)   COMMENT '中文展示名',
  name_en     VARCHAR(64)   COMMENT '英文名/原始值',
  sort_order  INT           COMMENT '展示顺序',
  extra       VARCHAR(255)  COMMENT '附加信息（颜色、别名等）'
) ENGINE=OLAP
UNIQUE KEY(code)
COMMENT '时间粒度：day/month 可用，week 仅广告域可用'
DISTRIBUTED BY HASH(code) BUCKETS 1
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 广告产品类型：1=SP 2=SB 3=SBV 4=SBBV
CREATE TABLE IF NOT EXISTS looom.dict_ad_type (
  code        VARCHAR(32)   NOT NULL COMMENT '枚举内部值',
  name_cn     VARCHAR(64)   COMMENT '中文展示名',
  name_en     VARCHAR(64)   COMMENT '英文名/原始值',
  sort_order  INT           COMMENT '展示顺序',
  extra       VARCHAR(255)  COMMENT '附加信息（颜色、别名等）'
) ENGINE=OLAP
UNIQUE KEY(code)
COMMENT '广告产品类型：1=SP 2=SB 3=SBV 4=SBBV'
DISTRIBUTED BY HASH(code) BUCKETS 1
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 列表排序字段白名单
CREATE TABLE IF NOT EXISTS looom.dict_sort_field (
  code        VARCHAR(32)   NOT NULL COMMENT '枚举内部值',
  name_cn     VARCHAR(64)   COMMENT '中文展示名',
  name_en     VARCHAR(64)   COMMENT '英文名/原始值',
  sort_order  INT           COMMENT '展示顺序',
  extra       VARCHAR(255)  COMMENT '附加信息（颜色、别名等）'
) ENGINE=OLAP
UNIQUE KEY(code)
COMMENT '列表排序字段白名单'
DISTRIBUTED BY HASH(code) BUCKETS 1
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 销量分档枚举
CREATE TABLE IF NOT EXISTS looom.dict_bought_bucket (
  code        VARCHAR(32)   NOT NULL COMMENT '枚举内部值',
  name_cn     VARCHAR(64)   COMMENT '中文展示名',
  name_en     VARCHAR(64)   COMMENT '英文名/原始值',
  sort_order  INT           COMMENT '展示顺序',
  extra       VARCHAR(255)  COMMENT '附加信息（颜色、别名等）'
) ENGINE=OLAP
UNIQUE KEY(code)
COMMENT '销量分档枚举'
DISTRIBUTED BY HASH(code) BUCKETS 1
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 变体维度切换：变体/Color/Size
CREATE TABLE IF NOT EXISTS looom.dict_dimension (
  code        VARCHAR(32)   NOT NULL COMMENT '枚举内部值',
  name_cn     VARCHAR(64)   COMMENT '中文展示名',
  name_en     VARCHAR(64)   COMMENT '英文名/原始值',
  sort_order  INT           COMMENT '展示顺序',
  extra       VARCHAR(255)  COMMENT '附加信息（颜色、别名等）'
) ENGINE=OLAP
UNIQUE KEY(code)
COMMENT '变体维度切换：变体/Color/Size'
DISTRIBUTED BY HASH(code) BUCKETS 1
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 关键词标签：isCore/isTarget/isAC 等
CREATE TABLE IF NOT EXISTS looom.dict_keyword_tag (
  code        VARCHAR(32)   NOT NULL COMMENT '枚举内部值',
  name_cn     VARCHAR(64)   COMMENT '中文展示名',
  name_en     VARCHAR(64)   COMMENT '英文名/原始值',
  sort_order  INT           COMMENT '展示顺序',
  extra       VARCHAR(255)  COMMENT '附加信息（颜色、别名等）'
) ENGINE=OLAP
UNIQUE KEY(code)
COMMENT '关键词标签：isCore/isTarget/isAC 等'
DISTRIBUTED BY HASH(code) BUCKETS 1
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 广告匹配类型：Exact/Phrase/Broad
CREATE TABLE IF NOT EXISTS looom.dict_match_type (
  code        VARCHAR(32)   NOT NULL COMMENT '枚举内部值',
  name_cn     VARCHAR(64)   COMMENT '中文展示名',
  name_en     VARCHAR(64)   COMMENT '英文名/原始值',
  sort_order  INT           COMMENT '展示顺序',
  extra       VARCHAR(255)  COMMENT '附加信息（颜色、别名等）'
) ENGINE=OLAP
UNIQUE KEY(code)
COMMENT '广告匹配类型：Exact/Phrase/Broad'
DISTRIBUTED BY HASH(code) BUCKETS 1
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 运营动作类型
CREATE TABLE IF NOT EXISTS looom.dict_op_event_type (
  code        VARCHAR(32)   NOT NULL COMMENT '枚举内部值',
  name_cn     VARCHAR(64)   COMMENT '中文展示名',
  name_en     VARCHAR(64)   COMMENT '英文名/原始值',
  sort_order  INT           COMMENT '展示顺序',
  extra       VARCHAR(255)  COMMENT '附加信息（颜色、别名等）'
) ENGINE=OLAP
UNIQUE KEY(code)
COMMENT '运营动作类型'
DISTRIBUTED BY HASH(code) BUCKETS 1
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

-- 变体角色：父体/子体/兄弟
CREATE TABLE IF NOT EXISTS looom.dict_variant_role (
  code        VARCHAR(32)   NOT NULL COMMENT '枚举内部值',
  name_cn     VARCHAR(64)   COMMENT '中文展示名',
  name_en     VARCHAR(64)   COMMENT '英文名/原始值',
  sort_order  INT           COMMENT '展示顺序',
  extra       VARCHAR(255)  COMMENT '附加信息（颜色、别名等）'
) ENGINE=OLAP
UNIQUE KEY(code)
COMMENT '变体角色：父体/子体/兄弟'
DISTRIBUTED BY HASH(code) BUCKETS 1
PROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");

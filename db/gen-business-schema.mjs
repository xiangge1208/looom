/**
 * 业务表 SQL 生成器
 *
 * 为什么用脚本生成而不是手写：
 *   业务表有 40+ 张、字段多且高度同构（尤其是渠道长表的 5 个指标列在多表复用）。
 *   手写容易出现列定义格式错误，且改一处口径要改多处。
 *   用生成器可以保证：列对齐格式统一、Doris 属性一致、同构结构只定义一次。
 *
 * 数据来源：docs/DATA_DICTIONARY.md（已确认版本）+ docs/raw/LIVE_PROBE.md（实测结论）
 * 输出：db/schema-02-business.sql
 *
 * 用法：node db/gen-business-schema.mjs
 */

import { writeFileSync } from 'node:fs'

const DB = 'looom'

/** Doris 建表统一属性（开发环境 BUCKETS 用 1~2，单副本） */
function props(buckets, key) {
  return `DISTRIBUTED BY HASH(${key}) BUCKETS ${buckets}\nPROPERTIES ("replication_num" = "1", "enable_unique_key_merge_on_write" = "true");`
}

/** 把列定义对齐成整齐的一列，避免手写时的空格错误 */
function renderCols(cols) {
  const nameW = Math.max(...cols.map((c) => c[0].length)) + 2
  const typeW = Math.max(...cols.map((c) => c[1].length)) + 2
  return cols
    .map(([name, type, comment, extra]) => {
const e = extra ? extra + ' ' : ''
      return `  ${name.padEnd(nameW)}${type.padEnd(typeW)}${e}COMMENT '${comment}'`
  })
    .join(',\n')
}

function table({ name, comment, cols, unique, buckets = 2, indexes = [] }) {
  const idx = indexes.map((i) => `  INDEX ${i[0]} (${i[1]}) USING INVERTED`).join(',\n')
  const body = renderCols(cols) + (idx ? ',\n' + idx : '')
  return [
    `-- ${comment}`,
    `CREATE TABLE IF NOT EXISTS ${DB}.${name} (`,
    body,
    `) ENGINE=OLAP`,
    `UNIQUE KEY(${unique})`,
    `COMMENT '${comment.replace(/'/g, '')}'`,
    props(buckets, unique.split(',')[0].trim()),
    '',
  ].join('\n')
}

/**
 * 站点字段。实测：原站 axios 拦截器对所有业务请求强制追加 country，支持 13 个站点。
 * 所有业务表必须带且进主键，否则不同站点的同一 ASIN 会被 Unique Key 合并覆盖。
 */
const COUNTRY = ['country', 'VARCHAR(8)', '站点：US/UK/DE/FR/IT/ES/JP/CA/MX/AU/AE/SA/BR', 'NOT NULL']

/** 时间片字段（月/周粒度）。实测 week 在 sales/keywords 域报「服务异常」，仅广告域可用 */
const TIME_PIECE = [
  ['time_piece_type', 'VARCHAR(16)', '时间粒度：month 可用 / week 仅广告域可用', 'NOT NULL'],
  ['time_piece_value', 'VARCHAR(32)', 'month 格式 YYYY-MM；week 格式 YYYY-MM-DD_YYYY-MM-DD', 'NOT NULL'],
]

/**
 * 渠道 5 指标。实测 asinKeywordList 里每个 *ScoreInfo 对象内部结构完全相同。
 * 用户已裁决采用长表：channel 进主键，而非 9 渠道 × 5 指标 = 45 列宽表。
 */
const SCORE_METRICS = [
  ['score', 'DOUBLE', '流量得分（实测为浮点，如 2859.33）'],
  ['score_ratio', 'DOUBLE', '占比，0-1 小数存储（前端负责乘 100 展示）'],
  ['score_change', 'DOUBLE', '得分变化量'],
  ['score_change_ratio', 'DOUBLE', '得分变化率，可为 NULL'],
  ['contri_change_ratio', 'DOUBLE', '贡献度变化率'],
]

const out = []

out.push(`-- =====================================================================
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

CREATE DATABASE IF NOT EXISTS ${DB};
USE ${DB};

-- =====================================================================
-- B1. 基础实体表（dim_）
-- =====================================================================
`)

out.push(
  table({
    name: 'dim_asin',
    comment: 'ASIN 商品主档（4 个域共用）',
    unique: 'asin, country',
    indexes: [['idx_dim_asin_brand', 'brand']],
    cols: [
      ['asin', 'VARCHAR(16)', 'ASIN 编号', 'NOT NULL'],
      COUNTRY,
      ['title', 'VARCHAR(1024)', '商品标题'],
['img', 'VARCHAR(512)', '主图地址（亚马逊 CDN）'],
      ['price', 'DECIMAL(12,2)', '价格'],
  ['brand', 'VARCHAR(255)', '品牌名'],
['brand_href', 'VARCHAR(512)', '品牌链接'],
      ['score', 'DOUBLE', '评分（真实值，如 4.8）'],
    ['star', 'DOUBLE', '半星展示值。实测 star = round(score*2)/2，100% 成立'],
      ['rating_num', 'BIGINT', '评价数'],
      ['is_best_seller', 'BOOLEAN', '是否 BestSeller'],
      ['is_parent_asin', 'BOOLEAN', '是否父体。实测父体自身无销量数据'],
   ['parent_asin', 'VARCHAR(16)', '父体 ASIN（子体填）'],
      ['first_available_day', 'DATE', '上架日期'],
    ['seller', 'VARCHAR(255)', '卖家名'],
      ['data_updated_at', 'DATETIME', '数据更新时间（原站毫秒时间戳转换而来）'],
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
      ['updated_at', 'DATETIME', '更新时间'],
    ],
  }),
)

out.push(
  table({
name: 'dim_keyword',
    comment: '关键词主档。实测 keywordId 全局唯一（US/UK/DE 三站 ID 段不重叠），故主键不带 country',
    unique: 'keyword_id',
    indexes: [['idx_dim_kw_text', 'keyword']],
    cols: [
 ['keyword_id', 'BIGINT', '关键词 ID（实测全局唯一）', 'NOT NULL'],
      ['keyword', 'VARCHAR(512)', '关键词原文', 'NOT NULL'],
      ['translate_keyword', 'VARCHAR(512)', '中文翻译（原站自带）'],
      ['country', 'VARCHAR(8)', '所属站点（非主键，仅作标记筛选用）'],
      ['est_searches_num', 'BIGINT', '预估搜索量'],
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
      ['updated_at', 'DATETIME', '更新时间'],
    ],
  }),
)

out.push(
  table({
    name: 'dim_word',
    comment: '单词/词根主档。⚠️ 词频接口只返回 word 文本，无 ID 字段，只能用文本作键',
    unique: 'word, country',
    buckets: 1,
    cols: [
      ['word', 'VARCHAR(128)', '单词/词根', 'NOT NULL'],
      COUNTRY,
   ['translate_word', 'VARCHAR(255)', '中文翻译'],
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(
  table({
    name: 'dim_asin_feature',
    comment:
      '变体属性。实测：父体 features 是维度名 ["Size","Color"]，子体是对应下标取值 ["Large","Dark Moss"]，入库需按下标 zip 对齐',
    unique: 'asin, country, feature_name',
    cols: [
   ['asin', 'VARCHAR(16)', 'ASIN 编号', 'NOT NULL'],
      COUNTRY,
      ['feature_name', 'VARCHAR(64)', '属性维度名，如 Size / Color（来自父体 features）', 'NOT NULL'],
      ['feature_value', 'VARCHAR(255)', '属性取值，如 Large / Dark Moss（来自子体 features 同下标）'],
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
 ],
  }),
)

out.push(
  table({
    name: 'dim_recommend_column',
    comment:
      '推荐专栏。实测裁定为动态实体而非固定枚举：前端硬编码仅 8 个短码但实测出 17 个标题且未收敛，新标题运行时 upsert 入库',
    unique: 'rec_title, country',
    buckets: 1,
    cols: [
      ['rec_title', 'VARCHAR(255)', '专栏英文原文（后端就用它做请求参数）', 'NOT NULL'],
    COUNTRY,
      ['short_code', 'VARCHAR(16)', '前端硬编码短码：Media/4Star/fView/KOL/rBuy/Trend/New/tDeal/other'],
      ['display_name_cn', 'VARCHAR(255)', '中文展示名（原站无，需我们自造）'],
      ['first_seen_at', 'DATETIME', '首次观测到的时间'],
      ['last_seen_at', 'DATETIME', '最近观测到的时间'],
    ],
  }),
)

out.push(
  table({
    name: 'dim_ad_campaign',
    comment:
      '广告活动。⚠️ 三套 ID 并存：fake_campaign_id 前台 4 位短码 / encrypt_campaign_id 内部加密 / campaign_id_a0 用户录入的后台真实 ID',
    unique: 'encrypt_campaign_id, country',
    cols: [
      ['encrypt_campaign_id', 'VARCHAR(64)', 'Sif 内部加密活动 ID（主键）', 'NOT NULL'],
      COUNTRY,
      ['fake_campaign_id', 'VARCHAR(16)', '前台短码，实测 4 位如 IW9V'],
      ['ad_type', 'TINYINT', '广告类型：1=SP 2=SB 3=SBV 4=SBBV'],
      ['product_type', 'VARCHAR(32)', '产品类型'],
      ['strategy', 'VARCHAR(255)', '投放策略。实测是后端算好的中文串，如「多广告组，多变体」'],
      ['asin_num', 'INT', '涉及 ASIN 数'],
['ad_num', 'INT', '投放小组数'],
      ['campaign_created_at', 'DATE', '活动创建日期'],
      ['last_ad_created_at', 'DATE', '最近新增投放小组日期'],
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
      ['updated_at', 'DATETIME', '更新时间'],
    ],
  }),
)

out.push(
  table({
    name: 'dim_ad_product_ad',
    comment:
      '投放小组(Product Ad)。⚠️ 不是 Amazon AdGroup —— 层级为 Campaign→AdGroup→ProductAd→变体→搜索词，而 AdGroup 层原站前端零字段故不建表',
 unique: 'encrypt_ad_id, country',
    cols: [
      ['encrypt_ad_id', 'VARCHAR(64)', 'Sif 内部加密投放小组 ID（主键）', 'NOT NULL'],
      COUNTRY,
      ['fake_ad_id', 'VARCHAR(16)', '前台短码，实测 4 位如 FLDB'],
      ['ad_created_at', 'DATE', '投放小组创建日期'],
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(
  table({
    name: 'dim_supplier',
    comment: '供应商（1688 货源）。本期仅占位 UI + 表结构，不做任何采集/爬虫/对接',
    unique: 'id',
  buckets: 1,
    indexes: [['idx_supplier_name', 'supplier_name']],
    cols: [
      ['id', 'BIGINT', '雪花 ID', 'NOT NULL'],
      ['supplier_name', 'VARCHAR(255)', '供应商名称'],
      ['offer_id', 'VARCHAR(64)', '1688 货源 ID'],
      ['title', 'VARCHAR(1024)', '货源标题'],
      ['img', 'VARCHAR(512)', '主图'],
      ['price', 'DECIMAL(12,2)', '价格'],
   ['min_order', 'INT', '起订量'],
      ['location', 'VARCHAR(128)', '地区'],
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(`
-- =====================================================================
-- B2.1 时序快照 —— 月粒度（timePieceType=month）
-- =====================================================================
`)

out.push(
  table({
    name: 'fact_asin_bought_monthly',
    comment:
    'ASIN 月度销量。实测：序列固定 40 个月起点 2023-05；销量是字符串分档（"200+"/"<50"）故双列并存；父体无销量只存子体',
    unique: 'asin, country, stat_month',
    cols: [
      ['asin', 'VARCHAR(16)', 'ASIN 编号（只存子体，父体销量由应用层聚合）', 'NOT NULL'],
      COUNTRY,
      ['stat_month', 'VARCHAR(7)', '统计月份 YYYY-MM', 'NOT NULL'],
      ['bought_lower_bound', 'BIGINT', '分档下界整数，用于排序和计算'],
      ['bought_label', 'VARCHAR(16)', '原始分档串，用于展示。"<50" 无法用整数无损表达'],
 ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(
  table({
    name: 'fact_asin_listing_snapshot',
    comment: 'Listing 指标月度快照（价格、评分、评价数等随时间变化的指标）',
    unique: 'asin, country, stat_month',
    cols: [
      ['asin', 'VARCHAR(16)', 'ASIN 编号', 'NOT NULL'],
      COUNTRY,
      ['stat_month', 'VARCHAR(7)', '统计月份 YYYY-MM', 'NOT NULL'],
      ['price', 'DECIMAL(12,2)', '当月价格'],
   ['score', 'DOUBLE', '当月评分'],
    ['rating_num', 'BIGINT', '当月评价数'],
      ['bsr', 'BIGINT', '当月 BSR 排名'],
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(
  table({
 name: 'fact_asin_traffic_channel',
    comment:
      'ASIN 分渠道流量（长表）。用户已裁决用长表：渠道是 9 个同构对象，宽表需 45 列且新增渠道要改表结构',
    unique: 'asin, country, time_piece_type, time_piece_value, channel',
    cols: [
      ['asin', 'VARCHAR(16)', 'ASIN 编号', 'NOT NULL'],
      COUNTRY,
  ...TIME_PIECE,
      ['channel', 'VARCHAR(16)', '渠道：total/nf/ad/allSp/sp/spRec/allSb/sb/sbv。⚠️ 响应里的 recSp 须归一为 spRec', 'NOT NULL'],
      ...SCORE_METRICS,
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(
  table({
    name: 'fact_asin_keyword_snapshot',
    comment: 'ASIN×关键词 流量与排名快照（反查流量词主表）',
 unique: 'asin, country, keyword_id, time_piece_type, time_piece_value, is_listing_search',
    cols: [
      ['asin', 'VARCHAR(16)', 'ASIN 编号', 'NOT NULL'],
      COUNTRY,
      ['keyword_id', 'BIGINT', '关键词 ID', 'NOT NULL'],
 ...TIME_PIECE,
      ['is_listing_search', 'BOOLEAN', 'Listing 维度还是单 ASIN 维度', 'NOT NULL'],
      ['is_core', 'BOOLEAN', '是否核心词'],
      ['is_target', 'BOOLEAN', '是否目标词'],
      ['piece_max_time', 'DATE', '该时间片的数据截止日'],
      ['nf_last_rank', 'INT', '自然位最新排名'],
 ['nf_last_rank_time', 'DATETIME', '自然位排名时间'],
      ['nf_last_rank_asin', 'VARCHAR(16)', '自然位命中的变体 ASIN'],
      ['sp_last_rank', 'INT', 'SP 广告位最新排名'],
      ['sp_last_rank_time', 'DATETIME', 'SP 排名时间'],
      ['sp_last_rank_asin', 'VARCHAR(16)', 'SP 命中的变体 ASIN'],
      ['sp_campaign_id', 'VARCHAR(64)', '关联广告活动（跨域外键，应用层维护）'],
      ['listing_score_ratio', 'DOUBLE', '该词在整个 Listing 中的占比'],
      ['exposure_positions', 'VARCHAR(255)', '曝光流量位，逗号分隔的渠道 code'],
      ['est_searches_num', 'BIGINT', '预估搜索量'],
  ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(
  table({
    name: 'fact_asin_keyword_score',
    comment: 'ASIN×关键词×渠道 得分（长表）。对应响应里的 9 个 *ScoreInfo 嵌套对象',
    unique: 'asin, country, keyword_id, time_piece_type, time_piece_value, channel',
    cols: [
      ['asin', 'VARCHAR(16)', 'ASIN 编号', 'NOT NULL'],
      COUNTRY,
      ['keyword_id', 'BIGINT', '关键词 ID', 'NOT NULL'],
    ...TIME_PIECE,
      ['channel', 'VARCHAR(16)', '渠道 code，取值同 fact_asin_traffic_channel', 'NOT NULL'],
   ...SCORE_METRICS,
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(
  table({
    name: 'fact_asin_keyword_overview',
    comment: 'ASIN 关键词概览聚合（各渠道的关键词计数）',
    unique: 'asin, country, time_piece_type, time_piece_value, is_listing_search, channel',
    cols: [
      ['asin', 'VARCHAR(16)', 'ASIN 编号', 'NOT NULL'],
      COUNTRY,
      ...TIME_PIECE,
      ['is_listing_search', 'BOOLEAN', 'Listing 维度还是单 ASIN 维度', 'NOT NULL'],
      ['channel', 'VARCHAR(16)', '渠道 code', 'NOT NULL'],
      ['keyword_cnt', 'BIGINT', '该渠道的关键词数'],
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
],
  }),
)

out.push(
  table({
    name: 'fact_word_frequency',
    comment: '词频聚合。scope_type/scope_key 区分 ASIN 维度还是词库分组维度（两接口共用一张表）',
    unique: 'scope_type, scope_key, country, time_piece_type, time_piece_value, word_model, word',
    cols: [
      ['scope_type', 'VARCHAR(16)', '范围类型：asin / keyword_group', 'NOT NULL'],
      ['scope_key', 'VARCHAR(64)', '范围键：ASIN 编号或分组 ID', 'NOT NULL'],
      COUNTRY,
...TIME_PIECE,
      ['word_model', 'VARCHAR(16)', '词频模型：搜索量加权 / 出现次数', 'NOT NULL'],
      ['word', 'VARCHAR(128)', '单词', 'NOT NULL'],
      ['frq', 'BIGINT', '词频值'],
      ['search_weight', 'DOUBLE', '搜索量权重'],
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(
  table({
    name: 'fact_asin_rec_column_period',
    comment:
      'ASIN×推荐专栏 曝光。⚠️ 混合粒度：实测传 month 但返回逐日 dates，且极度稀疏（31 天仅 1 天有值）→ 只存非 null 的天',
    unique: 'asin, country, rec_title, stat_date',
    cols: [
      ['asin', 'VARCHAR(16)', 'ASIN 编号', 'NOT NULL'],
      COUNTRY,
      ['rec_title', 'VARCHAR(255)', '推荐专栏英文原文', 'NOT NULL'],
   ['stat_date', 'DATE', '统计日期（只存有值的天）', 'NOT NULL'],
      ['ratio', 'DOUBLE', '流量贡献占比'],
      ['campaign_cnt', 'INT', '该专栏位的广告活动数'],
      ['keyword_cnt', 'INT', '该专栏位的关键词数'],
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(
  table({
    name: 'fact_ad_search_term_exposure',
    comment: '搜索词曝光快照（广告域最细事实表）。⚠️ 存的是买家搜索词，不是投放词',
    unique: 'encrypt_ad_id, country, keyword_id, variant_asin, stat_date',
    cols: [
      ['encrypt_ad_id', 'VARCHAR(64)', '投放小组 ID', 'NOT NULL'],
      COUNTRY,
      ['keyword_id', 'BIGINT', '搜索词 ID', 'NOT NULL'],
      ['variant_asin', 'VARCHAR(16)', '投放的变体 ASIN', 'NOT NULL'],
    ['stat_date', 'DATE', '统计日期（广告域用 granularity，按日/周落点）', 'NOT NULL'],
      ['encrypt_campaign_id', 'VARCHAR(64)', '所属广告活动（冗余，便于聚合）'],
      ['ad_type', 'TINYINT', '广告类型 1=SP 2=SB 3=SBV 4=SBBV'],
      ['traffic_type', 'VARCHAR(16)', '流量位类型：sp/spRec/sb/sbv'],
   ['score', 'DOUBLE', '流量得分'],
      ['rank_position', 'INT', '广告位排名'],
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(`
-- =====================================================================
-- B2.2 时序快照 —— 日粒度
-- =====================================================================
`)

out.push(
  table({
    name: 'fact_asin_multinf_daily',
    comment: '多变体自然位日快照。实测此接口无 timePiece 参数，直接返回逐日 dates 数组',
    unique: 'asin, country, stat_date',
    cols: [
      ['asin', 'VARCHAR(16)', 'ASIN 编号', 'NOT NULL'],
      COUNTRY,
      ['stat_date', 'DATE', '统计日期', 'NOT NULL'],
      ['asin_cnt', 'INT', '当日占位变体数'],
      ['keyword_cnt', 'INT', '当日关键词数'],
      ['score', 'DOUBLE', '自然位流量得分'],
      ['extra_score', 'DOUBLE', '多变体额外获得的自然流量得分'],
      ['listing_asin_cnt', 'INT', 'Listing 变体总数'],
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(
  table({
    name: 'fact_keyword_rank_history',
    comment: 'ASIN×关键词 排名历史（日粒度）',
    unique: 'asin, country, keyword_id, rank_type, stat_date',
    cols: [
  ['asin', 'VARCHAR(16)', 'ASIN 编号', 'NOT NULL'],
      COUNTRY,
      ['keyword_id', 'BIGINT', '关键词 ID', 'NOT NULL'],
      ['rank_type', 'VARCHAR(16)', '排名类型：nf 自然 / sp 广告', 'NOT NULL'],
      ['stat_date', 'DATE', '统计日期', 'NOT NULL'],
      ['rank_position', 'INT', '排名位置'],
   ['page_no', 'INT', '所在页码'],
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(
  table({
name: 'fact_keyword_metric_snapshot',
    comment: '关键词自身指标快照（搜索量、CPC、点击转化率等，与 ASIN 无关）',
    unique: 'keyword_id, country, granularity, stat_date',
    cols: [
  ['keyword_id', 'BIGINT', '关键词 ID', 'NOT NULL'],
      COUNTRY,
      ['granularity', 'VARCHAR(16)', '粒度：day/week/month', 'NOT NULL'],
      ['stat_date', 'DATE', '统计日期（周月粒度取区间起始日）', 'NOT NULL'],
      ['est_searches_num', 'BIGINT', '预估搜索量'],
 ['searches_rank', 'BIGINT', 'ABA 搜索排名'],
      ['cpc_bid', 'DECIMAL(12,2)', '建议竞价'],
      ['click_purchase_ratio', 'DOUBLE', '点击转化率'],
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(
  table({
    name: 'fact_keyword_search_trend',
    comment: '关键词搜索量趋势。is_prev_period 区分本期与上期（用于环比）',
    unique: 'keyword_id, country, granularity, stat_date, is_prev_period',
    cols: [
      ['keyword_id', 'BIGINT', '关键词 ID', 'NOT NULL'],
      COUNTRY,
      ['granularity', 'VARCHAR(16)', '粒度：day/week/month', 'NOT NULL'],
      ['stat_date', 'DATE', '统计日期', 'NOT NULL'],
  ['is_prev_period', 'BOOLEAN', 'false=本期 true=上期对照', 'NOT NULL'],
      ['searches_num', 'BIGINT', '搜索量'],
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(
  table({
    name: 'fact_asin_subbsr_snapshot',
    comment: 'ASIN 子类目 BSR 排名快照。⚠️ 原响应是动态 key 对象 {类目名:值}，入库须拆成行',
    unique: 'asin, country, cat_name, stat_date',
    cols: [
  ['asin', 'VARCHAR(16)', 'ASIN 编号', 'NOT NULL'],
      COUNTRY,
   ['cat_name', 'VARCHAR(255)', '子类目名称（原为动态 key）', 'NOT NULL'],
  ['stat_date', 'DATE', '统计日期', 'NOT NULL'],
      ['bsr', 'BIGINT', 'BSR 排名'],
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(
  table({
    name: 'fact_asin_op_event',
    comment:
      '运营动作事件。实测是系统识别的变化点（非用户标注）。与流量快照拆表：粒度不同（事件按天离散）、稀疏、且只追加不覆盖',
    unique: 'asin, country, stat_date, event_type',
    cols: [
      ['asin', 'VARCHAR(16)', 'ASIN 编号', 'NOT NULL'],
      COUNTRY,
      ['stat_date', 'DATE', '事件发生日期', 'NOT NULL'],
      ['event_type', 'VARCHAR(32)', '事件类型：titleImg 改标题图片 / campaignId 新增广告活动 / 价格活动等', 'NOT NULL'],
      ['event_detail', 'TEXT', '事件详情（如字符级 diff 区间、活动 ID）'],
   ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(`
-- =====================================================================
-- B2.3 时序快照 —— 区间聚合（非标准粒度）
-- =====================================================================
`)

out.push(
  table({
    name: 'fact_asin_multinf_keyword',
    comment: 'ASIN×关键词 多变体区间聚合（近7天/近30天/某周/某月）',
    unique: 'asin, country, keyword_id, time_piece_type, time_piece_value',
cols: [
      ['asin', 'VARCHAR(16)', 'ASIN 编号', 'NOT NULL'],
      COUNTRY,
      ['keyword_id', 'BIGINT', '关键词 ID', 'NOT NULL'],
      ...TIME_PIECE,
      ['avg_rank', 'DOUBLE', '区间平均自然位排名'],
      ['appear_days', 'INT', '区间内出现天数'],
      ['asin_cnt', 'INT', '同时占位的变体数'],
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(
  table({
    name: 'fact_asin_multinf_keyword_variant',
    comment: '关键词×变体 自然排名明细（多变体页弹层）',
    unique: 'parent_asin, country, keyword_id, variant_asin, time_piece_type, time_piece_value',
    cols: [
      ['parent_asin', 'VARCHAR(16)', '父体/主查 ASIN', 'NOT NULL'],
      COUNTRY,
      ['keyword_id', 'BIGINT', '关键词 ID', 'NOT NULL'],
      ['variant_asin', 'VARCHAR(16)', '变体 ASIN', 'NOT NULL'],
      ...TIME_PIECE,
      ['rank_position', 'INT', '自然位排名'],
      ['variant_role', 'VARCHAR(16)', '变体角色：主曝光变体 / 搭子'],
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(
  table({
    name: 'fact_asin_keyword_inout',
    comment: 'ASIN×关键词 前3页进出快照（运营时光机下钻）',
    unique: 'asin, country, keyword_id, stat_date',
    cols: [
      ['asin', 'VARCHAR(16)', 'ASIN 编号', 'NOT NULL'],
      COUNTRY,
  ['keyword_id', 'BIGINT', '关键词 ID', 'NOT NULL'],
      ['stat_date', 'DATE', '统计日期', 'NOT NULL'],
      ['change_type', 'VARCHAR(16)', '变化类型：in 进入前3页 / out 跌出前3页'],
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(`
-- =====================================================================
-- B3. 关系表（rel_）—— Doris 无外键，全部由应用层维护，无级联删除
-- =====================================================================
`)

out.push(
  table({
    name: 'rel_asin_variant',
    comment: '父子体变体组关系',
    unique: 'parent_asin, child_asin, country',
    cols: [
      ['parent_asin', 'VARCHAR(16)', '父体 ASIN', 'NOT NULL'],
['child_asin', 'VARCHAR(16)', '子体 ASIN', 'NOT NULL'],
   COUNTRY,
      ['display_order', 'INT', '展示顺序（实测 order 字段，0=汇总行）'],
      ['ratio', 'DOUBLE', '该变体的流量占比'],
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(
  table({
    name: 'rel_ad_campaign_product_ad',
    comment:
      '广告活动→投放小组（时序关系表）。⚠️ 实测 campaigns[].ads 是按日期分组的对象，同一活动各周包含的投放小组会变，故主键必须带 stat_date',
    unique: 'encrypt_campaign_id, encrypt_ad_id, country, stat_date',
    cols: [
      ['encrypt_campaign_id', 'VARCHAR(64)', '广告活动 ID', 'NOT NULL'],
      ['encrypt_ad_id', 'VARCHAR(64)', '投放小组 ID', 'NOT NULL'],
      COUNTRY,
      ['stat_date', 'DATE', '该关系成立的日期（周起始日）', 'NOT NULL'],
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(
  table({
    name: 'rel_rec_column_campaign_keyword',
    comment: '推荐专栏→广告活动→关键词 三层钻取关系',
    unique: 'asin, country, rec_title, keyword_id, encrypt_campaign_id',
    cols: [
      ['asin', 'VARCHAR(16)', 'ASIN 编号', 'NOT NULL'],
      COUNTRY,
      ['rec_title', 'VARCHAR(255)', '推荐专栏英文原文', 'NOT NULL'],
      ['keyword_id', 'BIGINT', '关键词 ID', 'NOT NULL'],
      ['encrypt_campaign_id', 'VARCHAR(64)', '广告活动 ID', 'NOT NULL'],
   ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(
  table({
    name: 'rel_keyword_group',
    comment: '关键词分组（用户词库）',
    unique: 'group_id, keyword_id, country',
    buckets: 1,
    cols: [
      ['group_id', 'BIGINT', '分组 ID', 'NOT NULL'],
      ['keyword_id', 'BIGINT', '关键词 ID', 'NOT NULL'],
   COUNTRY,
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(
  table({
    name: 'rel_keyword_top_asin',
    comment: '关键词头部 ASIN（该词下排名靠前的商品）',
 unique: 'keyword_id, country, asin',
    cols: [
      ['keyword_id', 'BIGINT', '关键词 ID', 'NOT NULL'],
      COUNTRY,
      ['asin', 'VARCHAR(16)', 'ASIN 编号', 'NOT NULL'],
  ['rank_position', 'INT', '排名位置'],
      ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(
  table({
    name: 'rel_asin_keyword_variant_exposure',
    comment: 'ASIN×关键词×变体 曝光关系',
    unique: 'parent_asin, variant_asin, keyword_id, country, time_piece_type, time_piece_value',
    cols: [
      ['parent_asin', 'VARCHAR(16)', '父体/主查 ASIN', 'NOT NULL'],
      ['variant_asin', 'VARCHAR(16)', '变体 ASIN', 'NOT NULL'],
      ['keyword_id', 'BIGINT', '关键词 ID', 'NOT NULL'],
      COUNTRY,
      ...TIME_PIECE,
      ['score', 'DOUBLE', '该变体在该词上的曝光得分'],
    ['created_at', 'DATETIME', '入库时间', 'NOT NULL'],
    ],
  }),
)

out.push(`
-- =====================================================================
-- B4. 枚举字典表（dict_）—— 不带 country，枚举与站点无关
-- =====================================================================
`)

const dictCols = [
  ['code', 'VARCHAR(32)', '枚举内部值', 'NOT NULL'],
  ['name_cn', 'VARCHAR(64)', '中文展示名'],
  ['name_en', 'VARCHAR(64)', '英文名/原始值'],
['sort_order', 'INT', '展示顺序'],
  ['extra', 'VARCHAR(255)', '附加信息（颜色、别名等）'],
]

const dicts = [
  ['dict_traffic_channel', '流量渠道类型。⚠️ 原站同一渠道有 5 套字段名，本表是对齐后的规范值'],
  ['dict_time_piece', '时间粒度：day/month 可用，week 仅广告域可用'],
  ['dict_ad_type', '广告产品类型：1=SP 2=SB 3=SBV 4=SBBV'],
  ['dict_sort_field', '列表排序字段白名单'],
  ['dict_bought_bucket', '销量分档枚举'],
  ['dict_dimension', '变体维度切换：变体/Color/Size'],
  ['dict_keyword_tag', '关键词标签：isCore/isTarget/isAC 等'],
  ['dict_match_type', '广告匹配类型：Exact/Phrase/Broad'],
  ['dict_op_event_type', '运营动作类型'],
  ['dict_variant_role', '变体角色：父体/子体/兄弟'],
]

for (const [name, comment] of dicts) {
  out.push(table({ name, comment, unique: 'code', buckets: 1, cols: dictCols }))
}

writeFileSync('db/schema-02-business.sql', out.join('\n'))
console.log('生成完成：db/schema-02-business.sql')
console.log('业务表数量：', out.filter((s) => s.includes('CREATE TABLE')).length)

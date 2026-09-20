/**
 * Seed 数据生成器
 *
 * 为什么用脚本生成而不是手写 SQL：
 *   goal.md 要求的规模是 5 ASIN × 50 关键词 × 30 天快照 + 广告 + 供应商，
 *   手写几千行 INSERT 既易错也无法保证父子体、关键词关联这些引用关系自洽。
 *   生成器可以先在内存里把关系建好，再统一输出，引用一定对得上。
 *
 * 数据全部自造：
 *   - ASIN 号是虚构的（B0SEED*），不使用真实亚马逊 ASIN
 *   - 标题、品牌、供应商名全是中文/英文自造，不复制原站任何文案
 *   - 图片用占位服务，不引用原站或亚马逊 CDN
 *
 * 用法：node db/gen-seed.mjs > db/seed.sql
 */

import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const DB = 'looom'

// ---- 确定性随机，保证每次生成的 seed 一致（便于排查问题）----
let _s = 20260918
function rnd() {
  _s = (_s * 1103515245 + 12345) & 0x7fffffff
  return _s / 0x7fffffff
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)]
const int = (min, max) => Math.floor(rnd() * (max - min + 1)) + min
const dec = (min, max, p = 2) => Number((rnd() * (max - min) + min).toFixed(p))

// ---- 雪花 ID（与后端同算法，但这里只需单调递增即可）----
let _id = 380000000000000000n
const nextId = () => (_id += 1n).toString()

const q = (v) => {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

const out = []
const say = (s) => out.push(s)

/** 批量 INSERT。Doris 单条 INSERT 开销大，必须批量 */
function insert(table, cols, rows, chunk = 200) {
  if (!rows.length) return
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk)
    say(
      `INSERT INTO ${DB}.${table} (${cols.join(', ')}) VALUES\n` +
     slice.map((r) => '  (' + cols.map((c) => q(r[c])).join(', ') + ')').join(',\n') +
        ';',
    )
  }
}

const NOW = '2026-09-18 12:00:00'
const COUNTRY = 'US'

say(`-- =====================================================================
-- Seed 数据（开发环境）
--
-- 本文件由 db/gen-seed.mjs 生成，请勿手工编辑。
-- 重新生成：node db/gen-seed.mjs
--
-- 数据全部自造，不含真实亚马逊数据、不含原站任何文案或素材。
-- ASIN 号为虚构的 B0SEED* 前缀，避免与真实商品混淆。
--
-- 幂等性：Doris Unique Key 模型下重复 INSERT 同主键即覆盖，
-- 所以本文件可以重复执行，不会产生重复行。
--
-- ⚠️ 字符集：下面这行 SET NAMES 是必须的，不要删。
--    seed 里有大量中文（商品标题、供应商名、积分流水备注等）。
--    若用 mysql 客户端导入时不带 --default-character-set=utf8mb4，
--    中文会被转成 EFBFBD（U+FFFD 替换字符）**永久损坏**——
--    而且只坏中文，英文和数字看着都正常，很难发现。
--    带上 SET NAMES 后，无论客户端什么配置都能正确入库。
--    scripts/setup-doris.sh 已经传了 --default-character-set，这里是双保险。
SET NAMES utf8mb4;
-- =====================================================================

USE ${DB};
`)

// =====================================================================
// 1. 测试用户（普通 + 管理员）
// =====================================================================
say('-- 1. 测试用户。密码均为 test1234（bcrypt cost=10）')

/**
 * 测试账号密码的 bcrypt 哈希。
 *
 * ⚠️ 必须真实计算，不能硬编码：
 * 之前图省事写了个凭记忆的占位串，结果它对任何密码都不匹配，
 * seed 用户全部登录失败。这类错误在写 seed 时不会报错，
 * 只有真正登录时才暴露 —— 所以这里直接算。
 *
 * 用固定 salt 让每次生成的 seed.sql 内容一致（便于 diff 和幂等重跑）。
 */
const bcrypt = require('bcryptjs')
const SEED_PASSWORD = 'test1234'
const FIXED_SALT = '$2a$10$abcdefghijklmnopqrstuv'
const PW_HASH = bcrypt.hashSync(SEED_PASSWORD, FIXED_SALT)

// 自检：生成时就验证哈希可用，避免再次产出登录不了的 seed
if (!bcrypt.compareSync(SEED_PASSWORD, PW_HASH)) {
  throw new Error('bcrypt 哈希自检失败，seed 会导致无法登录')
}

const USER_NORMAL = nextId()
const USER_ADMIN = nextId()

insert(
  'users',
  ['id', 'email', 'password_hash', 'nickname', 'avatar_url', 'status',
   'default_country', 'is_deleted', 'created_at', 'updated_at'],
  [
    {
      id: USER_NORMAL, email: 'user@looom.dev', password_hash: PW_HASH,
      nickname: '普通用户', avatar_url: 'https://api.dicebear.com/7.x/initials/svg?seed=user',
      status: 1, default_country: COUNTRY, is_deleted: 0, created_at: NOW, updated_at: NOW,
    },
    {
      id: USER_ADMIN, email: 'admin@looom.dev', password_hash: PW_HASH,
      nickname: '管理员', avatar_url: 'https://api.dicebear.com/7.x/initials/svg?seed=admin',
      status: 1, default_country: COUNTRY, is_deleted: 0, created_at: NOW, updated_at: NOW,
    },
  ],
)

// 角色
const ROLE_USER = nextId()
const ROLE_ADMIN = nextId()
insert(
  '`roles`',
  ['id', 'code', 'name', 'permissions', 'created_at'],
  [
    { id: ROLE_USER, code: 'user', name: '普通用户', permissions: '["query:read","supplier:read"]', created_at: NOW },
    { id: ROLE_ADMIN, code: 'admin', name: '管理员', permissions: '["*"]', created_at: NOW },
  ],
)
insert(
  'user_roles',
  ['id', 'user_id', 'role_id', 'created_at'],
  [
    { id: nextId(), user_id: USER_NORMAL, role_id: ROLE_USER, created_at: NOW },
    { id: nextId(), user_id: USER_ADMIN, role_id: ROLE_ADMIN, created_at: NOW },
  ],
)

// 积分账户。实测原站积分是浮点，故用小数。
//
// ⚠️ balance 这一列只是**展示缓存**。余额的权威值是 credit_transactions
// 的 SUM(amount)（Doris 并发 UPDATE 会丢更新，详见 DATA_DICTIONARY C4-13），
// 所以下面必须同时写一条 gift 流水，否则接口读出来的余额是 0。
insert(
  'credit_accounts',
  ['user_id', 'balance', 'total_recharged', 'total_consumed', 'frozen',
   'channel', 'integral_limit', 'version', 'updated_at'],
  [
    { user_id: USER_NORMAL, balance: 100.0, total_recharged: 100.0, total_consumed: 0,
      frozen: 0, channel: 'personal', integral_limit: null, version: 0, updated_at: NOW },
    { user_id: USER_ADMIN, balance: 9999.0, total_recharged: 9999.0, total_consumed: 0,
      frozen: 0, channel: 'personal', integral_limit: null, version: 0, updated_at: NOW },
  ],
)

// 初始额度的流水。
//
// id 必须**小于**运行期雪花 ID，否则扣费时的「前缀余额」判定
// （只统计 id <= 本次流水 id 的流水）会把初始额度排除在外，
// 导致任何扣费都判为余额不足。雪花 ID 当前在 3.7e17 量级，
// 这里用 1e17 量级的固定值，保证永远排在最前面。
insert(
  'credit_transactions',
  ['id', 'user_id', 'type', 'amount', 'balance_after',
   'biz_type', 'biz_id', 'remark', 'created_at'],
  [
    { id: '100000000000000001', user_id: USER_NORMAL, type: 'gift', amount: 100.0,
      balance_after: 100.0, biz_type: 'seed', biz_id: null,
      remark: '注册赠送初始积分', created_at: NOW },
    { id: '100000000000000002', user_id: USER_ADMIN, type: 'gift', amount: 9999.0,
      balance_after: 9999.0, biz_type: 'seed', biz_id: null,
      remark: '管理员测试额度', created_at: NOW },
  ],
)

// =====================================================================
// 2. 系统配置（积分单价等）
// =====================================================================
say('\n-- 2. 系统配置。积分单价参考原站 /rule 页规则（1 元 = 10 积分）')

insert(
  'system_configs',
  ['config_key', 'config_value', 'value_type', 'group_name', 'description', 'updated_at'],
  [
    { config_key: 'credit.rate.yuan_to_point', config_value: '10', value_type: 'int',
   group_name: 'credit', description: '1 元兑换的积分数', updated_at: NOW },
    { config_key: 'credit.cost.query_sales', config_value: '0', value_type: 'int',
      group_name: 'credit', description: '查销量：免费', updated_at: NOW },
    { config_key: 'credit.cost.query_traffic', config_value: '0', value_type: 'int',
      group_name: 'credit', description: '查流量结构：免费', updated_at: NOW },
    { config_key: 'credit.cost.reverse_keyword', config_value: '10', value_type: 'int',
      group_name: 'credit', description: '反查流量词：10 积分/ASIN', updated_at: NOW },
    { config_key: 'credit.cost.ai_analysis', config_value: '5', value_type: 'int',
      group_name: 'credit', description: 'AI 分析：5 积分/次', updated_at: NOW },
    { config_key: 'limit.compare_asin_max', config_value: '10', value_type: 'int',
      group_name: 'limit', description: '多产品对比上限。实测原站为 10 个', updated_at: NOW },
    { config_key: 'feature.week_granularity', config_value: 'false', value_type: 'bool',
      group_name: 'feature_flag',
      description: '周粒度开关。实测原站非广告域的 week 报「服务异常」，故默认关闭', updated_at: NOW },
  ],
)

// =====================================================================
// 3. 枚举字典
// =====================================================================
say('\n-- 3. 枚举字典')

// 流量渠道。来源：traffic 域对齐 5 套映射 + 实测 asinKeywordList 的 9 个 *ScoreInfo
const CHANNELS = [
  ['total', '全部流量', 'total', 1, ''],
  ['nf', '自然流量', 'natural', 2, '#1AB364'],
  ['ad', '广告流量', 'ad', 3, '#F0AA11'],
  ['allSp', 'SP广告流量', 'spAll', 4, '#F2732F'],
  ['sp', 'SP(常规)流量', 'spNormal', 5, '#F2732F'],
  ['spRec', 'SP(推荐)流量', 'spRecommend', 6, '#FF8F18'],
  ['allSb', 'SB广告流量', 'sbAll', 7, '#FFB302'],
  ['sb', 'SB(常规)流量', 'sbNormal', 8, '#FFB302'],
  ['sbv', 'SBV流量', 'sbv', 9, '#EEDB47'],
  ['ac', 'AC推荐词', 'amazonChoice', 10, ''],
  ['deal', 'Deal活动', 'deal', 11, '#CC0C39'],
  ['bs', 'Best Seller', 'bestSeller', 12, '#D14900'],
]
insert(
  'dict_traffic_channel',
  ['code', 'name_cn', 'name_en', 'sort_order', 'extra'],
  CHANNELS.map(([code, cn, en, o, color]) => ({
    code, name_cn: cn, name_en: en, sort_order: o, extra: color,
  })),
)

insert(
  'dict_time_piece',
  ['code', 'name_cn', 'name_en', 'sort_order', 'extra'],
  [
    { code: 'day', name_cn: '按日', name_en: 'day', sort_order: 1, extra: '多变体自然位用' },
    { code: 'month', name_cn: '按月', name_en: 'month', sort_order: 2, extra: '格式 YYYY-MM' },
    { code: 'week', name_cn: '按周', name_en: 'week', sort_order: 3,
      extra: '格式 YYYY-MM-DD_YYYY-MM-DD。实测仅广告域可用' },
  ],
)

// 广告类型。实测 adType 是 int 枚举，与 trafficType 正交
insert(
  'dict_ad_type',
  ['code', 'name_cn', 'name_en', 'sort_order', 'extra'],
  [
    { code: '1', name_cn: 'SP 商品推广', name_en: 'SP', sort_order: 1, extra: '' },
    { code: '2', name_cn: 'SB 品牌推广', name_en: 'SB', sort_order: 2, extra: '' },
    { code: '3', name_cn: 'SBV 品牌视频', name_en: 'SBV', sort_order: 3, extra: '' },
    { code: '4', name_cn: 'SBBV 品牌视频变体', name_en: 'SBBV', sort_order: 4, extra: '' },
  ],
)

insert(
  'dict_dimension',
  ['code', 'name_cn', 'name_en', 'sort_order', 'extra'],
  [
    { code: 'variant', name_cn: '不同变体', name_en: 'variant', sort_order: 1, extra: '' },
    { code: 'color', name_cn: '不同 Color', name_en: 'color', sort_order: 2, extra: '' },
    { code: 'size', name_cn: '不同 Size', name_en: 'size', sort_order: 3, extra: '' },
  ],
)

insert(
  'dict_keyword_tag',
  ['code', 'name_cn', 'name_en', 'sort_order', 'extra'],
  [
    { code: 'isCore', name_cn: '核心词', name_en: 'core', sort_order: 1, extra: '' },
    { code: 'isTarget', name_cn: '目标词', name_en: 'target', sort_order: 2, extra: '' },
    { code: 'isAC', name_cn: 'AC 词', name_en: 'amazonChoice', sort_order: 3, extra: '' },
  ],
)

insert(
  'dict_match_type',
  ['code', 'name_cn', 'name_en', 'sort_order', 'extra'],
  [
    { code: 'exact', name_cn: '精准匹配', name_en: 'Exact', sort_order: 1, extra: '' },
    { code: 'phrase', name_cn: '词组匹配', name_en: 'Phrase', sort_order: 2, extra: '' },
    { code: 'broad', name_cn: '广泛匹配', name_en: 'Broad', sort_order: 3, extra: '' },
  ],
)

insert(
  'dict_op_event_type',
  ['code', 'name_cn', 'name_en', 'sort_order', 'extra'],
  [
    { code: 'titleImg', name_cn: '修改标题或图片', name_en: 'titleImg', sort_order: 1, extra: '' },
    { code: 'campaignId', name_cn: '新增广告活动', name_en: 'campaignId', sort_order: 2, extra: '' },
    { code: 'priceChange', name_cn: '价格变动', name_en: 'priceChange', sort_order: 3, extra: '' },
    { code: 'coupon', name_cn: '优惠券活动', name_en: 'coupon', sort_order: 4, extra: '' },
  ],
)

insert(
  'dict_variant_role',
  ['code', 'name_cn', 'name_en', 'sort_order', 'extra'],
  [
    { code: 'parent', name_cn: '父体', name_en: 'parent', sort_order: 1, extra: '' },
    { code: 'main', name_cn: '主曝光变体', name_en: 'main', sort_order: 2, extra: '' },
    { code: 'sibling', name_cn: '同组变体', name_en: 'sibling', sort_order: 3, extra: '' },
  ],
)

insert(
  'dict_sort_field',
  ['code', 'name_cn', 'name_en', 'sort_order', 'extra'],
  [
    { code: 'score', name_cn: '流量得分', name_en: 'score', sort_order: 1, extra: '' },
    { code: 'bought', name_cn: '销量', name_en: 'bought', sort_order: 2, extra: '' },
    { code: 'price', name_cn: '价格', name_en: 'price', sort_order: 3, extra: '' },
    { code: 'star', name_cn: '评分', name_en: 'star', sort_order: 4,
      extra: '实测排序键是 star（半星值），展示用 score' },
  ],
)

// 销量分档。实测原站返回字符串分档而非整数
insert(
  'dict_bought_bucket',
  ['code', 'name_cn', 'name_en', 'sort_order', 'extra'],
  [
    { code: 'lt50', name_cn: '<50', name_en: '<50', sort_order: 1, extra: '0' },
    { code: '50p', name_cn: '50+', name_en: '50+', sort_order: 2, extra: '50' },
    { code: '100p', name_cn: '100+', name_en: '100+', sort_order: 3, extra: '100' },
    { code: '200p', name_cn: '200+', name_en: '200+', sort_order: 4, extra: '200' },
    { code: '500p', name_cn: '500+', name_en: '500+', sort_order: 5, extra: '500' },
    { code: '1kp', name_cn: '1,000+', name_en: '1000+', sort_order: 6, extra: '1000' },
    { code: '2kp', name_cn: '2,000+', name_en: '2000+', sort_order: 7, extra: '2000' },
    { code: '5kp', name_cn: '5,000+', name_en: '5000+', sort_order: 8, extra: '5000' },
    { code: '10kp', name_cn: '10,000+', name_en: '10000+', sort_order: 9, extra: '10000' },
  ],
)

// 推荐专栏。实测是动态实体，8 个短码来自前端硬编码，标题为英文原文
const REC_COLUMNS = [
  ['Customers frequently viewed', 'fView', '顾客常看'],
  ['Trending now', 'Trend', '当下热门'],
  ['Picks from Amazon Influencers', 'KOL', '达人推荐'],
  ['Seen on social media', 'Media', '社媒同款'],
  ['4 stars and above', '4Star', '四星以上'],
  ['Recently bought and rated', 'rBuy', '近期购买并评价'],
  ['New arrivals', 'New', '新品上架'],
  ["Today's deals", 'tDeal', '今日特惠'],
]
insert(
  'dim_recommend_column',
  ['rec_title', 'country', 'short_code', 'display_name_cn', 'first_seen_at', 'last_seen_at'],
  REC_COLUMNS.map(([t, c, cn]) => ({
    rec_title: t, country: COUNTRY, short_code: c, display_name_cn: cn,
    first_seen_at: NOW, last_seen_at: NOW,
  })),
)

// =====================================================================
// 4. ASIN（5 组，含多变体父子关系）
// =====================================================================
say('\n-- 4. ASIN 商品。5 个父体各带若干子体，模拟真实的变体组结构')

/**
 * 商品定义。
 * ⚠️ 码值必须是 2 位：ASIN 固定 10 位，
 *    'B0SEED'(6) + 商品码(2) + 序号(2) = 10，正好。
 *    原先用了 3~4 位 slug，生成出 11~12 位的非法 ASIN，
 *    会被后端的 ASIN 格式校验挡下。
 */
/**
 * 商品图。
 *
 * ## 为什么直接热链 Unsplash CDN，而不是转存 OSS
 *
 * 侦察实测原站 `img` 存的就是**亚马逊 CDN 直链**
 * （`https://m.media-amazon.com/images/I/81+9rUcRVTL._AC_UY218_.jpg`，
 * 见 docs/raw/LIVE_PROBE.md），所以「VARCHAR 存 URL」的字段设计本身是对的。
 *
 * 转存 OSS 在本项目里是错的选择：
 *   1. 要转存就得先把真实商品图抓下来 —— 那正是 goal.md 禁止的采集行为
 *   2. 真实商品图有版权，重新托管是侵权
 *   3. 原站就是直接引 CDN，复刻它不需要多一层
 * OSS 有意义的场景是「自己拥有的商品图」或「CDN 有防盗链/会过期」，
 * 本项目 seed 全是自造数据，没有真实商品图要托管。
 *
 * ## 为什么用 Unsplash
 *
 * Unsplash License 免署名、可商用，且**官方 API Guidelines 明确允许并鼓励热链**
 * `images.unsplash.com`（对比：Pixabay 条款禁止永久热链，必须自行缓存）。
 * 下面每个 ID 都实测过 `200 image/jpeg`，不是搜索结果里抄来的猜测。
 *
 * 一个品类给多张，子体按序轮用，避免整组变体长得一模一样。
 */
const PHOTOS = {
  // 固态硬盘
  SS: [
    'photo-1756836857559-4c8161fe07f3',
 'photo-1721333091782-1f4140831683',
  ],
  // 抓绒连帽卫衣
  HD: [
    'photo-1499972777470-6a932ea55420',
    'photo-1612978322313-be209301e185',
  ],
  // LED 护眼台灯
  LP: ['photo-1682827923239-9517e6d445a5'],
  // 不锈钢保温杯
  BT: [
    'photo-1592985666128-a89274277995',
    'photo-1730703136456-8bffc44d835c',
    'photo-1615830477327-2e4ea7353903',
  ],
  // 机械键盘
  KB: [
    'photo-1669884210062-e3055c8c8f5d',
    'photo-1749149661368-400dc927f295',
  ],
}

/** 拼出定尺寸的商品图 URL。w/h 相等取方图，和电商主图习惯一致 */
function photoUrl(code, index, size = 300) {
  const list = PHOTOS[code]
  if (!list?.length) return null
  const id = list[index % list.length]
  return `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${size}&h=${size}&q=80`
}

const PRODUCTS = [
  { slug: 'SS', code: 'SS', brand: 'Kinstore', title: '固态硬盘 SATA 2.5 英寸内置 SSD',
    dims: ['Size'], values: [['240 GB', '480 GB', '960 GB']], price: [39, 129] },
  { slug: 'HD', code: 'HD', brand: 'CozyLite', title: '抓绒连帽卫衣 保暖休闲上衣',
    dims: ['Size', 'Color'], values: [['S', 'M', 'L'], ['Dark Moss', 'Charcoal']], price: [44, 99] },
  { slug: 'LP', code: 'LP', brand: 'Luminar', title: 'LED 护眼台灯 无极调光',
    dims: ['Color'], values: [['White', 'Black']], price: [25, 59] },
  { slug: 'BT', code: 'BT', brand: 'HydroPeak', title: '不锈钢保温杯 24 小时保冷',
    dims: ['Size', 'Color'], values: [['500ml', '750ml'], ['Navy', 'Sand']], price: [18, 42] },
  { slug: 'KB', code: 'KB', brand: 'TypeCraft', title: '机械键盘 87 键 热插拔轴体',
    dims: ['Color'], values: [['Black', 'White', 'Grey']], price: [59, 149] },
]

const asinRows = []
const featureRows = []
const variantRows = []
/** 供后续关键词/广告引用 */
const allAsins = []

PRODUCTS.forEach((p, pi) => {
  // 父体结尾用 P：'B0SEED'(6) + code(2) + 'P0'(2) = 10 位
  const parentAsin = `B0SEED${p.code}P0`
  // 笛卡尔积生成子体组合
  const combos = p.values.reduce(
    (acc, vals) => acc.flatMap((prefix) => vals.map((v) => [...prefix, v])),
    [[]],
  )

  // 父体。实测父体自身无销量数据，这里也不给它建销量行
  asinRows.push({
    asin: parentAsin, country: COUNTRY,
    title: `${p.title}（父体）`,
    img: photoUrl(p.code, 0),
    price: null, brand: p.brand, brand_href: `https://example.com/brand/${p.brand}`,
    score: null, star: null, rating_num: null,
    is_best_seller: false, is_parent_asin: true, parent_asin: null,
    first_available_day: '2023-05-10', seller: `${p.brand} 官方店`,
    data_updated_at: NOW, created_at: NOW, updated_at: NOW,
  })

  // 父体的维度名（对应实测里顶层 features 是维度名列表）
  p.dims.forEach((d) => {
    featureRows.push({
      asin: parentAsin, country: COUNTRY, feature_name: d,
      feature_value: null, created_at: NOW,
    })
  })

  combos.forEach((combo, ci) => {
    const asin = `B0SEED${p.code}${String(ci + 1).padStart(2, '0')}`
    const score = dec(3.6, 4.9, 1)
    allAsins.push({ asin, parentAsin, product: p })

    asinRows.push({
      asin, country: COUNTRY,
      title: `${p.title} ${combo.join(' / ')}`,
      img: photoUrl(p.code, ci),
      price: dec(p.price[0], p.price[1]), brand: p.brand,
      brand_href: `https://example.com/brand/${p.brand}`,
      score,
      // 实测关系：star = round(score*2)/2
      star: Math.round(score * 2) / 2,
      rating_num: int(120, 250000),
      is_best_seller: ci === 0 && pi < 2, is_parent_asin: false, parent_asin: parentAsin,
      first_available_day: '2023-05-10', seller: `${p.brand} 官方店`,
      data_updated_at: NOW, created_at: NOW, updated_at: NOW,
    })

    // 子体的属性取值，按下标与父体维度名对齐
    combo.forEach((v, di) => {
      featureRows.push({
        asin, country: COUNTRY, feature_name: p.dims[di],
 feature_value: v, created_at: NOW,
      })
    })

    variantRows.push({
      parent_asin: parentAsin, child_asin: asin, country: COUNTRY,
      display_order: ci + 1, ratio: dec(0.02, 0.5, 4), created_at: NOW,
    })
  })
})

insert(
  'dim_asin',
  ['asin', 'country', 'title', 'img', 'price', 'brand', 'brand_href', 'score', 'star',
   'rating_num', 'is_best_seller', 'is_parent_asin', 'parent_asin', 'first_available_day',
   'seller', 'data_updated_at', 'created_at', 'updated_at'],
  asinRows,
)
insert('dim_asin_feature',
  ['asin', 'country', 'feature_name', 'feature_value', 'created_at'], featureRows)
insert('rel_asin_variant',
  ['parent_asin', 'child_asin', 'country', 'display_order', 'ratio', 'created_at'], variantRows)

// =====================================================================
// 5. 月度销量（40 个月，起点 2023-05 —— 与实测一致）
// =====================================================================
say('\n-- 5. 月度销量。40 个月序列，起点 2023-05（实测原站就是这个范围）')

const BUCKETS = [
  [0, '<50'], [50, '50+'], [100, '100+'], [200, '200+'], [500, '500+'],
  [1000, '1,000+'], [2000, '2,000+'], [5000, '5,000+'], [10000, '10,000+'],
]

function months(count, startY, startM) {
  const list = []
  let y = startY, m = startM
  for (let i = 0; i < count; i++) {
    list.push(`${y}-${String(m).padStart(2, '0')}`)
    m++
    if (m > 12) { m = 1; y++ }
  }
  return list
}
const MONTHS_40 = months(40, 2023, 5)

const boughtRows = []
const listingRows = []
for (const { asin } of allAsins) {
  // 让销量呈缓慢上升趋势，并在中段插入一次跃升，便于 AI 解读异常点
  let level = int(0, 3)
  MONTHS_40.forEach((m, i) => {
    if (i === 20) level = Math.min(level + 2, BUCKETS.length - 1)
    else if (rnd() > 0.88) level = Math.min(level + 1, BUCKETS.length - 1)
    const [lower, label] = BUCKETS[level]
    boughtRows.push({
      asin, country: COUNTRY, stat_month: m,
      bought_lower_bound: lower, bought_label: label, created_at: NOW,
    })
    // Listing 指标快照只取最近 12 个月，避免 seed 过大
    if (i >= 28) {
      listingRows.push({
        asin, country: COUNTRY, stat_month: m,
        price: dec(18, 149), score: dec(3.6, 4.9, 1),
        rating_num: int(120, 250000), bsr: int(120, 90000), created_at: NOW,
      })
    }
  })
}
insert('fact_asin_bought_monthly',
  ['asin', 'country', 'stat_month', 'bought_lower_bound', 'bought_label', 'created_at'],
  boughtRows)
insert('fact_asin_listing_snapshot',
  ['asin', 'country', 'stat_month', 'price', 'score', 'rating_num', 'bsr', 'created_at'],
  listingRows)

// =====================================================================
// 6. 关键词（50 个）
// =====================================================================
say('\n-- 6. 关键词。50 个自造词，含中文翻译')

const KW_HEADS = ['internal', 'portable', 'wireless', 'fleece', 'stainless', 'mechanical',
  'led desk', 'insulated', 'usb c', 'rgb']
const KW_CORES = ['ssd', 'hoodie', 'lamp', 'bottle', 'keyboard', 'hard drive',
  'water bottle', 'sweatshirt', 'reading light', 'gaming keyboard']
const KW_TAILS = ['', ' for laptop', ' for men', ' for office', ' 2 pack',
  ' with usb', ' for travel', ' large', ' cheap', ' best']
const KW_CN = {
  ssd: '固态硬盘', hoodie: '连帽卫衣', lamp: '台灯', bottle: '水瓶', keyboard: '键盘',
  'hard drive': '硬盘', 'water bottle': '保温杯', sweatshirt: '卫衣',
  'reading light': '阅读灯', 'gaming keyboard': '游戏键盘',
}

/**
 * 词核 → 商品品类 code。
 *
 * ⚠️ 这张表是「关键词头部商品」正确性的关键。
 * 原先 rel_keyword_top_asin 用 pick(allAsins) 从**全部**商品里随机取，
 * 结果「sweatshirt（卫衣）」这个词的头部商品里出现了机械键盘 ——
 * 页面上「该词下的头部商品」一眼就是假的，AI 拿到这种数据也会得出错误结论。
 * 绑定品类后，卫衣词只会出现卫衣商品。
 */
const CORE_TO_CODE = {
  ssd: 'SS',
  'hard drive': 'SS',
  hoodie: 'HD',
  sweatshirt: 'HD',
  lamp: 'LP',
  'reading light': 'LP',
  bottle: 'BT',
  'water bottle': 'BT',
  keyboard: 'KB',
  'gaming keyboard': 'KB',
}

const keywordRows = []
const keywords = []
const seenKw = new Set()
let kwId = 4200000
while (keywords.length < 50) {
  const core = pick(KW_CORES)
  const text = `${pick(KW_HEADS)} ${core}${pick(KW_TAILS)}`.trim().replace(/\s+/g, ' ')
  if (seenKw.has(text)) continue
  seenKw.add(text)
  kwId += int(100, 9000)
  const searches = int(800, 260000)
  keywords.push({ id: kwId, text, core, searches })
  keywordRows.push({
    keyword_id: kwId, keyword: text, translate_keyword: KW_CN[core] ?? core,
    country: COUNTRY, est_searches_num: searches, created_at: NOW, updated_at: NOW,
  })
}
insert('dim_keyword',
  ['keyword_id', 'keyword', 'translate_keyword', 'country', 'est_searches_num',
   'created_at', 'updated_at'],
  keywordRows)

// 词根表
const wordRows = [...new Set(keywords.flatMap((k) => k.text.split(' ')))]
  .filter((w) => w.length > 2)
  .map((w) => ({ word: w, country: COUNTRY, translate_word: KW_CN[w] ?? null, created_at: NOW }))
insert('dim_word', ['word', 'country', 'translate_word', 'created_at'], wordRows)

// =====================================================================
// 7. ASIN × 关键词 快照 + 分渠道得分（长表）
// =====================================================================
say('\n-- 7. ASIN×关键词 快照与分渠道得分。渠道用长表（用户已裁决）')

const MONTH_NOW = '2026-08'
const LEAF_CHANNELS = ['nf', 'sp', 'spRec', 'sb', 'sbv']

const kwSnapRows = []
const kwScoreRows = []
const trafficChannelRows = []
const kwRankRows = []

// 每个子体关联 10~18 个关键词，避免 seed 体积爆炸
for (const { asin } of allAsins) {
  const n = int(10, 18)
  const picked = []
  while (picked.length < n) {
    const k = pick(keywords)
    if (!picked.find((x) => x.id === k.id)) picked.push(k)
  }

  for (const k of picked) {
    kwSnapRows.push({
      asin, country: COUNTRY, keyword_id: k.id,
      time_piece_type: 'month', time_piece_value: MONTH_NOW,
      is_listing_search: false,
      is_core: rnd() > 0.8, is_target: rnd() > 0.85,
      piece_max_time: '2026-08-31',
      nf_last_rank: int(1, 144), nf_last_rank_time: NOW, nf_last_rank_asin: asin,
      sp_last_rank: rnd() > 0.5 ? int(1, 60) : null,
      sp_last_rank_time: NOW, sp_last_rank_asin: asin,
      sp_campaign_id: null,
      listing_score_ratio: dec(0.0001, 0.2, 6),
      exposure_positions: rnd() > 0.5 ? 'nf,sp' : 'nf',
      est_searches_num: k.searches, created_at: NOW,
    })

    // 分渠道得分：自然占大头，广告占小头，与实测的 84%/16% 量级一致
    let total = 0
    for (const ch of LEAF_CHANNELS) {
      const base = ch === 'nf' ? dec(50, 900) : dec(0, 120)
      if (base <= 0) continue
      total += base
      kwScoreRows.push({
        asin, country: COUNTRY, keyword_id: k.id,
        time_piece_type: 'month', time_piece_value: MONTH_NOW, channel: ch,
        score: base, score_ratio: 0, score_change: dec(-50, 90),
        score_change_ratio: dec(-0.4, 0.6, 4), contri_change_ratio: dec(-0.2, 0.3, 4),
        created_at: NOW,
      })
    }
    // 回填占比（0-1 小数，与实测一致，不乘 100）
    kwScoreRows
      .filter((r) => r.asin === asin && r.keyword_id === k.id)
      .forEach((r) => { r.score_ratio = Number((r.score / total).toFixed(6)) })

    // 30 天排名快照（goal.md 要求）
    for (let d = 0; d < 30; d++) {
      const day = new Date(Date.UTC(2026, 7, 20 + d))
      kwRankRows.push({
 asin, country: COUNTRY, keyword_id: k.id, rank_type: 'nf',
        stat_date: day.toISOString().slice(0, 10),
 rank_position: int(1, 144), page_no: int(1, 3), created_at: NOW,
      })
    }
  }
}

insert('fact_asin_keyword_snapshot',
  ['asin', 'country', 'keyword_id', 'time_piece_type', 'time_piece_value', 'is_listing_search',
   'is_core', 'is_target', 'piece_max_time', 'nf_last_rank', 'nf_last_rank_time',
   'nf_last_rank_asin', 'sp_last_rank', 'sp_last_rank_time', 'sp_last_rank_asin',
   'sp_campaign_id', 'listing_score_ratio', 'exposure_positions', 'est_searches_num',
   'created_at'],
  kwSnapRows)

insert('fact_asin_keyword_score',
  ['asin', 'country', 'keyword_id', 'time_piece_type', 'time_piece_value', 'channel',
   'score', 'score_ratio', 'score_change', 'score_change_ratio', 'contri_change_ratio',
   'created_at'],
  kwScoreRows)

insert('fact_keyword_rank_history',
  ['asin', 'country', 'keyword_id', 'rank_type', 'stat_date', 'rank_position', 'page_no',
   'created_at'],
  kwRankRows)

// ASIN 级分渠道流量（查流量结构页用）
for (const { asin } of allAsins) {
  const nf = dec(3000, 20000)
  const sp = dec(200, 3000)
  const spRec = dec(50, 900)
  const sb = dec(0, 400)
  const sbv = dec(0, 200)
  const ad = sp + spRec + sb + sbv
  const total = nf + ad
  const mk = (ch, v) => ({
    asin, country: COUNTRY, time_piece_type: 'month', time_piece_value: MONTH_NOW,
    channel: ch, score: v, score_ratio: Number((v / total).toFixed(6)),
    score_change: dec(-500, 900), score_change_ratio: dec(-0.3, 0.5, 4),
    contri_change_ratio: dec(-0.2, 0.3, 4), created_at: NOW,
  })
  trafficChannelRows.push(
    mk('total', total), mk('nf', nf), mk('ad', ad),
    mk('allSp', sp + spRec), mk('sp', sp), mk('spRec', spRec),
    mk('allSb', sb + sbv), mk('sb', sb), mk('sbv', sbv),
  )
}
insert('fact_asin_traffic_channel',
  ['asin', 'country', 'time_piece_type', 'time_piece_value', 'channel', 'score',
   'score_ratio', 'score_change', 'score_change_ratio', 'contri_change_ratio', 'created_at'],
  trafficChannelRows)

// =====================================================================
// 8. 广告（3 个活动示例）
// =====================================================================
say('\n-- 8. 广告活动。3 个示例，含投放小组与搜索词曝光')

const campaigns = []
const productAds = []
const campaignAdRel = []
const searchTermRows = []

const STRATEGIES = ['多广告组，多变体', '单广告组，多变体', '单广告组，单变体']

for (let i = 0; i < 3; i++) {
  const encCampaignId = `A0SEED${String(i + 1).padStart(3, '0')}CAMPAIGN${i}`
  const fakeCampaignId = `C${String(i + 1).padStart(3, '0')}`
  campaigns.push({
    encrypt_campaign_id: encCampaignId, country: COUNTRY,
    fake_campaign_id: fakeCampaignId, ad_type: i + 1,
    product_type: 'SPONSORED_PRODUCTS', strategy: STRATEGIES[i],
    asin_num: int(3, 20), ad_num: int(5, 40),
    campaign_created_at: '2025-11-25', last_ad_created_at: '2026-08-15',
    created_at: NOW, updated_at: NOW,
  })

  // 每个活动下 3 个投放小组
  for (let j = 0; j < 3; j++) {
    const encAdId = `A0SEED${String(i + 1)}${String(j + 1)}PRODUCTAD${j}`
    productAds.push({
      encrypt_ad_id: encAdId, country: COUNTRY,
      fake_ad_id: `A${i}${j}${String.fromCharCode(65 + j)}`,
      ad_created_at: '2025-11-25', created_at: NOW,
    })

    // 时序关系：实测 campaigns[].ads 是按日期分组的对象，
    // 同一活动在不同周包含的投放小组集合会变，所以关系表带 stat_date
    for (let w = 0; w < 4; w++) {
      const d = new Date(Date.UTC(2026, 7, 2 + w * 7))
      campaignAdRel.push({
        encrypt_campaign_id: encCampaignId, encrypt_ad_id: encAdId, country: COUNTRY,
 stat_date: d.toISOString().slice(0, 10), created_at: NOW,
      })
    }

    // 搜索词曝光（买家搜索词，不是投放词）
    const target = allAsins[int(0, allAsins.length - 1)]
    for (let t = 0; t < 4; t++) {
      const k = pick(keywords)
      const d = new Date(Date.UTC(2026, 7, 2 + t * 7))
      searchTermRows.push({
        encrypt_ad_id: encAdId, country: COUNTRY, keyword_id: k.id,
 variant_asin: target.asin, stat_date: d.toISOString().slice(0, 10),
 encrypt_campaign_id: encCampaignId, ad_type: i + 1,
        traffic_type: pick(['sp', 'spRec', 'sb', 'sbv']),
        score: dec(10, 800), rank_position: int(1, 60), created_at: NOW,
      })
    }
  }
}

insert('dim_ad_campaign',
  ['encrypt_campaign_id', 'country', 'fake_campaign_id', 'ad_type', 'product_type',
   'strategy', 'asin_num', 'ad_num', 'campaign_created_at', 'last_ad_created_at',
   'created_at', 'updated_at'],
  campaigns)
insert('dim_ad_product_ad',
  ['encrypt_ad_id', 'country', 'fake_ad_id', 'ad_created_at', 'created_at'], productAds)
insert('rel_ad_campaign_product_ad',
  ['encrypt_campaign_id', 'encrypt_ad_id', 'country', 'stat_date', 'created_at'],
  campaignAdRel)
insert('fact_ad_search_term_exposure',
  ['encrypt_ad_id', 'country', 'keyword_id', 'variant_asin', 'stat_date',
   'encrypt_campaign_id', 'ad_type', 'traffic_type', 'score', 'rank_position', 'created_at'],
  searchTermRows)

// =====================================================================
// 9. 推荐专栏曝光 + 多变体自然位 + 运营事件
// =====================================================================
say('\n-- 9. 推荐专栏曝光、多变体自然位日快照、运营动作事件')

const recPeriodRows = []
for (const { asin } of allAsins.slice(0, 8)) {
  for (const [title] of REC_COLUMNS.slice(0, 4)) {
    // 实测该数据极度稀疏（31 天仅 1 天有值），所以只插少量天
    for (let d = 0; d < 2; d++) {
      const day = new Date(Date.UTC(2026, 7, 5 + d * 12))
      recPeriodRows.push({
        asin, country: COUNTRY, rec_title: title,
 stat_date: day.toISOString().slice(0, 10),
        ratio: dec(0.001, 0.15, 5), campaign_cnt: int(0, 6), keyword_cnt: int(0, 20),
        created_at: NOW,
      })
    }
  }
}
insert('fact_asin_rec_column_period',
  ['asin', 'country', 'rec_title', 'stat_date', 'ratio', 'campaign_cnt', 'keyword_cnt',
   'created_at'],
  recPeriodRows)

const multinfRows = []
const opEventRows = []
// 按父体 ASIN 生成：多变体自然位是「整个变体组」的指标，
// 与 fact_asin_multinf_keyword_variant.parent_asin 的语义一致
for (const prod of PRODUCTS) {
  const parentAsin = `B0SEED${prod.code}P0`
  const groupSize = allAsins.filter((a) => a.parentAsin === parentAsin).length
  for (let d = 0; d < 30; d++) {
    const day = new Date(Date.UTC(2026, 7, 20 + d))
    multinfRows.push({
      asin: parentAsin, country: COUNTRY, stat_date: day.toISOString().slice(0, 10),
      asin_cnt: int(1, Math.max(1, groupSize)), keyword_cnt: int(0, 30),
      score: dec(100, 4000), extra_score: dec(0, 800),
      listing_asin_cnt: groupSize, created_at: NOW,
    })
  }
  // 运营事件是稀疏的，每组只给 1~2 个
  const evCount = int(1, 2)
  for (let e = 0; e < evCount; e++) {
    const day = new Date(Date.UTC(2026, 7, 22 + e * 9))
    const type = pick(['titleImg', 'campaignId', 'priceChange', 'coupon'])
    opEventRows.push({
      asin: parentAsin, country: COUNTRY, stat_date: day.toISOString().slice(0, 10),
      event_type: type,
      event_detail: JSON.stringify({ note: '自造 seed 事件', type }),
      created_at: NOW,
    })
  }
}
// 多变体自然位的核心数据：关键词 × 变体 的排名明细。
// 这个页面的价值就在于「同一个词下有多个变体同时占位」，
// 所以必须让部分关键词带 2~3 个变体，不能一个词只挂一个。
const multinfKwVariantRows = []
const multinfKwRows = []
for (const prod of PRODUCTS) {
  // 父体 ASIN 由商品码推出，与上面生成时一致
  const parentAsin = `B0SEED${prod.code}P0`
  // 该父体下的子体
  const children = allAsins
    .filter((a) => a.parentAsin === parentAsin)
    .map((a) => a.asin)
  if (!children.length) continue

  const kwCount = int(4, 8)
  const pickedKw = []
  while (pickedKw.length < kwCount) {
    const k = pick(keywords)
    if (!pickedKw.find((x) => x.id === k.id)) pickedKw.push(k)
  }

  for (const k of pickedKw) {
    // 60% 的词有多个变体同时占位 —— 这正是「多变体自然位」要展示的场景
    const multi = rnd() > 0.4
    const variants = multi ? children.slice(0, int(2, Math.min(3, children.length))) : [children[0]]

    variants.forEach((vAsin, vi) => {
      multinfKwVariantRows.push({
        parent_asin: parentAsin, country: COUNTRY, keyword_id: k.id,
        variant_asin: vAsin,
        time_piece_type: 'month', time_piece_value: MONTH_NOW,
        // 主曝光变体排名靠前，其余靠后
        rank_position: vi === 0 ? int(1, 24) : int(25, 96),
        variant_role: vi === 0 ? 'main' : 'sibling',
        created_at: NOW,
      })
    })

    multinfKwRows.push({
      parent_asin: parentAsin, country: COUNTRY, keyword_id: k.id,
      time_piece_type: 'month', time_piece_value: MONTH_NOW,
      avg_rank: dec(1, 96),
      appear_days: int(1, 30),
      asin_cnt: variants.length,
      created_at: NOW,
    })
  }
}
insert('fact_asin_multinf_keyword_variant',
  ['parent_asin', 'country', 'keyword_id', 'variant_asin', 'time_piece_type',
   'time_piece_value', 'rank_position', 'variant_role', 'created_at'],
  multinfKwVariantRows)
// 注意：本表列名是 asin，而 variant 表用的是 parent_asin（schema 里就不一致）
insert('fact_asin_multinf_keyword',
  ['asin', 'country', 'keyword_id', 'time_piece_type', 'time_piece_value',
   'avg_rank', 'appear_days', 'asin_cnt', 'created_at'],
  multinfKwRows.map((r) => ({ ...r, asin: r.parent_asin })))

// 关键词头部 ASIN：某个词下自然位靠前的商品（关键词来源页用）
const topAsinRows = []
for (const k of keywords.slice(0, 25)) {
  // 只从该词所属品类的商品里挑，保证「词 → 头部商品」语义自洽。
  // 同品类子体不够 5 个时就有几个算几个，不去别的品类凑数。
  const code = CORE_TO_CODE[k.core]
  const sameCategory = code
    ? allAsins.filter((a) => a.product.code === code)
    : allAsins
  const pool = sameCategory.length ? sameCategory : allAsins
  const picks = []
  const want = Math.min(int(5, 10), pool.length)
  let guard = 0
  while (picks.length < want && guard++ < 200) {
    const a = pick(pool)
    if (!picks.find((x) => x.asin === a.asin)) picks.push(a)
  }
  picks.forEach((a, i) => {
    topAsinRows.push({
      keyword_id: k.id, country: COUNTRY, asin: a.asin,
      rank_position: i + 1 + int(0, 2), created_at: NOW,
    })
  })
}
insert('rel_keyword_top_asin',
  ['keyword_id', 'country', 'asin', 'rank_position', 'created_at'],
  topAsinRows)

insert('fact_asin_multinf_daily',
  ['asin', 'country', 'stat_date', 'asin_cnt', 'keyword_cnt', 'score', 'extra_score',
   'listing_asin_cnt', 'created_at'],
  multinfRows)
insert('fact_asin_op_event',
  ['asin', 'country', 'stat_date', 'event_type', 'event_detail', 'created_at'],
  opEventRows)

// =====================================================================
// 10. 供应商（10 个，每个 5 个货源商品）
// =====================================================================
say('\n-- 10. 供应商货源。10 个供应商 × 5 个商品。本期仅占位数据，无采集逻辑')

const SUP_CITIES = ['深圳', '东莞', '宁波', '义乌', '温州', '泉州', '青岛', '苏州', '佛山', '金华']
const SUP_KINDS = ['电子科技', '日用百货', '服饰', '家居', '五金']
const supplierRows = []
for (let s = 0; s < 10; s++) {
  const city = SUP_CITIES[s]
  const name = `${city}${pick(SUP_KINDS)}有限公司`
  for (let p = 0; p < 5; p++) {
    const offerProduct = pick(PRODUCTS)
    supplierRows.push({
      id: nextId(), supplier_name: name,
      offer_id: `SEEDOFFER${s}${p}`,
      // 标题和图片必须取**同一个**品类，否则会出现
      // 「标题写键盘、配图是保温杯」这种一眼假的组合
      title: `${pick(['优质', '厂家直供', '现货', '爆款'])}${offerProduct.title}`,
      img: photoUrl(offerProduct.code, p, 200),
      price: dec(8, 120), min_order: pick([1, 2, 5, 10, 50]),
      location: city, created_at: NOW,
    })
  }
}
insert('dim_supplier',
  ['id', 'supplier_name', 'offer_id', 'title', 'img', 'price', 'min_order', 'location',
   'created_at'],
  supplierRows)

// =====================================================================
say(`
-- =====================================================================
-- Seed 完成
--
-- 测试账号（密码均为 test1234）：
--   普通用户  user@looom.dev    100 积分
--   管理员    admin@looom.dev   9999 积分
--
-- 数据量参考：
--   ASIN ${asinRows.length}（含 ${PRODUCTS.length} 个父体）
--   关键词 ${keywordRows.length}
--   月度销量 ${boughtRows.length} 行（40 个月 × 子体数）
--   关键词快照 ${kwSnapRows.length} 行
--   分渠道得分 ${kwScoreRows.length} 行
--   30 天排名快照 ${kwRankRows.length} 行
--   广告活动 ${campaigns.length} / 投放小组 ${productAds.length}
--   供应商货源 ${supplierRows.length} 行
-- =====================================================================`)

// 自检：所有 ASIN 必须是 10 位，否则后端的格式校验会把请求全挡下
for (const r of asinRows) {
  if (!/^[A-Z0-9]{10}$/.test(r.asin)) {
    throw new Error(`生成的 ASIN 非法（须为 10 位大写字母数字）：${r.asin}`)
  }
}

writeFileSync('db/seed.sql', out.join('\n') + '\n')

console.log('生成完成：db/seed.sql')
console.log(`  ASIN ${asinRows.length}（父体 ${PRODUCTS.length}）`)
console.log(`  关键词 ${keywordRows.length}`)
console.log(`  月度销量 ${boughtRows.length}`)
console.log(`  关键词快照 ${kwSnapRows.length}`)
console.log(`  分渠道得分 ${kwScoreRows.length}`)
console.log(`  排名快照 ${kwRankRows.length}`)
console.log(`  广告 ${campaigns.length} 活动 / ${productAds.length} 投放小组`)
console.log(`  多变体明细 ${multinfKwVariantRows.length} / 关键词头部ASIN ${topAsinRows.length}`)
console.log(`  供应商 ${supplierRows.length}`)

/**
 * 把 sif_sweep.py 落盘的 CLI 响应灌进 Doris。
 *
 * 用法：
 *   node scripts/sif_load_to_doris.mjs --in /tmp/sif_b0fv --asin B0FVNPKGJ8 [--country US] [--dry]
 *
 * ## 为什么是「读目录」而不是「直接调 CLI」
 *
 * 网关按调用次数计费（每次查询都实时打一次 whoami，有意不缓存），
 * 实测 43 个 endpoint 扫一遍就把额度打穿了。所以采集与入库分成两步：
 * 采集用 sif_sweep.py 落盘一次，入库可以反复重跑、改映射、验证，
 * 不再产生任何网关调用。
 *
 * ## 写入语义
 *
 * 目标表都是 Doris Unique Key + merge-on-write，INSERT 即整行 upsert。
 * 但这也意味着 **没写进 VALUES 的列会被写成 NULL**，不是「保持原值」。
 * 所以 dim_asin 这种已有数据的表必须先 SELECT 出原行、合并后再写回，
 * 否则会把别人 ETL 灌的 title/price 清空。见 mergeDimAsin()。
 */
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

/**
 * mysql2 装在 apps/api/node_modules 下，而本脚本在 scripts/ ——
 * ESM 的 import 按**文件所在目录**向上找 node_modules，找不到会直接报错，
 * 跟 cwd 无关。所以显式从 apps/api 解析。
 */
const require = createRequire(path.join(import.meta.dirname, '..', 'apps', 'api', 'package.json'))
const mysql = require('mysql2/promise')

// ---------- CLI 参数 ----------

const argv = process.argv.slice(2)
const arg = (k, d = null) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const IN_DIR = arg('in', '/tmp/sif_b0fv')
const ASIN = arg('asin', 'B0FVNPKGJ8')
const COUNTRY = arg('country', 'US')
const DRY = argv.includes('--dry')

// ---------- 读取响应 ----------

/**
 * 剥掉 CLI 信封和上游信封。
 * CLI 返回 {status, data:{code, data, message}}，有的接口少一层。
 * 失败的响应（quota_exhausted / 404）没有 data，返回 null 让调用方跳过。
 */
function load(endpoint) {
  const f = path.join(IN_DIR, `${endpoint}.json`)
  if (!fs.existsSync(f)) return null
  let p
  try {
    p = JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return null
  }
  if (p.status !== 'ok') return null
  const d = p.data
  if (d && typeof d === 'object' && 'code' in d && 'data' in d) return d.data
  return d
}

// ---------- 小工具 ----------

const nn = (v) => (v === undefined || v === '' ? null : v)
/** 数字化，但把 NaN/Infinity 挡在外面 —— Doris 会拒收 */
const num = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v))
const bool = (v) => (v === null || v === undefined ? null : v ? 1 : 0)

const now = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}
const NOW = now()

/**
 * 销量分档：数值 → 原站展示标签。
 *
 * ⚠️ CLI 的 boughtHistory 给的是**分档下界数字**（实测取值集合只有
 * 0/50/100/200/300 这种整档值，不是任意精确销量），所以这里是
 * 「下界 → 标签」的反查，而不是把精确值归档。
 * 档位取自 dict_bought_bucket，0 对应 "<50"。
 */
const BUCKETS = [
  [10000, '10,000+'],
  [5000, '5,000+'],
  [2000, '2,000+'],
  [1000, '1,000+'],
  [500, '500+'],
  [200, '200+'],
  [100, '100+'],
  [50, '50+'],
]
function boughtLabel(v) {
  if (v === null || v === undefined) return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  for (const [lo, label] of BUCKETS) if (n >= lo) return label
  return '<50'
}

// ---------- 数据库 ----------

const env = Object.fromEntries(
  fs
    .readFileSync(path.join(import.meta.dirname, '..', '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)

const conn = await mysql.createConnection({
  host: env.DB_HOST,
  port: Number(env.DB_PORT),
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  supportBigNumbers: true,
  bigNumberStrings: true,
})

const stats = {}
const note = (t, n) => {
  stats[t] = (stats[t] ?? 0) + n
}

/**
 * 分批 INSERT。
 *
 * Doris 每条 INSERT 都是一次导入事务，逐行写 390 行会非常慢且产生大量
 * 小版本（影响 compaction）。所以攒成多值 INSERT 批量提交。
 * 批大小 200 是在「SQL 长度」和「事务数」之间取的折中。
 */
async function insertBatch(table, columns, rows, batch = 200) {
  if (!rows.length) return
  if (DRY) {
    console.log(`[dry] ${table}: ${rows.length} 行, 首行 ${JSON.stringify(rows[0])}`)
    note(table, rows.length)
    return
  }
  const cols = columns.map((c) => `\`${c}\``).join(', ')
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch)
    const ph = chunk.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ')
    const flat = chunk.flat()
    await conn.query(`INSERT INTO \`${table}\` (${cols}) VALUES ${ph}`, flat)
  }
  note(table, rows.length)
}

// =====================================================================
// 1. dim_asin —— 商品主档（合并写，不能覆盖）
//
// 数据来源三处，按可信度叠加：
//   web-asin-variants  → 全组 388 个 ASIN 的 img/price/score/star/rating/BS
//   web-sales-asin     → 10 个的 firstAvailableDay / brand
//   asin-basic-info    → 探针 ASIN 自身
//
// ⚠️ 必须先读原行再合并：Unique Key 表的 INSERT 是整行替换，
//    漏列会被写成 NULL，把别人 ETL 灌的 title 清掉。
// =====================================================================

const DIM_ASIN_COLS = [
  'asin', 'country', 'title', 'img', 'price', 'brand', 'brand_href',
  'score', 'star', 'rating_num', 'is_best_seller', 'is_parent_asin',
  'parent_asin', 'first_available_day', 'seller', 'data_updated_at',
  'created_at', 'updated_at',
]

async function mergeDimAsin(patches) {
  const asins = [...patches.keys()]
  if (!asins.length) return

  // 原行按 1000 个一批读回来（IN 列表太长 Doris 会拒绝解析）
  const existing = new Map()
  for (let i = 0; i < asins.length; i += 500) {
    const chunk = asins.slice(i, i + 500)
    const [rows] = await conn.query(
      `SELECT ${DIM_ASIN_COLS.map((c) => `\`${c}\``).join(', ')} FROM dim_asin
        WHERE country = ? AND asin IN (${chunk.map(() => '?').join(', ')})`,
      [COUNTRY, ...chunk],
    )
    for (const r of rows) existing.set(r.asin, r)
  }

  const out = []
  for (const [asin, patch] of patches) {
    const old = existing.get(asin) ?? {}
    // 合并规则：patch 里非 null 的字段覆盖旧值，null 的保留旧值。
    // 这样重跑不会把已有数据抹掉，也不会用 null 覆盖真实值。
    const merged = {}
    for (const c of DIM_ASIN_COLS) {
      const pv = patch[c]
      merged[c] = pv === null || pv === undefined ? (old[c] ?? null) : pv
    }
    merged.asin = asin
    merged.country = COUNTRY
    merged.created_at = old.created_at ? fmtDt(old.created_at) : NOW
    merged.updated_at = NOW
    merged.data_updated_at = NOW
    // date / datetime 列从 DB 读回来是 Date 对象，要转回字符串
    merged.first_available_day = fmtDate(merged.first_available_day)
    out.push(DIM_ASIN_COLS.map((c) => merged[c]))
  }
  await insertBatch('dim_asin', DIM_ASIN_COLS, out)
}

/** Date 对象 / 字符串 → 'YYYY-MM-DD'，null 透传 */
function fmtDate(v) {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v).slice(0, 10)
}
/**
 * → 'YYYY-MM-DD HH:mm:ss'，null 透传。
 *
 * ⚠️ 接口的时间字段有三种形态，必须都认：
 *   Date 对象      —— 从 Doris 读回来的
 *   'YYYY-MM-DD…'  —— 字符串
 *   1789200000000  —— **epoch 毫秒数**（updateTime / spLastRankTime 都是这种）
 * 漏掉第三种会把 "1789200000000" 原样塞进 DATETIME 列，Doris 存成 NULL 或报错。
 */
function fmtDt(v) {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ')
  if (typeof v === 'number' || /^\d{10,}$/.test(String(v))) {
    const ms = Number(v)
    if (!Number.isFinite(ms)) return null
    // 10 位是秒、13 位是毫秒
    const d = new Date(String(v).length <= 10 ? ms * 1000 : ms)
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace('T', ' ')
  }
  return String(v).slice(0, 19).replace('T', ' ')
}

// =====================================================================
// 主流程
// =====================================================================

console.log(`[load] ${ASIN} / ${COUNTRY} / 源目录 ${IN_DIR}${DRY ? ' （dry-run）' : ''}`)

const variantsResp = load('web-asin-variants')
const salesAsinResp = load('web-sales-asin')
const basicResp = load('asin-basic-info')
const listingSummary = load('listing-summary')
const salesKeywordResp = load('web-sales-keyword')
const listingHistory = load('web-sales-listing-history')
const trafficTrend = load('traffic-trend')
const kwList = load('asin-keyword-list')
const kwOverview = load('keyword-overview')
const abaTrend = load('keyword-aba-trend')
const rankHistory = load('asin-keyword-rank-history')
const bsExposure = load('asin-bs-exposure')
const salesHistory = load('asin-sales-history')

// ---- 1.1 变体组：dim_asin 补字段 + rel_asin_variant + dim_asin_feature ----

/** asin → dim_asin 的待写字段 */
const asinPatch = new Map()
const patch = (asin, fields) => {
  if (!asin) return
  const cur = asinPatch.get(asin) ?? {}
  for (const [k, v] of Object.entries(fields)) {
    // 先到先得：先灌的源可信度更高，后面的只补空缺
    if (cur[k] === null || cur[k] === undefined) cur[k] = v
  }
  asinPatch.set(asin, cur)
}

/** asin → { 维度名: 取值 }，用于 dim_asin_feature */
const featureMap = new Map()
/** 维度名列表（父体那一层存维度名本身，feature_value 为空） */
let dimensionNames = []

if (variantsResp?.variants) {
  // variants[0] 的 asin 是空串 —— 那是「整组汇总」行，不是商品，要跳过
  const real = variantsResp.variants.filter((v) => v.asin)
  console.log(`[load] web-asin-variants: ${real.length} 个变体`)

  for (const v of real) {
    patch(v.asin, {
      title: nn(v.title),
      img: nn(v.img),
      price: num(v.price),
      // asinScore 是真实评分(4.2)，score 在这个接口里是「流量得分」不是评分 ——
      // 实测 score=58.7 / 647037 这种量级，绝不是 1-5 分的评分
      score: num(v.asinScore),
      star: num(v.star),
      rating_num: num(v.ratingNum),
      is_best_seller: bool(v.isBestSeller),
      parent_asin: ASIN,
      is_parent_asin: v.asin === ASIN ? 1 : 0,
    })
    if (Array.isArray(v.features) && v.features.length) {
      featureMap.set(v.asin, v.features)
    }
  }
}

// 维度名来自 web-sales-asin 的 features[].feature（Specialsizetype/Size/Color）
if (Array.isArray(salesAsinResp?.features)) {
  dimensionNames = salesAsinResp.features
  console.log(`[load] 维度: ${dimensionNames.join(' / ')}`)
}

// web-sales-asin 独有：brand / brandHref / firstAvailableDay
for (const a of salesAsinResp?.asins ?? []) {
  patch(a.asin, {
    title: nn(a.title),
    img: nn(a.img),
    price: num(a.price),
    score: num(a.score),
    star: num(a.star),
    rating_num: num(a.ratingNum),
    brand: nn(a.brand),
    brand_href: nn(a.brandHref),
    first_available_day: nn(a.firstAvailableDay),
    parent_asin: ASIN,
    is_parent_asin: a.asin === ASIN ? 1 : 0,
  })
}

// asin-basic-info：探针自身，字段最全（含 isBestSeller / brand）
for (const a of basicResp ?? []) {
  patch(a.asin, {
    title: nn(a.title),
    img: nn(a.img),
    price: num(a.price),
    score: num(a.score),
    star: num(a.star),
    rating_num: num(a.ratingNum),
    brand: nn(a.brand),
    brand_href: nn(a.brandLink),
    is_best_seller: bool(a.isBestSeller),
  })
}

/**
 * 父体标记。
 *
 * ⚠️ 这是当前库里最关键的一处修补：rel_asin_variant 有 12731 条变体关系、
 * 368 个不同 parent_asin，但 dim_asin 里 is_parent_asin=1 的只有 1 条 ——
 * 之前的 ETL 没回填这个标记。
 * 后端 getSalesOverview 靠它判断「传入的是父体还是子体」，不回填的话
 * 查父体会走成「传子体」分支。
 *
 * 本接口的 pasin=false 表示「探针 ASIN 自身不是父体」，
 * 但 rel_asin_variant 里它确实是 390 个子体的 parent —— 以关系表为准。
 */
patch(ASIN, { is_parent_asin: 1, parent_asin: ASIN })

await mergeDimAsin(asinPatch)

// ---- 1.2 rel_asin_variant：display_order + ratio ----

if (variantsResp?.variants) {
  const rows = variantsResp.variants
    .filter((v) => v.asin)
    .map((v) => [ASIN, v.asin, COUNTRY, num(v.order) ?? 0, num(v.ratio), NOW])
  await insertBatch(
    'rel_asin_variant',
    ['parent_asin', 'child_asin', 'country', 'display_order', 'ratio', 'created_at'],
    rows,
  )
}

// ---- 1.3 dim_asin_feature：维度名 + 各变体取值 ----

/**
 * 两层结构（与后端 sales.service 的读法对齐）：
 *   父体行：feature_value 为空，只声明维度名 → 前端据此生成表格列
 *   子体行：feature_value 是实际取值
 *
 * features 数组靠**下标**与 dimensionNames 对齐（实测 web-asin-variants
 * 的 features 是 ["Standard","XX-Large","Pink"] 这种无键数组，
 * 顺序与 web-sales-asin 的 features 声明一致）。
 */
if (dimensionNames.length) {
  const featRows = []

  /**
   * 父体自身有没有属性值，决定这一行存什么。
   *
   * 主键是 (asin, country, feature_name)，所以同一个 ASIN 的同一维度
   * 只能存一行：要么是「维度声明」（feature_value 为空），要么是它自己的
   * 属性取值，二者互斥。
   *
   * 实测 B0FVNPKGJ8 既是父体又是在售变体，features=["Standard","XX-Large","Pink"]。
   * 这种情况下**属性值优先** —— 丢掉它会让父体行的 Color/Size 显示成「—」，
   * 而它明明是个有颜色有尺码的实物。维度名则由后端从全组并集兜底推导
   * （见 sales.service.ts 的 dimensions 计算）。
   */
  const parentOwnVals = featureMap.get(ASIN)
  const parentIsAlsoVariant =
    Array.isArray(parentOwnVals) && parentOwnVals.length === dimensionNames.length

  if (!parentIsAlsoVariant) {
    // 纯分组节点：存维度声明行
    for (const d of dimensionNames) featRows.push([ASIN, COUNTRY, d, '', NOW])
  } else {
    console.log(`[load] ${ASIN} 既是父体又是在售变体，其 dim_asin_feature 存真实属性值而非维度声明`)
  }

  let skipped = 0
  for (const [asin, vals] of featureMap) {
    // 纯分组节点的父体已写声明行，不再写取值；是在售变体则照常写
    if (asin === ASIN && !parentIsAlsoVariant) continue
    if (vals.length !== dimensionNames.length) {
      // 长度不一致说明下标对齐假设不成立，宁可跳过也不要错配属性
      skipped++
      continue
    }
    vals.forEach((val, i) => {
      if (val === null || val === undefined || val === '') return
      featRows.push([asin, COUNTRY, dimensionNames[i], String(val), NOW])
    })
  }
  if (skipped) console.log(`[load] dim_asin_feature: ${skipped} 个变体的属性数与维度数不符，已跳过`)
  await insertBatch(
    'dim_asin_feature',
    ['asin', 'country', 'feature_name', 'feature_value', 'created_at'],
    featRows,
  )
}

// ---- 2. fact_asin_bought_monthly：逐月销量 ----

/**
 * 两个源都给逐月销量，字段形状不同：
 *   web-sales-asin           → asins[].boughtHistory[] + boughtHistoryDates[]（各 ASIN 自带日期轴）
 *   web-sales-listing-history → chars[].boughtList[].bought + 顶层 boughtHistoryDates[]（共用日期轴）
 *
 * 两者靠**下标**与日期数组对齐，长度不符时跳过 —— 错位会把 8 月的销量
 * 写到 5 月去，这种错误在页面上看不出来但结论全错。
 */
const boughtRows = new Map() // `${asin}|${month}` → row，去重（两个源会重叠）
const addBought = (asin, month, v) => {
  if (!asin || !month) return
  const n = num(v)
  if (n === null) return // null 表示该月无数据，不写 0（会被误读成销量归零）
  boughtRows.set(`${asin}|${month}`, [asin, COUNTRY, month, n, boughtLabel(n), NOW])
}

for (const a of salesAsinResp?.asins ?? []) {
  const hist = a.boughtHistory
  const dates = a.boughtHistoryDates
  if (!Array.isArray(hist) || !Array.isArray(dates)) continue
  if (hist.length !== dates.length) {
    console.log(`[load] ${a.asin} boughtHistory(${hist.length}) 与日期(${dates.length}) 长度不符，跳过`)
    continue
  }
  hist.forEach((v, i) => addBought(a.asin, dates[i], v))
}

if (listingHistory?.chars && Array.isArray(listingHistory.boughtHistoryDates)) {
  const dates = listingHistory.boughtHistoryDates
  for (const ch of listingHistory.chars) {
    const list = ch.boughtList
    if (!Array.isArray(list)) continue
    if (list.length !== dates.length) {
      console.log(`[load] ${ch.dimVal} boughtList(${list.length}) 与日期(${dates.length}) 长度不符，跳过`)
      continue
    }
    // dimVal 在 dimension=1 时就是 ASIN（实测值形如 B0FDJWW351）
    list.forEach((b, i) => addBought(ch.dimVal, dates[i], b?.bought))
  }
}

// asin-sales-history：探针自身的长序列
if (salesHistory?.chars && Array.isArray(salesHistory.boughtHistoryDates)) {
  const dates = salesHistory.boughtHistoryDates
  for (const ch of salesHistory.chars) {
    const list = ch.boughtList
    if (!Array.isArray(list) || list.length !== dates.length) continue
    list.forEach((v, i) => addBought(ch.dimVal, dates[i], v))
  }
}

// asin-bs-exposure：40 个月的长序列（2023-05 起，与 goal.md 实测一致）
for (const [, v] of Object.entries(bsExposure ?? {})) {
  const hist = v?.boughtHistory
  const dates = v?.boughtHistoryDates
  if (!Array.isArray(hist) || !Array.isArray(dates) || hist.length !== dates.length) continue
  hist.forEach((x, i) => addBought(v.asin, dates[i], x))
}

await insertBatch(
  'fact_asin_bought_monthly',
  ['asin', 'country', 'stat_month', 'bought_lower_bound', 'bought_label', 'created_at'],
  [...boughtRows.values()],
)

// ---- 3. fact_asin_keyword_overview：各渠道流量词数量 ----

/**
 * listing-summary 给的是「每个变体各渠道有多少个流量词」，
 * 字段名就是渠道码：total / natural / ad / sp / spRec / brand / vedio / ac / rec。
 *
 * ⚠️ 渠道码要映射到 dict_traffic_channel 的 code，不能直接用接口字段名：
 *    接口的 natural 对应字典里的 nf，vedio 对应 sbv（字典 name_en=sbv）。
 *    不映射的话前端按 code 取不到中文名，页面会显示英文字段名。
 */
const CH_MAP = {
  total: 'total',
  natural: 'nf',
  ad: 'ad',
  sp: 'sp',
  spRec: 'spRec',
  brand: 'sb',
  brandVedio: 'sbv',
  ac: 'ac',
}

const TP_TYPE = 'month'
/** 用哪个月做口径：取 ranking-update-time 的 month，没有就用数据里最新的月 */
const rankingTime = load('ranking-update-time')
const TP_VALUE =
  rankingTime?.month ??
  [...new Set([...boughtRows.keys()].map((k) => k.split('|')[1]))].sort().pop() ??
  null
console.log(`[load] 时间口径 ${TP_TYPE}=${TP_VALUE}`)

if (listingSummary?.asins && TP_VALUE) {
  const rows = []
  for (const a of listingSummary.asins) {
    for (const [srcKey, code] of Object.entries(CH_MAP)) {
      const cnt = num(a[srcKey])
      if (cnt === null) continue
      // is_listing_search=0：非「listing 内搜索」口径，与后端默认读法一致
      rows.push([a.asin, COUNTRY, TP_TYPE, TP_VALUE, 0, code, cnt, NOW])
    }
  }
  await insertBatch(
    'fact_asin_keyword_overview',
    ['asin', 'country', 'time_piece_type', 'time_piece_value', 'is_listing_search',
      'channel', 'keyword_cnt', 'created_at'],
    rows,
  )
}

// ---- 4. fact_asin_traffic_channel：分渠道流量得分 ----

/**
 * traffic-trend 是**平行数组**结构：dates[] 与 spScore[]/nfScore[] 等等按下标对齐，
 * 每个元素是 {score, scoreRatio, scoreChange, scoreChangeRatio, contriChangeRatio}。
 *
 * 表的粒度是 month，而接口给的是**逐日** 403 天 —— 所以要按月聚合。
 * 聚合口径：score 取该月**最后一个有值的日**（这是「当月末的流量水平」，
 * 不是求和 —— score 是存量型指标，日与日之间会重复计同一批流量词）。
 */
const TREND_CH = {
  totalScore: 'total',
  nfScore: 'nf',
  adScore: 'ad',
  spScore: 'sp',
  recSpScore: 'spRec',
  sbScore: 'sb',
  sbvScore: 'sbv',
}

if (trafficTrend?.dates) {
  const dates = trafficTrend.dates

  /**
   * 先为每个月定一个**锚点日**，再从这一天读全部渠道。
   *
   * ⚠️ 不能让各渠道各自取「自己最后一个有值的日」。实测那样会让同一个月的
   *    total 取到 2026-09-18（0.065）而 sp 取到 2026-09-17（8.25），
   *    子渠道反而大于总量；traffic.service 用「渠道 / 合计」重算占比时
   *    得出 0.0077 这种荒谬值（应接近 1.0）。
   *    库里单看数字看不出问题，只有拉起接口横向对比才会暴露。
   *
   * 锚点取「totalScore 最后一个有值的日」：total 是全渠道汇总口径，
   * 它有值的那天各子渠道必然也在采集范围内，用它做基准最稳。
   *
   * 另外，元素存在但 score=null 的日子（实测 21/80）其 scoreChange 为负、
   * scoreChangeRatio=-1.0，语义是「当日流量退出」而非「当日无采集」。
   * 这种日子不能当锚点，也不写 NULL 冒充 0 —— 缺行比假 0 诚实。
   */
  const anchorIdx = new Map() // month → dates 下标
  const totalArr = Array.isArray(trafficTrend.totalScore) ? trafficTrend.totalScore : []
  if (totalArr.length === dates.length) {
    dates.forEach((d, i) => {
      const v = totalArr[i]
      if (!v || v.score === null || v.score === undefined) return
      // 后写覆盖先写 → 留下该月最后一个 total 有值的日
      anchorIdx.set(String(d).slice(0, 7), i)
    })
  }

  const rows = []
  for (const [month, i] of anchorIdx) {
    for (const [srcKey, code] of Object.entries(TREND_CH)) {
      const arr = trafficTrend[srcKey]
      if (!Array.isArray(arr) || arr.length !== dates.length) continue
      const v = arr[i]
      // 锚点日该渠道无值 = 当月这个渠道没有流量，不写这一行
      if (!v || typeof v !== 'object' || v.score === null || v.score === undefined) continue
      rows.push([
        trafficTrend.asin, COUNTRY, TP_TYPE, month, code,
        num(v.score), num(v.scoreRatio), num(v.scoreChange),
        num(v.scoreChangeRatio), num(v.contriChangeRatio), NOW,
      ])
    }
  }
  await insertBatch(
    'fact_asin_traffic_channel',
    ['asin', 'country', 'time_piece_type', 'time_piece_value', 'channel',
      'score', 'score_ratio', 'score_change', 'score_change_ratio',
      'contri_change_ratio', 'created_at'],
    rows,
  )
}

// ---- 5. fact_asin_listing_snapshot：月度价格/评分/BSR ----

/**
 * 同样从 traffic-trend 的平行数组按月聚合。
 * price 用 buyboxPrice（实测 dealPrice 是促销价，不代表常态售价）。
 */
if (trafficTrend?.dates) {
  const dates = trafficTrend.dates
  const pick = (k) => (Array.isArray(trafficTrend[k]) && trafficTrend[k].length === dates.length ? trafficTrend[k] : null)
  const bsr = pick('bsr')
  const star = pick('star')
  const review = pick('review')
  const price = pick('buyboxPrice')

  const byMonth = new Map()
  dates.forEach((d, i) => {
    const month = String(d).slice(0, 7)
    const cur = byMonth.get(month) ?? { price: null, score: null, rating: null, bsr: null }
    // 每个字段各自取该月最后一个有值的日，互不影响
    if (price?.[i] !== null && price?.[i] !== undefined) cur.price = num(price[i])
    if (star?.[i] !== null && star?.[i] !== undefined) cur.score = num(star[i])
    if (review?.[i] !== null && review?.[i] !== undefined) cur.rating = num(review[i])
    if (bsr?.[i] !== null && bsr?.[i] !== undefined) cur.bsr = num(bsr[i])
    byMonth.set(month, cur)
  })

  const rows = [...byMonth.entries()]
    // 整月全空的不写，避免造出一堆空快照行
    .filter(([, v]) => v.price !== null || v.score !== null || v.rating !== null || v.bsr !== null)
    .map(([month, v]) => [trafficTrend.asin, COUNTRY, month, v.price, v.score, v.rating, v.bsr, NOW])
  await insertBatch(
    'fact_asin_listing_snapshot',
    ['asin', 'country', 'stat_month', 'price', 'score', 'rating_num', 'bsr', 'created_at'],
    rows,
  )
}

// ---- 6. fact_asin_subbsr_snapshot：子类目 BSR ----

if (trafficTrend?.subBsr && trafficTrend?.dates) {
  const dates = trafficTrend.dates
  const rows = []
  // subBsr 是「类目名 → 逐日数组」的动态 key map
  for (const [catName, arr] of Object.entries(trafficTrend.subBsr)) {
    if (!Array.isArray(arr) || arr.length !== dates.length) continue
    arr.forEach((v, i) => {
      const n = num(v)
      if (n === null) return
      rows.push([trafficTrend.asin, COUNTRY, catName, dates[i], n, NOW])
    })
  }
  await insertBatch(
    'fact_asin_subbsr_snapshot',
    ['asin', 'country', 'cat_name', 'stat_date', 'bsr', 'created_at'],
    rows,
  )
}

// ---- 7. dim_keyword：关键词主档（当前 0 行，反查流量词页完全空白）----

/**
 * 关键词归一：btrim(lower())，与 schema-04 的约定一致。
 * 主键是 (keyword, country)，keyword_id 降级为普通列 —— 但后端
 * keywords.service 目前还在用 `k.keyword_id = s.keyword_id` 做 JOIN，
 * 所以这一列必须填，否则 JOIN 不上、页面还是空的。
 */
const norm = (k) => String(k ?? '').trim().toLowerCase()

/**
 * 渠道码归一。
 *
 * ⚠️ 上游对「SP 推荐位」用了两个拼法：traffic-trend 的字段叫 recSpScore，
 * asin-keyword-list 的 exposurePositions 里是 `recSp`，
 * 而 dict_traffic_channel 和前端 CHANNEL_NAMES 用的都是 `spRec`。
 * 不归一的话页面上会直接显示原始码 `recSp`（实测反查流量词页就是这样），
 * 因为查字典查不到中文名。
 */
const CHANNEL_ALIAS = { recSp: 'spRec', recsp: 'spRec' }
const normChannel = (c) => {
  if (c === null || c === undefined || c === '') return null
  return CHANNEL_ALIAS[String(c)] ?? String(c)
}

const kwMap = new Map() // normKeyword → { keyword_id, translate_keyword, est_searches_num }
const addKw = (raw, fields = {}) => {
  const k = norm(raw)
  if (!k) return
  const cur = kwMap.get(k) ?? { keyword_id: null, translate_keyword: null, est_searches_num: null }
  for (const [f, v] of Object.entries(fields)) {
    if (v !== null && v !== undefined && (cur[f] === null || cur[f] === undefined)) cur[f] = v
  }
  kwMap.set(k, cur)
}

/**
 * ⚠️ 两个「搜索量」不是一回事，实测同一个词 pink sweatsuit：
 *     asin-keyword-list.monthSearchVolume = 1550  （月搜索量）
 *     keyword-overview.estSearchesNum     =  757  （ABA 周预估搜索量）
 * dim_keyword.est_searches_num 的注释是「预估搜索量」，对应后者；
 * 前者是月度量级，混在一列里会让页面上的数字自相矛盾。
 * 所以 keyword-overview 优先，且它先写入以占住这一列。
 */
if (kwOverview?.keyword) {
  addKw(kwOverview.keyword, { est_searches_num: num(kwOverview.estSearchesNum) })
}
for (const r of kwList?.list ?? []) {
  addKw(r.keyword, {
    keyword_id: num(r.keywordId),
    translate_keyword: nn(r.translateKeyword),
    // 只有 keyword-overview 没覆盖到的词才退而用月搜索量（addKw 是先到先得）
    est_searches_num: num(r.monthSearchVolume),
  })
}

await insertBatch(
  'dim_keyword',
  ['keyword', 'country', 'keyword_id', 'translate_keyword', 'est_searches_num', 'created_at', 'updated_at'],
  [...kwMap.entries()].map(([k, v]) => [
    k, COUNTRY, v.keyword_id, v.translate_keyword, v.est_searches_num, NOW, NOW,
  ]),
)

// ---- 8. fact_asin_keyword_snapshot：ASIN × 关键词（反查流量词主表）----

if (kwList?.list && TP_VALUE) {
  const rows = kwList.list.map((r) => {
    const tags = Array.isArray(r.keywordTags) ? r.keywordTags : []
    return [
      ASIN, COUNTRY, norm(r.keyword), TP_TYPE, TP_VALUE, 0,
      num(r.keywordId),
      /**
       * ⚠️ is_core 只认 tags 里真正的 isCore，**不要把 isMainKw 当核心词**。
       *
       * 字典 dict_keyword_tag 里 isCore/isTarget/isAC 三个码，而本接口实测
       * 只吐 isMainKw（探针 ASIN 的 4 个词全带这个标签）。把 isMainKw 映射成
       * is_core 会让「核心词」筛选全选中、失去区分度 —— 4/4 命中就是证据。
       * 核心词要靠 web-asin-core-keywords（本次被额度打断，未取到），
       * 取不到就诚实留 0，不要用别的标签冒充。
       */
      tags.includes('isCore') ? 1 : 0,
      tags.includes('isTarget') ? 1 : 0,
      nn(r.pieceMaxTime),
      num(r.nfLastRank), fmtDt(r.nfLastRankTime), nn(r.nfLastRankAsin),
      num(r.spLastRank), fmtDt(r.spLastRankTime), nn(r.spLastRankAsin),
      nn(r.spCampaignId),
      num(r.scoreInfo?.scoreRatio),
      // exposurePositions 是数组，表里是 VARCHAR —— 逗号拼接，前端再 split。
      // 顺带归一渠道码，见 normChannel()
      Array.isArray(r.exposurePositions)
        ? r.exposurePositions.map(normChannel).join(',')
        : nn(normChannel(r.exposurePositions)),
      num(r.monthSearchVolume),
      NOW,
    ]
  })
  await insertBatch(
    'fact_asin_keyword_snapshot',
    ['asin', 'country', 'keyword', 'time_piece_type', 'time_piece_value', 'is_listing_search',
      'keyword_id', 'is_core', 'is_target', 'piece_max_time',
      'nf_last_rank', 'nf_last_rank_time', 'nf_last_rank_asin',
      'sp_last_rank', 'sp_last_rank_time', 'sp_last_rank_asin', 'sp_campaign_id',
      'listing_score_ratio', 'exposure_positions', 'est_searches_num', 'created_at'],
    rows,
  )
}

// ---- 9. fact_asin_keyword_score：关键词分渠道得分 ----

/**
 * asin-keyword-list 的 scoreInfo 是**单一汇总得分**，不分渠道。
 * 所以这里只能写 channel='total' 一行 —— 分渠道拆分要靠
 * web-asin-keyword-overview（本次被额度打断，未取到）。
 * 宁可只写 total，也不要把汇总值复制到各渠道冒充明细。
 */
if (kwList?.list && TP_VALUE) {
  const rows = kwList.list
    .filter((r) => r.scoreInfo)
    .map((r) => [
      ASIN, COUNTRY, norm(r.keyword), TP_TYPE, TP_VALUE, 'total',
      num(r.keywordId),
      num(r.scoreInfo.score), num(r.scoreInfo.scoreRatio),
      num(r.scoreInfo.scoreChange), num(r.scoreInfo.scoreChangeRatio),
      num(r.scoreInfo.contriChangeRatio), NOW,
    ])
  await insertBatch(
    'fact_asin_keyword_score',
    ['asin', 'country', 'keyword', 'time_piece_type', 'time_piece_value', 'channel',
      'keyword_id', 'score', 'score_ratio', 'score_change', 'score_change_ratio',
      'contri_change_ratio', 'created_at'],
    rows,
  )
}

// ---- 10. fact_keyword_competition_snapshot：关键词竞争格局 ----

if (kwOverview?.keyword && kwOverview.abaDate) {
  await insertBatch(
    'fact_keyword_competition_snapshot',
    ['keyword', 'country', 'stat_week', 'stat_week_end', 'keyword_id',
      'nf_asin_num', 'sp_ad_asin_num', 'brand_ad_asin_num', 'ppc_ad_asin_num',
      'search_recommend_asin_num', 'video_ad_asin_num', 'sale_num',
      'global_keyword_num', 'created_at'],
    [[
      norm(kwOverview.keyword), COUNTRY, kwOverview.abaDate, nn(kwOverview.abaDateEnd),
      kwMap.get(norm(kwOverview.keyword))?.keyword_id ?? null,
      num(kwOverview.nfAsinNum), num(kwOverview.spAdAsinNum),
      num(kwOverview.brandAdAsinNum), num(kwOverview.ppcAdAsinNum),
      num(kwOverview.searchRecommendAsinNum), num(kwOverview.vedioAdAsinNum),
      num(kwOverview.saleNum), num(kwOverview.globalKeywordNum), NOW,
    ]],
  )
}

// ---- 11. fact_keyword_metric_snapshot：关键词搜索量与排名 ----

if (kwOverview?.keyword && kwOverview.abaDate) {
  await insertBatch(
    'fact_keyword_metric_snapshot',
    ['keyword', 'country', 'granularity', 'stat_date', 'stat_date_end',
      'keyword_id', 'est_searches_num', 'searches_rank', 'created_at'],
    [[
      norm(kwOverview.keyword), COUNTRY, 'week', kwOverview.abaDate,
      nn(kwOverview.abaDateEnd),
      kwMap.get(norm(kwOverview.keyword))?.keyword_id ?? null,
      num(kwOverview.estSearchesNum), num(kwOverview.searchesRank), NOW,
    ]],
  )
}

// ---- 12. fact_keyword_search_trend：ABA 月度搜索量曲线 ----

/**
 * keyword-aba-trend 也是平行数组：granularities[] 是月份轴，
 * keywordSearchVolumes[] / extSearchVolumes[] / keywordRanks[] 按下标对齐。
 *
 * 两个搜索量的区别（实测数值不同，不能混）：
 *   keywordSearchVolumes → 该词本身的搜索量        → is_prev_period=0
 *   extSearchVolumes     → 含扩展词的搜索量（更大）→ 另存一行，用 is_prev_period=1 区分
 *
 * ⚠️ 这是对 is_prev_period 的**借用**，字段原意是「上期对照」。
 *    本次没有上期数据，用它承载「扩展搜索量」是为了不改表结构；
 *    若日后要取真正的上期对照，这里必须改成独立字段，否则语义会打架。
 */
if (abaTrend?.granularities) {
  const g = abaTrend.granularities
  const rows = []
  const kwId = kwMap.get(norm(kwOverview?.keyword))?.keyword_id ?? null
  const kwText = norm(kwOverview?.keyword)
  const push = (arr, isPrev) => {
    if (!Array.isArray(arr) || arr.length !== g.length) return
    arr.forEach((v, i) => {
      const n = num(v)
      if (n === null) return
      // granularities 是 'YYYY-MM'，表里 stat_date 是 DATE → 补成当月 1 日
      rows.push([kwText, COUNTRY, 'month', `${g[i]}-01`, isPrev, kwId, n, NOW])
    })
  }
  if (kwText) {
    push(abaTrend.keywordSearchVolumes, 0)
    push(abaTrend.extSearchVolumes, 1)
  }
  await insertBatch(
    'fact_keyword_search_trend',
    ['keyword', 'country', 'granularity', 'stat_date', 'is_prev_period',
      'keyword_id', 'searches_num', 'created_at'],
    rows,
  )
}

// ---- 13. dim_festival：节日日历（ABA 趋势自带）----

if (Array.isArray(abaTrend?.festivals)) {
  const seen = new Map()
  for (const group of abaTrend.festivals) {
    if (!Array.isArray(group)) continue
    for (const f of group) {
      if (!f?.name || !f?.startDate) continue
      seen.set(`${f.name}|${f.startDate}`, [f.name, COUNTRY, f.startDate, nn(f.endDate), NOW])
    }
  }
  await insertBatch(
    'dim_festival',
    ['festival_name', 'country', 'start_date', 'end_date', 'created_at'],
    [...seen.values()],
  )
}

// ---- 14. fact_keyword_rank_history：关键词逐日排名 ----

/**
 * asin-keyword-rank-history 的 dates[] 与各 *RankHistory[] 按下标对齐。
 * 每个非 null 元素是 {asin, rank, rankStr, campaignId, maskCampaignId, asinOrder}。
 * rank_type 用字典里的渠道码（nf / sp / sb / sbv）。
 */
const RANK_TYPES = {
  nfRankHistory: 'nf',
  spRankHistory: 'sp',
  sbRankHistory: 'sb',
  sbvRankHistory: 'sbv',
}

if (rankHistory?.dates) {
  const dates = rankHistory.dates
  // 这个接口的响应里不含关键词本身，只能用请求时的入参 —— 与 sweep 保持一致
  const kwText = norm(arg('keyword', 'pink sweatsuit'))
  const rows = []
  for (const [srcKey, rankType] of Object.entries(RANK_TYPES)) {
    const arr = rankHistory[srcKey]
    if (!Array.isArray(arr) || arr.length !== dates.length) continue
    arr.forEach((v, i) => {
      if (!v || typeof v !== 'object') return
      /**
       * rankStr 形如 "p3,6/12" = 第 3 页、该页第 6 位、每页 12 位。
       * 已对账验证：pink set 的 spLastRankStr=p3,6/12 且 spLastRank=30，
       * (3-1)×12+6 = 30 ✓；pink sweatsuit 的 p1,3/12 → 0×12+3 = 3 ✓。
       * 所以 m[1]=页码、m[2]=页内位次、m[3]=每页容量，不要弄反。
       */
      const m = /^p(\d+),(\d+)\/(\d+)$/.exec(String(v.rankStr ?? ''))
      rows.push([
        v.asin ?? ASIN, COUNTRY, kwText, rankType, dates[i],
        kwMap.get(kwText)?.keyword_id ?? null,
        num(v.rank),
        m ? Number(m[1]) : null,
        m ? Number(m[3]) : null,
        m ? `${m[2]}` : null,
        num(v.asinOrder),
        nn(v.campaignId), nn(v.maskCampaignId), NOW,
      ])
    })
  }
  if (kwText) {
    await insertBatch(
      'fact_keyword_rank_history',
      ['asin', 'country', 'keyword', 'rank_type', 'stat_date', 'keyword_id',
        'rank_position', 'page_no', 'page_size', 'slot', 'asin_order',
        'campaign_id', 'mask_campaign_id', 'created_at'],
      rows,
    )
  }
}

// =====================================================================
// 汇总
// =====================================================================

console.log(`\n[load] ${DRY ? '预演' : '写入'}完成：`)
const names = Object.keys(stats).sort()
if (!names.length) console.log('  （无数据可写）')
for (const t of names) console.log(`  ${String(stats[t]).padStart(7)}  ${t}`)

await conn.end()

/**
 * 补充入库：把 sif_sweep.py 落盘目录里**尚未被 sif_load_to_doris.mjs 消费**的
 * 数据源，灌进对应的事实/关系/维度表。
 *
 * ## 为什么需要这个脚本
 *
 * `sif_load_to_doris.mjs` 覆盖 16 张表，但页面上还有 4 个模块读的是另外的表，
 * 那些表在当前库里是空的 —— 页面打开就是「暂无数据」：
 *
 *   多变体自然位   → fact_asin_multinf_daily / fact_asin_multinf_keyword_variant
 *   运营时光机     → fact_asin_op_event
 *   推荐专栏       → rel_rec_column_campaign_keyword
 *   广告透视       → dim_ad_campaign（该 ASIN 的活动 ID 不在库里，JOIN 落空）
 *
 * 这些表的源数据其实**已经在落盘目录里了**，只是藏在别的响应对象的嵌套字段下：
 *
 *   asin-keyword-list.list[].multiNfInfo.dateAsins[]  → 多变体自然位（两表）
 *   asin-keyword-list.list[].allRankHistory.recRanks[] → 推荐专栏
 *   traffic-trend 的平行数组相邻日 diff                → 运营时光机
 *   asin-keyword-list / asin-keyword-rank-history 的 campaignId → dim_ad_campaign
 *
 * ## 与 sif_load_to_doris.mjs 一致的写入语义
 *
 * - 目标表都是 Unique Key + merge-on-write，INSERT 即整行 upsert；
 * - dim_* 表必须先读原行再合并，否则漏列会被写成 NULL 抹掉已有数据；
 * - 无源字段**留 NULL，不编造 0**（0 会被前端读成「真的是 0」）。
 */
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(path.join(import.meta.dirname, '..', 'apps', 'api', 'package.json'))
const mysql = require('mysql2/promise')

// ---------- CLI 参数 ----------

const argv = process.argv.slice(2)
const arg = (k, d = null) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const IN_DIR = arg('in', '/tmp/sifout')
const ASIN = arg('asin', 'B01NBNDC1T')
const COUNTRY = arg('country', 'US')
const DRY = argv.includes('--dry')

// ---------- 读取 ----------

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

const nn = (v) => (v === undefined || v === '' ? null : v)
const num = (v) => {
  const n = Number(v)
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n
}
const clip = (s, n) => (s === null || s === undefined ? null : String(s).slice(0, n))

const pad = (x) => String(x).padStart(2, '0')
const NOW = (() => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
})()

/**
 * Doris 读回的 DATETIME 列经 mysql2 返回的是 **Date 对象**，
 * 直接 String() 会得到 "Fri Sep 18 2026 12:00:00 GMT+0800" 这种英文串，
 * 塞回 DATETIME 列会被存成 NULL 或报错。所以读回来的时间一律走这里转。
 */
const fmtDt = (v) => {
  if (v === null || v === undefined) return null
  if (v instanceof Date) {
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())} ${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}`
  }
  return String(v).slice(0, 19).replace('T', ' ')
}

/** 同上，DATE 列 */
const fmtDate = (v) => {
  if (v === null || v === undefined) return null
  if (v instanceof Date) {
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`
  }
  return String(v).slice(0, 10)
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
    await conn.query(`INSERT INTO \`${table}\` (${cols}) VALUES ${ph}`, chunk.flat())
  }
  note(table, rows.length)
}

console.log(`[load-extra] ${ASIN} / ${COUNTRY} / 源目录 ${IN_DIR}${DRY ? ' （dry-run）' : ''}`)

const kwList = load('asin-keyword-list')
const rankHistory = load('asin-keyword-rank-history')
const trafficTrend = load('traffic-trend')

if (!kwList?.list) {
  console.error('[load-extra] 缺少 asin-keyword-list，无法继续')
  process.exit(1)
}

/**
 * ⚠️ 关联键用 (keyword, country) 而非 keyword_id。
 *
 * schema-04 已把这两张表的主键从 keyword_id 改成 keyword 文本 ——
 * 实测 keyword_id 跨站点不唯一（1120764 在 FR 是 "pastille lave glace"、
 * 在 US 是 "halloween trays for food"），且在多数源接口里为空。
 * 所以 keyword 列必须填，keyword_id 只是可空的参考列。
 */
const normKw = (k) => String(k ?? '').trim().toLowerCase()

// =====================================================================
// 1. 多变体自然位 —— fact_asin_multinf_keyword_variant（月内最好名次）
//    + fact_asin_multinf_daily（逐日聚合）
//
// 源：asin-keyword-list.list[].multiNfInfo.dateAsins[]，逐日 × 每词
//     每个 asin 元素形如 {asin, date, rank, pageNum, features, pageRank, pageSize}
// =====================================================================

const varBest = new Map() // `${kw}|${variant}|${month}` → {rank, pageNum, pageRank, pageSize, img, kid}
const dayAgg = new Map() // date → {asins:Set, kws:Set}

for (const it of kwList.list) {
  const kw = normKw(it.keyword)
  const kid = num(it.keywordId)
  const da = it.multiNfInfo?.dateAsins
  if (!kw || !Array.isArray(da)) continue

  for (const day of da) {
    const date = nn(day.date)
    if (!date) continue
    const month = date.slice(0, 7)
    const cur = dayAgg.get(date) ?? { asins: new Set(), kws: new Set() }
    cur.kws.add(kw)

    for (const a of day.asins ?? []) {
      const vid = nn(a.asin)
      if (!vid) continue
      cur.asins.add(vid)
      // 主键是 (parent,variant,keyword,country,month)，源是逐日的：
      // 同一个月多天会撞同一主键，取 rank 最小（名次最好）的那天 ——
      // 页面问的是「这个变体在这个词上能排到多少位」，月内最好成绩更有意义；
      // 同时把该天的页码三件套与图片一起带走，保证它们与 rank 来自同一天
      const key = `${kw}|${vid}|${month}`
      const prev = varBest.get(key)
      const r = num(a.rank)
      if (!prev || (r !== null && (prev.rank === null || r < prev.rank))) {
        varBest.set(key, {
          rank: r,
          pageNum: num(a.pageNum),
          pageRank: num(a.pageRank),
          pageSize: num(a.pageSize),
          img: nn(a.img),
          kid,
        })
      }
    }
    dayAgg.set(date, cur)
  }
}

const variantRows = []
for (const [key, v] of varBest) {
  const [kw, vid, month] = key.split('|')
  // 变体角色：被查询的 ASIN 自身是主曝光变体，其余同组变体是搭子
  const role = vid === ASIN ? 'main' : 'sibling'
  variantRows.push([ASIN, COUNTRY, kw, vid, 'month', month, v.kid, v.rank,
    v.pageNum, v.pageRank, v.pageSize, clip(v.img, 512), role, NOW])
}
await insertBatch(
  'fact_asin_multinf_keyword_variant',
  ['parent_asin', 'country', 'keyword', 'variant_asin', 'time_piece_type',
    'time_piece_value', 'keyword_id', 'rank_position', 'page_num', 'page_rank',
    'page_size', 'img', 'variant_role', 'created_at'],
  variantRows,
)

// 日级快照。score / extra_score / listing_asin_cnt 三个列确证无源（见
// docs/MODULE_DATA_FLOW.md 模块 2），留 NULL 而不是 0 ——
// 0 会被前端读成「当日没有多变体占位」，而真相是「这个口径没采集」。
const dailyRows = []
for (const [date, agg] of dayAgg) {
  dailyRows.push([ASIN, COUNTRY, date, agg.asins.size, agg.kws.size, null, null, null, NOW])
}
await insertBatch(
  'fact_asin_multinf_daily',
  ['asin', 'country', 'stat_date', 'asin_cnt', 'keyword_cnt', 'score',
    'extra_score', 'listing_asin_cnt', 'created_at'],
  dailyRows,
)

// =====================================================================
// 2. 推荐专栏 —— rel_rec_column_campaign_keyword + dim_recommend_column
//
// 源：asin-keyword-list.list[].allRankHistory.{date[], recRanks[]} 平行数组。
//     recRanks[i] 非 null 时是 {专栏英文名: {campaignId, maskCampaignId}}。
//
// ⚠️ 不写 fact_asin_rec_column_period：那张表的 ratio 列**确证无源**，
//    写进去只能是 NULL，页面会显示「—」且拿不到活动/关键词数。
//    而 insights.service 在 period 表查空时会回落到本关系表并标
//    ratioAvailable=false —— 空着反而让页面走对分支、显示出真实信息。
// =====================================================================

const recRel = new Map() // `${title}|${kw}|${cid}` → row
const recTitles = new Set()

for (const it of kwList.list) {
  const kw = normKw(it.keyword)
  const kid = num(it.keywordId)
  if (!kw) continue
  const ar = it.allRankHistory
  if (!ar) continue
  const dates = ar.date
  const rr = ar.recRanks
  if (!Array.isArray(dates) || !Array.isArray(rr)) continue

  rr.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') return
    const d = dates[i]
    if (!d) return
    for (const [title, v] of Object.entries(entry)) {
      const cid = nn(v?.campaignId)
      if (!cid) continue
      recTitles.add(title)
      recRel.set(`${title}|${kw}|${cid}`, [
        ASIN, COUNTRY, clip(title, 255), kw, clip(cid, 64), kid,
        nn(v?.maskCampaignId), NOW,
      ])
    }
  })
}

await insertBatch(
  'rel_rec_column_campaign_keyword',
  ['asin', 'country', 'rec_title', 'keyword', 'encrypt_campaign_id', 'keyword_id',
    'mask_campaign_id', 'created_at'],
  [...recRel.values()],
)

// 专栏维表：原站无中文名，display_name_cn 留 NULL 让前端回落显示英文原名。
//
// ⚠️ Doris 不支持 ON DUPLICATE KEY UPDATE，且 merge-on-write 是**整行覆盖**，
//    直接 INSERT 会把已存在的 display_name_cn 抹成 NULL。
//    所以先读原行，只补 first_seen_at / last_seen_at。
if (recTitles.size) {
  const REC_COLS = ['rec_title', 'country', 'short_code', 'display_name_cn',
    'first_seen_at', 'last_seen_at']
  const titles = [...recTitles]
  const old = new Map()
  const [rows] = await conn.query(
    `SELECT ${REC_COLS.map((c) => `\`${c}\``).join(', ')} FROM dim_recommend_column
      WHERE country = ? AND rec_title IN (${titles.map(() => '?').join(', ')})`,
    [COUNTRY, ...titles.map((t) => clip(t, 255))],
  )
  for (const r of rows) old.set(r.rec_title, r)

  const out = titles.map((t) => {
    const key = clip(t, 255)
    const o = old.get(key)
    return [
      key, COUNTRY,
      o?.short_code ?? null,
      o?.display_name_cn ?? null,
      o?.first_seen_at ? fmtDt(o.first_seen_at) : NOW,
      NOW,
    ]
  })
  console.log(`[load-extra] dim_recommend_column: ${titles.length} 个专栏（库中已存在 ${old.size}）`)
  await insertBatch('dim_recommend_column', REC_COLS, out)
}

// =====================================================================
// 3. 运营时光机 —— fact_asin_op_event
//
// traffic-trend 存的是**逐日快照**，不是事件。要对五个受监控列做相邻日 diff，
// 变化处生成一条事件。口径与 scripts/etl_module6_timemachine.py 保持一致：
//
//   ⚠️ NULL 不算变化。快照缺采集那天所有列都是 NULL，
//      把「有值 → NULL」也当事件会造出大量假事件。
//      只在**前后都有值且不相等**时记一条。
//
//   ⚠️ campaignId 这一列实测是**在投活动数**（1~82 的纯数字），
//      不是活动 ID。所以 event_type 用 campaignCnt（字典里的
//      「在投广告活动数变化」），不能标成 campaignId（那是「新增广告活动」）。
// =====================================================================

const EVENT_COLS = [
  ['buyboxPrice', 'priceChange'],
  ['campaignId', 'campaignCnt'],
  ['promotion', 'promotion'],
  ['couponInfo', 'coupon'],
  ['titleImg', 'titleImg'],
]

const eventRows = []
if (trafficTrend?.dates) {
  const dates = trafficTrend.dates
  for (const [col, etype] of EVENT_COLS) {
    const arr = trafficTrend[col]
    if (!Array.isArray(arr) || arr.length !== dates.length) continue
    for (let i = 1; i < arr.length; i++) {
      const prev = arr[i - 1]
      const cur = arr[i]
      // 任一侧无值 → 不是变化，跳过
      if (prev === null || prev === undefined || prev === '') continue
      if (cur === null || cur === undefined || cur === '') continue
      if (String(prev) === String(cur)) continue
      // 主键 (asin,country,stat_date,event_type)，同日同类型只能一条
      const detail =
        etype === 'coupon'
          ? `coupon(raw): ${prev} → ${cur}`
          : `${prev} → ${cur}`
      eventRows.push([ASIN, COUNTRY, dates[i], etype, clip(detail, 2000), NOW])
    }
  }
}
await insertBatch(
  'fact_asin_op_event',
  ['asin', 'country', 'stat_date', 'event_type', 'event_detail', 'created_at'],
  eventRows,
)

// =====================================================================
// 4. dim_ad_campaign —— 补本 ASIN 的活动主档
//
// 广告透视页从 fact_asin_keyword_snapshot.sp_campaign_id JOIN 本表。
// 该 ASIN 的四个 SP 活动 ID 不在库里的 5756 条中，JOIN 落空 → 页面空白。
//
// ⚠️ 各属性列（strategy / asin_num / ad_num / 两个日期）确证无源，
//    留 NULL。merge-on-write 是整行覆盖，所以必须先读原行再合并写回，
//    否则会把别的 ETL 灌的属性清空。
// =====================================================================

const AD_COLS = [
  'encrypt_campaign_id', 'country', 'fake_campaign_id', 'ad_type', 'product_type',
  'strategy', 'asin_num', 'ad_num', 'campaign_created_at', 'last_ad_created_at',
  'created_at', 'updated_at',
]

// campaignId → ad_type。nf 是自然位不是广告，不参与推导
const AD_TYPE_OF = { spRankHistory: 1, sbRankHistory: 2, sbvRankHistory: 3 }
const campaigns = new Map() // cid → {mask, adType}

const putCampaign = (cid, mask, adType) => {
  if (!cid) return
  const cur = campaigns.get(cid) ?? { mask: null, adType: null }
  if (!cur.mask && mask) cur.mask = mask
  if (cur.adType === null && adType !== null) cur.adType = adType
  campaigns.set(cid, cur)
}

// 源 1：asin-keyword-list.list[].allRankHistory 的 spRank/sbRank/sbvRank
for (const it of kwList.list) {
  const ar = it.allRankHistory
  if (!ar) continue
  for (const [key, t] of Object.entries(AD_TYPE_OF)) {
    for (const v of ar[key] ?? []) {
      if (v && typeof v === 'object') putCampaign(nn(v.campaignId), nn(v.maskCampaignId), t)
    }
  }
  // 平铺列 spCampaignId / spMaskCampaignId 就是 SP 活动，ad_type=1
  if (it.spCampaignId) putCampaign(nn(it.spCampaignId), nn(it.spMaskCampaignId), 1)
}

// 源 2：asin-keyword-rank-history 的四个排名历史数组
if (rankHistory?.dates) {
  for (const [key, t] of Object.entries(AD_TYPE_OF)) {
    for (const v of rankHistory[key] ?? []) {
      if (v && typeof v === 'object') putCampaign(nn(v.campaignId), nn(v.maskCampaignId), t)
    }
  }
}

// 源 3：推荐专栏里带出来的活动（ad_type 无源，留 NULL）
for (const [, row] of recRel) putCampaign(row[4], null, null)

/**
 * 过滤掉非活动 ID 的脏值。
 *
 * 真实加密活动 ID 有两种形态（实测）：
 *   A02072291IS4WZ4HOLPDL  —— 'A0' 前缀 + 字母数字混合，共 22 位（SP 活动）
 *   300004263212106        —— 纯数字 15 位（SB / SBV 活动）
 *   7096405550401          —— 纯数字 13 位
 *
 * ⚠️ 这里曾把 'A0' 之后写成 `\d{15,}`（要求全数字），结果把**所有 SP 活动**
 *    都当成脏值滤掉，广告页依然空白。'A0' 后面是字母数字混合，不是纯数字。
 *
 * 要滤的是 spRankHistory 里混进来的 '1' '2' '17' —— 那些是「在投活动数」
 * 误落到 campaignId 字段的短数字，长度远小于真实 ID。
 */
const isRealCid = (c) =>
  /^A0[0-9A-Z]{13,}$/.test(c) || /^\d{11,}$/.test(c)
const realCampaigns = new Map([...campaigns].filter(([cid]) => isRealCid(cid)))

if (realCampaigns.size) {
  const ids = [...realCampaigns.keys()]
  const existing = new Map()
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const [rows] = await conn.query(
      `SELECT ${AD_COLS.map((c) => `\`${c}\``).join(', ')} FROM dim_ad_campaign
        WHERE country = ? AND encrypt_campaign_id IN (${chunk.map(() => '?').join(', ')})`,
      [COUNTRY, ...chunk],
    )
    for (const r of rows) existing.set(r.encrypt_campaign_id, r)
  }

  const out = []
  for (const [cid, c] of realCampaigns) {
    const old = existing.get(cid) ?? {}
    // 非 null 覆盖，null 保留旧值 —— 与 sif_load_to_doris.mjs 的 mergeDimAsin 同规则
    const merged = {}
    for (const col of AD_COLS) {
      const pv = col === 'fake_campaign_id' ? c.mask : col === 'ad_type' ? c.adType : null
      merged[col] = pv === null || pv === undefined ? (old[col] ?? null) : pv
    }
    merged.encrypt_campaign_id = cid
    merged.country = COUNTRY
    merged.campaign_created_at = fmtDate(old.campaign_created_at)
    merged.last_ad_created_at = fmtDate(old.last_ad_created_at)
    merged.created_at = old.created_at ? fmtDt(old.created_at) : NOW
    merged.updated_at = NOW
    out.push(AD_COLS.map((col) => merged[col]))
  }
  console.log(`[load-extra] dim_ad_campaign: 本 ASIN 关联 ${realCampaigns.size} 个活动（库中已存在 ${existing.size}）`)
  await insertBatch('dim_ad_campaign', AD_COLS, out)
}

// =====================================================================
// 汇总
// =====================================================================

console.log(`\n[load-extra] ${DRY ? '预演' : '写入'}完成：`)
const names = Object.keys(stats).sort()
if (!names.length) console.log('  （无数据可写）')
for (const t of names) console.log(`  ${String(stats[t]).padStart(7)}  ${t}`)

await conn.end()

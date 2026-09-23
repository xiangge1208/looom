/**
 * 广告域入库：把 web-variant-ad-keywords 的分页结果灌进 Doris 的广告表。
 *
 * ## 为什么需要这个脚本
 *
 * 之前广告页只能从 `fact_asin_keyword_snapshot.sp_campaign_id` 反查出 4 个 SP 活动 ——
 * 那是「该 ASIN 的流量词恰好由哪个活动带来」的副产品，不是广告数据本身。
 * 真正的广告源是 `web-variant-ad-keywords`：737 个广告词 × 24 个投放小组 ×
 * 22 个活动 × 11 个变体，而它此前**抓到了却没入库**。
 *
 * 灌 5 张表：
 *   dim_ad_campaign                    22 个活动（合并写，不覆盖已有列）
 *   dim_ad_product_ad                  24 个投放小组
 *   rel_ad_campaign_product_ad         活动×小组隶属关系（带 stat_date）
 *   fact_ad_search_term_exposure       广告词×小组×变体×日 的曝光与排名
 *   rel_asin_keyword_variant_exposure  关键词×变体 的广告曝光得分
 *
 * ## 三个数据口径上的坑
 *
 * 1. **adIds / campaignIds / asins 是三个平行数组，彼此没有下标对应关系。**
 *    一个词可能挂 3 个小组、3 个活动、1 个变体 —— 不能按下标 zip 成三元组。
 *    所以 rel_ad_campaign_product_ad 只能建「该词涉及的活动 × 该词涉及的小组」
 *    的笛卡尔积，这是上游给的信息上限。宁可宽一点也不要凭下标编造精确归属。
 *
 * 2. **spHistory 按变体 ASIN 分列**，形如 {date:[...], B01NBNDC1T:[...], B081PW4RT9:[...]}。
 *    列名是变体 ASIN，不是固定字段，要遍历 key 而不是取死字段。
 *
 * 3. **fact_ad_search_term_exposure 的主键含 encrypt_ad_id**，
 *    而 spHistory 只给「词×变体×日」的排名，给不出「是哪个小组投的」。
 *    该词挂 N 个小组时，同一条排名会落到 N 行上 —— 这是主键粒度比数据粒度
 *    更细导致的必然结果，不是重复写入。ad_type 固定 1(SP)，因为本接口只吐 SP。
 *
 * 用法：
 *   node scripts/sif_load_ads_to_doris.mjs --dir .tmp/sif-ads --asin B01NBNDC1T [--country US] [--dry]
 */
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(path.join(import.meta.dirname, '..', 'apps', 'api', 'package.json'))
const mysql = require('mysql2/promise')

const argv = process.argv.slice(2)
const arg = (k, d = null) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const DIR = arg('dir', '.tmp/sif-ads')
const ASIN = arg('asin', 'B01NBNDC1T')
const COUNTRY = arg('country', 'US')
const DRY = argv.includes('--dry')

const nn = (v) => (v === undefined || v === '' ? null : v)
const num = (v) => {
  const n = Number(v)
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n
}
const clip = (s, n) => (s === null || s === undefined ? null : String(s).slice(0, n))
const normKw = (k) => String(k ?? '').trim().toLowerCase()

const pad = (x) => String(x).padStart(2, '0')
const NOW = (() => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
})()
const fmtDate = (v) => {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`
  return String(v).slice(0, 10)
}
const fmtDt = (v) => {
  if (v === null || v === undefined) return null
  if (v instanceof Date) {
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())} ${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}`
  }
  return String(v).slice(0, 19).replace('T', ' ')
}

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
  host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER,
  password: env.DB_PASSWORD, database: env.DB_NAME,
  supportBigNumbers: true, bigNumberStrings: true,
})

const stats = {}
const note = (t, n) => { stats[t] = (stats[t] ?? 0) + n }

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

// ---------- 读取所有分页 ----------

const files = fs.readdirSync(DIR).filter((f) => /^adkw-p\d+\.json$/.test(f)).sort()
const allKeywords = []
for (const f of files) {
  let p
  try {
    p = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))
  } catch { continue }
  if (p.status !== 'ok') { console.log(`  跳过 ${f}: status=${p.status}`); continue }
  const b = p.data?.data
  for (const k of b?.keywords ?? []) allKeywords.push(k)
}
console.log(`[ads] ${files.length} 个分页文件 → ${allKeywords.length} 个广告词${DRY ? ' （dry-run）' : ''}`)
if (!allKeywords.length) { console.error('[ads] 无数据'); process.exit(1) }

// ---------- 汇总维度 ----------

const adIds = new Set()
const campIds = new Set()
/** `${campaignId}|${adId}` → Set<stat_date> */
const campAdPairs = new Map()
/** fact_ad_search_term_exposure 行 */
const expRows = new Map()
/** rel_asin_keyword_variant_exposure 行 */
const varExpRows = new Map()
/** dim_keyword 补充：广告词也要进主档，否则 JOIN 不上 */
const kwMeta = new Map()

/** 该批数据的时间口径：用 spHistory 里最后一天 */
let maxDate = null

for (const k of allKeywords) {
  const kw = normKw(k.keyword)
  if (!kw) continue

  for (const a of k.adIds ?? []) if (a) adIds.add(String(a))
  for (const c of k.campaignIds ?? []) if (c) campIds.add(String(c))

  kwMeta.set(kw, {
    translate: nn(k.translateKeyword),
    est: num(k.estSearchesNum),
  })

  // ---- spHistory：按变体分列的逐日广告位排名 ----
  const sp = k.spHistory
  const dates = Array.isArray(sp?.date) ? sp.date : []
  for (const d of dates) {
    const ds = fmtDate(d)
    if (ds && (!maxDate || ds > maxDate)) maxDate = ds
  }

  // 活动×小组隶属关系：只能建笛卡尔积（见文件头第 1 条）
  const lastDate = dates.length ? fmtDate(dates[dates.length - 1]) : null
  if (lastDate) {
    for (const c of k.campaignIds ?? []) {
      for (const a of k.adIds ?? []) {
        if (!c || !a) continue
        const key = `${c}|${a}`
        if (!campAdPairs.has(key)) campAdPairs.set(key, new Set())
        campAdPairs.get(key).add(lastDate)
      }
    }
  }

  if (sp && typeof sp === 'object') {
    for (const [col, arr] of Object.entries(sp)) {
      if (col === 'date' || !Array.isArray(arr)) continue
      // 列名就是变体 ASIN（见文件头第 2 条）
      const variant = col
      if (arr.length !== dates.length) continue
      arr.forEach((v, i) => {
        if (!v || typeof v !== 'object') return
        const rank = num(v.rank)
        if (rank === null) return
        const ds = fmtDate(dates[i])
        if (!ds) return
        // 主键含 encrypt_ad_id，而排名数据给不出具体小组 → 该词的每个小组各落一行
        // （见文件头第 3 条）。无小组时用占位符，避免整条丢失
        const ads = (k.adIds ?? []).filter(Boolean)
        const targets = ads.length ? ads : ['__unknown__']
        for (const adId of targets) {
          expRows.set(`${adId}|${kw}|${variant}|${ds}`, [
            clip(adId, 64), COUNTRY, clip(kw, 128), clip(variant, 16), ds,
            null,                                   // keyword_id：本接口不给
            clip((k.campaignIds ?? [])[0] ?? null, 64), // 冗余列，取首个
            1,                                      // ad_type：本接口只吐 SP
            'sp',
            num(k.spScoreRatio),
            rank,
            NOW,
          ])
        }
      })
    }
  }

  // ---- 关键词×变体 广告曝光得分 ----
  for (const v of k.asins ?? []) {
    if (!v) continue
    varExpRows.set(`${v}|${kw}`, [
      ASIN, clip(v, 16), clip(kw, 128), COUNTRY, 'latelyDay', '30',
      null, num(k.kwSpScoreRatio), NOW,
    ])
  }
}

const STAT_DATE = maxDate ?? fmtDate(new Date())
console.log(`[ads] 去重：活动 ${campIds.size} 个、投放小组 ${adIds.size} 个、时间口径 ${STAT_DATE}`)

// ---------- 1. dim_ad_campaign（合并写）----------

const AD_CAMP_COLS = ['encrypt_campaign_id', 'country', 'fake_campaign_id', 'ad_type',
  'product_type', 'strategy', 'asin_num', 'ad_num', 'campaign_created_at',
  'last_ad_created_at', 'created_at', 'updated_at']

if (campIds.size) {
  const ids = [...campIds]
  const existing = new Map()
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const [rows] = await conn.query(
      `SELECT ${AD_CAMP_COLS.map((c) => `\`${c}\``).join(', ')} FROM dim_ad_campaign
        WHERE country = ? AND encrypt_campaign_id IN (${chunk.map(() => '?').join(', ')})`,
      [COUNTRY, ...chunk],
    )
    for (const r of rows) existing.set(r.encrypt_campaign_id, r)
  }
  const out = ids.map((cid) => {
    const old = existing.get(cid) ?? {}
    // fake_campaign_id 是加密 ID 的后 4 位（实测：A02072291IS4WZ4HOLPDL → LPDL）
    const mask = cid.length >= 4 ? cid.slice(-4) : null
    const merged = {}
    for (const c of AD_CAMP_COLS) merged[c] = old[c] ?? null
    merged.encrypt_campaign_id = cid
    merged.country = COUNTRY
    merged.fake_campaign_id = old.fake_campaign_id ?? mask
    // ad_type：本接口只覆盖 SP，已有值不动（可能是 ETL 灌的 SB/SBV）
    merged.ad_type = old.ad_type ?? 1
    merged.campaign_created_at = fmtDate(old.campaign_created_at)
    merged.last_ad_created_at = fmtDate(old.last_ad_created_at)
    merged.created_at = old.created_at ? fmtDt(old.created_at) : NOW
    merged.updated_at = NOW
    return AD_CAMP_COLS.map((c) => merged[c])
  })
  console.log(`[ads] dim_ad_campaign: ${ids.length} 个（库中已存在 ${existing.size}）`)
  await insertBatch('dim_ad_campaign', AD_CAMP_COLS, out)
}

// ---------- 2. dim_ad_product_ad（合并写）----------

const AD_PROD_COLS = ['encrypt_ad_id', 'country', 'fake_ad_id', 'ad_created_at', 'created_at']

if (adIds.size) {
  const ids = [...adIds]
  const existing = new Map()
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const [rows] = await conn.query(
      `SELECT ${AD_PROD_COLS.map((c) => `\`${c}\``).join(', ')} FROM dim_ad_product_ad
        WHERE country = ? AND encrypt_ad_id IN (${chunk.map(() => '?').join(', ')})`,
      [COUNTRY, ...chunk],
    )
    for (const r of rows) existing.set(r.encrypt_ad_id, r)
  }
  const out = ids.map((aid) => {
    const old = existing.get(aid) ?? {}
    return [
      clip(aid, 64), COUNTRY,
      old.fake_ad_id ?? (aid.length >= 4 ? aid.slice(-4) : null),
      fmtDate(old.ad_created_at),
      old.created_at ? fmtDt(old.created_at) : NOW,
    ]
  })
  console.log(`[ads] dim_ad_product_ad: ${ids.length} 个（库中已存在 ${existing.size}）`)
  await insertBatch('dim_ad_product_ad', AD_PROD_COLS, out)
}

// ---------- 3. rel_ad_campaign_product_ad ----------

const relRows = []
for (const [key, dateSet] of campAdPairs) {
  const [cid, aid] = key.split('|')
  for (const d of dateSet) {
    relRows.push([clip(cid, 64), clip(aid, 64), COUNTRY, d, NOW])
  }
}
await insertBatch(
  'rel_ad_campaign_product_ad',
  ['encrypt_campaign_id', 'encrypt_ad_id', 'country', 'stat_date', 'created_at'],
  relRows,
)

// ---------- 4. fact_ad_search_term_exposure ----------

await insertBatch(
  'fact_ad_search_term_exposure',
  ['encrypt_ad_id', 'country', 'keyword', 'variant_asin', 'stat_date', 'keyword_id',
    'encrypt_campaign_id', 'ad_type', 'traffic_type', 'score', 'rank_position', 'created_at'],
  [...expRows.values()],
)

// ---------- 5. rel_asin_keyword_variant_exposure ----------

await insertBatch(
  'rel_asin_keyword_variant_exposure',
  ['parent_asin', 'variant_asin', 'keyword', 'country', 'time_piece_type',
    'time_piece_value', 'keyword_id', 'score', 'created_at'],
  [...varExpRows.values()],
)

// ---------- 6. dim_keyword 补档（广告词也要进主档，否则页面 JOIN 不上）----------

const DIM_KW_COLS = ['keyword', 'country', 'keyword_id', 'translate_keyword',
  'est_searches_num', 'created_at', 'updated_at']

if (kwMeta.size) {
  const kws = [...kwMeta.keys()]
  const existing = new Map()
  for (let i = 0; i < kws.length; i += 300) {
    const chunk = kws.slice(i, i + 300)
    const [rows] = await conn.query(
      `SELECT ${DIM_KW_COLS.map((c) => `\`${c}\``).join(', ')} FROM dim_keyword
        WHERE country = ? AND keyword IN (${chunk.map(() => '?').join(', ')})`,
      [COUNTRY, ...chunk.map((k) => clip(k, 128))],
    )
    for (const r of rows) existing.set(r.keyword, r)
  }
  const out = kws.map((kw) => {
    const old = existing.get(kw) ?? {}
    const m = kwMeta.get(kw)
    return [
      clip(kw, 128), COUNTRY,
      old.keyword_id ?? null,
      // 已有翻译优先保留（可能来自更可信的源）
      old.translate_keyword ?? m.translate,
      old.est_searches_num ?? m.est,
      old.created_at ? fmtDt(old.created_at) : NOW,
      NOW,
    ]
  })
  console.log(`[ads] dim_keyword: ${kws.length} 个广告词（库中已存在 ${existing.size}）`)
  await insertBatch('dim_keyword', DIM_KW_COLS, out)
}

console.log(`\n[ads] ${DRY ? '预演' : '写入'}完成：`)
for (const t of Object.keys(stats).sort()) console.log(`  ${String(stats[t]).padStart(7)}  ${t}`)

await conn.end()

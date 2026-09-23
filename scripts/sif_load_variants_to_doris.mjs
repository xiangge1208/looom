/**
 * 把**每个变体**的 asin-keyword-list 落盘数据灌进 Doris。
 *
 * ## 为什么需要这个脚本
 *
 * `sif_load_to_doris.mjs` 只处理探针 ASIN 自己的 asin-keyword-list，
 * 所以反查流量词页只有父体的 4 个词。而实测该组 16 个变体各有**自己独有**的
 * 头部词（尺寸词完全不同：父体是 `18x18 pillow inserts`，子体是
 * `22x22 pillow insert` / `12x12 pillow` / `26x26 pillow inserts` …），
 * 合并后 50 个去重词 —— 只看父体会漏掉 46 个。
 *
 * ## 与 sif_load_extra_to_doris.mjs 的分工
 *
 *   extra  脚本：处理**父体**响应里的嵌套结构（multiNfInfo / recRanks / 事件）
 *   本脚本    ：处理**子体**各自的响应，口径与 extra 完全一致
 *
 * 两者写的是同一批表，靠主键 (asin, country, ...) 区分，不会互相覆盖。
 *
 * ## 一个必读的口径说明
 *
 * `asin-keyword-list` 对每个 ASIN 都只返回 4 个词，且**分页参数无效** ——
 * 实测 `page` / `pageNum` / `pageNo` 配 50/100/500 的 pageSize、
 * 翻到第 2 页，结果都是同样的 4 条，响应里也没有 `total` 字段。
 * 所以这不是「没翻页」，而是该接口对单个 ASIN 就是给头部 4 词。
 * 不要为了「凑更多词」去循环翻页 —— 那是无效请求。
 *
 * 用法：
 *   node scripts/sif_load_variants_to_doris.mjs --dir .tmp/sif-variants --country US [--dry]
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
const DIR = arg('dir', '.tmp/sif-variants')
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
  if (typeof v === 'number' || /^\d{10,}$/.test(String(v))) {
    const ms = Number(v)
    if (!Number.isFinite(ms)) return null
    const d = new Date(String(v).length <= 10 ? ms * 1000 : ms)
    return Number.isNaN(d.getTime()) ? null : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
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

/** 渠道码归一：上游对「SP 推荐位」有 recSp / spRec 两种拼法 */
const CHANNEL_ALIAS = { recSp: 'spRec', recsp: 'spRec' }
const normChannel = (c) => {
  if (c === null || c === undefined || c === '') return null
  return CHANNEL_ALIAS[String(c)] ?? String(c)
}

// ---------- 读取 ----------

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('-kwlist.json'))
console.log(`[variants] ${files.length} 个变体文件 <- ${DIR}${DRY ? ' （dry-run）' : ''}`)

const kwSnapshotRows = []
const kwScoreRows = []
const dimKw = new Map()
const varBest = new Map()   // multif 变体×词×月
const dayAgg = new Map()    // multif 日级
const recRel = new Map()
const recTitles = new Set()
const campaigns = new Map()
const seenAsin = new Set()

for (const f of files) {
  let p
  try {
    p = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))
  } catch { continue }
  if (p.status !== 'ok') { console.log(`  跳过 ${f}: status=${p.status}`); continue }

  const asin = f.replace('-kwlist.json', '')
  const list = p.data?.data?.list
  if (!Array.isArray(list) || !list.length) continue
  seenAsin.add(asin)

  for (const r of list) {
    const kw = normKw(r.keyword)
    if (!kw) continue
    const tags = Array.isArray(r.keywordTags) ? r.keywordTags : []

    // ---- 关键词主档 ----
    if (!dimKw.has(kw)) {
      dimKw.set(kw, {
        kid: num(r.keywordId),
        translate: nn(r.translateKeyword),
        est: num(r.monthSearchVolume),
      })
    }

    // ---- ASIN × 关键词 快照 ----
    kwSnapshotRows.push([
      asin, COUNTRY, clip(kw, 128), 'month', '2026-08', 0,
      num(r.keywordId),
      // is_core 只认 tags 里真正的 isCore。该接口实测只吐 isMainKw，
      // 把它当核心词会让筛选失去区分度（详见 keywords.service.ts 的说明）
      tags.includes('isCore') ? 1 : 0,
      tags.includes('isTarget') ? 1 : 0,
      nn(r.pieceMaxTime),
      num(r.nfLastRank), fmtDt(r.nfLastRankTime), nn(r.nfLastRankAsin),
      num(r.spLastRank), fmtDt(r.spLastRankTime), nn(r.spLastRankAsin),
      nn(r.spCampaignId),
      num(r.scoreInfo?.scoreRatio),
      Array.isArray(r.exposurePositions)
        ? r.exposurePositions.map(normChannel).join(',')
        : nn(normChannel(r.exposurePositions)),
      num(r.monthSearchVolume),
      NOW,
    ])

    // ---- 关键词分渠道得分（本接口只给汇总，故 channel='total'）----
    if (r.scoreInfo) {
      kwScoreRows.push([
        asin, COUNTRY, clip(kw, 128), 'month', '2026-08', 'total',
        num(r.keywordId),
        num(r.scoreInfo.score), num(r.scoreInfo.scoreRatio),
        num(r.scoreInfo.scoreChange), num(r.scoreInfo.scoreChangeRatio),
        num(r.scoreInfo.contriChangeRatio), NOW,
      ])
    }

    // ---- 多变体自然位：取月内最好名次（与父体口径一致）----
    const da = r.multiNfInfo?.dateAsins
    if (Array.isArray(da)) {
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
          const key = `${kw}|${vid}|${month}`
          const prev = varBest.get(key)
          const rk = num(a.rank)
          if (!prev || (rk !== null && (prev.rank === null || rk < prev.rank))) {
            varBest.set(key, {
              rank: rk, pageNum: num(a.pageNum), pageRank: num(a.pageRank),
              pageSize: num(a.pageSize), img: nn(a.img), kid: num(r.keywordId),
            })
          }
        }
        dayAgg.set(date, cur)
      }
    }

    // ---- 推荐专栏 → 活动×关键词 关联 ----
    const ar = r.allRankHistory
    if (ar && Array.isArray(ar.date) && Array.isArray(ar.recRanks)) {
      ar.recRanks.forEach((entry, i) => {
        if (!entry || typeof entry !== 'object') return
        for (const [title, v] of Object.entries(entry)) {
          const cid = nn(v?.campaignId)
          if (!cid) return
          recTitles.add(title)
          recRel.set(`${title}|${kw}|${cid}`, [
            asin, COUNTRY, clip(title, 255), clip(kw, 128), clip(cid, 64),
            num(r.keywordId), nn(v?.maskCampaignId), NOW,
          ])
        }
      })
    }

    // ---- 活动主档 ----
    if (r.spCampaignId) {
      const cid = String(r.spCampaignId)
      const cur = campaigns.get(cid) ?? { mask: null, adType: null }
      if (!cur.mask) cur.mask = nn(r.spMaskCampaignId)
      if (cur.adType === null) cur.adType = 1   // spCampaignId 就是 SP
      campaigns.set(cid, cur)
    }
  }
}

console.log(`  覆盖 ${seenAsin.size} 个变体，${dimKw.size} 个去重词`)

// ---------- 写入 ----------

await insertBatch(
  'fact_asin_keyword_snapshot',
  ['asin', 'country', 'keyword', 'time_piece_type', 'time_piece_value',
    'is_listing_search', 'keyword_id', 'is_core', 'is_target', 'piece_max_time',
    'nf_last_rank', 'nf_last_rank_time', 'nf_last_rank_asin',
    'sp_last_rank', 'sp_last_rank_time', 'sp_last_rank_asin', 'sp_campaign_id',
    'listing_score_ratio', 'exposure_positions', 'est_searches_num', 'created_at'],
  kwSnapshotRows,
)

await insertBatch(
  'fact_asin_keyword_score',
  ['asin', 'country', 'keyword', 'time_piece_type', 'time_piece_value', 'channel',
    'keyword_id', 'score', 'score_ratio', 'score_change', 'score_change_ratio',
    'contri_change_ratio', 'created_at'],
  kwScoreRows,
)

// ---- dim_keyword（合并写，保留已有翻译/搜索量）----
if (dimKw.size) {
  const DIM_KW_COLS = ['keyword', 'country', 'keyword_id', 'translate_keyword',
    'est_searches_num', 'created_at', 'updated_at']
  const kws = [...dimKw.keys()]
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
    const m = dimKw.get(kw)
    return [
      clip(kw, 128), COUNTRY,
      old.keyword_id ?? m.kid,
      old.translate_keyword ?? m.translate,
      old.est_searches_num ?? m.est,
      old.created_at ? fmtDt(old.created_at) : NOW,
      NOW,
    ]
  })
  console.log(`[variants] dim_keyword: ${kws.length} 个（库中已存在 ${existing.size}）`)
  await insertBatch('dim_keyword', DIM_KW_COLS, out)
}

// ---- 多变体自然位（每变体各自展开）----
const variantRows = []
for (const [key, v] of varBest) {
  const [kw, vid, month] = key.split('|')
  variantRows.push([vid, COUNTRY, clip(kw, 128), vid, 'month', month, v.kid,
    v.rank, v.pageNum, v.pageRank, v.pageSize, clip(v.img, 512), 'main', NOW])
}
await insertBatch(
  'fact_asin_multinf_keyword_variant',
  ['parent_asin', 'country', 'keyword', 'variant_asin', 'time_piece_type',
    'time_piece_value', 'keyword_id', 'rank_position', 'page_num', 'page_rank',
    'page_size', 'img', 'variant_role', 'created_at'],
  variantRows,
)

// parent_asin 是主键的一部分，不能为 null —— 按变体分别写
const dailyByAsin = new Map()
for (const [date, agg] of dayAgg) {
  for (const a of agg.asins) {
    const key = `${a}|${date}`
    dailyByAsin.set(key, [a, COUNTRY, date, agg.asins.size, agg.kws.size, null, null, null, NOW])
  }
}
await insertBatch(
  'fact_asin_multinf_daily',
  ['asin', 'country', 'stat_date', 'asin_cnt', 'keyword_cnt', 'score',
    'extra_score', 'listing_asin_cnt', 'created_at'],
  [...dailyByAsin.values()],
)

// ---- 推荐专栏关系 ----
await insertBatch(
  'rel_rec_column_campaign_keyword',
  ['asin', 'country', 'rec_title', 'keyword', 'encrypt_campaign_id', 'keyword_id',
    'mask_campaign_id', 'created_at'],
  [...recRel.values()],
)

// ---- 专栏维表（合并写，不能抹掉已有中文名）----
if (recTitles.size) {
  const REC_COLS = ['rec_title', 'country', 'short_code', 'display_name_cn',
    'first_seen_at', 'last_seen_at']
  const titles = [...recTitles].map((t) => clip(t, 255))
  const old = new Map()
  const [rows] = await conn.query(
    `SELECT ${REC_COLS.map((c) => `\`${c}\``).join(', ')} FROM dim_recommend_column
      WHERE country = ? AND rec_title IN (${titles.map(() => '?').join(', ')})`,
    [COUNTRY, ...titles],
  )
  for (const r of rows) old.set(r.rec_title, r)
  const out = titles.map((t) => {
    const o = old.get(t)
    return [t, COUNTRY, o?.short_code ?? null, o?.display_name_cn ?? null,
      o?.first_seen_at ? fmtDt(o.first_seen_at) : NOW, NOW]
  })
  console.log(`[variants] dim_recommend_column: ${titles.length} 个（库中已存在 ${old.size}）`)
  await insertBatch('dim_recommend_column', REC_COLS, out)
}

// ---- 活动主档（合并写）----
if (campaigns.size) {
  const AD_COLS = ['encrypt_campaign_id', 'country', 'fake_campaign_id', 'ad_type',
    'product_type', 'strategy', 'asin_num', 'ad_num', 'campaign_created_at',
    'last_ad_created_at', 'created_at', 'updated_at']
  const ids = [...campaigns.keys()]
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
  const out = ids.map((cid) => {
    const old = existing.get(cid) ?? {}
    const c = campaigns.get(cid)
    const merged = {}
    for (const col of AD_COLS) merged[col] = old[col] ?? null
    merged.encrypt_campaign_id = cid
    merged.country = COUNTRY
    merged.fake_campaign_id = old.fake_campaign_id ?? c.mask ?? (cid.length >= 4 ? cid.slice(-4) : null)
    merged.ad_type = old.ad_type ?? c.adType
    merged.campaign_created_at = fmtDate(old.campaign_created_at)
    merged.last_ad_created_at = fmtDate(old.last_ad_created_at)
    merged.created_at = old.created_at ? fmtDt(old.created_at) : NOW
    merged.updated_at = NOW
    return AD_COLS.map((col) => merged[col])
  })
  console.log(`[variants] dim_ad_campaign: ${ids.length} 个（库中已存在 ${existing.size}）`)
  await insertBatch('dim_ad_campaign', AD_COLS, out)
}

console.log(`\n[variants] ${DRY ? '预演' : '写入'}完成：`)
for (const t of Object.keys(stats).sort()) console.log(`  ${String(stats[t]).padStart(7)}  ${t}`)

await conn.end()

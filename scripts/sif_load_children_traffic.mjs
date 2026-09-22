/**
 * 把子体 ASIN 的 traffic-trend 落盘数据灌进 Doris。
 *
 * ## 为什么单独有这个脚本
 *
 * `sif_load_to_doris.mjs` 只处理「探针 ASIN 自己」那一个 traffic-trend ——
 * 流量渠道 / Listing 快照 / 子类目 BSR 三张表因此只有父体一行。
 * 而 /traffic/variants 页面是把**整组变体**并排展示的，
 * 各子体没有数据就全是 0，页面看起来像「这组只有父体有流量」。
 *
 * 所以采集侧要额外把 16 个子体各打一次 traffic-trend（脚本外完成，
 * 落盘到 <dir>/<asin>-traffic.json），本脚本负责按同一口径写入。
 *
 * ## 聚合口径与 sif_load_to_doris.mjs 完全一致
 *
 * 三张表都从 traffic-trend 的**平行数组**按月聚合：
 *   fact_asin_traffic_channel      score 取该月「最后一个 total 有值的日」（锚点日）
 *   fact_asin_listing_snapshot     每个字段各自取该月最后一个有值的日
 *   fact_asin_subbsr_snapshot      subBsr 逐日展开，不做月聚合
 *
 * ⚠️ 锚点日的选择不能省：若让各渠道各自取「自己最后一个有值的日」，
 *    同一个月的 total 与 sp 会取自不同天，子渠道反而大于总量，
 *    上层用「渠道/合计」重算占比时得出荒谬值。详见主脚本的注释。
 *
 * 用法：
 *   node scripts/sif_load_children_traffic.mjs --dir .tmp/sif-children [--country US] [--dry]
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
const DIR = arg('dir', '.tmp/sif-children')
const COUNTRY = arg('country', 'US')
const DRY = argv.includes('--dry')

const num = (v) => {
  const n = Number(v)
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n
}

const pad = (x) => String(x).padStart(2, '0')
const NOW = (() => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
})()

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

/** 渠道字段 → 字典 code（与主脚本 TREND_CH 一致） */
const TREND_CH = {
  totalScore: 'total', nfScore: 'nf', adScore: 'ad', spScore: 'sp',
  recSpScore: 'spRec', sbScore: 'sb', sbvScore: 'sbv',
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('-traffic.json'))
console.log(`[children] ${files.length} 个文件 <- ${DIR}${DRY ? ' （dry-run）' : ''}`)

const chRows = [], lsRows = [], bsRows = []
const seen = new Set()

for (const f of files) {
  let p
  try {
    p = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))
  } catch { continue }
  if (p.status !== 'ok') { console.log(`  跳过 ${f}: status=${p.status}`); continue }

  const t = p.data?.data
  if (!t?.dates) continue
  const asin = String(t.asin ?? f.replace('-traffic.json', ''))
  seen.add(asin)
  const dates = t.dates

  // ---- 渠道得分：按月锚点日聚合 ----
  const totalArr = Array.isArray(t.totalScore) ? t.totalScore : []
  const anchorIdx = new Map()
  if (totalArr.length === dates.length) {
    dates.forEach((d, i) => {
      const v = totalArr[i]
      if (!v || v.score === null || v.score === undefined) return
      // 后写覆盖先写 → 留下该月最后一个 total 有值的日
      anchorIdx.set(String(d).slice(0, 7), i)
    })
  }
  for (const [month, i] of anchorIdx) {
    for (const [srcKey, code] of Object.entries(TREND_CH)) {
      const arr = t[srcKey]
      if (!Array.isArray(arr) || arr.length !== dates.length) continue
      const v = arr[i]
      // 锚点日该渠道无值 = 当月这个渠道没有流量，不写这一行（缺行比假 0 诚实）
      if (!v || typeof v !== 'object' || v.score === null || v.score === undefined) continue
      chRows.push([asin, COUNTRY, 'month', month, code,
        num(v.score), num(v.scoreRatio), num(v.scoreChange),
        num(v.scoreChangeRatio), num(v.contriChangeRatio), NOW])
    }
  }

  // ---- Listing 月度快照 ----
  const pick = (k) =>
    Array.isArray(t[k]) && t[k].length === dates.length ? t[k] : null
  const bsr = pick('bsr'), star = pick('star'), review = pick('review'), price = pick('buyboxPrice')
  const byMonth = new Map()
  dates.forEach((d, i) => {
    const month = String(d).slice(0, 7)
    const cur = byMonth.get(month) ?? { price: null, score: null, rating: null, bsr: null }
    if (price?.[i] !== null && price?.[i] !== undefined) cur.price = num(price[i])
    if (star?.[i] !== null && star?.[i] !== undefined) cur.score = num(star[i])
    if (review?.[i] !== null && review?.[i] !== undefined) cur.rating = num(review[i])
    if (bsr?.[i] !== null && bsr?.[i] !== undefined) cur.bsr = num(bsr[i])
    byMonth.set(month, cur)
  })
  for (const [month, v] of byMonth) {
    if (v.price === null && v.score === null && v.rating === null && v.bsr === null) continue
    lsRows.push([asin, COUNTRY, month, v.price, v.score, v.rating, v.bsr, NOW])
  }

  // ---- 子类目 BSR：逐日展开，不做月聚合 ----
  if (t.subBsr && typeof t.subBsr === 'object') {
    for (const [catName, arr] of Object.entries(t.subBsr)) {
      if (!Array.isArray(arr) || arr.length !== dates.length) continue
      arr.forEach((v, i) => {
        const n = num(v)
        if (n === null) return
        bsRows.push([asin, COUNTRY, catName, dates[i], n, NOW])
      })
    }
  }
}

console.log(`  覆盖 ${seen.size} 个 ASIN`)

await insertBatch('fact_asin_traffic_channel',
  ['asin', 'country', 'time_piece_type', 'time_piece_value', 'channel', 'score',
    'score_ratio', 'score_change', 'score_change_ratio', 'contri_change_ratio', 'created_at'],
  chRows)
await insertBatch('fact_asin_listing_snapshot',
  ['asin', 'country', 'stat_month', 'price', 'score', 'rating_num', 'bsr', 'created_at'],
  lsRows)
await insertBatch('fact_asin_subbsr_snapshot',
  ['asin', 'country', 'cat_name', 'stat_date', 'bsr', 'created_at'],
  bsRows)

console.log(`\n[children] ${DRY ? '预演' : '写入'}完成：`)
for (const t of Object.keys(stats).sort()) console.log(`  ${String(stats[t]).padStart(7)}  ${t}`)

await conn.end()

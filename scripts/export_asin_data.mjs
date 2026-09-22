/**
 * 导出某 ASIN 的全部关联数据到一个 JSON 文件。
 *
 * 用途：给用户一份「这个 ASIN 在库里到底存了哪些数据」的完整快照，
 * 可用于对账、离线核对、或换库重灌。
 *
 * 用法：
 *   node scripts/export_asin_data.mjs --asin B01NBNDC1T --country US [--out out.json]
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
const ASIN = arg('asin', 'B01NBNDC1T')
const COUNTRY = arg('country', 'US')
const OUT = arg('out', `.tmp/${ASIN}-data.json`)

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

const q = async (sql, params = []) => {
  const [rows] = await conn.query(sql, params)
  return rows
}

// 变体组：所有子体（后续多张表的统计口径都按这组 ASIN 展开）
const variants = await q(
  `SELECT child_asin FROM rel_asin_variant WHERE parent_asin = ? AND country = ? ORDER BY display_order`,
  [ASIN, COUNTRY],
)
const childAsins = variants.map((v) => v.child_asin)
const ph = childAsins.length ? childAsins.map(() => '?').join(', ') : "''"
const scope = [COUNTRY, ...childAsins]

const out = {
  _meta: {
    asin: ASIN,
    country: COUNTRY,
    exportedAt: new Date().toISOString(),
    // 说明各表的统计口径，避免读的人误以为全是同一个 ASIN 维度
    scopeNote:
      'rel_asin_variant 是父子关系；流量/销量/Listing 快照是子体维度，' +
      '导出时按其子体集合展开；关键词/广告/推荐专栏是主查 ASIN 维度。',
    variantCount: childAsins.length,
  },
  dim_asin: await q(`SELECT * FROM dim_asin WHERE country = ? AND asin IN (${ph})`, scope),
  rel_asin_variant: await q(
    `SELECT * FROM rel_asin_variant WHERE country = ? AND parent_asin = ? ORDER BY display_order`,
    [COUNTRY, ASIN],
  ),
  dim_asin_feature: await q(
    `SELECT * FROM dim_asin_feature WHERE country = ? AND asin IN (${ph})`,
    scope,
  ),
  fact_asin_bought_monthly: await q(
    `SELECT * FROM fact_asin_bought_monthly WHERE country = ? AND asin IN (${ph}) ORDER BY asin, stat_month`,
    scope,
  ),
  fact_asin_traffic_channel: await q(
    `SELECT * FROM fact_asin_traffic_channel WHERE country = ? AND asin IN (${ph}) ORDER BY asin, time_piece_value, channel`,
    scope,
  ),
  fact_asin_listing_snapshot: await q(
    `SELECT * FROM fact_asin_listing_snapshot WHERE country = ? AND asin IN (${ph}) ORDER BY asin, stat_month`,
    scope,
  ),
  fact_asin_subbsr_snapshot: await q(
    `SELECT * FROM fact_asin_subbsr_snapshot WHERE country = ? AND asin IN (${ph}) ORDER BY stat_date`,
    scope,
  ),
  fact_asin_keyword_overview: await q(
    `SELECT * FROM fact_asin_keyword_overview WHERE country = ? AND asin IN (${ph}) ORDER BY asin, time_piece_value, channel`,
    scope,
  ),
  fact_asin_keyword_snapshot: await q(
    `SELECT * FROM fact_asin_keyword_snapshot WHERE country = ? AND asin = ? ORDER BY listing_score_ratio DESC`,
    [COUNTRY, ASIN],
  ),
  dim_keyword: await q(
    `SELECT k.* FROM dim_keyword k
      WHERE k.country = ? AND k.keyword IN (
        SELECT keyword FROM fact_asin_keyword_snapshot WHERE country = ? AND asin = ?)`,
    [COUNTRY, COUNTRY, ASIN],
  ),
  fact_asin_keyword_score: await q(
    `SELECT * FROM fact_asin_keyword_score WHERE country = ? AND asin = ? ORDER BY score DESC`,
    [COUNTRY, ASIN],
  ),
  fact_keyword_rank_history: await q(
    `SELECT * FROM fact_keyword_rank_history WHERE country = ? AND asin = ? ORDER BY keyword, rank_type, stat_date`,
    [COUNTRY, ASIN],
  ),
  fact_keyword_competition_snapshot: await q(
    `SELECT c.* FROM fact_keyword_competition_snapshot c
      WHERE c.country = ? AND c.keyword IN (
        SELECT keyword FROM fact_asin_keyword_snapshot WHERE country = ? AND asin = ?)`,
    [COUNTRY, COUNTRY, ASIN],
  ),
  fact_keyword_metric_snapshot: await q(
    `SELECT m.* FROM fact_keyword_metric_snapshot m
      WHERE m.country = ? AND m.keyword IN (
        SELECT keyword FROM fact_asin_keyword_snapshot WHERE country = ? AND asin = ?)`,
    [COUNTRY, COUNTRY, ASIN],
  ),
  fact_keyword_search_trend: await q(
    `SELECT t.* FROM fact_keyword_search_trend t
      WHERE t.country = ? AND t.keyword IN (
        SELECT keyword FROM fact_asin_keyword_snapshot WHERE country = ? AND asin = ?)
      ORDER BY t.stat_date`,
    [COUNTRY, COUNTRY, ASIN],
  ),
  fact_asin_multinf_daily: await q(
    `SELECT * FROM fact_asin_multinf_daily WHERE country = ? AND asin = ? ORDER BY stat_date`,
    [COUNTRY, ASIN],
  ),
  fact_asin_multinf_keyword_variant: await q(
    `SELECT * FROM fact_asin_multinf_keyword_variant WHERE country = ? AND parent_asin = ? ORDER BY keyword, rank_position`,
    [COUNTRY, ASIN],
  ),
  fact_asin_op_event: await q(
    `SELECT * FROM fact_asin_op_event WHERE country = ? AND asin = ? ORDER BY stat_date`,
    [COUNTRY, ASIN],
  ),
  rel_rec_column_campaign_keyword: await q(
    `SELECT * FROM rel_rec_column_campaign_keyword WHERE country = ? AND asin = ?`,
    [COUNTRY, ASIN],
  ),
  dim_recommend_column: await q(
    `SELECT * FROM dim_recommend_column WHERE country = ? AND rec_title IN (
        SELECT rec_title FROM rel_rec_column_campaign_keyword WHERE country = ? AND asin = ?)`,
    [COUNTRY, COUNTRY, ASIN],
  ),
  dim_ad_campaign: await q(
    `SELECT * FROM dim_ad_campaign WHERE country = ? AND encrypt_campaign_id IN (
        SELECT sp_campaign_id FROM fact_asin_keyword_snapshot
         WHERE country = ? AND asin = ? AND sp_campaign_id IS NOT NULL)`,
    [COUNTRY, COUNTRY, ASIN],
  ),
}

console.log(`[export] ${ASIN} / ${COUNTRY}（变体组 ${childAsins.length} 个子体）`)
let total = 0
for (const [k, v] of Object.entries(out)) {
  if (k === '_meta') continue
  console.log(`  ${String(v.length).padStart(7)}  ${k}`)
  total += v.length
}
console.log(`  ${String(total).padStart(7)}  合计`)

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8')
console.log(`\n[export] 已写入 ${OUT}（${(fs.statSync(OUT).size / 1024).toFixed(1)} KB）`)

await conn.end()

/**
 * 推荐专栏「按天活动数/词数趋势」入库 —— 原站 rec/recView → Doris
 *
 * 目标表：looom.fact_rec_column_trend（DDL 见 db/schema-09-rec-column-trend.sql）
 *
 * ## 为什么用这个源，而不是 PG 或 sif-mcp
 *
 * 原站「查推荐专栏」主表有两列带按天迷你趋势（广告活动数量及趋势、
 * 广告词数量及趋势）。这两列需要「跨该 ASIN **全部关键词**去重后的逐日计数」：
 *
 *   - PG 侧 `allRankHistory.recRanks` 只记「某天该专栏出现了、由哪个活动带来」，
 *     没有计数，且它是**单关键词**粒度 —— 跨词去重要在应用层做，
 *     而 sif-cli 的 `asin-keyword-list` 又忽略分页参数（恒返回 4 条词，
 *     实测 B01NBNDC1T 实际有 610 个推荐位词），所以这条路算不全。
 *   - sif-mcp 的工具目录里没有推荐专栏接口（只有当期 ratio，无趋势）。
 *   - sif-cli 没有注册 rec/* 端点（直调 404）。
 *
 * 唯一可行的是原站 `POST /api/search/rec/recView`：服务端已经把上面那层
 * 去重聚合做好了，直接给 campaignCntTrends / keywordCntTrends。
 * 它必须带按请求现签的 `_m` 参数，所以由主会话在已登录的浏览器里导航并捕获响应
 * （见文件末尾「采集方式」），本脚本只负责**解析 + 入库**。
 *
 * ## 本脚本只读一个输入文件
 *
 *   .tmp/rec-trend/recview.json
 *     { dates: string[7],
 *       overview: { <ASIN>: [recCnt, campaignCnt, keywordCnt] },
 *       asins: { <ASIN>: [ [recTitle, ratio, campaignCnt, keywordCnt,
 *                           campaignCntTrends[], keywordCntTrends[],
 *                           lastCampaignCnt, lastKeywordCnt], ... ] },
 *       noData: string[] }
 *
 * ⚠️ 数组形态而非对象：趋势本身就是定长数组，对象化会让「按下标对齐」
 *    这件事变得不明显，而错位是这个脚本最容易出的错。
 *
 * ## 两个必须守住的口径（实测得来，写错会让图表骗人）
 *
 * 1. **null 不是 0，是「当天该专栏无曝光」**。
 *    实测 B07N7GDB6Q / Seen on social media 的 ct 是 [null,1,2,3,3,3,3]。
 *    写 0 会让图表画出贴底的线，读起来像「有数据但为 0」。所以 NULL 原样入库。
 *
 * 2. **last_* 不是数组末位**。原站另给 lastCampaignCnt / lastKeywordCnt：
 *    上例 ct 末位是 3（同日），但 Picks from Amazon Influencers 的 ct 末位是
 *    null 而 lastCampaignCnt=1。前端显示行尾数字要用 last_*。
 *
 * 用法：
 *   node scripts/load_rec_column_trend.mjs [--in .tmp/rec-trend/recview.json] [--country US] [--dry]
 *
 * ## 采集方式（复现用）
 *
 * 在已登录 sif.com 的浏览器里逐个 ASIN 导航到
 *   https://www.sif.com/recommend?country=US&from=commonAsinTab&asin=<ASIN>
 * 并捕获页面自身发出的 rec/recView 响应体。不能用 fetch 手工重放：
 * `_m` 是按请求现签的，复用会拿到 404 / code -10。
 */
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(path.join(import.meta.dirname, '..', 'apps', 'api', 'package.json'))
const mysql = require('mysql2/promise')

// ---------- CLI ----------

const argv = process.argv.slice(2)
const arg = (k, d = null) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const IN = arg('in', '.tmp/rec-trend/recview.json')
const COUNTRY = arg('country', 'US')
const DRY = argv.includes('--dry')

// ---------- 小工具 ----------

const pad = (x) => String(x).padStart(2, '0')
const NOW = (() => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
})()

/**
 * 数值容错。
 *
 * ⚠️ 必须把 undefined 也当 null：趋势数组里 null 与「下标越界得到的 undefined」
 * 在这个脚本里是同一件事（都表示无曝光），但落库时 undefined 会被
 * mysql2 拼成字面量 undefined 导致语法错误。
 */
const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const clip = (s, n) => (s === null || s === undefined ? null : String(s).slice(0, n))

// ---------- 凭据（与同族脚本一致：env 优先，回落根 .env）----------
//
// ⚠️ 不得硬编码密码 —— 本仓库有过凭据泄漏事故。

function readDotEnv() {
  const f = path.join(import.meta.dirname, '..', '.env')
  if (!fs.existsSync(f)) return {}
  return Object.fromEntries(
    fs
      .readFileSync(f, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
      }),
  )
}

const dotenv = readDotEnv()
const DB_KEYS = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']
const env = Object.fromEntries(DB_KEYS.map((k) => [k, process.env[k] ?? dotenv[k]]))
const missing = DB_KEYS.filter((k) => k !== 'DB_PASSWORD' && !env[k])
if (missing.length) {
  console.error(`[rec-trend] 缺少数据库配置：${missing.join(', ')}（设环境变量或写入根目录 .env）`)
  process.exit(1)
}

// =====================================================================
// 1. 读输入并展开成行
// =====================================================================

const COLS = [
  'asin', 'country', 'rec_title', 'stat_date',
  'campaign_cnt', 'keyword_cnt',
  'last_campaign_cnt', 'last_keyword_cnt',
  'window_days', 'window_start', 'window_end', 'created_at',
]

function buildRows(payload) {
  const dates = payload?.dates
  if (!Array.isArray(dates) || !dates.length) {
    throw new Error('输入文件缺少 dates 数组')
  }
  const N = dates.length
  const windowStart = dates[0]
  const windowEnd = dates[N - 1]

  const rows = []
  const skipped = []
  const mismatched = []

  for (const [asin, cols] of Object.entries(payload.asins ?? {})) {
    if (!Array.isArray(cols)) {
      skipped.push(`${asin}（不是数组）`)
      continue
    }
    for (const c of cols) {
      if (!Array.isArray(c) || c.length < 8) {
        skipped.push(`${asin}（行结构不符）`)
        continue
      }
      const [
        recTitle, _ratio, _campaignCnt, _keywordCnt,
        ct, kt, lastC, lastK,
      ] = c

      // 长度必须与 dates 严格对齐 —— 错位会让「某天」张冠李戴，
      // 而且这种错从数字上看不出来（都是合理的整数），所以宁可报错也不猜。
      if (!Array.isArray(ct) || !Array.isArray(kt) || ct.length !== N || kt.length !== N) {
        mismatched.push(`${asin}/${recTitle} ct=${ct?.length} kt=${kt?.length} 期望 ${N}`)
        continue
      }

      for (let i = 0; i < N; i++) {
        rows.push([
          clip(asin, 16), COUNTRY, clip(recTitle, 255), dates[i],
          // NULL 原样保留，不补 0：null = 当天无曝光
          num(ct[i]), num(kt[i]),
          // 窗口级字段按行重复存，便于单表查询不用再关联窗口表
          num(lastC), num(lastK),
          N, windowStart, windowEnd, NOW,
        ])
      }
    }
  }
  return { rows, skipped, mismatched }
}

// =====================================================================
// 2. 入库
// =====================================================================

async function insertBatch(conn, table, cols, rows) {
  if (!rows.length) return 0
  const head = `INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES `
  const ph = '(' + cols.map(() => '?').join(', ') + ')'
  // 单条 SQL 不宜过大，200 行一批
  const B = 200
  let n = 0
  for (let i = 0; i < rows.length; i += B) {
    const chunk = rows.slice(i, i + B)
    if (!DRY) {
      await conn.query(head + chunk.map(() => ph).join(', '), chunk.flat())
    }
    n += chunk.length
  }
  return n
}

async function main() {
  if (!fs.existsSync(IN)) {
    console.error(`[rec-trend] 输入不存在：${IN}`)
    process.exit(1)
  }
  const payload = JSON.parse(fs.readFileSync(IN, 'utf8'))
  const { rows, skipped, mismatched } = buildRows(payload)

  const asinCount = new Set(rows.map((r) => r[0])).size
  const titleCount = new Set(rows.map((r) => r[2])).size
  const nullCnt = rows.filter((r) => r[4] === null).length
  const noData = payload.noData ?? []

  console.log(`[rec-trend] ${COUNTRY} / 源 ${IN}${DRY ? ' （dry-run）' : ''}`)
  console.log(`  dates ${payload.dates.length} 天：${payload.dates[0]} ~ ${payload.dates[payload.dates.length - 1]}`)
  console.log(`  有数据 ASIN ${asinCount} / 专栏 ${titleCount} / 落表 ${rows.length} 行`)
  console.log(`  无推荐专栏的 ASIN ${noData.length} 个（不造行）：${noData.join(' ') || '-'}`)
  console.log(`  当天无曝光的格子 ${nullCnt} 个（写 NULL，不写 0）`)
  if (skipped.length) console.log(`  ⚠️ 跳过 ${skipped.length} 项：${skipped.slice(0, 3).join('; ')}`)
  if (mismatched.length) {
    console.log(`  ⚠️ 趋势长度不符 ${mismatched.length} 项（已跳过，不猜）：${mismatched.slice(0, 3).join('; ')}`)
  }

  if (DRY) {
    console.log('\n[dry] fact_rec_column_trend 将写入 %d 行，首行:', rows.length)
    console.log('     ', JSON.stringify(rows[0]))
    return
  }

  const conn = await mysql.createConnection({
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 9030),
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    charset: 'utf8mb4',
  })
  try {
    const n = await insertBatch(conn, 'fact_rec_column_trend', COLS, rows)
    console.log(`\n[rec-trend] 写入完成：fact_rec_column_trend ${n} 行`)

    // 回读校验：确认 NULL 没被写成 0，且行数对得上
    const [chk] = await conn.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN campaign_cnt IS NULL THEN 1 ELSE 0 END) AS null_c,
              COUNT(DISTINCT asin) AS asins
         FROM fact_rec_column_trend WHERE country = ?`,
      [COUNTRY],
    )
    const r = chk[0]
    console.log(`  回读：${r.total} 行 / ${r.asins} 个 ASIN / campaign_cnt 为 NULL 的 ${r.null_c} 个`)
  } finally {
    await conn.end()
  }
}

main().catch((e) => {
  console.error('[rec-trend] 失败：', e.message)
  process.exit(1)
})

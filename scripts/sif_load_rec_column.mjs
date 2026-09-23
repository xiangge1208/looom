/**
 * 推荐专栏「流量占比」入库 —— sif-mcp ops_get_listing_traffic_overview → Doris
 *
 * ## 为什么单独一个脚本
 *
 * `fact_asin_rec_column_period.ratio` 一直空着。历史结论（见
 * `scripts/etl_module3_reccolumn.py` 顶部注释）是「PG 侧 flow-overview 是区间聚合、
 * 没有日期维度」，所以整张表被放弃，只留下 64 行 `B0SEED*` 假数据。
 *
 * 现在换源：sif-mcp 的 `ops_get_listing_traffic_overview` 直接给出
 * `recommend` 对象，键是专栏英文原名，值里的 `ratio` 就是缺的流量占比，
 * 并且响应带 `data_notice: "Data updated through YYYY-MM-DD ..."` —— 有了真日期，
 * stat_date 不必再硬造。实测 B07N7GDB6Q 返回 5 个专栏，
 * ratio 与原站页面逐项一致（70% / 12% / 11% / 7.2% / 0.32%）。
 *
 * ⚠️ 取数时 `isListingSearch` 必须传 `false`。传 true 返回的是父体整组聚合
 *    （实测 7 个专栏），那是 Listing 级不是 ASIN 级，会和原站单 ASIN 页面对不上。
 *
 * ## 本脚本只负责「解析 + 入库」
 *
 * MCP 工具由主会话调用并把响应落盘，脚本读文件。两种输入形态：
 *
 *   --in <目录>    目录下每个 `<ASIN>.json` 是一次 MCP 响应（ASIN 取自文件名）
 *   --in <文件>    单文件里放 `{ "<ASIN>": {...响应}, ... }` 映射
 *
 * ## 写入语义（与 sif_load_extra_to_doris.mjs 一致）
 *
 * - 目标表 Unique Key + merge-on-write，INSERT 即整行 upsert；
 * - dim_recommend_column 必须先读原行再合并，否则 display_name_cn / short_code
 *   会被整行覆盖抹成 NULL；
 * - 无源字段留 NULL，不编造 0 —— `campaign_cnt` / `keyword_cnt` 这个源不提供，
 *   写 0 会被前端读成「真的有 0 个活动」。
 *
 * 用法：
 *   node scripts/sif_load_rec_column.mjs --in .tmp/rec-overview/ [--country US] [--dry]
 *   node scripts/sif_load_rec_column.mjs --in .tmp/rec-overview.json --dry
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
const IN = arg('in', '.tmp/rec-overview')
const COUNTRY = arg('country', 'US')
const DRY = argv.includes('--dry')

// ---------- 小工具 ----------

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

/** Doris 读回的 DATETIME 是 Date 对象，String() 会得到英文串塞不回去 */
const fmtDt = (v) => {
  if (v === null || v === undefined) return null
  if (v instanceof Date) {
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())} ${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}`
  }
  return String(v).slice(0, 19).replace('T', ' ')
}

// ---------- 数据库凭据 ----------
//
// 优先 process.env，缺项回落到仓库根 .env（.env 已在 .gitignore）。
// ⚠️ 不得硬编码任何密码 —— 本仓库有过凭据泄漏事故。

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
  console.error(`[rec-column] 缺少数据库配置：${missing.join(', ')}（设环境变量或写入根目录 .env）`)
  process.exit(1)
}

// =====================================================================
// 1. 读输入：目录 → 每个 <ASIN>.json；单文件 → {asin: response} 映射
// =====================================================================

/**
 * MCP 响应可能被包一层（`{status:'ok', data:{...}}` 或 `{code, data}`），
 * 也可能就是裸的 overview 对象。逐层剥到能看见 `recommend` 为止。
 */
function unwrap(p) {
  let d = p
  for (let i = 0; i < 4 && d && typeof d === 'object'; i++) {
    if ('recommend' in d || 'overview' in d) return d
    if ('data' in d && d.data && typeof d.data === 'object') {
      d = d.data
      continue
    }
    if ('result' in d && d.result && typeof d.result === 'object') {
      d = d.result
      continue
    }
    break
  }
  return d
}

function readInput(target) {
  const abs = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target)
  if (!fs.existsSync(abs)) {
    console.error(`[rec-column] 输入不存在：${abs}`)
    process.exit(1)
  }
  const out = new Map() // asin → response

  if (fs.statSync(abs).isDirectory()) {
    for (const f of fs.readdirSync(abs).filter((f) => f.toLowerCase().endsWith('.json')).sort()) {
      const asin = path.basename(f, path.extname(f)).trim().toUpperCase()
      let p
      try {
        p = JSON.parse(fs.readFileSync(path.join(abs, f), 'utf8'))
      } catch (e) {
        console.warn(`[rec-column] ${f} JSON 解析失败，跳过：${e.message}`)
        continue
      }
      out.set(asin, unwrap(p))
    }
    return out
  }

  let p
  try {
    p = JSON.parse(fs.readFileSync(abs, 'utf8'))
  } catch (e) {
    console.error(`[rec-column] ${abs} JSON 解析失败：${e.message}`)
    process.exit(1)
  }
  for (const [k, v] of Object.entries(p ?? {})) {
    // 单文件形态要求顶层键是 ASIN，值是响应。顶层若直接是 overview 对象
    // （出现 recommend / overview 键）说明用错了形态，明确报错而不是静默吞掉。
    if (k === 'recommend' || k === 'overview' || k === 'total') {
      console.error('[rec-column] 单文件模式要求 {"<ASIN>": {...响应}} 映射；检测到裸响应对象 —— 请改用目录模式或补上 ASIN 键')
      process.exit(1)
    }
    if (!v || typeof v !== 'object') continue
    out.set(String(k).trim().toUpperCase(), unwrap(v))
  }
  return out
}

const inputs = readInput(IN)
if (!inputs.size) {
  console.error('[rec-column] 没读到任何 ASIN 输入')
  process.exit(1)
}

// =====================================================================
// 2. stat_date —— 只认 data_notice 里的真实日期
//
// ⚠️ 解析不到就报错退出，**不用 new Date() 兜底**。
//    硬造日期会把「某天的专栏流量占比」变成假的时间序列 ——
//    这个坑本仓库踩过一次，见 scripts/etl_module3_reccolumn.py 顶部注释。
// =====================================================================

/** "Data updated through 2026-09-21 (refreshes daily, 1-day delay)" → "2026-09-21" */
function parseStatDate(resp) {
  const notice = resp?.data_notice ?? resp?.dataNotice ?? null
  if (typeof notice !== 'string') return null
  const m = notice.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  const d = `${m[1]}-${m[2]}-${m[3]}`
  // 粗校验：Date 能还原成同一串才算合法日期（挡掉 2026-13-45 这类）
  const probe = new Date(`${d}T00:00:00Z`)
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== d) return null
  return d
}

// =====================================================================
// 3. 解析 recommend → 行
// =====================================================================

const factRows = []
const recTitles = new Set()
const perAsin = [] // 日志用
const noRatio = [] // ratio 缺失的 (asin, title)
const skipped = []

for (const [asin, resp] of inputs) {
  if (!asin || !/^[A-Z0-9]{8,16}$/.test(asin)) {
    skipped.push(`${asin}（ASIN 形态不合法）`)
    continue
  }
  const rec = resp?.recommend
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    skipped.push(`${asin}（响应里没有 recommend 对象）`)
    continue
  }
  const statDate = parseStatDate(resp)
  if (!statDate) {
    console.error(
      `[rec-column] ${asin}: data_notice 里解析不到日期，拒绝入库。` +
      `\n  原值：${JSON.stringify(resp?.data_notice ?? null)}` +
      '\n  stat_date 是主键的一部分，硬造日期会产生假的时间序列 —— 请补齐 data_notice 后重跑。',
    )
    process.exit(1)
  }

  const titles = Object.keys(rec)
  let n = 0
  for (const title of titles) {
    const v = rec[title]
    if (!v || typeof v !== 'object') {
      skipped.push(`${asin} / ${title}（值不是对象）`)
      continue
    }
    const ratio = num(v.ratio)
    if (ratio === null) noRatio.push(`${asin} / ${title}`)
    const key = clip(title, 255)
    recTitles.add(key)
    // campaign_cnt / keyword_cnt：本源不提供 → NULL，不写 0
    factRows.push([asin, COUNTRY, key, statDate, ratio, null, null, NOW])
    n += 1
  }
  perAsin.push({ asin, statDate, cols: n, titles })
}

// 主键 (asin,country,rec_title,stat_date) 去重：同批撞键保留后者
const dedup = new Map()
for (const r of factRows) dedup.set(`${r[0]}|${r[1]}|${r[2]}|${r[3]}`, r)
const dupCount = factRows.length - dedup.size

// =====================================================================
// 4. 连库 + 写入
// =====================================================================

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

console.log(`[rec-column] ${COUNTRY} / 源 ${IN} / ${inputs.size} 个 ASIN${DRY ? ' （dry-run）' : ''}`)
for (const p of perAsin) {
  console.log(`  ${p.asin}  stat_date=${p.statDate}  ${p.cols} 个专栏  ${p.titles.join(' | ')}`)
}
if (dupCount) console.log(`[rec-column] 同批主键重复合并 ${dupCount} 行`)
if (skipped.length) console.log(`[rec-column] 跳过 ${skipped.length} 项：${skipped.join('; ')}`)
if (noRatio.length) {
  console.log(`[rec-column] ⚠️ ratio 为空 ${noRatio.length} 项（写 NULL）：${noRatio.join('; ')}`)
} else {
  console.log('[rec-column] ratio 全部有值')
}

await insertBatch(
  'fact_asin_rec_column_period',
  ['asin', 'country', 'rec_title', 'stat_date', 'ratio', 'campaign_cnt', 'keyword_cnt', 'created_at'],
  [...dedup.values()],
)

// ---------- dim_recommend_column upsert ----------
//
// ⚠️ Doris 不支持 ON DUPLICATE KEY UPDATE，merge-on-write 是**整行覆盖**，
//    直接 INSERT 会把已有的 display_name_cn / short_code 抹成 NULL。
//    所以先读原行，只补 first_seen_at / last_seen_at。
if (recTitles.size) {
  const REC_COLS = ['rec_title', 'country', 'short_code', 'display_name_cn',
    'first_seen_at', 'last_seen_at']
  const titles = [...recTitles]
  const old = new Map()
  const [rows] = await conn.query(
    `SELECT ${REC_COLS.map((c) => `\`${c}\``).join(', ')} FROM dim_recommend_column
      WHERE country = ? AND rec_title IN (${titles.map(() => '?').join(', ')})`,
    [COUNTRY, ...titles],
  )
  for (const r of rows) old.set(r.rec_title, r)

  const out = titles.map((t) => {
    const o = old.get(t)
    return [
      t, COUNTRY,
      o?.short_code ?? null,
      o?.display_name_cn ?? null,
      o?.first_seen_at ? fmtDt(o.first_seen_at) : NOW,
      NOW,
    ]
  })
  const fresh = titles.filter((t) => !old.has(t))
  console.log(
    `[rec-column] dim_recommend_column: ${titles.length} 个专栏（库中已存在 ${old.size}` +
    `${fresh.length ? `，新增 ${fresh.length}：${fresh.join(' | ')}` : ''}）`,
  )
  await insertBatch('dim_recommend_column', REC_COLS, out)
}

// ---------- seed 行体检 ----------
//
// seed 行 asin 是 B0SEED*，与真实 ASIN 主键不冲突，所以不删（删除属破坏性操作，
// 交给用户决定），但要报出来提醒。
try {
  const [[c]] = await conn.query(
    "SELECT COUNT(*) AS n FROM fact_asin_rec_column_period WHERE asin LIKE 'B0SEED%'",
  )
  const n = Number(c?.n ?? 0)
  if (n > 0) {
    console.log(
      `[rec-column] ⚠️ 库里还有 ${n} 行 seed 假数据（asin LIKE 'B0SEED%'）。` +
      '主键与真实 ASIN 不冲突故未删除；确认要清理请自行执行 DELETE。',
    )
  } else {
    console.log('[rec-column] 库里无 seed 假数据')
  }
} catch (e) {
  console.warn(`[rec-column] seed 行体检失败（不影响写入）：${e.message}`)
}

// =====================================================================
// 汇总
// =====================================================================

console.log(`\n[rec-column] ${DRY ? '预演' : '写入'}完成：`)
const names = Object.keys(stats).sort()
if (!names.length) console.log('  （无数据可写）')
for (const t of names) console.log(`  ${String(stats[t]).padStart(7)}  ${t}`)

await conn.end()

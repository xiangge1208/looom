/**
 * 日粒度快照 + 流量归因 + ABA 趋势 入库 —— sif-cli 响应 → Doris
 *
 * ## 背景
 *
 * 原站三个图表本地做不出来，根因都是数据层缺日粒度（不是表设计错）：
 *   「查流量(词)」60 天价格/BSR/事件复合图（11 系列）
 *   「运营时光机」83 天因果图（16 系列）
 *   「查流量(词)」流量变化归因表
 *
 * 换源 sif-cli 后一次就能拿全，本脚本负责解析入库。建表见
 * db/schema-10-daily-grain.sql。
 *
 * ## 本脚本只负责「解析 + 入库」
 *
 * 取数由主会话调 sif-cli 落盘（与 sif_load_rec_column.mjs 同模式）——
 * 网关按调用计费，采集一次、入库可反复重跑。期望的输入文件：
 *
 *   <IN>/traffic-trend-12m.json   sif-cli call traffic-trend --query '{"asin":..,"granularity":"day","lastMonths":12}'
 *   <IN>/rvs.json                 sif-cli rvs <ASIN> --json
 *   <IN>/diag.txt                 sif-cli diag <ASIN> --period 2026-08 --granularity month
 *   <IN>/aba-<词>.json            sif-cli call keyword-aba-trend --query '{"keyword":..,"granularity":"week"}'
 *
 * 缺哪个文件就跳过对应的表，不报错 —— 三张表各自独立，允许分批灌。
 *
 * ## 三个必须知道的读数口径（实测，易错）
 *
 * 1. **响应是「时间轴 + 等长数组」，按下标对齐**，不是 {date,value} 配对结构。
 *    实测 356 天：dates[] 与 bsr[]/star[]/buyboxPrice[] 等长同序。
 *
 * 2. **流量族是结构体数组**：nfScore[i] = {score, scoreRatio, scoreChange, ...}，
 *    要取 .score / .scoreRatio，不能整个对象往列里塞。
 *
 * 3. **bsr 是大类、subBsr 是小类**。实测 bsr[] 对应 catName="Home & Kitchen"
 *    （值 20~65），subBsr 是 {"Pillow Inserts": [...]}（值恒 1~2）。
 *    现有 fact_asin_subbsr_snapshot 只存了小类，所以大类此前整个丢了。
 *    subBsr 的键是**动态类目名**，必须遍历取，不能硬编码。
 *
 * ## NULL vs 0
 *
 * 稀疏列一律 NULL 不写 0。实测 356 天里 ldPrice 只有 36 天非空、
 * titleImg 14 天、promotion/couponInfo/primePrice 全为 null。
 * 写 0 会被前端读成「当天秒杀价是 0 元」。
 *
 * 用法：
 *   node scripts/sif_load_daily_grain.mjs --in .tmp/daily/ [--asin B01NBNDC1T] [--country US] [--dry]
 */
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

// mysql2 装在 apps/api/node_modules 下，而本脚本在 scripts/ ——
// ESM 的 import 按文件所在目录向上找 node_modules，找不到会直接报错，跟 cwd 无关。
const require = createRequire(path.join(import.meta.dirname, '..', 'apps', 'api', 'package.json'))
const mysql = require('mysql2/promise')

// ---------- CLI 参数 ----------

const argv = process.argv.slice(2)
const arg = (k, d = null) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const IN = arg('in', '.tmp/daily')
const ASIN = arg('asin', 'B01NBNDC1T')
const COUNTRY = arg('country', 'US')
const DRY = argv.includes('--dry')

// ---------- 小工具 ----------

/** 空串/undefined 归一成 NULL（不碰 0 和 false） */
const nn = (v) => (v === undefined || v === '' ? null : v)

/**
 * 数值归一。undefined 也要当 NULL —— 数组下标越界会得到 undefined，
 * mysql2 会把它拼成字面量 undefined 导致语法错误。
 * Number.isFinite 守卫是因为 Doris 拒收 NaN/Infinity。
 */
const num = (v) => {
  const n = Number(v)
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n
}

const clip = (s, n) => (s === null || s === undefined ? null : String(s).slice(0, n))

/** 本地时区的 'YYYY-MM-DD HH:mm:ss'，用于 created_at */
const NOW = (() => {
  const d = new Date()
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
})()

/**
 * Doris 的 DATE 经 mysql2 读回是 **Date 对象**，直接 String() 会得到
 * "Wed Oct 01 2025 ..." 这种英文串。回读校验里要显示日期就得走这个。
 */
const fmtDate = (v) => {
  if (!v) return null
  if (v instanceof Date) {
    const p = (x) => String(x).padStart(2, '0')
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`
  }
  return String(v).slice(0, 10)
}

/**
 * 剥信封。sif-cli 的响应形如 { status, data: { code, data: {...} } }，
 * 有时只有一层。逐层剥到看见目标键为止。
 */
function unwrap(raw, probeKey) {
  let cur = raw
  for (let i = 0; i < 4 && cur && typeof cur === 'object'; i++) {
    if (probeKey in cur) return cur
    cur = cur.data
  }
  return null
}

/** 读 JSON；sif-cli 的输出前可能有一行 [sif-cli] 提示，容错跳过 */
function readJson(file) {
  if (!fs.existsSync(file)) return null
  const txt = fs.readFileSync(file, 'utf8')
  const start = txt.indexOf('{')
  if (start < 0) return null
  try {
    return JSON.parse(txt.slice(start))
  } catch {
    console.error(`[daily-grain] ${path.basename(file)} 不是合法 JSON，跳过`)
    return null
  }
}

// ---------- 数据库配置 ----------
//
// ⚠️ 不得硬编码密码 —— 本仓库有过凭据泄漏事故。
// process.env 优先，缺项回落根目录 .env，都没有则报错退出。

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
  console.error(
    `[daily-grain] 缺少数据库配置：${missing.join(', ')}（设环境变量或写入根目录 .env）`,
  )
  process.exit(1)
}

// ---------- 写库 ----------

const stats = {}
const note = (t, n) => {
  stats[t] = (stats[t] ?? 0) + n
}

let conn = null

/**
 * 批量 upsert。Doris 不支持 ON DUPLICATE KEY UPDATE，
 * Unique Key + merge-on-write 下裸 INSERT 就是整行覆盖。
 * ⚠️ 推论：没写进 VALUES 的列会被置 NULL 而不是保持原值。
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
    await conn.query(`INSERT INTO \`${table}\` (${cols}) VALUES ${ph}`, chunk.flat())
  }
  note(table, rows.length)
}

// ---------- 表 1：fact_asin_daily_snapshot ----------

const DAILY_COLS = [
  'asin', 'country', 'stat_date',
  'buybox_price', 'deal_price', 'ld_price', 'ld_raw', 'prime_price',
  'total_score', 'nf_score', 'nf_ratio', 'ad_score', 'ad_ratio',
  'sp_score', 'rec_sp_score', 'sb_score', 'sbv_score',
  'bsr', 'sub_bsr', 'sub_bsr_cat', 'cat_name',
  'star', 'review_num', 'seller_num',
  'woot', 'title_img', 'coupon_info', 'promotion', 'buybox_seller',
  'bought_in_past_month', 'created_at',
]

function buildDailyRows(d) {
  const dates = d.dates || []
  if (!dates.length) return []

  /** 流量族取 .score / .scoreRatio —— 它们是结构体数组不是数值数组 */
  const sc = (arr, i) => num(arr?.[i]?.score)
  const rt = (arr, i) => num(arr?.[i]?.scoreRatio)

  /**
   * ldPrice 是**复合串**不是数字：实测 "14.99_0_当日19:35-次日07:35"
   * （价格_标志_时段）。直接 num() 会全部得到 NULL —— 第一次灌数就是这么
   * 把 36 天有值的秒杀价全丢了。这里拆出价格、原串另存。
   */
  const ldOf = (raw) => {
    if (raw === null || raw === undefined || raw === '') return [null, null]
    const s = String(raw)
    return [num(s.split('_')[0]), clip(s, 255)]
  }

  /**
   * subBsr 的键是动态类目名（实测 "Pillow Inserts"），遍历取第一个。
   * 硬编码类目名换个商品就取不到。
   */
  const subEntries = Object.entries(d.subBsr || {})
  const subCat = subEntries.length ? subEntries[0][0] : null
  const subArr = subEntries.length ? subEntries[0][1] : []

  const rows = []
  for (let i = 0; i < dates.length; i++) {
    const day = dates[i]
    if (!day) continue
    const [ldPrice, ldRaw] = ldOf(d.ldPrice?.[i])
    rows.push([
      ASIN, COUNTRY, day,
      num(d.buyboxPrice?.[i]), num(d.dealPrice?.[i]), ldPrice, ldRaw, num(d.primePrice?.[i]),
      sc(d.totalScore, i),
      sc(d.nfScore, i), rt(d.nfScore, i),
      sc(d.adScore, i), rt(d.adScore, i),
      sc(d.spScore, i), sc(d.recSpScore, i), sc(d.sbScore, i), sc(d.sbvScore, i),
      num(d.bsr?.[i]), num(subArr?.[i]), clip(subCat, 255), clip(nn(d.catName), 255),
      num(d.star?.[i]), num(d.review?.[i]), num(d.seller?.[i]),
      num(d.woot?.[i]),
      // titleImg 是整数标志位（实测值 2），不是文本
      num(d.titleImg?.[i]),
      clip(nn(d.couponInfo?.[i]), 255),
      clip(nn(d.promotion?.[i]), 255),
      clip(nn(d.buyboxSeller?.[i]), 255),
      num(d.boughtInPastMonth?.[i]),
      NOW,
    ])
  }
  return rows
}

// ---------- 表 2：fact_asin_keyword_attribution ----------

const ATTR_COLS = [
  'asin', 'country', 'keyword', 'stat_date', 'granularity',
  'keyword_id', 'translate_keyword',
  'contri_change', 'contri_change_ratio', 'contri_change_total',
  'score', 'score_before', 'score_ratio',
  'search_volume', 'search_rank',
  'reason_summary', 'change_reasons', 'positive', 'created_at',
]

/**
 * rvs 的 changeReasons[] → 中文摘要。
 * 源已经把话说好了（reason 字段形如 "SP(常规)位：- → 1"），这里只做拼接。
 * type=REC 那种没有 reason、只有 recTitle，需要自己补动词。
 */
function summarizeRvsReasons(reasons) {
  if (!Array.isArray(reasons) || !reasons.length) return null
  const parts = []
  for (const r of reasons) {
    if (r?.reason) parts.push(String(r.reason))
    else if (r?.recTitle) parts.push(`获得推荐专栏：${r.recTitle}`)
  }
  return parts.length ? parts.join('；') : null
}

/**
 * diag 的 pchangeReason → 中文摘要。
 *
 * 与 rvs 不同：这里是**结构化**的，源没给现成文案，要自己组装。
 * 每个 *Info 有两种形态（实测）：
 *   对象 {inFre, beforeInFre, rankAvg, begoreRankAvg, ...}  周/月粒度
 *   字符串 "17_3"（形如 "上期_本期"）                        部分渠道
 * 只有 isChanged 为真的渠道才值得写进摘要，否则摘要会被没变化的渠道刷满。
 *
 * ⚠️ 源字段名有拼写错误（begoreRankAvg 少个 f、vedioInfo 而非 video），
 *    这是源侧的，照它写，不要"修正"成正确拼写否则取不到值。
 */
/**
 * ⚠️ 源里有**同义字段对**，只能保留一个否则摘要里同一件事说两遍：
 *   sbInfo  与 brandInfo   实测值恒相同（都是 "17_3"）→ 只取 sbInfo
 *   sbvInfo 与 vedioInfo   同上（vedio 是源侧拼写错误）→ 只取 sbvInfo
 * 实测未去重时摘要会变成「SB位：17 → 3；品牌位：17 → 3」这种重复读数。
 */
const CH_LABEL = {
  nfInfo: '自然位',
  spInfo: 'SP(常规)位',
  recSpInfo: 'SP(推荐)位',
  sbInfo: 'SB位',
  sbvInfo: 'SBV位',
  acInfo: 'AC推荐',
  erInfo: 'ER推荐',
  trInfo: 'TR推荐',
  otherRecommendedInfo: '其他推荐位',
}

function summarizePchangeReason(p) {
  if (!p || typeof p !== 'object') return null
  const parts = []
  for (const [k, label] of Object.entries(CH_LABEL)) {
    const v = p[k]
    if (v === null || v === undefined) continue
    if (typeof v === 'string') {
      // "17_3" = 上期_本期
      const [before, now] = v.split('_')
      if (before !== now) parts.push(`${label}：${before || '-'} → ${now || '-'}`)
      continue
    }
    if (typeof v === 'object' && v.isChanged) {
      const a = v.begoreRankAvg ?? v.beforeInFre
      const b = v.rankAvg ?? v.inFre
      if (a !== b) parts.push(`${label}：${a ?? '-'} → ${b ?? '-'}`)
    }
  }
  return parts.length ? parts.join('；') : null
}

/** rvs（日粒度）→ 行 */
function buildAttrRowsFromRvs(d) {
  const day = d?.date
  const list = d?.mainChangeKeywords
  if (!day || !Array.isArray(list)) return []
  return list
    .filter((r) => r?.keyword)
    .map((r) => [
      ASIN, COUNTRY, clip(r.keyword, 128), day, 'day',
      num(r.keywordId), clip(nn(r.translateKeyword), 255),
      num(r.contriChange), num(r.contriChangeRatio), num(r.contriChangeTotal),
      num(r.score), num(r.scoreBefore), num(r.scoreRatio),
      num(r.searchVolume), num(r.searchRank),
      clip(summarizeRvsReasons(r.changeReasons), 512),
      r.changeReasons ? JSON.stringify(r.changeReasons) : null,
      num(r.changeReasons?.[0]?.positive),
      NOW,
    ])
}

/** diag（月粒度）→ 行。period 形如 2026-08，落表存该月首日 */
function buildAttrRowsFromDiag(d, period) {
  const list = d?.details
  if (!Array.isArray(list) || !period) return []
  const day = `${period}-01`
  return list
    .filter((r) => r?.keyword)
    .map((r) => [
      ASIN, COUNTRY, clip(r.keyword, 128), day, 'month',
      num(r.keywordId), clip(nn(r.translateKeyword), 255),
      // diag 用 diffScore 表示变化量（rvs 用 contriChange），语义相同
      num(r.diffScore), num(r.diffScoreRatio), num(r.affectTotalScore),
      num(r.score), num(r.scoreBefore), num(r.scoreRatio),
      num(r.estSearchesNum), num(r.searchesRank),
      clip(summarizePchangeReason(r.pchangeReason), 512),
      r.pchangeReason ? JSON.stringify(r.pchangeReason) : null,
      // diag 没有 positive 字段，用变化量的符号推
      r.diffScore === null || r.diffScore === undefined ? null : (Number(r.diffScore) >= 0 ? 1 : -1),
      NOW,
    ])
}

// ---------- 表 3：fact_keyword_search_trend（ABA 趋势） ----------

const ABA_COLS = [
  'keyword', 'country', 'granularity', 'stat_date', 'is_prev_period',
  'keyword_id', 'searches_num', 'ext_searches_num', 'searches_rank', 'created_at',
]

/**
 * keyword-aba-trend → 行。
 * granularities[] 是时间轴，另三个数组按下标对齐。
 * is_prev_period 恒 0 —— 该源只返回当期序列，没有"上期"概念，
 * 但它是既有表的主键列，必须给值。
 */
function buildAbaRows(d, keyword) {
  const axis = d?.granularities || []
  if (!axis.length) return []
  const rows = []
  for (let i = 0; i < axis.length; i++) {
    const day = axis[i]
    if (!day) continue
    rows.push([
      clip(keyword, 128), COUNTRY, 'week', day, 0,
      null,
      num(d.keywordSearchVolumes?.[i]),
      num(d.extSearchVolumes?.[i]),
      num(d.keywordRanks?.[i]),
      NOW,
    ])
  }
  return rows
}

// ---------- 主流程 ----------

/** 同批主键撞键要自己去重 —— 一批 INSERT 里重复主键 Doris 行为不确定 */
function dedupe(rows, keyIdx) {
  const m = new Map()
  for (const r of rows) m.set(keyIdx.map((i) => r[i]).join('|'), r)
  return [...m.values()]
}

async function main() {
  console.log(
    `[daily-grain] ${ASIN} / ${COUNTRY} / 源 ${IN}${DRY ? ' （dry-run）' : ''}`,
  )

  if (!DRY) {
    conn = await mysql.createConnection({
      host: env.DB_HOST,
      port: Number(env.DB_PORT),
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      charset: 'utf8mb4',
      supportBigNumbers: true,
      bigNumberStrings: true,
    })
  }

  // --- 1. 日粒度快照 ---
  const ttFile = path.join(IN, 'traffic-trend-12m.json')
  const tt = unwrap(readJson(ttFile), 'dates')
  if (tt) {
    const rows = dedupe(buildDailyRows(tt), [0, 1, 2])
    console.log(`  traffic-trend: ${rows.length} 天`)
    await insertBatch('fact_asin_daily_snapshot', DAILY_COLS, rows)
  } else {
    console.log(`  traffic-trend: 跳过（${path.basename(ttFile)} 不存在或无 dates）`)
  }

  // --- 2. 归因：rvs（日）+ diag（月），同一张表两种 granularity ---
  const attrRows = []

  const rvs = unwrap(readJson(path.join(IN, 'rvs.json')), 'mainChangeKeywords')
  if (rvs) {
    const r = buildAttrRowsFromRvs(rvs)
    console.log(`  rvs: ${r.length} 词（${rvs.date}，日粒度）`)
    attrRows.push(...r)
  } else {
    console.log('  rvs: 跳过（rvs.json 不存在或无 mainChangeKeywords）')
  }

  const diag = unwrap(readJson(path.join(IN, 'diag.txt')), 'details')
  if (diag) {
    /**
     * diag 响应里没有回显 period，只能从文件名或参数推。
     * 这里用 --period 覆盖，缺省取 details 里出现的最近月份（若源带了 date）；
     * 都没有就跳过 —— 硬造日期会让这批数据落在错误的期上。
     */
    const period = arg('period', diag.date ? String(diag.date).slice(0, 7) : null)
    if (period) {
      const r = buildAttrRowsFromDiag(diag, period)
      console.log(`  diag: ${r.length} 词（${period}，月粒度，源总计 ${diag.total ?? '?'}）`)
      attrRows.push(...r)
    } else {
      console.log('  diag: 跳过（无法确定期，请显式传 --period 2026-08）')
    }
  } else {
    console.log('  diag: 跳过（diag.txt 不存在或无 details）')
  }

  await insertBatch(
    'fact_asin_keyword_attribution',
    ATTR_COLS,
    dedupe(attrRows, [0, 1, 2, 3, 4]),
  )

  // --- 3. ABA 趋势：目录下所有 aba-*.json，词取自文件名 ---
  const abaRows = []
  if (fs.existsSync(IN) && fs.statSync(IN).isDirectory()) {
    for (const f of fs.readdirSync(IN)) {
      if (!f.startsWith('aba-') || !f.endsWith('.json')) continue
      const kw = f.slice(4, -5)
      const d = unwrap(readJson(path.join(IN, f)), 'granularities')
      if (!d) {
        console.log(`  aba[${kw}]: 跳过（无 granularities）`)
        continue
      }
      const r = buildAbaRows(d, kw)
      console.log(`  aba[${kw}]: ${r.length} 期`)
      abaRows.push(...r)
    }
  }
  await insertBatch(
    'fact_keyword_search_trend',
    ABA_COLS,
    dedupe(abaRows, [0, 1, 2, 3, 4]),
  )

  // --- 汇总 ---
  console.log(`\n[daily-grain] ${DRY ? '预演' : '写入'}完成：`)
  for (const t of Object.keys(stats).sort()) {
    console.log(`  ${String(stats[t]).padStart(7)}  ${t}`)
  }

  // --- 回读校验：确认 NULL 没被写成 0 ---
  if (!DRY && stats['fact_asin_daily_snapshot']) {
    const [chk] = await conn.query(
      `SELECT COUNT(*) AS total,
              COUNT(DISTINCT stat_date) AS days,
              MIN(stat_date) AS d0, MAX(stat_date) AS d1,
              SUM(CASE WHEN ld_price IS NOT NULL THEN 1 ELSE 0 END) AS ld_set,
              SUM(CASE WHEN title_img IS NOT NULL THEN 1 ELSE 0 END) AS ti_set,
              SUM(CASE WHEN promotion IS NOT NULL THEN 1 ELSE 0 END) AS promo_set,
              SUM(CASE WHEN sb_score IS NOT NULL THEN 1 ELSE 0 END) AS sb_set,
              SUM(CASE WHEN bsr IS NULL THEN 1 ELSE 0 END) AS bsr_null,
              SUM(CASE WHEN ld_price = 0 THEN 1 ELSE 0 END) AS ld_zero
         FROM fact_asin_daily_snapshot WHERE asin = ? AND country = ?`,
      [ASIN, COUNTRY],
    )
    const c = chk[0]
    /**
     * 校验稀疏列**该有值的天数对得上源**，而不是只看 NULL 多不多 ——
     * 第一次灌数时 ld_price 全 NULL 也能通过「NULL > 0」的检查，
     * 实际是解析错了（源是复合串）。所以这里打印非空计数供人工对源。
     */
    console.log(
      `\n[daily-grain] 回读：${c.total} 行 / ${c.days} 天（${fmtDate(c.d0)} ~ ${fmtDate(c.d1)}）\n` +
        `  稀疏列非空天数（对照源应一致）：` +
        `ld_price=${c.ld_set} title_img=${c.ti_set} promotion=${c.promo_set} sb_score=${c.sb_set}\n` +
        `  bsr NULL=${c.bsr_null}（应为 0）｜ld_price=0 的行=${c.ld_zero}（应为 0，NULL 不该被写成 0）`,
    )
  }

  if (conn) await conn.end()
}

main().catch((e) => {
  console.error('[daily-grain] 失败：', e?.message ?? e)
  process.exit(1)
})

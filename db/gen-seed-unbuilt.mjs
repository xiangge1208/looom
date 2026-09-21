/**
 * 未建模块的 seed 生成器（M13 竞价表起步，后续期次往里加）
 *
 * ## 为什么不动 gen-seed.mjs
 *
 * 那个生成器（1058 行）还是 **schema-04 之前的 keyword_id 主键版本**，
 * 重跑会把关键词域的设计回退、seed 插不进现在的表。
 * 本期策略：两个 seed 文件并存，新表走本文件，老文件冻结不动。
 * 详见 ROADMAP §4.2。
 *
 * ## 本期产出：fact_keyword_bid_estimate（建议竞价）
 *
 * 这张表**没有真实数据源** —— 原站 `search/cpc/category` 不在爬虫覆盖的
 * 41 个 endpoint 里（AUDIT §4）。表结构按真实响应建，数据用本生成器造。
 * 真实源到位后只换 ETL，不改表不改前端。
 *
 * ## 造数要贴合三条官方口径（否则 UI 上一眼假）
 *
 * 1. **竞价与品类强相关、与产品无关**（页面说明第 1 条）——
 *    所以同一个词在不同类目下竞价差异要明显，而不是随机抖动。
 *    做法：每个类目有自己的「基准价」，词只在基准价上按搜索量微���。
 *
 * 2. **三档递增**（实测样例 0.37 → 0.49 → 0.61）——
 *    与 ACOS 的递减方向相反。这是前端最容易画反的地方，seed 必须体现正确方向。
 *
 * 3. **仅降低与固定已被原站合并**（页面说明第 3 条）——
 *    所以 bid_strategy 只有 auto/legacy 两个值，不造第三种。
 *    实测 auto 与 legacy 的差异很小（ACOS 表里 13% 完全同值），
 *    这里让 legacy 比 auto 高 5~15%（手动投放通常要出价更高才能拿到位置）。
 *
 * ## 关键词挂真实词，不用 B0SEED 式假词
 *
 * 全仓 seed 约定是 ASIN 用 `B0SEED` 前缀便于一眼辨真假。但**关键词不能这么做** ——
 * 竞价页是「按词查」的，挂假词会导致用户查任何真实词都空白。
 * 所以这里从 `fact_keyword_conversion_funnel` 取真实高搜索量词，
 * 只有**竞价数值和类目**是造的，靠 `source='seed'` 列区分，前端据此打标记。
 *
 * 用法：
 *     node db/gen-seed-unbuilt.mjs            # 写 db/seed-unbuilt.sql
 *     node db/gen-seed-unbuilt.mjs --apply    # 直接灌库（需 DB_* 环境变量）
 */

import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

// mysql2 装在 apps/api 下，不在仓库根。用 createRequire 从那里解析
// （gen-seed.mjs 取 bcryptjs 也是这个做法）。
const require = createRequire(new URL('../apps/api/package.json', import.meta.url))

const DB = 'looom'

// ---- 确定性随机：同样的种子永远产出同样的 seed，便于复现问题 ----
let _s = 20260921
function rnd() {
  _s = (_s * 1103515245 + 12345) & 0x7fffffff
  return _s / 0x7fffffff
}
const int = (min, max) => Math.floor(rnd() * (max - min + 1)) + min
const dec = (min, max, p = 2) => Number((rnd() * (max - min) + min).toFixed(p))
const pick = (arr) => arr[Math.floor(rnd() * arr.length)]

const q = (v) => {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return String(v)
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

const out = []
const say = (s) => out.push(s)

function insert(table, cols, rows, chunk = 200) {
  if (!rows.length) return
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk)
    say(
      `INSERT INTO ${DB}.${table} (${cols.join(', ')}) VALUES\n` +
        part.map((r) => '  (' + r.map(q).join(', ') + ')').join(',\n') +
        ';',
    )
  }
}

// ====================================================================
// 类目池
//
// 亚马逊浏览节点 ID 是真实存在的公开编号，这里用的是常见大类的真实 ID
// （它们不是「数据」，是公开的类目编码，等同于行业标准分类号）。
// base 是该类目的竞价基准价（美元），体现「竞价与品类强相关」：
// 电子类目竞争激烈基准价高，家居类目低。
// ====================================================================
const CATEGORIES = [
  { id: '1055398', name: 'Home & Kitchen', base: 0.82 },
  { id: '1063498', name: 'Storage & Organization', base: 0.71 },
  { id: '172282', name: 'Electronics', base: 1.64 },
  { id: '1064954', name: 'Home Décor', base: 0.95 },
  { id: '3760901', name: 'Home Office Furniture', base: 1.18 },
  { id: '166461', name: 'Arts, Crafts & Sewing', base: 0.58 },
  { id: '7141123011', name: 'Clothing, Shoes & Jewelry', base: 1.05 },
  { id: '165793011', name: 'Toys & Games', base: 0.76 },
  { id: '3375251', name: 'Sports & Outdoors', base: 0.89 },
  { id: '2619525011', name: 'Office Products', base: 0.93 },
  { id: '3760911', name: 'Kids Furniture', base: 1.02 },
  { id: '1055398011', name: 'Kitchen & Dining', base: 0.68 },
]

const MATCH_TYPES = ['broad', 'phrase', 'exact']
const STRATEGIES = ['auto', 'legacy']

/**
 * 匹配方式对竞价的影响系数。
 *
 * 精准匹配流量最准、竞争最激烈，出价最高；广泛匹配最便宜。
 * 这个次序是亚马逊广告的常识，不是随机数 —— 造反了 UI 上会显得不合理。
 */
const MATCH_FACTOR = { broad: 0.82, phrase: 0.95, exact: 1.15 }

/**
 * 生成竞价三档。
 *
 * ⚠️ 必须递增：start < median < end（页面实测 0.37/0.49/0.61）。
 * 与 ACOS 的递减方向相反，这是前端最容易搞混的地方。
 */
function makeBid(base, matchType, strategy, volumeFactor) {
  const f = MATCH_FACTOR[matchType]
  // 手动投放（legacy）通常要比自动出价高一些才��拿到同样的位置
  const sf = strategy === 'legacy' ? 1.0 + rnd() * 0.15 + 0.05 : 1.0
  const mid = base * f * sf * volumeFactor
  // 三档围绕中位展开，低档 -22%±、高档 +25%±
  const start = mid * (0.74 + rnd() * 0.06)
  const end = mid * (1.2 + rnd() * 0.1)
  return [
    Number(start.toFixed(2)),
    Number(mid.toFixed(2)),
    Number(end.toFixed(2)),
  ]
}

/** 统计月：竞价每月更新一次（官方口径第 4 条），造最近 3 个月 */
const MONTHS = ['2026-07', '2026-08', '2026-09']

const NOW = '2026-09-21 12:00:00'

function genBidEstimate(keywords) {
  const cols = [
    'keyword', 'country', 'category_id', 'match_type', 'bid_strategy',
    'stat_month', 'category_name', 'category_href', 'category_sale_num',
    'bid_start', 'bid_median', 'bid_end', 'source', 'created_at',
  ]
  const rows = []

  for (const { keyword, searchVolume } of keywords) {
    // 搜索量越大竞争越激烈、竞价越高。用对数压缩避免大词价格失控。
    const volumeFactor = 0.75 + Math.log10(Math.max(searchVolume, 10)) / 8

    // 每词 4~14 个类目（实测均值 10.3，AUDIT §4）
    const catCount = int(4, 12)
    const cats = []
    const pool = [...CATEGORIES]
    for (let i = 0; i < catCount && pool.length; i++) {
      cats.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0])
    }

    for (const cat of cats) {
      const saleNum = int(1200, 480000)
      for (const month of MONTHS) {
        // 月度波动：越近的月份价格略高（旺季临近）
        const monthFactor = 1 + MONTHS.indexOf(month) * 0.04
        for (const mt of MATCH_TYPES) {
          for (const st of STRATEGIES) {
            const [s, m, e] = makeBid(cat.base * monthFactor, mt, st, volumeFactor)
            rows.push([
              keyword, 'US', cat.id, mt, st, month,
              cat.name,
              `https://www.amazon.com/b?node=${cat.id}`,
              saleNum,
              s, m, e, 'seed', NOW,
            ])
          }
        }
      }
    }
  }
  return { cols, rows }
}

// ====================================================================
async function main() {
  const apply = process.argv.includes('--apply')

  // 从库里取真实关键词（按搜索量降序），只造竞价数值不造词。
  // 理由见文件头：竞价页按词查，挂假词会让用户查真实词全空白。
  const mysql = require('mysql2/promise')
  // 提成变量：灌库时 Doris 可能断连，重连要复用同一份配置
  const dbConf = {
    host: process.env.DB_HOST || '120.24.248.175',
    port: Number(process.env.DB_PORT || 9030),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: DB,
  }
  let conn = await mysql.createConnection(dbConf)

  const [kwRows] = await conn.query(
    `SELECT keyword, MAX(search_volume) AS sv
       FROM fact_keyword_conversion_funnel
      WHERE country = 'US'
      GROUP BY keyword
      ORDER BY sv DESC
      LIMIT 200`,
  )
  const keywords = kwRows.map((r) => ({
    keyword: r.keyword,
    searchVolume: Number(r.sv) || 100,
  }))
  console.error(`取到 ${keywords.length} 个真实关键词`)

  say('-- ⚠️ 本文件由 db/gen-seed-unbuilt.mjs 生成，不要手改。')
  say('-- 数据为 seed 模拟：关键词是真实的，竞价数值与类目归属是造的。')
  say('-- 靠 source=\'seed\' 列区分，前端必须据此显示「模拟数据」标记。')
  say(`USE ${DB};`)
  say('')

  const { cols, rows } = genBidEstimate(keywords)
  say(`-- fact_keyword_bid_estimate: ${rows.length} 行`)
  insert('fact_keyword_bid_estimate', cols, rows)

  const sql = out.join('\n') + '\n'
  writeFileSync('db/seed-unbuilt.sql', sql, 'utf8')
  console.error(`已写 db/seed-unbuilt.sql（${rows.length} 行竞价）`)

  if (apply) {
    console.error('正在灌库…')
    // ⚠️ 切分前必须先剥掉注释行，不能用 `s.startsWith('--')` 过滤整条语句 ——
    //    生成的文件里注释与其后的 INSERT 之间只有换行没有分号，
    //    按 `;\n` 切出来的第一块是「注释 + 第一条 INSERT」，
    //    startsWith('--') 会把这整块连同 INSERT 一起丢掉（实测少灌 200 行）。
    const stmts = sql
      .split(/;\s*\n/)
      .map((s) =>
        s
          .split('\n')
          .filter((line) => !line.trim().startsWith('--'))
          .join('\n')
          .trim(),
      )
      .filter(Boolean)

    // ⚠️ Doris 会在长连接上批量写一段时间后主动断开（实测 125 批 × 200 行后
    //    报 ECONNRESET）。数据其实已经写进去了，但后续语句会全部失败。
    //    所以这里捕获连接类错误并重连续跑，而不是整个脚本挂掉。
    let live = conn
    for (let i = 0; i < stmts.length; i++) {
      try {
        await live.query(stmts[i])
      } catch (e) {
        if (e.code !== 'ECONNRESET' && e.code !== 'PROTOCOL_CONNECTION_LOST') throw e
        console.error(`  连接在第 ${i + 1}/${stmts.length} 批断开，重连续跑…`)
        try {
          await live.end()
        } catch {
          /* 连接已死，end 失败无所谓 */
        }
        live = await mysql.createConnection(dbConf)
        await live.query(stmts[i]) // 重放这一批：Unique Key 覆盖，重复执行安全
      }
    }
    conn = live

    const [[cnt]] = await conn.query(
      'SELECT COUNT(*) AS n FROM fact_keyword_bid_estimate',
    )
    console.error(`灌库完成，表内 ${cnt.n} 行`)
  }
  await conn.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

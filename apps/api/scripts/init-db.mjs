/**
 * 容器启动时的数据库初始化（建表 + 灌 seed）
 *
 * goal.md 要求「容器启动时自动执行建表 SQL 和 seed（如果表已存在则跳过建表，
 * 不要报错中断）」。之前只有 scripts/setup-doris.sh 需要人工先跑一次，
 * 新环境 `docker compose up` 起来后表是空的，属于未实现的硬性要求。
 *
 * ## 为什么用 Node 而不是复用 setup-doris.sh
 *
 * runner 镜像是 node:22-alpine，没有 mysql 客户端。装 mysql-client 会让
 * 镜像变大且多一个 apk 源依赖；而 mysql2 是后端本来就有的运行时依赖，
 * 直接用它执行 SQL 文件更省事，也不用担心客户端字符集问题
 * （seed.sql 自带 SET NAMES utf8mb4，见 db/gen-seed.mjs 的注释）。
 *
 * ## 幂等性
 *
 * - schema：全部 CREATE TABLE IF NOT EXISTS，重复执行无副作用
 * - seed：Doris Unique Key 模型下同主键 INSERT 即覆盖，重复执行不产生重复行
 *
 * 所以这个脚本每次容器启动都跑一遍是安全的。
 *
 * ## 失败策略
 *
 * 初始化失败**不阻断启动** —— 打印警告后让后端继续起。
 * 理由：Doris 是外部实例，可能只是启动瞬间还没就绪；后端自己有连接自检
 * 和健康检查，让它按既有逻辑报错比在这里直接退出更容易排查。
 * 但如果是 SQL 本身有问题，日志里会留下具体语句。
 */
import { readFileSync, existsSync } from 'node:fs'
import { createConnection } from 'mysql2/promise'

const DB_HOST = process.env.DB_HOST ?? '127.0.0.1'
const DB_PORT = Number(process.env.DB_PORT ?? 9030)
const DB_NAME = process.env.DB_NAME ?? 'looom'
// 建表要 root（etl_user 可能没有 CREATE 权限）；没配 root 就退回业务账号
const DB_USER = process.env.DB_ROOT_USER ?? process.env.DB_USER ?? 'root'
const DB_PASSWORD = process.env.DB_ROOT_PASSWORD ?? process.env.DB_PASSWORD ?? ''

/**
 * 幂等的 SQL 文件，每次启动都执行。位置见 Dockerfile 的 COPY。
 *
 * 顺序必须与 scripts/setup-doris.sh 的 glob 一致，否则容器环境和手动建库
 * 会产出不同的 schema。schema-03 是 2026-09-20 JSON 深挖补的 3 张表，
 * 漏掉它会让容器里少 3 张表。
 */
const FILES = [
  '/app/db/schema-01-system.sql',
  '/app/db/schema-02-business.sql',
  '/app/db/schema-03-gap-tables.sql',
  // schema-05 大表按月分区、schema-06 M13 第一版建表。
  // ⚠️ 这两个此前漏在这里，导致容器建出的库比 setup-doris.sh 少表。
  // schema-05 的分区迁移部分对已有表是搬数据+RENAME（非幂等），
  // 但对全新库（容器场景）只是带分区建表，所以放这里是安全的。
  '/app/db/schema-05-partitions.sql',
  '/app/db/schema-06-m13-wordpick.sql',
  '/app/db/seed.sql',
  // M13 竞价页的 seed（真实源未接入，走生成器）。
  // ⚠️ 必须在 schema-07 之后 —— 目标表 fact_keyword_bid_estimate 是
  // schema-07 重建的，schema-06 建的那张已被改名成 acos_estimate。
  '/app/db/seed-unbuilt.sql',
]

/**
 * M13 数据层返工 —— **非幂等**，带存在性守卫。
 *
 * 含 ALTER TABLE RENAME 和 INSERT SELECT，重复执行会报 Unknown table。
 * 守卫：探测 fact_keyword_acos_estimate 是否已存在（存在=已执行过）。
 *
 * 顺序要求：必须在 FILES 的 schema-06 之后、seed-unbuilt.sql 之前。
 * 代码里的执行点见下方 main()。
 */
const REWORK_SCHEMA = '/app/db/schema-07-m13-rework.sql'

/**
 * 关键词域重建脚本 —— **破坏性**，不能无条件执行。
 *
 * schema-04 把 16 张关键词表的主键从 keyword_id 改成 (keyword, country)，
 * 用的是 DROP TABLE + CREATE TABLE。每次容器重启都跑会清空 dim_keyword 等表。
 *
 * 执行条件（与 setup-doris.sh 的守卫保持一致）：
 *   - dim_keyword 不存在（全新库，无数据可丢）→ 必须跑，否则后端按文本键写的
 *     JOIN 会报 Unknown column 'keyword'
 *   - 或显式设 RESET_KEYWORD_DOMAIN=1
 */
const KEYWORD_SCHEMA = '/app/db/schema-04-keyword-text-key.sql'

/**
 * 把 SQL 文件切成单条语句。
 *
 * 只按分号切 + 跳过纯注释行，够用是因为这些文件由生成器产出，
 * 不含存储过程、触发器等带内部分号的结构。
 */
function splitStatements(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
}

async function main() {
  const log = (m) => console.log(`[init-db] ${m}`)

  /**
   * 执行 M13 返工（schema-07），带存在性守卫。
   *
   * 非幂等的原因与守卫方式见 REWORK_SCHEMA 的注释。
   * 失败不抛异常 —— 与本脚本的整体原则一致：初始化问题不阻断后端启动，
   * 只记日志让人去看。
   */
  async function runReworkOnce(conn) {
    if (!existsSync(REWORK_SCHEMA)) return

    const [r] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'fact_keyword_acos_estimate'`,
      [DB_NAME],
    )
    if (Number(r[0].n) > 0) {
      log('跳过 schema-07（fact_keyword_acos_estimate 已存在，说明已执行过）')
      return
    }

    log('执行 schema-07（M13 返工：ACOS 表改名拆维 + 竞价表重建 + 补列）')
    try {
      await runFile(conn, REWORK_SCHEMA)
    } catch (e) {
      // Doris 的 ADD COLUMN 是异步 SCHEMA_CHANGE，同表连续 ALTER 可能报
      // state(SCHEMA_CHANGE) is not NORMAL。下次启动会重试（守卫会看到
      // acos_estimate 已建好就跳过，剩余的 ALTER 需要手动补）。
      console.error(
        `[init-db] schema-07 执行中断：${e.message}\n` +
          '          若是 SCHEMA_CHANGE 冲突，手动重跑 ' +
          'bash scripts/setup-doris.sh 即可（已完成部分有守卫）。',
      )
    }
  }

  /** 逐条执行一个 SQL 文件，「表已存在」按跳过处理，不中断 */
  async function runFile(conn, file) {
    const statements = splitStatements(readFileSync(file, 'utf8'))
    let ok = 0
    let skipped = 0
    for (const stmt of statements) {
      try {
        await conn.query(stmt)
        ok++
      } catch (err) {
        // 表已存在之类的重复错误按「跳过」处理，符合 goal.md
        // 「如果表已存在则跳过建表，不要报错中断」
        if (/already exist|Duplicate/i.test(err.message)) {
          skipped++
        } else {
          log(`语句失败（继续执行剩余语句）：${err.message}`)
          log(`  SQL 片段：${stmt.slice(0, 120)}`)
        }
      }
    }
    log(`${file.split('/').pop()}：执行 ${ok} 条，跳过 ${skipped} 条`)
  }

  const missing = FILES.filter((f) => !existsSync(f))
  if (missing.length) {
    log(`跳过初始化：镜像内缺少 SQL 文件 ${missing.join(', ')}`)
    return
  }

  let conn
  try {
    conn = await createConnection({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASSWORD,
      charset: 'utf8mb4',
      multipleStatements: false,
      connectTimeout: 15000,
    })
  } catch (err) {
    log(`连接 Doris 失败，跳过初始化（后端启动后会自检）：${err.message}`)
    return
  }

  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``)
    await conn.query(`USE \`${DB_NAME}\``)

    // ---- 关键词域：先判断要不要跑 schema-04（必须在 seed 之前）----
    //
    // 放在 FILES 之前执行，因为 seed.sql 里有往关键词表插数的语句，
    // 若先 seed 再 DROP 重建，插进去的数据会被清掉。
    if (existsSync(KEYWORD_SCHEMA)) {
      const [kw] = await conn.query(
        `SELECT COUNT(*) AS n FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'dim_keyword'`,
        [DB_NAME],
      )
      const isFreshDb = Number(kw[0].n) === 0
      const forced = process.env.RESET_KEYWORD_DOMAIN === '1'

      if (isFreshDb || forced) {
        log(
          isFreshDb
            ? 'dim_keyword 不存在（全新库），执行 schema-04 建关键词域'
            : 'RESET_KEYWORD_DOMAIN=1，重建关键词域（将清空 16 张表）',
        )
        await runFile(conn, KEYWORD_SCHEMA)
      } else {
        log('跳过 schema-04（破坏性重建，关键词表已存在且有数据）')
      }
    }

    // FILES 是顺序敏感的：schema-07 必须夹在 schema-06 与 seed-unbuilt 之间
    // （它把 schema-06 建的 bid_estimate 改名，再重建一张新语义的同名表，
    //   seed-unbuilt 灌的是新表）。所以循环到 seed-unbuilt 前插入返工步骤。
    for (const file of FILES) {
      if (file.endsWith('seed-unbuilt.sql')) {
        await runReworkOnce(conn)
      }
      await runFile(conn, file)
    }

    const [rows] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
      [DB_NAME],
    )
    log(`初始化完成，${DB_NAME} 现有 ${rows[0].n} 张表`)
  } finally {
    await conn.end()
  }
}

main().catch((err) => {
  // 兜底：绝不因初始化失败而阻断后端启动
  console.error(`[init-db] 初始化异常，跳过：${err.message}`)
})

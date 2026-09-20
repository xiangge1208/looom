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

/** SQL 文件在镜像里的位置，见 Dockerfile 的 COPY */
const FILES = [
  '/app/db/schema-01-system.sql',
  '/app/db/schema-02-business.sql',
  '/app/db/seed.sql',
]

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

    for (const file of FILES) {
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

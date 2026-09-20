import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as mysql from 'mysql2/promise'

/**
 * Doris 数据访问服务
 *
 * 为什么不用 ORM：
 *   Doris 没有外键、没有跨行事务、没有自增主键，ORM 的核心能力大半用不上，
 *   且 ORM 生成的 SQL（子查询、JOIN 改写）在 Doris 上容易踩到不支持的语法。
 *   这里用 mysql2 直接跑 SQL，所有查询都是显式的、可预期的。
 */
@Injectable()
export class DorisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DorisService.name)
  private pool: mysql.Pool
  private readonly dbName: string

  constructor(private readonly config: ConfigService) {
this.dbName = this.config.get<string>('DB_NAME', 'looom')
  }

  async onModuleInit() {
    const host = this.config.get<string>('DB_HOST', '127.0.0.1')
  const port = this.config.get<number>('DB_PORT', 9030)
    const user = this.config.get<string>('DB_USER', 'etl_user')
    const password = this.config.get<string>('DB_PASSWORD', '')

    this.pool = mysql.createPool({
    host,
    port: Number(port),
   user,
 password,
   database: this.dbName,
      waitForConnections: true,
      connectionLimit: 10,
      // Doris 对超长空闲连接不友好，主动设小一点
      idleTimeout: 60_000,
      charset: 'utf8mb4',
      // 注意：Doris 不支持 multipleStatements 的部分用法，保持关闭
      multipleStatements: false,
      timezone: 'Z',

      // ⚠️ 关键配置，不加会静默写错数据：
      // 雪花 ID 是 19 位 BIGINT，超过 JS 安全整数上限（2^53）。
      // mysql2 默认把 BIGINT 读成 JS Number，也不接受 bigint 参数，
      // 转换时会丢低位 —— 实测 376317047212085248 变成 ...250（+2）。
      // 后果是「按 id 更新」会写到另一行，产生重复行且缓存查不中。
      //   supportBigNumbers + bigNumberStrings：读取时返回字符串
      //   decimalNumbers 保持 false，DECIMAL 也按字符串返回（积分金额同样不能丢精度）
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
    })

    await this.checkOnBoot(host, port)
  }

  async onModuleDestroy() {
    await this.pool?.end()
  }

  /**
   * 启动自检。
   * 按 goal.md 要求：库不存在或表为空时打明确的中文错误日志，提示先跑初始化脚本，
   * 后端自己不去 CREATE DATABASE。
   */
  private async checkOnBoot(host: string, port: number | string) {
    try {
      await this.pool.query('SELECT 1')
    } catch (err: any) {
      this.logger.error('═'.repeat(64))
      this.logger.error(`连接 Doris 失败：${host}:${port}`)
      this.logger.error(`原因：${err?.message ?? err}`)
      this.logger.error('请检查：')
      this.logger.error('  1. Doris FE 是否在运行')
      this.logger.error('  2. .env 里的 DB_HOST / DB_PORT 是否正确')
 this.logger.error(
    '  3. 后端在容器里跑时，DB_HOST 应为 host.docker.internal 或宿主机内网 IP',
      )
    this.logger.error('═'.repeat(64))
      throw err
}

    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
      [this.dbName],
    )
    const tableCount = Number(rows?.[0]?.n ?? 0)

  if (tableCount === 0) {
      this.logger.error('═'.repeat(64))
      this.logger.error(`数据库 "${this.dbName}" 不存在，或一张表都没有。`)
      this.logger.error('后端不会自动建库建表，请先执行初始化脚本：')
      this.logger.error('')
      this.logger.error('    bash scripts/setup-doris.sh')
    this.logger.error('')
      this.logger.error('该脚本幂等，可重复执行。')
   this.logger.error('═'.repeat(64))
      throw new Error(`数据库 ${this.dbName} 未初始化，请先运行 scripts/setup-doris.sh`)
    }

    this.logger.log(`Doris 连接正常：${host}:${port}/${this.dbName}（${tableCount} 张表）`)
  }

  /**
   * 把 bigint 参数规范成字符串。
   *
   * 为什么要这么做：mysql2 不接受 JS bigint 作为绑定参数，
   * 而把 bigint 转 Number 会丢精度（见连接配置里的说明）。
   * 转成十进制字符串则完全没有精度问题，mysql2 会按 BIGINT 正确解析。
   */
  private normalizeParams(params: any[]): any[] {
    return params.map((p) => (typeof p === 'bigint' ? p.toString() : p))
  }

  /** 执行查询，返回行数组 */
  async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const [rows] = await this.pool.query(sql, this.normalizeParams(params))
    return rows as T[]
  }

  /** 执行查询，返回首行或 null */
  async queryOne<T = any>(sql: string, params: any[] = []): Promise<T | null> {
  const rows = await this.query<T>(sql, params)
    return rows.length > 0 ? rows[0] : null
  }

  /** 执行写入（INSERT / UPDATE / DELETE） */
  async execute(sql: string, params: any[] = []): Promise<mysql.ResultSetHeader> {
    const [result] = await this.pool.execute(sql, this.normalizeParams(params))
    return result as mysql.ResultSetHeader
  }

  /**
   * Doris 的 Unique Key 模型下，INSERT 同主键即覆盖（upsert 语义）。
   * 这是 Doris 与 MySQL 最重要的差异之一：没有 ON DUPLICATE KEY UPDATE，
   * 直接 INSERT 就是「有则更新，无则插入」。
   */
  async upsert(table: string, row: Record<string, any>): Promise<void> {
    const cols = Object.keys(row)
    const placeholders = cols.map(() => '?').join(', ')
    const sql = `INSERT INTO \`${this.dbName}\`.\`${table}\` (${cols
  .map((c) => `\`${c}\``)
      .join(', ')}) VALUES (${placeholders})`
    await this.execute(sql, Object.values(row))
  }

  /** 批量 upsert。Doris 单条 INSERT 开销大，批量能显著降低导入压力 */
  async upsertMany(table: string, rows: Record<string, any>[]): Promise<void> {
    if (rows.length === 0) return
    const cols = Object.keys(rows[0])
    const oneRow = `(${cols.map(() => '?').join(', ')})`
    const sql = `INSERT INTO \`${this.dbName}\`.\`${table}\` (${cols
      .map((c) => `\`${c}\``)
.join(', ')}) VALUES ${rows.map(() => oneRow).join(', ')}`
    const params = rows.flatMap((r) => cols.map((c) => r[c] ?? null))
    await this.execute(sql, this.normalizeParams(params))
  }

  get database(): string {
    return this.dbName
  }
}

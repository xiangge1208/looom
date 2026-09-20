/**
 * 字段格式化助手
 *
 * 为什么需要：
 *   Doris 的 DATE 列经 mysql2 返回的是 JS Date 对象，JSON 序列化会变成
 *   "2026-08-22T00:00:00.000Z"。而 VARCHAR 存的时间片（如 stat_month）
 *   返回的是原始字符串 "2026-08"。
 *   同一套 API 里两种格式并存，前端要写两套解析逻辑，很容易出错。
 *
 * 为什么不用 mysql2 的 dateStrings 选项全局解决：
 *   那会让 DATETIME 也变成 'YYYY-MM-DD HH:mm:ss' 字符串，
 *   而鉴权模块里 `new Date(expires_at)` 会把这种格式按**本地时区**解析，
 *   与写入时用的 UTC 不一致，引入隐蔽的过期判断错误。
 *   所以这里只在输出给前端的地方显式格式化，不动数据库驱动行为。
 */

/** DATE → 'YYYY-MM-DD'。入参可以是 Date、字符串或 null */
export function fmtDate(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) {
    // 用 UTC 取值：写入时用的是 UTC，读出来也要按 UTC 解读，避免时区偏移
    const y = v.getUTCFullYear()
    const m = String(v.getUTCMonth() + 1).padStart(2, '0')
    const d = String(v.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  const s = String(v)
  // 已经是 YYYY-MM-DD 或带时间的字符串，统一截到日期部分
  return s.length >= 10 ? s.slice(0, 10) : s
}

/** DATETIME → 'YYYY-MM-DD HH:mm:ss' */
export function fmtDateTime(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) {
    return v.toISOString().slice(0, 19).replace('T', ' ')
  }
  return String(v).replace('T', ' ').slice(0, 19)
}

/**
 * 数值转 number，null/undefined 保持 null。
 * Doris 的 DECIMAL 经 mysql2 返回字符串（我们开了 bigNumberStrings），
 * 直接运算会变成字符串拼接，必须显式转。
 */
export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 数值转 number，null 时给默认值 */
export function numOr(v: unknown, fallback = 0): number {
  return num(v) ?? fallback
}

/** 布尔字段：Doris 返回 0/1 或 true/false，统一成 boolean */
export function bool(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true'
}

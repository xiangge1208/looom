/**
 * 游标分页
 *
 * 为什么不用页码分页：
 *   goal.md 要求游标分页。Doris 的深 OFFSET 需要扫描并丢弃前 N 行，
 *   翻到后面页会越来越慢。游标分页用 WHERE 条件跳过，代价恒定。
 *
 * 注意：原站用的是页码分页（实测 pageNum + total），我们有意不照抄。
 */

export interface CursorQuery {
  /** 上一页返回的 nextCursor，首页不传 */
  cursor?: string
  limit?: number
}

export interface CursorPage<T> {
  items: T[]
  /** 下一页游标。为 null 表示没有更多数据 */
  nextCursor: string | null
  hasMore: boolean
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

export function normalizeLimit(limit?: number): number {
  const n = Number(limit ?? DEFAULT_LIMIT)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(n), MAX_LIMIT)
}

/**
 * 把游标编成不透明字符串。
 *
 * 不直接暴露原始值，避免前端依赖其内部结构（将来改排序字段就不用改前端）。
 * 用 base64url 而不是 base64：游标会出现在 URL query 里，
 * base64 的 +/= 需要额外转义。
 */
export function encodeCursor(values: (string | number)[]): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url')
}

export function decodeCursor(cursor?: string): (string | number)[] | null {
  if (!cursor) return null
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    // 游标非法就当首页处理，不报错 —— 用户可能手改了 URL
    return null
  }
}

/**
 * 按「多取一条」判断是否还有下一页。
 *
 * 比额外跑一次 COUNT(*) 便宜得多 —— Doris 上 COUNT 全表是重操作。
 */
export function buildPage<T>(
  rows: T[],
  limit: number,
  makeCursor: (last: T) => (string | number)[],
): CursorPage<T> {
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  return {
    items,
    hasMore,
    nextCursor: hasMore && items.length ? encodeCursor(makeCursor(items[items.length - 1])) : null,
  }
}

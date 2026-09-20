import { Injectable } from '@nestjs/common'
import { DorisService } from '../database/doris.service'
import { buildPage, decodeCursor, normalizeLimit } from '../common/cursor'
import { fmtDateTime } from '../common/format'

/**
 * 供应商搜索
 *
 * ⚠️ goal.md 的硬约束：**本期只做 UI 占位和表结构，
 * 不要写任何采集、爬虫、1688 对接逻辑，数据先用 seed。**
 *
 * 所以这里**只读 dim_supplier**，没有任何出站请求。
 * 真实货源数据后续由用户自行购买后导入，不在本项目范围内。
 *
 * 字段是按 seed 的通用货源字段来的（名称/标题/价格/起订量/地区），
 * 不是从 1688 接口实测得来 —— 侦察阶段没有这个域的真实响应。
 */
@Injectable()
export class SuppliersService {
  constructor(private readonly db: DorisService) {}

  /**
   * 搜索货源。
   *
   * ⚠️ 为什么用 LIKE 而不是 MATCH_ANY：
   * supplier_name 上虽然建了 INVERTED 索引，但建表时**没指定中文分词器**
   *（缺 PROPERTIES("parser"="chinese")），实测 `MATCH_ANY '深圳'` 返回 0，
   * 而 `LIKE '%深圳%'` 能正确命中 5 行 —— 倒排索引对中文按整串处理，用不上。
   *
   * 本期数据量只有 seed 的 50 条，LIKE 全表扫足够。
   * 真要接入大量货源时应重建索引并加 "parser" = "chinese"，再换回 MATCH_ANY；
   * 那属于数据接入阶段，不在本期范围（goal.md 明确本期不做采集/对接）。
   */
  async search(opts: {
    keyword?: string
    location?: string
    minPrice?: number
    maxPrice?: number
    cursor?: string
    limit?: number
  }) {
    const limit = normalizeLimit(opts.limit)
    const where: string[] = ['1 = 1']
    const params: any[] = []

    if (opts.keyword?.trim()) {
      const kw = opts.keyword.trim()
      const like = `%${kw}%`
      where.push('(supplier_name LIKE ? OR title LIKE ?)')
      params.push(like, like)
    }

    if (opts.location?.trim()) {
      where.push('location = ?')
      params.push(opts.location.trim())
    }

    if (opts.minPrice !== undefined && opts.minPrice !== null) {
      where.push('price >= ?')
      params.push(opts.minPrice)
    }

    if (opts.maxPrice !== undefined && opts.maxPrice !== null) {
      where.push('price <= ?')
      params.push(opts.maxPrice)
    }

    // 游标按 (price, id) 升序 —— 价格是采购场景最关心的排序维度
    const cur = decodeCursor(opts.cursor)
    if (cur && cur.length === 2) {
      where.push('(price > ? OR (price = ? AND id > ?))')
      params.push(cur[0], cur[0], cur[1])
    }

    const rows = await this.db.query<any>(
      `SELECT id, supplier_name, offer_id, title, img, price,
       min_order, location, created_at
         FROM dim_supplier
        WHERE ${where.join(' AND ')}
 ORDER BY price ASC, id ASC
 LIMIT ?`,
      [...params, limit + 1],
    )

    const page = buildPage(rows, limit, (last: any) => [
      Number(last.price ?? 0),
      String(last.id),
    ])

    return {
      ...page,
      items: page.items.map((r: any) => this.mapSupplier(r)),
    }
  }

  /** 可选地区列表，给前端筛选下拉用 */
  async listLocations() {
    const rows = await this.db.query<any>(
      `SELECT location, COUNT(*) AS cnt
         FROM dim_supplier
        WHERE location IS NOT NULL AND location <> ''
 GROUP BY location
 ORDER BY cnt DESC`,
    )
    return {
      items: rows.map((r: any) => ({
        location: r.location,
 count: Number(r.cnt),
      })),
    }
  }

  /**
   * 取若干货源喂给 AI 插入点 4。
   *
   * 只返回评估需要的字段，不把 img / created_at 这类无关信息塞进 prompt ——
   * 既省 token，也避免模型被无关字段带偏。
   */
  async getForEvaluation(ids: string[]) {
    if (!ids.length) return []
    const ph = ids.map(() => '?').join(', ')
    const rows = await this.db.query<any>(
      `SELECT supplier_name, title, price, min_order, location
         FROM dim_supplier WHERE id IN (${ph})`,
      ids,
    )
    return rows.map((r: any) => ({
      supplierName: r.supplier_name,
      title: r.title,
      price: r.price === null ? null : Number(r.price),
      minOrder: r.min_order === null ? null : Number(r.min_order),
      location: r.location,
    }))
  }

  private mapSupplier(r: any) {
    return {
      id: String(r.id),
      supplierName: r.supplier_name,
      /** 1688 货源 ID。seed 数据里是自造的，不指向真实货源 */
      offerId: r.offer_id,
      title: r.title,
      img: r.img,
      price: r.price === null ? null : Number(r.price),
      minOrder: r.min_order === null ? null : Number(r.min_order),
      location: r.location,
      createdAt: fmtDateTime(r.created_at),
    }
  }
}

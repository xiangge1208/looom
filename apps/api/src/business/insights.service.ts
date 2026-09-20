import { Injectable } from '@nestjs/common'
import { DorisService } from '../database/doris.service'
import { fmtDate } from '../common/format'

/**
 * 查多变体自然位 / 运营时光机 / 查推荐专栏
 *
 * 这三个页面的共同点是都以时序数据为主，但**粒度不同**，
 * 所以分别查不同的快照表，不做跨粒度合并（goal.md 明确要求）：
 *   多变体自然位 → fact_asin_multinf_daily（日）
 *   运营时光机   → fact_asin_op_event（日，事件稀疏）+ 月度指标
 *   推荐专栏     → fact_asin_rec_column_period（混合，只存有值的天）
 */
@Injectable()
export class InsightsService {
  constructor(private readonly db: DorisService) {}

  /**
   * 查多变体自然位
   *
   * 实测此接口无 timePiece 参数，直接返回逐日 dates 数组，
   * 所以这里也按日粒度查，不接受时间片参数。
   */
  async getVariationNaturalRank(asin: string, country: string) {
    const daily = await this.db.query<any>(
      `SELECT stat_date, asin_cnt, keyword_cnt, score, extra_score, listing_asin_cnt
  FROM fact_asin_multinf_daily
        WHERE asin = ? AND country = ?
        ORDER BY stat_date`,
      [asin, country],
    )

    // 关键词×变体 的排名明细
    const detail = await this.db.query<any>(
      `SELECT v.keyword_id, k.keyword, k.translate_keyword, v.variant_asin,
    v.rank_position, v.variant_role, r.name_cn AS role_name
         FROM fact_asin_multinf_keyword_variant v
  JOIN dim_keyword k ON k.keyword_id = v.keyword_id
   LEFT JOIN dict_variant_role r ON r.code = v.variant_role
 WHERE v.parent_asin = ? AND v.country = ?
    ORDER BY v.keyword_id, v.rank_position`,
      [asin, country],
    )

    // 按关键词分组，一个词下可能有多个变体同时占位（这正是「多变体自然位」的含义）
    const byKeyword = new Map<string, any>()
    for (const d of detail) {
      const key = String(d.keyword_id)
      if (!byKeyword.has(key)) {
 byKeyword.set(key, {
          keywordId: key,
    keyword: d.keyword,
   translateKeyword: d.translate_keyword,
   variants: [],
        })
      }
      byKeyword.get(key).variants.push({
        asin: d.variant_asin,
        rankPosition: Number(d.rank_position),
        role: d.variant_role,
 roleName: d.role_name ?? d.variant_role,
      })
    }

    return {
      asin,
      country,
      /** 日趋势。dates 与各 series 等长，前端直接画 */
      // 统一成 YYYY-MM-DD。Doris 的 DATE 列经 mysql2 返回 JS Date，
      // 直接序列化会变成 ISO 串，与其他接口的日期格式不一致
      dates: daily.map((d: any) => fmtDate(d.stat_date)),
      trend: {
        asinCount: daily.map((d: any) => Number(d.asin_cnt ?? 0)),
        keywordCount: daily.map((d: any) => Number(d.keyword_cnt ?? 0)),
 score: daily.map((d: any) => Number(d.score ?? 0)),
        // 多变体「额外获得」的自然流量，是这个页面的核心指标
 extraScore: daily.map((d: any) => Number(d.extra_score ?? 0)),
      },
      keywords: [...byKeyword.values()],
    }
  }

  /**
   * 运营时光机
   *
   * 把运营动作事件叠加到指标时间轴上。
   * 事件是「系统识别的变化点」而非用户标注（侦察已确认），
   * 且非常稀疏 —— 库里只存有事件的天，前端按日期对齐到图上。
   */
  async getTimeline(asin: string, country: string) {
    const events = await this.db.query<any>(
      `SELECT e.stat_date, e.event_type, e.event_detail, d.name_cn AS type_name
  FROM fact_asin_op_event e
    LEFT JOIN dict_op_event_type d ON d.code = e.event_type
        WHERE e.asin = ? AND e.country = ?
   ORDER BY e.stat_date`,
      [asin, country],
    )

    // 月度指标作为背景曲线。
    // 快照数据是子体维度的，但用户常输入父体看整个变体组的走势，
    // 所以这里按组汇总：价格/评分/BSR 取平均，销量取下界之和。
    const asins = await this.resolveAsinScope(asin, country)
    if (!asins.length) {
      return {
        asin,
        country,
        months: [],
        metrics: { price: [], score: [], bsr: [], bought: [] },
        events: [],
      }
    }
    const ph = asins.map(() => '?').join(', ')

    const metrics = await this.db.query<any>(
      `SELECT stat_month,
              AVG(price) AS price, AVG(score) AS score, AVG(bsr) AS bsr
         FROM fact_asin_listing_snapshot
        WHERE asin IN (${ph}) AND country = ?
        GROUP BY stat_month
        ORDER BY stat_month`,
      [...asins, country],
    )

    const bought = await this.db.query<any>(
      `SELECT stat_month, SUM(bought_lower_bound) AS bought_lower_bound
         FROM fact_asin_bought_monthly
        WHERE asin IN (${ph}) AND country = ?
        GROUP BY stat_month
        ORDER BY stat_month`,
      [...asins, country],
    )
    const boughtMap = new Map(bought.map((b: any) => [b.stat_month, b]))

    return {
      asin,
      country,
      months: metrics.map((m: any) => m.stat_month),
      metrics: {
 price: metrics.map((m: any) => (m.price === null ? null : Number(m.price))),
        score: metrics.map((m: any) => (m.score === null ? null : Number(m.score))),
        bsr: metrics.map((m: any) => (m.bsr === null ? null : Number(m.bsr))),
 bought: metrics.map((m: any) => {
      const b = boughtMap.get(m.stat_month)
          return b ? Number(b.bought_lower_bound) : null
        }),
      },
      /** 运营动作事件。稀疏，前端在时间轴上打点 */
      events: events.map((e: any) => ({
        date: fmtDate(e.stat_date),
     eventType: e.event_type,
    eventName: e.type_name ?? e.event_type,
        detail: this.safeJson(e.event_detail),
      })),
    }
  }

  /** 查推荐专栏：某 ASIN 出现在哪些推荐位 */
  async getRecommendColumns(asin: string, country: string) {
    const rows = await this.db.query<any>(
      `SELECT p.rec_title, p.stat_date, p.ratio, p.campaign_cnt, p.keyword_cnt,
       c.display_name_cn, c.short_code
      FROM fact_asin_rec_column_period p
     LEFT JOIN dim_recommend_column c
        ON c.rec_title = p.rec_title AND c.country = p.country
    WHERE p.asin = ? AND p.country = ?
        ORDER BY p.rec_title, p.stat_date`,
      [asin, country],
    )

    // 按专栏分组
    const byColumn = new Map<string, any>()
    for (const r of rows) {
      if (!byColumn.has(r.rec_title)) {
        byColumn.set(r.rec_title, {
     recTitle: r.rec_title,
   // 推荐专栏是动态实体，新标题可能没有中文名，回落到英文原文
   name: r.display_name_cn ?? r.rec_title,
   shortCode: r.short_code ?? 'other',
     points: [],
          totalRatio: 0,
 })
      }
      const col = byColumn.get(r.rec_title)
      const ratio = r.ratio === null ? 0 : Number(r.ratio)
      col.points.push({
        date: fmtDate(r.stat_date),
        ratio,
 campaignCount: Number(r.campaign_cnt ?? 0),
      keywordCount: Number(r.keyword_cnt ?? 0),
      })
      col.totalRatio += ratio
    }

    const columns = [...byColumn.values()].sort((a, b) => b.totalRatio - a.totalRatio)

    return { asin, country, columns }
  }

  /** 竞品对比：把多个 ASIN 的已有指标并排放 */
  async compareAsins(asins: string[], country: string) {
    if (!asins.length) return { country, items: [] }

    // 上限 10 个，与实测原站一致（asinMagic 传 11 个起报参数错误）
    const list = asins.slice(0, 10)
    const ph = list.map(() => '?').join(', ')

    const base = await this.db.query<any>(
      `SELECT asin, title, img, price, score, star, rating_num, brand, is_best_seller
     FROM dim_asin WHERE country = ? AND asin IN (${ph})`,
      [country, ...list],
    )

    const traffic = await this.db.query<any>(
      `SELECT asin, channel, score, score_ratio
    FROM fact_asin_traffic_channel
        WHERE country = ? AND time_piece_type = 'month'
     AND channel IN ('total','nf','ad') AND asin IN (${ph})`,
      [country, ...list],
    )
    const tMap = new Map<string, any>()
    for (const t of traffic) {
      const cur = tMap.get(t.asin) ?? {}
      cur[t.channel] = { score: Number(t.score), ratio: Number(t.score_ratio) }
      tMap.set(t.asin, cur)
    }

    const bought = await this.db.query<any>(
      // 子查询按 country 过滤，避免跨站点取最新月导致误判无数据
      `SELECT asin, bought_lower_bound, bought_label
         FROM fact_asin_bought_monthly
 WHERE country = ? AND asin IN (${ph})
     AND stat_month = (
           SELECT MAX(stat_month) FROM fact_asin_bought_monthly WHERE country = ?
         )`,
      [country, ...list, country],
    )
    const bMap = new Map(bought.map((b: any) => [b.asin, b]))

    const items = base.map((a: any) => ({
      asin: a.asin,
      title: a.title,
      img: a.img,
      brand: a.brand,
      price: a.price === null ? null : Number(a.price),
      score: a.score === null ? null : Number(a.score),
      ratingNum: a.rating_num === null ? null : Number(a.rating_num),
      isBestSeller: !!a.is_best_seller,
      boughtLabel: bMap.get(a.asin)?.bought_label ?? null,
      traffic: tMap.get(a.asin) ?? {},
    }))

    /**
     * 组内相对标记（对应原站的 *Best 字段）。
     * 这些值是「相对当前对比组」算出来的，换一组对比对象就变，
     * 所以不能持久化 —— 每次请求现算。
     */
    const maxOf = (fn: (x: any) => number | null) =>
      Math.max(...items.map((i: any) => fn(i) ?? -Infinity))
    const maxBought = maxOf((i) => (i.boughtLabel ? Number(bMap.get(i.asin)?.bought_lower_bound ?? 0) : null))
    const maxScore = maxOf((i) => i.score)
    const minPrice = Math.min(...items.map((i: any) => i.price ?? Infinity))

    return {
      country,
      items: items.map((i: any) => ({
        ...i,
        best: {
          // 注意：原站这些字段实测是 true / null 两态，没有 false
          //
          // ⚠️ bought 必须先判断「有没有销量数据」再比大小。
          // 原先直接拿 `?? 0` 的兜底值参与比较：组内只要有一个 ASIN 查不到
          // 销量行，maxBought 就是 0，于是所有无数据的 ASIN 都满足 0 === 0，
          // 全被标成「组内销量最佳」—— 无数据反而拿了最佳标记。
          bought:
            i.boughtLabel && maxBought > -Infinity
              ? Number(bMap.get(i.asin)?.bought_lower_bound ?? 0) === maxBought || null
              : null,
          score: i.score === maxScore || null,
          price: i.price === minPrice || null,
        },
      })),
    }
  }

  /**
   * 把输入的 ASIN 解析成要统计的 ASIN 集合。
   *
   * 快照类数据（销量、Listing 指标、流量渠道）都是**子体维度**的，
   * 但用户经常输入父体想看整个变体组的表现。
   * 传父体就展开成该组全部子体，传子体就只返回它自己。
   */
  private async resolveAsinScope(asin: string, country: string): Promise<string[]> {
    const target = await this.db.queryOne<any>(
      'SELECT asin, is_parent_asin FROM dim_asin WHERE asin = ? AND country = ? LIMIT 1',
      [asin, country],
    )
    if (!target) return []
    if (target.is_parent_asin) {
      const children = await this.db.query<any>(
        'SELECT child_asin FROM rel_asin_variant WHERE parent_asin = ? AND country = ? ORDER BY display_order',
        [asin, country],
      )
      return children.map((c: any) => c.child_asin)
    }
    return [asin]
  }

  private safeJson(v: any) {
    if (!v) return null
    try {
      return JSON.parse(v)
    } catch {
      return v
    }
  }
}

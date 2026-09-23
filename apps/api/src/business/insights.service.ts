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

    /**
     * 关键词×变体 的排名明细
     *
     * ⚠️ 两处修正：
     *   1. JOIN 按 (keyword, country) —— keyword_id 跨站点不唯一且可空
     *      （实测 1120764 在 FR 是 "pastille lave glace"、US 是 "halloween trays for food"）
     *   2. **必须按单个时间片过滤**。该表唯一键含 (time_piece_type, time_piece_value)，
     *      库里实测有 2026-07/08/09 三个月共存。不过滤的话同一个「词×变体」
     *      会按月重复出现，下面分组时被反复 push 进 variants，排名还会串月。
     *      这里取该 ASIN 最新的一个月。
     */
    const latest = await this.db.queryOne<{ tv: string }>(
      `SELECT MAX(time_piece_value) AS tv
         FROM fact_asin_multinf_keyword_variant
        WHERE parent_asin = ? AND country = ? AND time_piece_type = 'month'`,
      [asin, country],
    )
    const month = latest?.tv ?? null

    const detail = month
      ? await this.db.query<any>(
          `SELECT v.keyword, v.keyword_id, k.translate_keyword, v.variant_asin,
    v.rank_position, v.variant_role, r.name_cn AS role_name
         FROM fact_asin_multinf_keyword_variant v
  LEFT JOIN dim_keyword k
         ON k.keyword = v.keyword AND k.country = v.country
   LEFT JOIN dict_variant_role r ON r.code = v.variant_role
 WHERE v.parent_asin = ? AND v.country = ?
           AND v.time_piece_type = 'month' AND v.time_piece_value = ?
    ORDER BY v.keyword, v.rank_position`,
          [asin, country, month],
        )
      : []

    // 按关键词分组，一个词下可能有多个变体同时占位（这正是「多变体自然位」的含义）
    const byKeyword = new Map<string, any>()
    for (const d of detail) {
      const key = String(d.keyword)
      if (!byKeyword.has(key)) {
 byKeyword.set(key, {
          keywordId: d.keyword_id === null ? null : String(d.keyword_id),
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
      /** 关键词明细所属的时间片，前端需要展示「当前看的是哪个月」 */
      keywordTimePieceValue: month,
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
    /**
     * 两个源合并，不是二选一。
     *
     *   fact_asin_rec_column_period        → ratio（流量占比）
     *   rel_rec_column_campaign_keyword    → campaign_cnt / keyword_cnt（关联计数）
     *
     * 原先的实现是「period 查不到就整体回落到关联表」，结果是只要有一个源缺，
     * 另一个源的数据也被丢掉。实际上两者互补：一个有占比没计数，
     * 一个有计数没占比，按 rec_title 外连起来才是完整的一行。
     *
     * ⚠️ 缺失一律用 null，不要用 0。0 会被读成「真的是 0 个活动」，
     * 而 null 表示「这个源不提供这个值」—— 前端据此显示「—」。
     */
    const ratioRows = await this.db.query<any>(
      `SELECT p.rec_title, p.stat_date, p.ratio,
              c.display_name_cn, c.short_code
         FROM fact_asin_rec_column_period p
    LEFT JOIN dim_recommend_column c
           ON c.rec_title = p.rec_title AND c.country = p.country
        WHERE p.asin = ? AND p.country = ?
          AND p.stat_date = (
                SELECT MAX(stat_date) FROM fact_asin_rec_column_period
                 WHERE asin = ? AND country = ?
              )
     ORDER BY p.ratio DESC`,
      [asin, country, asin, country],
    )

    const countRows = await this.db.query<any>(
      `SELECT r.rec_title,
              COUNT(DISTINCT r.encrypt_campaign_id) AS campaign_cnt,
              COUNT(DISTINCT r.keyword)             AS keyword_cnt,
              c.display_name_cn, c.short_code
         FROM rel_rec_column_campaign_keyword r
    LEFT JOIN dim_recommend_column c
           ON c.rec_title = r.rec_title AND c.country = r.country
        WHERE r.asin = ? AND r.country = ?
     GROUP BY r.rec_title, c.display_name_cn, c.short_code`,
      [asin, country],
    )

    /**
     * 按天趋势（第三源）。
     *
     * 表里每 (asin, 专栏, 日期) 一行，直接给前端两条序列。
     * 取自原站 rec/recView，服务端已做「跨该 ASIN 全部关键词去重」的逐日聚合 ——
     * 这一层 PG 侧算不出来（sif-cli 的 asin-keyword-list 忽略分页、恒返回 4 条词），
     * 详见 db/schema-09-rec-column-trend.sql 的说明。
     *
     * ⚠️ 这里返回的 trend 数组与 dates 严格同长同序，null 表示**当天无曝光**。
     * 前端必须断线而不是补 0 —— 补 0 会画成贴底的线，读起来像「有数据但为 0」。
     */
    const trendRows = await this.db.query<any>(
      `SELECT rec_title, stat_date, campaign_cnt, keyword_cnt,
              last_campaign_cnt, last_keyword_cnt
         FROM fact_rec_column_trend
        WHERE asin = ? AND country = ?
        ORDER BY stat_date`,
      [asin, country],
    )

    // 日期轴：所有专栏共用，取并集排序（各专栏的日期集合本应相同，
    // 但用并集更稳，缺的那天在各自序列里补 null）
    //
    // fmtDate 的签名是 string | null（它要处理脏数据），但 stat_date 是主键的一部分、
    // 不可能为 null。这里显式收窄一次，免得下游每处索引都要处理 null 分支。
    const dateOf = (v: any): string => fmtDate(v) ?? ''

    const trendDates = [...new Set(trendRows.map((r: any) => dateOf(r.stat_date)))].sort()

    /**
     * 专栏 → 该专栏的逐日行映射。
     *
     * ⚠️ 同时存一份「代表行」（`any`）。因为 last_campaign_cnt / last_keyword_cnt
     * 是**窗口级**字段、按行重复存，取任意一行都一样；而下面算行尾数字时
     * 需要的是「行」而不是「日期→行」的映射 ——
     * 曾经写成 `const c = trendMap.get(t)` 然后 `c?.last_campaign_cnt`，
     * 那恒为 undefined，`??` 就静默回落到 rel_ 表那个已知不准的计数
     * （词覆盖只有原站 1/12），页面上显示的是**有值的错数**，比报错更难发现。
     */
    const trendMap = new Map<string, { byDate: Record<string, any>; any: any }>()
    for (const r of trendRows) {
      const t = String(r.rec_title)
      if (!trendMap.has(t)) trendMap.set(t, { byDate: {}, any: r })
      trendMap.get(t)!.byDate[dateOf(r.stat_date)] = r
    }

    /** 把某专栏的逐日行对齐到共享日期轴；没有该天的行 → null（无曝光） */
    const align = (title: string, pick: (row: any) => number | null) => {
      const g = trendMap.get(title)
      return trendDates.map((d) => {
        const hit = g?.byDate[d]
        return hit ? pick(hit) : null
      })
    }

    const countMap = new Map<string, any>(countRows.map((r: any) => [r.rec_title, r]))
    const ratioMap = new Map<string, any>(ratioRows.map((r: any) => [r.rec_title, r]))

    // 三个源的专栏名取并集：某专栏可能只出现在其中一两个源里
    const titles = [
      ...new Set([...ratioMap.keys(), ...countMap.keys(), ...trendMap.keys()]),
    ]

    const num = (v: any) => (v === null || v === undefined ? null : Number(v))

    const columns = titles
      .map((t) => {
        const a = ratioMap.get(t)
        const b = countMap.get(t)
        const g = trendMap.get(t)

        const campaignTrends = g ? align(t, (r) => num(r.campaign_cnt)) : undefined
        const keywordTrends = g ? align(t, (r) => num(r.keyword_cnt)) : undefined

        /**
         * 行尾当前数取 last_*（原站另有此字段），**不是趋势数组末位**。
         * 实测 Picks from Amazon Influencers 的 ct 末位是 null 而
         * lastCampaignCnt=1 —— 取末位会显示成「—」，把有数据的行显示成无数据。
         *
         * 优先用趋势表的 last_*；没有趋势时回落到关联表的去重计数。
         *
         * ⚠️ 用 `g.any`（该专栏的任一行）而不是 `g` 本身 —— g 是
         * {byDate, any} 的容器，直接取 .last_campaign_cnt 会得到 undefined。
         */
        const lastCampaign =
          num(g?.any?.last_campaign_cnt) ?? num(b?.campaign_cnt)
        const lastKeyword =
          num(g?.any?.last_keyword_cnt) ?? num(b?.keyword_cnt)

        return {
          recTitle: t,
          name: a?.display_name_cn ?? b?.display_name_cn ?? t,
          shortCode: a?.short_code ?? b?.short_code ?? 'other',
          ratio: num(a?.ratio),
          /**
           * 计数优先用趋势表里的「窗口内最近值」，它来自原站服务端的去重聚合，
           * 比我们 rel_ 表按 (专栏,词,活动) 三元组去重算出来的准得多 ——
           * 实测 rel_ 的词覆盖只有原站约 1/12（B07N7GDB6Q：3 vs 35）。
           */
          campaignCount: lastCampaign,
          keywordCount: lastKeyword,
          campaignTrends,
          keywordTrends,
          lastCampaignCount: lastCampaign,
          lastKeywordCount: lastKeyword,
        }
      })
      // 有占比的按占比降序，没占比的按词数降序排在后面（对齐原站主排序列）
      .sort((x, y) => {
        if (x.ratio !== null && y.ratio !== null) return y.ratio - x.ratio
        if (x.ratio !== null) return -1
        if (y.ratio !== null) return 1
        return (y.keywordCount ?? 0) - (x.keywordCount ?? 0)
      })

    const statDate = ratioRows.length ? fmtDate(ratioRows[0].stat_date) : null

    /**
     * 三个计数卡。
     *
     * recCount 取并集大小（真实可数）；活动数与词数只有关联表能给，
     * 而关联表的词覆盖实测只有原站的 ~1/12（3 vs 35，见 AUDIT_REC_COLUMN_DATA.md），
     * 所以这两个数会明显偏小。coverage.hasCounts 让前端能标注这一点，
     * 而不是让用户以为原站数据就这么少。
     */
    const allCampaigns = await this.db.queryOne<any>(
      `SELECT COUNT(DISTINCT encrypt_campaign_id) AS c,
              COUNT(DISTINCT keyword)             AS k
         FROM rel_rec_column_campaign_keyword
        WHERE asin = ? AND country = ?`,
      [asin, country],
    )

    /**
     * ⚠️ `COUNT()` 无行时返回 0，不是 NULL —— 直接用会把「关联表里没有这个 ASIN」
     * 显示成「0 个广告活动」。所以用 countRows 是否为空来判断，
     * 空则整体置 null，让前端显示「—」。
     */
    const hasCounts = countRows.length > 0
    const hasTrends = trendRows.length > 0

    return {
      asin,
      country,
      statDate,
      /** 趋势序列共用的日期轴。有趋势时才有值，前端画折线要用它当横轴 */
      dates: trendDates,
      overview: {
        recCount: columns.length,
        campaignCount: hasCounts ? num(allCampaigns?.c) : null,
        keywordCount: hasCounts ? num(allCampaigns?.k) : null,
      },
      columns,
      coverage: {
        hasRatio: ratioRows.length > 0,
        hasCounts,
        hasTrends,
      },
    }
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

    /**
     * 分渠道流量。
     *
     * ⚠️ 必须按时间片过滤。该表唯一键含 (time_piece_type, time_piece_value)，
     * 同一个 (asin, channel) 会有多个月的行。原先没有 time_piece_value 条件，
     * 下面 `cur[t.channel] = ...` 会被后来的行覆写 ——
     * 最终留下哪个月完全取决于 Doris 的返回顺序，结果不确定
     * （同一请求两次可能拿到不同月份的数据）。
     *
     * 取每个 ASIN **各自**的最新月，而不是这批 ASIN 的全局最新月：
     * 各 ASIN 数据进度常常不齐，用全局最新月会让落后的 ASIN 整行变空。
     */
    const traffic = await this.db.query<any>(
      `SELECT t.asin, t.channel, t.score, t.score_ratio
    FROM fact_asin_traffic_channel t
         JOIN (
           SELECT asin, MAX(time_piece_value) AS tv
             FROM fact_asin_traffic_channel
            WHERE country = ? AND time_piece_type = 'month' AND asin IN (${ph})
            GROUP BY asin
         ) m ON m.asin = t.asin AND m.tv = t.time_piece_value
        WHERE t.country = ? AND t.time_piece_type = 'month'
     AND t.channel IN ('total','nf','ad') AND t.asin IN (${ph})`,
      [country, ...list, country, ...list],
    )
    const tMap = new Map<string, any>()
    for (const t of traffic) {
      const cur = tMap.get(t.asin) ?? {}
      cur[t.channel] = { score: Number(t.score), ratio: Number(t.score_ratio) }
      tMap.set(t.asin, cur)
    }

    /**
     * 销量。取每个 ASIN **各自**的最新月，与上面的 traffic 查询口径保持一致。
     *
     * 原先是「全站点最新月」的标量子查询，各 ASIN 数据进度不齐时，
     * 落后的 ASIN 一行都查不到，销量列显示成空。
     * 实测量化：US 站 38,484 个 ASIN 里有 7,040 个（18%）最新月落后于全局最新月，
     * 也就是近两成的对比行销量是空的 —— 不是隐患，是已经在发生的数据缺失。
     *
     * 同时这也修掉一处口径不一致：流量按各自最新月、销量按全局最新月，
     * 同一页面上两列可能来自不同月份，无法横向解读。
     */
    const bought = await this.db.query<any>(
      `SELECT b.asin, b.stat_month, b.bought_lower_bound, b.bought_label
         FROM fact_asin_bought_monthly b
         JOIN (
           SELECT asin, MAX(stat_month) AS mx
             FROM fact_asin_bought_monthly
            WHERE country = ? AND asin IN (${ph})
            GROUP BY asin
         ) m ON m.asin = b.asin AND m.mx = b.stat_month
        WHERE b.country = ? AND b.asin IN (${ph})`,
      [country, ...list, country, ...list],
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
      /**
       * 销量。
       *
       * ⚠️ 不能只返回 bought_label —— 实测 US 站 810,460 行里
       * bought_label 有 808,567 行是 NULL（99.8%），而 bought_lower_bound 零 NULL。
       * 原先只取 label，导致真实数据下销量列几乎全空。
       *
       * label 是原站的分档串（「10,000+」），只有部分行有；
       * lower_bound 是分档下界整数，始终有值。
       * 两个都下发：前端优先显示 label，没有就用 lower_bound 自己拼「N+」。
       */
      boughtLabel: bMap.get(a.asin)?.bought_label ?? null,
      boughtLowerBound:
        bMap.get(a.asin)?.bought_lower_bound === undefined ||
        bMap.get(a.asin)?.bought_lower_bound === null
          ? null
          : Number(bMap.get(a.asin).bought_lower_bound),
      /** 该 ASIN 销量数据实际所属月份（各 ASIN 进度不齐，前端可提示截止月） */
      boughtStatMonth: bMap.get(a.asin)?.stat_month ?? null,
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

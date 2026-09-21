import { Injectable } from '@nestjs/common'
import { DorisService } from '../database/doris.service'
import { buildPage, decodeCursor, normalizeLimit } from '../common/cursor'
import type { KeywordListDto } from './dto/query.dto'

/**
 * 反查流量词
 *
 * 对应原站 /reverse（注意不是 /keywords —— 原站那个是「以词拓词」，
 * 属于 goal.md 未纳入的功能族）。
 *
 * 实测要点：
 *   - 旧接口 /api/search/asinKeywords 已 404 下线，只复刻新版结构
 *   - 渠道得分是 9 个同构对象，库里存长表，这里 pivot
 *
 * ⚠️ 关联键用 (keyword, country) 而不是 keyword_id：
 *   早期以为 keywordId 全局唯一，实测**证伪** —— 库里 keyword_id=1120764
 *   在 FR 站是 "pastille lave glace"、在 US 站是 "halloween trays for food"。
 *   schema-04 已把 16 张关键词表的主键改成 (keyword, country)，
 *   keyword_id 降级为可空普通列（仅部分源接口提供）。
 *   所以 JOIN 必须带 country，且以文本为键，否则跨站串词 + keyword_id 为空时丢行。
 */
@Injectable()
export class KeywordsService {
  constructor(private readonly db: DorisService) {}

  /**
   * 关键词列表（游标分页）
   *
   * 排序与游标的配合：游标编的是「排序字段值 + keyword」两个值，
   * 后者用于打破前者相同时的并列，保证翻页不重不漏。
   */
  async listKeywords(dto: KeywordListDto) {
    const country = dto.country ?? 'US'
    // 按**该 ASIN** 取最新月，不是全站最新月 —— 见 latestMonth 的说明
    const month = dto.timePieceValue ?? (await this.latestMonth(country, dto.asin))
    const limit = normalizeLimit(dto.limit)
    const desc = (dto.order ?? 'desc') === 'desc'

    // 排序字段白名单，避免拼 SQL 注入
    const SORT_COLUMNS: Record<string, string> = {
      score: 's.listing_score_ratio',
      rank: 's.nf_last_rank',
      searches: 's.est_searches_num',
    }
    const sortCol = SORT_COLUMNS[dto.sortBy ?? 'score'] ?? SORT_COLUMNS.score

    const where: string[] = [
      's.asin = ?',
      's.country = ?',
      "s.time_piece_type = 'month'",
      's.time_piece_value = ?',
    ]
    const params: any[] = [dto.asin, country, month]

    // 关键词搜索走 dim_keyword 的倒排索引
    if (dto.keyword) {
      where.push('k.keyword MATCH_ANY ?')
      params.push(dto.keyword)
    }

    /**
     * 游标：上一页最后一行的 (排序值, keyword)
     *
     * tie-break 用 keyword 文本而不是 keyword_id —— 后者可空，
     * NULL 参与比较时结果为 UNKNOWN，整行被 WHERE 过滤掉，翻页会漏数据。
     */
    const cur = decodeCursor(dto.cursor)
    if (cur && cur.length === 2) {
      const op = desc ? '<' : '>'
      // 复合条件：排序值更小，或排序值相等但关键词字典序更小
      where.push(`(${sortCol} ${op} ? OR (${sortCol} = ? AND s.keyword ${op} ?))`)
      params.push(cur[0], cur[0], cur[1])
    }

    const dir = desc ? 'DESC' : 'ASC'
    // 多取一条用于判断 hasMore，避免额外跑 COUNT(*)
    const rows = await this.db.query<any>(
      `SELECT s.keyword, s.keyword_id, k.translate_keyword, k.est_searches_num,
      s.is_core, s.is_target, s.nf_last_rank, s.sp_last_rank,
       s.listing_score_ratio, s.exposure_positions, s.piece_max_time
    FROM fact_asin_keyword_snapshot s
         JOIN dim_keyword k
           ON k.keyword = s.keyword AND k.country = s.country
 WHERE ${where.join(' AND ')}
   ORDER BY ${sortCol} ${dir}, s.keyword ${dir}
   LIMIT ${limit + 1}`,
      params,
    )

    const page = buildPage(rows, limit, (last: any) => [
      dto.sortBy === 'rank'
        ? Number(last.nf_last_rank ?? 0)
        : dto.sortBy === 'searches'
   ? Number(last.est_searches_num ?? 0)
          : Number(last.listing_score_ratio ?? 0),
      String(last.keyword),
    ])

    // 批量取各词的分渠道得分，避免 N+1 查询。按 keyword 文本取，与主键一致
    const kws = page.items.map((r: any) => String(r.keyword))
    const scoreMap = new Map<string, Record<string, any>>()
    if (kws.length) {
      const scores = await this.db.query<any>(
    `SELECT keyword, channel, score, score_ratio, score_change_ratio
       FROM fact_asin_keyword_score
    WHERE asin = ? AND country = ? AND time_piece_type = 'month'
     AND time_piece_value = ?
AND keyword IN (${kws.map(() => '?').join(', ')})`,
      [dto.asin, country, month, ...kws],
      )
      for (const s of scores) {
        const key = String(s.keyword)
   const cur2 = scoreMap.get(key) ?? {}
        cur2[s.channel] = {
    score: Number(s.score),
   ratio: s.score_ratio === null ? null : Number(s.score_ratio),
  changeRatio: s.score_change_ratio === null ? null : Number(s.score_change_ratio),
        }
        scoreMap.set(key, cur2)
      }
    }

    return {
      asin: dto.asin,
      country,
      timePieceValue: month,
      items: page.items.map((r: any) => ({
        // keyword_id 可空（多数源接口不返回），前端不要拿它做主键
        keywordId: r.keyword_id === null ? null : String(r.keyword_id),
        keyword: r.keyword,
        translateKeyword: r.translate_keyword,
        estSearchesNum: r.est_searches_num === null ? null : Number(r.est_searches_num),
 isCore: !!r.is_core,
        isTarget: !!r.is_target,
        nfLastRank: r.nf_last_rank === null ? null : Number(r.nf_last_rank),
        spLastRank: r.sp_last_rank === null ? null : Number(r.sp_last_rank),
        listingScoreRatio:
          r.listing_score_ratio === null ? null : Number(r.listing_score_ratio),
        exposurePositions: r.exposure_positions ? String(r.exposure_positions).split(',') : [],
      channels: scoreMap.get(String(r.keyword)) ?? {},
      })),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    }
  }

  /**
   * 单个关键词的流量来源分析。
   *
   * goal.md 列了 /keywords/source 这个路由，但原站没有对应页面
   * （承担该语义的是 /compete 和 /amount，以及反查页的行内抽屉）。
   * 这里实现为「某关键词下的头部 ASIN + 该词的排名历史」。
   *
   * ⚠️ 入参是**关键词文本**而非 keyword_id：
   *   keyword_id 跨站点不唯一（实测 1120764 在 FR/US 是两个不同的词），
   *   且在多数源接口里为空。文本 + country 才是 schema-04 的真实主键。
   */
  async getKeywordSource(keywordText: string, country: string, asin?: string) {
    // 必须带 country，否则同一个词会跨站点取错行
    const keyword = await this.db.queryOne<any>(
      `SELECT keyword_id, keyword, translate_keyword, est_searches_num
      FROM dim_keyword WHERE keyword = ? AND country = ? LIMIT 1`,
      [keywordText, country],
    )
    if (!keyword) return null

    const topAsins = await this.db.query<any>(
      `SELECT t.asin, t.rank_position, a.title, a.img, a.price, a.score, a.star
         FROM rel_keyword_top_asin t
         LEFT JOIN dim_asin a ON a.asin = t.asin AND a.country = t.country
        WHERE t.keyword = ? AND t.country = ?
        ORDER BY t.rank_position
        LIMIT 20`,
      [keywordText, country],
    )

    // 排名历史。只有传了 asin 才有意义（排名是 ASIN×关键词 的属性）
    const rankHistory = asin
      ? await this.db.query<any>(
       `SELECT stat_date, rank_position, page_no
       FROM fact_keyword_rank_history
        WHERE asin = ? AND country = ? AND keyword = ? AND rank_type = 'nf'
       ORDER BY stat_date`,
       [asin, country, keywordText],
    )
      : []

    return {
      keyword: {
        // keyword_id 可空，仅作对账参考，不再作为关联键
        keywordId: keyword.keyword_id === null ? null : String(keyword.keyword_id),
        keyword: keyword.keyword,
        translateKeyword: keyword.translate_keyword,
        estSearchesNum:
   keyword.est_searches_num === null ? null : Number(keyword.est_searches_num),
      },
      topAsins: topAsins.map((t: any) => ({
        asin: t.asin,
        rankPosition: Number(t.rank_position),
        title: t.title,
 img: t.img,
 price: t.price === null ? null : Number(t.price),
        score: t.score === null ? null : Number(t.score),
      })),
      rankHistory: rankHistory.map((h: any) => ({
        date: h.stat_date,
        rank: Number(h.rank_position),
        pageNo: h.page_no === null ? null : Number(h.page_no),
      })),
    }
  }

  /**
   * 数据最新月份。
   *
   * ## 两层收敛，都不能省
   *
   * 1. **按 country**：各站点数据进度不一致时（US 到 2026-08、JP 只到 2026-06），
   *    用全局最新月查 JP 会得到空结果并被误判为「无数据」。
   *
   * 2. **按 asin**（本次修复）：实测本表 4,800 个 ASIN 里
   *    **897 个（19%）的最新月是 2026-08**，而全站最新月是 2026-09。
   *    对这 897 个 ASIN 用全站最新月去查 → 返回空 →
   *    页面显示「该 ASIN 没有流量词」，而它其实有，只是上月的数据。
   *
   *    这与 traffic.service.ts 的 latestMonth、wordpick.service.ts 的
   *    latestWeek 是同一类问题：**只要数据按 ASIN/关键词稀疏分布，
   *    按全局最新周期过滤就会把「上期有数据」误判成「无数据」**。
   *
   * @param asin 限定范围；不传则退回全站点最新月
   */
  private async latestMonth(country: string, asin?: string): Promise<string> {
    if (asin) {
      const r = await this.db.queryOne<any>(
        `SELECT MAX(time_piece_value) AS m FROM fact_asin_keyword_snapshot
          WHERE time_piece_type = 'month' AND country = ? AND asin = ?`,
        [country, asin],
      )
      // 该 ASIN 在本表完全没数据时落到下面取全站最新月 ——
      // 保证 SQL 里的 time_piece_value 始终是个确定值
      if (r?.m) return r.m
    }
    const r = await this.db.queryOne<any>(
      `SELECT MAX(time_piece_value) AS m FROM fact_asin_keyword_snapshot
        WHERE time_piece_type = 'month' AND country = ?`,
      [country],
    )
    return r?.m ?? '2026-08'
  }
}

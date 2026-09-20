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
 *   - keywordId 全局唯一，关联用 id 不用文本
 *   - 渠道得分是 9 个同构对象，库里存长表，这里 pivot
 */
@Injectable()
export class KeywordsService {
  constructor(private readonly db: DorisService) {}

  /**
   * 关键词列表（游标分页）
   *
   * 排序与游标的配合：游标编的是「排序字段值 + keyword_id」两个值，
   * 后者用于打破前者相同时的并列，保证翻页不重不漏。
   */
  async listKeywords(dto: KeywordListDto) {
    const country = dto.country ?? 'US'
    const month = dto.timePieceValue ?? (await this.latestMonth(country))
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

    // 游标：上一页最后一行的 (排序值, keyword_id)
    const cur = decodeCursor(dto.cursor)
    if (cur && cur.length === 2) {
      const op = desc ? '<' : '>'
      // 复合条件：排序值更小，或排序值相等但 id 更小
      where.push(`(${sortCol} ${op} ? OR (${sortCol} = ? AND s.keyword_id ${op} ?))`)
      params.push(cur[0], cur[0], cur[1])
    }

    const dir = desc ? 'DESC' : 'ASC'
    // 多取一条用于判断 hasMore，避免额外跑 COUNT(*)
    const rows = await this.db.query<any>(
      `SELECT s.keyword_id, k.keyword, k.translate_keyword, k.est_searches_num,
      s.is_core, s.is_target, s.nf_last_rank, s.sp_last_rank,
       s.listing_score_ratio, s.exposure_positions, s.piece_max_time
    FROM fact_asin_keyword_snapshot s
         JOIN dim_keyword k ON k.keyword_id = s.keyword_id
 WHERE ${where.join(' AND ')}
   ORDER BY ${sortCol} ${dir}, s.keyword_id ${dir}
   LIMIT ${limit + 1}`,
      params,
    )

    const page = buildPage(rows, limit, (last: any) => [
      dto.sortBy === 'rank'
        ? Number(last.nf_last_rank ?? 0)
        : dto.sortBy === 'searches'
   ? Number(last.est_searches_num ?? 0)
          : Number(last.listing_score_ratio ?? 0),
      String(last.keyword_id),
    ])

    // 批量取各词的分渠道得分，避免 N+1 查询
    const ids = page.items.map((r: any) => String(r.keyword_id))
    const scoreMap = new Map<string, Record<string, any>>()
    if (ids.length) {
      const scores = await this.db.query<any>(
    `SELECT keyword_id, channel, score, score_ratio, score_change_ratio
       FROM fact_asin_keyword_score
    WHERE asin = ? AND country = ? AND time_piece_type = 'month'
     AND time_piece_value = ?
AND keyword_id IN (${ids.map(() => '?').join(', ')})`,
      [dto.asin, country, month, ...ids],
      )
      for (const s of scores) {
        const key = String(s.keyword_id)
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
        keywordId: String(r.keyword_id),
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
      channels: scoreMap.get(String(r.keyword_id)) ?? {},
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
   */
  async getKeywordSource(keywordId: string, country: string, asin?: string) {
    const keyword = await this.db.queryOne<any>(
      `SELECT keyword_id, keyword, translate_keyword, est_searches_num
      FROM dim_keyword WHERE keyword_id = ? LIMIT 1`,
      [keywordId],
    )
    if (!keyword) return null

    const topAsins = await this.db.query<any>(
      `SELECT t.asin, t.rank_position, a.title, a.img, a.price, a.score, a.star
         FROM rel_keyword_top_asin t
         LEFT JOIN dim_asin a ON a.asin = t.asin AND a.country = t.country
        WHERE t.keyword_id = ? AND t.country = ?
        ORDER BY t.rank_position
        LIMIT 20`,
      [keywordId, country],
    )

    // 排名历史。只有传了 asin 才有意义（排名是 ASIN×关键词 的属性）
    const rankHistory = asin
      ? await this.db.query<any>(
       `SELECT stat_date, rank_position, page_no
       FROM fact_keyword_rank_history
        WHERE asin = ? AND country = ? AND keyword_id = ? AND rank_type = 'nf'
       ORDER BY stat_date`,
       [asin, country, keywordId],
    )
      : []

    return {
      keyword: {
        keywordId: String(keyword.keyword_id),
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
   * ⚠️ 必须按 country 取最新月，不能取全局 MAX。
   * 各站点数据进度不一致时（US 到 2026-08、JP 只到 2026-06），
   * 用全局最新月查 JP 会得到空结果并被误判为「无数据」。
   */
  private async latestMonth(country: string): Promise<string> {
    const r = await this.db.queryOne<any>(
      `SELECT MAX(time_piece_value) AS m FROM fact_asin_keyword_snapshot
        WHERE time_piece_type = 'month' AND country = ?`,
      [country],
    )
    return r?.m ?? '2026-08'
  }
}

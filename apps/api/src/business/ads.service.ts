import { Injectable } from '@nestjs/common'
import { DorisService } from '../database/doris.service'
import { fmtDate } from '../common/format'
import { buildPage, decodeCursor, normalizeLimit } from '../common/cursor'

/**
 * 广告透视（查广告架构 / 查投放小组 / 查广告词）
 *
 * ⚠️ 三条侦察结论直接决定了这里的查询方式：
 *   1. Product Ad ≠ Amazon AdGroup。层级是 Campaign→AdGroup→ProductAd→变体→搜索词，
 *      而 AdGroup 层原站前端零字段，所以没有这一层的表和查询
 *   2. 查广告词页存的是**买家搜索词**，不是投放词
 *   3. Campaign→ProductAd 的关系带时间维度（同一活动各周包含的小组会变），
 *      所以查询必须带日期，不能当静态关系
 */
@Injectable()
export class AdsService {
  constructor(private readonly db: DorisService) {}

  /** 查广告架构：某 ASIN 被哪些广告活动投放 */
  async listCampaigns(asin: string, country: string) {
    // 先通过搜索词曝光反查出涉及该 ASIN 的活动
    const rows = await this.db.query<any>(
      `SELECT c.encrypt_campaign_id, c.fake_campaign_id, c.ad_type, c.strategy,
      c.asin_num, c.ad_num, c.campaign_created_at, c.last_ad_created_at,
     t.name_cn AS ad_type_name,
    COUNT(DISTINCT e.encrypt_ad_id) AS involved_ad_num,
       SUM(e.score) AS total_score
      FROM fact_ad_search_term_exposure e
        JOIN dim_ad_campaign c
        ON c.encrypt_campaign_id = e.encrypt_campaign_id AND c.country = e.country
   LEFT JOIN dict_ad_type t ON t.code = CAST(c.ad_type AS CHAR)
        WHERE e.variant_asin = ? AND e.country = ?
   GROUP BY c.encrypt_campaign_id, c.fake_campaign_id, c.ad_type, c.strategy,
      c.asin_num, c.ad_num, c.campaign_created_at, c.last_ad_created_at, t.name_cn
        ORDER BY total_score DESC`,
      [asin, country],
    )

    return {
      asin,
      country,
      campaigns: rows.map((r: any) => ({
  // 三套 ID：加密 ID 是主键，fake 是前台 4 位短码，
    // campaignIdA0（用户录入的后台真实 ID）在 sys_user_ad_note 里，不在业务表
    encryptCampaignId: r.encrypt_campaign_id,
        fakeCampaignId: r.fake_campaign_id,
        adType: Number(r.ad_type),
        adTypeName: r.ad_type_name ?? String(r.ad_type),
 // 后端算好的中文串，直接用
        strategy: r.strategy,
 asinNum: Number(r.asin_num ?? 0),
        adNum: Number(r.ad_num ?? 0),
        involvedAdNum: Number(r.involved_ad_num ?? 0),
        totalScore: r.total_score === null ? 0 : Number(r.total_score),
        campaignCreatedAt: fmtDate(r.campaign_created_at),
        lastAdCreatedAt: fmtDate(r.last_ad_created_at),
      })),
    }
  }

  /**
   * 查投放小组（原站叫「查广告组」但内部实为 Product Ad）
   *
   * 关系表带 stat_date，所以这里按日期聚合 —— 同一活动在不同周
   * 包含的投放小组集合是变化的。
   */
  async listProductAds(campaignId: string, country: string) {
    const rows = await this.db.query<any>(
      `SELECT p.encrypt_ad_id, p.fake_ad_id, p.ad_created_at,
    MIN(r.stat_date) AS first_seen, MAX(r.stat_date) AS last_seen,
       COUNT(DISTINCT r.stat_date) AS active_weeks
      FROM rel_ad_campaign_product_ad r
      JOIN dim_ad_product_ad p
        ON p.encrypt_ad_id = r.encrypt_ad_id AND p.country = r.country
    WHERE r.encrypt_campaign_id = ? AND r.country = ?
   GROUP BY p.encrypt_ad_id, p.fake_ad_id, p.ad_created_at
        ORDER BY first_seen`,
      [campaignId, country],
    )

    return {
      encryptCampaignId: campaignId,
      productAds: rows.map((r: any) => ({
        encryptAdId: r.encrypt_ad_id,
        fakeAdId: r.fake_ad_id,
 adCreatedAt: fmtDate(r.ad_created_at),
        firstSeen: fmtDate(r.first_seen),
        lastSeen: fmtDate(r.last_seen),
 // 该小组在多少个时间点出现过，反映投放是否持续
 activeWeeks: Number(r.active_weeks ?? 0),
      })),
    }
  }

  /**
   * 查广告词：买家通过哪些搜索词看到了广告
   *
   * 注意字段命名用 searchTerm 而非 keyword —— 这是买家实际搜索的词，
   * 不是卖家设置的投放词（原站模板明确标注「搜索词(不是投放词)」）。
   */
  async listSearchTerms(
    asin: string,
    country: string,
    opts: { cursor?: string; limit?: number; campaignId?: string } = {},
  ) {
    const limit = normalizeLimit(opts.limit)

    const where = ['e.variant_asin = ?', 'e.country = ?']
    const params: any[] = [asin, country]

    if (opts.campaignId) {
      where.push('e.encrypt_campaign_id = ?')
      params.push(opts.campaignId)
    }

    const cur = decodeCursor(opts.cursor)
    if (cur && cur.length === 2) {
      where.push('(e.score < ? OR (e.score = ? AND e.keyword_id < ?))')
      params.push(cur[0], cur[0], cur[1])
    }

    const rows = await this.db.query<any>(
      `SELECT e.keyword_id, k.keyword, k.translate_keyword, e.encrypt_ad_id,
     e.encrypt_campaign_id, e.ad_type, e.traffic_type, e.score,
   e.rank_position, e.stat_date, c.name_cn AS traffic_name
      FROM fact_ad_search_term_exposure e
      JOIN dim_keyword k ON k.keyword_id = e.keyword_id
      LEFT JOIN dict_traffic_channel c ON c.code = e.traffic_type
 WHERE ${where.join(' AND ')}
    ORDER BY e.score DESC, e.keyword_id DESC
 LIMIT ${limit + 1}`,
      params,
    )

    const page = buildPage(rows, limit, (last: any) => [
      Number(last.score),
      String(last.keyword_id),
    ])

    return {
      asin,
      country,
      items: page.items.map((r: any) => ({
        keywordId: String(r.keyword_id),
        searchTerm: r.keyword,
        translateKeyword: r.translate_keyword,
        encryptAdId: r.encrypt_ad_id,
        encryptCampaignId: r.encrypt_campaign_id,
        adType: Number(r.ad_type),
        trafficType: r.traffic_type,
 trafficTypeName: r.traffic_name ?? r.traffic_type,
        score: Number(r.score),
        rankPosition: r.rank_position === null ? null : Number(r.rank_position),
 statDate: fmtDate(r.stat_date),
      })),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    }
  }
}

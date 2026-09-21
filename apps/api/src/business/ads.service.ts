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

  /**
   * 查广告架构：某 ASIN 被哪些广告活动投放
   *
   * ⚠️ 原实现从 `fact_ad_search_term_exposure` 反查，但那张表**建不起来**：
   * 它的四元组主键 (encrypt_ad_id, country, keyword_id, variant_asin) 在
   * keyword_id 上闭合不了 —— 上游 `web-variant-ad-keywords.keywords[]` 只给
   * 关键词文本、不给 keywordId，回查字典 835 个词仅 15 个可解（1.8%）。
   * 详见 docs/MODULE_DATA_FLOW.md 模块 7-9。
   * 表恒为空 → 这个接口恒返回 0 条，页面永远空白。
   *
   * 改走 `fact_asin_keyword_snapshot.sp_campaign_id`：它是「该 ASIN 的某个
   * 流量词由哪个广告活动带来」，能直接给出 ASIN → 活动 的关联，
   * 实测覆盖 2,661 个 ASIN / 6,352 条关联。
   *
   * 代价：只能拿到 SP（商品推广）活动 —— 该列只记 SP 的 campaignId。
   * 但这是目前唯一闭合的路径，比整页空白强。
   * involvedAdNum 改成「该活动为本 ASIN 带来多少个流量词」，
   * totalScore 用这些词的流量得分之和（原先是曝光得分，同样无源）。
   */
  async listCampaigns(asin: string, country: string) {
    const rows = await this.db.query<any>(
      `SELECT c.encrypt_campaign_id, c.fake_campaign_id, c.ad_type, c.strategy,
              c.asin_num, c.ad_num, c.campaign_created_at, c.last_ad_created_at,
              t.name_cn AS ad_type_name,
              COUNT(DISTINCT s.keyword) AS involved_ad_num,
              SUM(COALESCE(s.listing_score_ratio, 0)) AS total_score
         FROM fact_asin_keyword_snapshot s
         JOIN dim_ad_campaign c
           ON c.encrypt_campaign_id = s.sp_campaign_id AND c.country = s.country
    LEFT JOIN dict_ad_type t ON t.code = CAST(c.ad_type AS CHAR)
        WHERE s.asin = ? AND s.country = ? AND s.sp_campaign_id IS NOT NULL
     GROUP BY c.encrypt_campaign_id, c.fake_campaign_id, c.ad_type, c.strategy,
              c.asin_num, c.ad_num, c.campaign_created_at, c.last_ad_created_at,
              t.name_cn
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

    // tie-break 用 keyword 文本：keyword_id 可空，NULL 参与比较会让整行被过滤掉
    const cur = decodeCursor(opts.cursor)
    if (cur && cur.length === 2) {
      where.push('(e.score < ? OR (e.score = ? AND e.keyword < ?))')
      params.push(cur[0], cur[0], cur[1])
    }

    /**
     * ⚠️ 这里必须是 LEFT JOIN，且按 (keyword, country) 关联。
     *
     * 原先是 `JOIN dim_keyword ON keyword_id`，有两个致命问题：
     *   1. 广告搜索词源接口**根本不返回 keywordId**（schema-04:251 已注明），
     *      真实数据下该列全为 NULL，INNER JOIN 后这个 Tab 恒为空；
     *   2. keyword_id 跨站点不唯一，不带 country 会串词。
     * 改成 LEFT JOIN 后，即使 dim_keyword 里还没有这个词（ETL 时序差），
     * 曝光行本身也不会丢 —— 搜索词文本就在事实表里，不依赖维表。
     */
    const rows = await this.db.query<any>(
      `SELECT e.keyword, e.keyword_id, k.translate_keyword, e.encrypt_ad_id,
     e.encrypt_campaign_id, e.ad_type, e.traffic_type, e.score,
   e.rank_position, e.stat_date, c.name_cn AS traffic_name
      FROM fact_ad_search_term_exposure e
      LEFT JOIN dim_keyword k
        ON k.keyword = e.keyword AND k.country = e.country
      LEFT JOIN dict_traffic_channel c ON c.code = e.traffic_type
 WHERE ${where.join(' AND ')}
    ORDER BY e.score DESC, e.keyword DESC
 LIMIT ${limit + 1}`,
      params,
    )

    const page = buildPage(rows, limit, (last: any) => [
      Number(last.score),
      String(last.keyword),
    ])

    return {
      asin,
      country,
      items: page.items.map((r: any) => ({
        // 广告源接口不返回 keywordId，真实数据下基本恒为 null
        keywordId: r.keyword_id === null ? null : String(r.keyword_id),
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

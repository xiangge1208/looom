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
   *
   * ## 2026-09-22 修正：该前提已不成立，改回走曝光表
   *
   * 上面那段结论错在「必须靠 keyword_id 关联」这个假设上。schema-04 早已把
   * 关键词表的主键改成 `(keyword, country)` 文本键，`keyword_id` 降级为可空列
   * —— 所以**按关键词文本就能闭合**，keywordId 缺失根本不影响建表。
   * 补齐 web-variant-ad-keywords 的全部分页后，这张表实测 1,887 行、21 个活动、
   * 24 个投放小组，不再是空表。
   *
   * 退回 `fact_asin_keyword_snapshot.sp_campaign_id` 的代价是**严重低估**：
   * 那一列只记「该 ASIN 的流量词恰好由哪个 SP 活动带来」，是广告数据的副产品，
   * 实测只能看到 4 个活动，而真实投放有 21 个 —— 漏掉 81%。
   * 所以这里改回以曝光表为准。
   *
   * ## 统计口径
   *
   * 按**变体组**聚合：广告投在子体上，用户查父体时要看到整组的投放全貌，
   * 所以 variant_asin 用子体集合而不是单个 ASIN。
   * involvedAdNum = 该活动下的投放小组数（回归字段原义）；
   * totalScore = 该活动各词曝光得分之和。
   */
  async listCampaigns(asin: string, country: string) {
    const asins = await this.resolveAsinScope(asin, country)
    if (!asins.length) return { asin, country, campaigns: [] }

    const ph = asins.map(() => '?').join(', ')
    const rows = await this.db.query<any>(
      `SELECT c.encrypt_campaign_id, c.fake_campaign_id, c.ad_type, c.strategy,
              c.asin_num, c.ad_num, c.campaign_created_at, c.last_ad_created_at,
              t.name_cn AS ad_type_name,
              COUNT(DISTINCT e.encrypt_ad_id) AS involved_ad_num,
              COUNT(DISTINCT e.keyword) AS keyword_cnt,
              COUNT(DISTINCT e.variant_asin) AS variant_cnt,
              SUM(COALESCE(e.score, 0)) AS total_score
         FROM fact_ad_search_term_exposure e
         JOIN dim_ad_campaign c
           ON c.encrypt_campaign_id = e.encrypt_campaign_id AND c.country = e.country
    LEFT JOIN dict_ad_type t ON t.code = CAST(c.ad_type AS CHAR)
        WHERE e.country = ? AND e.variant_asin IN (${ph})
     GROUP BY c.encrypt_campaign_id, c.fake_campaign_id, c.ad_type, c.strategy,
              c.asin_num, c.ad_num, c.campaign_created_at, c.last_ad_created_at,
              t.name_cn
     ORDER BY keyword_cnt DESC, total_score DESC`,
      [country, ...asins],
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
        /**
         * 「涉及 ASIN」列。
         *
         * ⚠️ 原先写 `Number(r.asin_num ?? 0)`，而 dim_ad_campaign.asin_num
         * 实测 5,925/5,928 行是 NULL（源侧就没给），于是页面上这一列**恒显示 0**，
         * 看起来像「这个广告活动没有投任何商品」，是错的读数。
         *
         * 修法：优先用 dim 表的源值，源值缺失时**回落到本次查询已经算出的
         * variant_cnt**（该活动下有曝光的去重变体数）—— 同一个 SELECT 里
         * 已经 COUNT(DISTINCT e.variant_asin) 了，不必另建表或回填。
         * 两者口径略有差别（variant_cnt 只统计「本组变体」中有曝光的），
         * 所以用 asinNumSource 标出来，前端可据此决定是否加「≥」前缀。
         *
         * 都没有时给 null 而不是 0，让前端显示「—」。
         */
        asinNum:
          r.asin_num !== null && r.asin_num !== undefined
            ? Number(r.asin_num)
            : r.variant_cnt !== null && r.variant_cnt !== undefined
              ? Number(r.variant_cnt)
              : null,
        /** 'source' = 源给的准确值；'derived' = 由本组曝光变体数推算（可能偏小） */
        asinNumSource:
          r.asin_num !== null && r.asin_num !== undefined ? 'source' : 'derived',
        adNum: r.ad_num === null || r.ad_num === undefined ? null : Number(r.ad_num),
        // 该活动下有曝光的投放小组数
        involvedAdNum: Number(r.involved_ad_num ?? 0),
        // 该活动为本变体组带来多少个买家搜索词
        keywordCnt: Number(r.keyword_cnt ?? 0),
        // 该活动覆盖了组内多少个变体
        variantCnt: Number(r.variant_cnt ?? 0),
        totalScore: r.total_score === null ? 0 : Number(r.total_score),
        campaignCreatedAt: fmtDate(r.campaign_created_at),
        lastAdCreatedAt: fmtDate(r.last_ad_created_at),
      })),
    }
  }

  /**
   * 把输入的 ASIN 解析成要统计的 ASIN 集合。
   *
   * 广告投放在**子体**维度上（曝光表的 variant_asin 是子体），
   * 但用户常输入父体想看整组的投放全貌。
   * 传父体就展开成该组全部子体，传子体就只返回它自己。
   *
   * 与 insights.service.ts 的同名方法口径一致。
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
      // 变体关系表里父体自己也可能作为在售变体出现，去重后返回
      const list = children.map((c: any) => c.child_asin)
      return list.length ? [...new Set(list)] : [asin]
    }
    return [asin]
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

    /**
     * 按**变体组**查，不是单个 ASIN。
     *
     * 曝光表的 variant_asin 是子体 —— 广告投在子体上。用户查父体时
     * 只匹配父体自己会漏掉绝大部分广告词（实测该组 11 个变体都有投放，
     * 只看父体会从 737 个词掉到 100 个左右）。
     */
    const asins = await this.resolveAsinScope(asin, country)
    if (!asins.length) {
      return { asin, country, items: [], nextCursor: null, hasMore: false }
    }

    const where = [
      `e.variant_asin IN (${asins.map(() => '?').join(', ')})`,
      'e.country = ?',
    ]
    const params: any[] = [...asins, country]

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
   e.rank_position, e.stat_date, e.variant_asin, c.name_cn AS traffic_name
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
        // 投放这个词的是哪个变体 —— 查父体时组内多个子体都可能在投同一个词
        variantAsin: r.variant_asin,
 statDate: fmtDate(r.stat_date),
      })),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    }
  }
}

import { Injectable } from '@nestjs/common'
import { DorisService } from '../database/doris.service'
import { buildPage, decodeCursor, normalizeLimit } from '../common/cursor'
import type {
  AcosEstimateQueryDto,
  BidEstimateQueryDto,
  WordPickQueryDto,
} from './dto/query.dto'

/**
 * M13 选词 / 关键词竞争分析（4 个页面）
 *
 * 对应原站：
 *   /conversion-rate   关键词转化率      → fact_keyword_conversion_funnel
 *   /amount            流量位竞品数量    → fact_keyword_metric_snapshot 的 *_asin_num 列
 *   /compete           流量位竞争格局    → fact_keyword_competition_snapshot + rel_keyword_top_asin
 *   /cpc-browsetree    查关键词竞价      → fact_keyword_bid_estimate（无源，seed）
 *
 * ## 数据源与就绪度（2026-09-21 五轮 sif 页面审计后修订）
 *
 * ⚠️ 本节推翻了 M13_PROBE_FINDINGS 的「4 页全是真实数据」结论。
 * 探源阶段发现 web-keyword-conversion 带着 ACOS/CPA 的三档预估，曾据此判定
 * 「查关键词竞价」有源。审计实测发现那是**两个不同指标**：
 *
 *   | | ACOS/CPA（本表有） | 建议竞价（原站 /cpc-browsetree 真正展示的） |
 *   |---|---|---|
 *   | 维度 | 关键词×周×匹配×策略 | 关键词×**类目**×匹配×策略×月 |
 *   | 三档方向 | ACOS 递减、CPA 递增 | 递增 |
 *   | 源 endpoint | web-keyword-conversion ✅ 已爬 | search/cpc/category ❌ 未爬 |
 *
 * 所以就绪度是 **3 页真实 + 1 页 seed**：
 *   /conversion-rate  真实（fact_keyword_conversion_funnel 5,875 行）
 *   /amount           真实（fact_keyword_metric_snapshot，但竞品数量列只 318 行）
 *   /compete          待探（源 competePattern 是否有 PG 日志未确认，无则 seed）
 *   /cpc-browsetree   **seed**（fact_keyword_bid_estimate 无真实源）
 *
 * ACOS/CPA 数据没白爬 —— /conversion-rate 页要用它算 ACOS（见下方第 3 条）。
 *
 * ## 三个必须知道的数据口径
 *
 * 1. **竞品数量列的时间语义与同表其他列不同**。
 *    源 web-compete-keyword 的响应里没有周维度，只能按词匹配最新周行，
 *    所以 nf_asin_num 等 10 列是「最近一次抓取的竞品格局」，
 *    而 est_searches_num 等列是「该 ABA 周的」。前端展示时不要混着说成同一周。
 *    填充率：318/22,320 词（compete 源只覆盖 789 词，与 metric 表交集 318）。
 *
 * 2. **ACOS/CPA 的 start/median/end 不是区间端点**，是悲观/中位/乐观三档。
 *    Doris 实测 33,019/33,019 行满足 start > median > end，单调性 100%。
 *    直接按 "start-end" 当区间渲染会把大小关系画反。
 *    ⚠️ CPA 的方向**相反**（递增，0.45→0.58→0.71），两者不要共用渲染逻辑。
 *    ⚠️ 不是每词都有 6 种匹配×策略组合：实测 5,118 词齐全、409 词只有 auto、
 *    362 词只有 legacy。按 2×3 矩阵渲染要容忍整行缺失。
 *
 * 3. **ACOS 不该由后端算**。审计实测 /conversion-rate 页的 ACOS 三档是
 *    **前端按用户填的「自定义毛利率」实时算**的，页面上那个输入框是必填项。
 *    所以 service 返回 cpa_* 与价格带即可，acos_* 只作默认毛利率下的参考值，
 *    前端拿到 CPA 和用户毛利率自行计算。不要把 acos 当成唯一事实来源。
 *
 * ⚠️ 关联键一律用 (keyword, country)，不用 keyword_id ——
 * 后者跨站点不唯一且大量为空，见 keywords.service.ts 的说明。
 */
@Injectable()
export class WordPickService {
  constructor(private readonly db: DorisService) {}

  /**
   * 取某表某站点的最新 ABA 周。
   *
   * 各表的周列名不同（funnel 用 stat_week，metric 用 stat_date），
   * 所以列名作为参数传入 —— 但**必须是调用方硬编码的字面量，不可来自请求**，
   * 这里不做转义。
   */
  private async latestWeek(
    table:
      | 'fact_keyword_conversion_funnel'
      | 'fact_keyword_acos_estimate'
      | 'fact_keyword_metric_snapshot',
    weekCol: 'stat_week' | 'stat_date',
    country: string,
    keyword?: string,
  ): Promise<string | null> {
    // ⚠️ 传了 keyword 就取**该词的**最新周，不是全库最新周。
    //
    // 各词的数据周次很不齐 —— ACOS 表 5,849 个词分布在 6 个周里，
    // 21,369/33,019 行集中在最后一周，但像 yoga mat 这种词只在
    // 2026-08-16 有数据。按全库最新周过滤会让这些词查出来是空的，
    // 用户会以为没数据，实际是周次对不上。
    const row = await this.db.queryOne<any>(
      `SELECT MAX(${weekCol}) AS w FROM ${table}
        WHERE country = ?${keyword ? ' AND keyword = ?' : ''}`,
      keyword ? [country, keyword] : [country],
    )
    if (!row?.w) return null
    // Doris 的 DATE 经 mysql2 变成 JS Date，按 UTC 取日期部分。
    // 不能用 toLocaleDateString —— 会按本地时区偏移一天。
    return row.w instanceof Date ? row.w.toISOString().slice(0, 10) : String(row.w)
  }

  // ====================================================================
  // 1. 关键词转化率 —— /conversion-rate
  // ====================================================================

  /**
   * ABA 转化漏斗：搜索量 → 点击量 → 购买量，外加份额与价格带。
   *
   * 排序默认按搜索量降序（选词场景先看大词）。
   */
  async listConversion(dto: WordPickQueryDto) {
    const country = dto.country ?? 'US'
    const week =
      dto.statWeek ??
      (await this.latestWeek(
        'fact_keyword_conversion_funnel',
        'stat_week',
        country,
        dto.keyword,
      ))
    const limit = normalizeLimit(dto.limit)
    const desc = (dto.order ?? 'desc') === 'desc'

    // 排序字段白名单。key 是对外的参数值，value 是真实列名 —— 不拼用户输入
    const SORT_COLUMNS: Record<string, string> = {
      searchVolume: 'search_volume',
      clickVolume: 'click_volume',
      purchaseVolume: 'purchase_volume',
      searchClickRatio: 'search_click_ratio',
      searchPurchaseRatio: 'search_purchase_ratio',
      clickPurchaseRatio: 'click_purchase_ratio',
      conversionShared: 'conversion_shared',
      avgKwPrice: 'avg_kw_price',
    }
    const sortCol = SORT_COLUMNS[dto.sortBy ?? 'searchVolume'] ?? 'search_volume'

    const where: string[] = ['country = ?']
    const params: any[] = [country]
    if (week) {
      where.push('stat_week = ?')
      params.push(week)
    }
    if (dto.keyword) {
      // 精确匹配：DTO 已把输入 trim+lower，与 ETL 的 btrim(lower()) 归一一致
      where.push('keyword = ?')
      params.push(dto.keyword)
    }

    // 游标：(排序值, keyword)。tie-break 用 keyword 文本，它是主键成员且非空
    const cur = decodeCursor(dto.cursor)
    if (cur && cur.length === 2) {
      const op = desc ? '<' : '>'
      where.push(`(${sortCol} ${op} ? OR (${sortCol} = ? AND keyword ${op} ?))`)
      params.push(cur[0], cur[0], cur[1])
    }

    const dir = desc ? 'DESC' : 'ASC'
    const rows = await this.db.query<any>(
      `SELECT keyword, country, stat_week, search_volume, click_volume,
              purchase_volume, search_click_ratio, search_purchase_ratio,
              click_purchase_ratio, click_shared, conversion_shared,
              avg_kw_price, max_kw_price, min_kw_price, source
         FROM fact_keyword_conversion_funnel
        WHERE ${where.join(' AND ')}
        ORDER BY ${sortCol} ${dir}, keyword ${dir}
        LIMIT ${limit + 1}`,
      params,
    )

    const page = buildPage(rows, limit, (last: any) => [
      Number(last[sortCol] ?? 0),
      String(last.keyword),
    ])

    return {
      country,
      statWeek: week,
      items: page.items.map((r: any) => ({
        keyword: r.keyword,
        statWeek: fmtWeek(r.stat_week),
        searchVolume: numOrNull(r.search_volume),
        clickVolume: numOrNull(r.click_volume),
        purchaseVolume: numOrNull(r.purchase_volume),
        searchClickRatio: numOrNull(r.search_click_ratio),
        searchPurchaseRatio: numOrNull(r.search_purchase_ratio),
        clickPurchaseRatio: numOrNull(r.click_purchase_ratio),
        clickShared: numOrNull(r.click_shared),
        // 实测 81.5% 填充，是本表唯一非 100% 的度量。前端要能显示「—」
        conversionShared: numOrNull(r.conversion_shared),
        avgKwPrice: numOrNull(r.avg_kw_price),
        maxKwPrice: numOrNull(r.max_kw_price),
        minKwPrice: numOrNull(r.min_kw_price),
        source: r.source,
      })),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    }
  }

  // ====================================================================
  // 2. 流量位竞品数量 —— /amount
  // ====================================================================

  /**
   * 该关键词下各流量位有多少个竞品 ASIN 在占位。
   *
   * ## ⚠️ 本页有两种时间语义混在一行，前端不要说成同一周
   *
   * 竞品数量那 8 列（`nf_asin_num` 等）来自 `web-compete-keyword`，
   * 源响应**没有周维度**，只能按词匹配最新周行 —— 语义是
   * 「最近一次抓取的竞品格局」。而 `est_searches_num` / `searches_rank`
   * 来自 `sif_keyword_overview`，是**该 ABA 周的**。
   *
   * 落表填充率也因此很低：22,320 行里只有 318 行有竞品数量
   * （compete 源只覆盖 789 词，与本表词级交集 318）。
   * 所以 `hasCompeteData` 标志位要返回给前端，让它知道该显示「—」还是 0。
   *
   * ## 页面把两个字段合并成一列显示
   *
   * `clickShared` / `conversionShared` 是「ABA Top3 集中度」（不是份额），
   * 页面渲染成一列「点击 8.6% / 转化 3.9%」。这里分开返回，前端自己拼。
   */
  async listAmount(dto: WordPickQueryDto) {
    const country = dto.country ?? 'US'
    const week =
      dto.statWeek ??
      (await this.latestWeek(
        'fact_keyword_metric_snapshot',
        'stat_date',
        country,
        dto.keyword,
      ))
    const limit = normalizeLimit(dto.limit)
    const desc = (dto.order ?? 'desc') === 'desc'

    const SORT_COLUMNS: Record<string, string> = {
      estSearchesNum: 'est_searches_num',
      searchesRank: 'searches_rank',
      saleNum: 'sale_num',
      nfAsinNum: 'nf_asin_num',
      ppcAsinNum: 'ppc_asin_num',
      clickShared: 'click_shared',
      conversionShared: 'conversion_shared',
    }
    const sortCol = SORT_COLUMNS[dto.sortBy ?? 'estSearchesNum'] ?? 'est_searches_num'

    // granularity 恒为 week（实测 22,320 行全是），但仍显式过滤 ——
    // 将来若灌入 month 粒度，不加这个条件会把两种粒度混在一页
    const where: string[] = ['country = ?', "granularity = 'week'"]
    const params: any[] = [country]
    if (week) {
      where.push('stat_date = ?')
      params.push(week)
    }
    if (dto.keyword) {
      where.push('keyword = ?')
      params.push(dto.keyword)
    }
    // 只看有竞品数据的词（默认关，因为 318/22,320 的过滤太狠，
    // 默认开会让用户以为库里只有 318 个词）
    if (dto.onlyWithCompete) {
      where.push('nf_asin_num IS NOT NULL')
    }

    // 游标 tie-break 用 keyword：它是主键成员且非空。
    // 排序列可能为 NULL（竞品数量列 98.6% 是 NULL），NULL 在 Doris 的
    // DESC 排序里排最后，游标比较时会把 NULL 行整批跳过 —— 这是可接受的：
    // 按竞品数量排序时用户本来就只关心有数据的行。
    const cur = decodeCursor(dto.cursor)
    if (cur && cur.length === 2) {
      const op = desc ? '<' : '>'
      where.push(`(${sortCol} ${op} ? OR (${sortCol} = ? AND keyword ${op} ?))`)
      params.push(cur[0], cur[0], cur[1])
    }

    const dir = desc ? 'DESC' : 'ASC'
    const rows = await this.db.query<any>(
      `SELECT keyword, country, stat_date, est_searches_num, searches_rank,
              sale_num, nf_asin_num, ppc_asin_num, sp_asin_num,
              sp_recommended_asin_num, recommended_asin_num, brand_asin_num,
              video_asin_num, ac_asin_num, click_shared, conversion_shared
         FROM fact_keyword_metric_snapshot
        WHERE ${where.join(' AND ')}
        ORDER BY ${sortCol} ${dir}, keyword ${dir}
        LIMIT ${limit + 1}`,
      params,
    )

    const page = buildPage(rows, limit, (last: any) => [
      Number(last[sortCol] ?? 0),
      String(last.keyword),
    ])

    return {
      country,
      statWeek: week,
      items: page.items.map((r: any) => ({
        keyword: r.keyword,
        statWeek: fmtWeek(r.stat_date),
        estSearchesNum: numOrNull(r.est_searches_num),
        searchesRank: numOrNull(r.searches_rank),
        // ⚠️ 语义是「在售产品数」不是销量（审计 §3 纠正）
        activeListingNum: numOrNull(r.sale_num),
        nfAsinNum: numOrNull(r.nf_asin_num),
        ppcAsinNum: numOrNull(r.ppc_asin_num),
        spAsinNum: numOrNull(r.sp_asin_num),
        spRecommendedAsinNum: numOrNull(r.sp_recommended_asin_num),
        recommendedAsinNum: numOrNull(r.recommended_asin_num),
        brandAsinNum: numOrNull(r.brand_asin_num),
        videoAsinNum: numOrNull(r.video_asin_num),
        // ⚠️ 实测 318 行全为 0（AC 是稀缺标）。前端要显示 0 而非空白，
        // 靠 hasCompeteData 区分「没有 AC 竞品」和「没查到数据」
        acAsinNum: numOrNull(r.ac_asin_num),
        // 页面合并成一列「点击 x% / 转化 y%」
        top3ClickShare: numOrNull(r.click_shared),
        top3ConversionShare: numOrNull(r.conversion_shared),
        /** 竞品数量列是否有数据。false 时前端应显示「—」不是 0 */
        hasCompeteData: r.nf_asin_num !== null && r.nf_asin_num !== undefined,
      })),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    }
  }

  // ====================================================================
  // 3. 流量位竞争格局 —— /compete
  // ====================================================================

  /**
   * 该关键词下有哪些 ASIN 在占位、各占哪类流量位多少份额。
   *
   * ## 这页是「ASIN 列表」不是「关键词度量」
   *
   * 原以为是关键词级的竞品数量统计（那是 /amount），实测是
   * **ASIN × 流量位份额矩阵** —— 谁在占哪类流量位。默认按自然份额降序。
   *
   * ## keyword 必填
   *
   * 与其他三页不同，本页**不支持不传 keyword 的榜单模式**：
   * 表的粒度是 (关键词, ASIN)，不传词会跨词混排，份额之间没有可比性。
   *
   * ## 覆盖面很窄，要如实告知
   *
   * 源 `web-compete-pattern` 只有 9 个词有数据（1,351 行）。
   * 查不到时返回空列表 + `dataScope` 说明，不要静默返回空让用户以为是 bug。
   *
   * ## ASIN 属性是冗余存的，不 JOIN dim_asin
   *
   * 实测这批 ASIN 有 75% 不在 `dim_asin` 里（1,142 个里缺 859 个），
   * JOIN 取属性会让四分之三的行没有图片，而图片列是这页的核心。
   */
  async listCompetePattern(dto: WordPickQueryDto) {
    const country = dto.country ?? 'US'
    const limit = normalizeLimit(dto.limit)
    const desc = (dto.order ?? 'desc') === 'desc'

    if (!dto.keyword) {
      // 不抛异常 —— 前端首次进页面还没选词时也会调这个接口
      return {
        country,
        keyword: null,
        items: [],
        nextCursor: null,
        hasMore: false,
        dataScope: '请输入关键词。本页按词查该词下的竞品占位情况。',
      }
    }

    const SORT_COLUMNS: Record<string, string> = {
      nfScoreRatio: 'nf_score_ratio',
      spScoreRatio: 'sp_score_ratio',
      spRecScoreRatio: 'sp_rec_score_ratio',
      brandAdScoreRatio: 'brand_ad_score_ratio',
      videoAdScoreRatio: 'video_ad_score_ratio',
      acScoreRatio: 'ac_score_ratio',
      price: 'price',
      ratingNum: 'rating_num',
      score: 'score',
    }
    // 默认按自然份额降序（原站页面说明「默认以自然流量份额排序」）
    const sortCol = SORT_COLUMNS[dto.sortBy ?? 'nfScoreRatio'] ?? 'nf_score_ratio'

    const where: string[] = ['keyword = ?', 'country = ?']
    const params: any[] = [dto.keyword, country]

    // tie-break 用 asin：它是主键成员且非空
    const cur = decodeCursor(dto.cursor)
    if (cur && cur.length === 2) {
      const op = desc ? '<' : '>'
      where.push(`(${sortCol} ${op} ? OR (${sortCol} = ? AND asin ${op} ?))`)
      params.push(cur[0], cur[0], cur[1])
    }

    const dir = desc ? 'DESC' : 'ASC'
    const rows = await this.db.query<any>(
      `SELECT keyword, country, asin, rank_position, title, img, price,
              rating_num, star, score, bought_in_past_month,
              nf_score_ratio, sp_score_ratio, sp_rec_score_ratio,
              brand_ad_score_ratio, video_ad_score_ratio, ac_score_ratio,
              has_variants, ac, stat_date, source
         FROM rel_keyword_asin_traffic_share
        WHERE ${where.join(' AND ')}
        ORDER BY ${sortCol} ${dir}, asin ${dir}
        LIMIT ${limit + 1}`,
      params,
    )

    const page = buildPage(rows, limit, (last: any) => [
      Number(last[sortCol] ?? 0),
      String(last.asin),
    ])

    return {
      country,
      keyword: dto.keyword,
      items: page.items.map((r: any) => ({
        asin: r.asin,
        rankPosition: numOrNull(r.rank_position),
        title: r.title,
        img: r.img,
        price: numOrNull(r.price),
        ratingNum: numOrNull(r.rating_num),
        star: numOrNull(r.star),
        score: numOrNull(r.score),
        // ⚠️ 分档字符串如「6,000+」，不是数值，前端不要当数字算
        boughtInPastMonth: r.bought_in_past_month,
        // 页面 6 个流量位列
        nfScoreRatio: numOrNull(r.nf_score_ratio),
        spScoreRatio: numOrNull(r.sp_score_ratio),
        spRecScoreRatio: numOrNull(r.sp_rec_score_ratio),
        brandAdScoreRatio: numOrNull(r.brand_ad_score_ratio),
        videoAdScoreRatio: numOrNull(r.video_ad_score_ratio),
        // 实测 26/1,351 行非零，有真实区分度（与 metric 表的 ac_asin_num 恒 0 不同）
        acScoreRatio: numOrNull(r.ac_score_ratio),
        hasVariants: r.has_variants === null ? null : Boolean(r.has_variants),
        ac: r.ac,
        // ⚠️ 抓取日不是数据周：源响应无周维度
        fetchedDate: fmtWeek(r.stat_date),
        source: r.source,
      })),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      // er_score_ratio / tr_score_ratio 实测全为 0，不返回（页面表头也没这两列）
      dataScope:
        page.items.length === 0
          ? `「${dto.keyword}」暂无竞争格局数据。该数据源当前仅覆盖少量关键词。`
          : '份额为最近一次抓取的快照（源无周维度），默认按自然流量份额降序。',
    }
  }

  // ====================================================================
  // 4. ACOS / CPA 三档预估 —— /conversion-rate 页的两列
  // ====================================================================

  /**
   * 某词在各匹配方式 × 投放策略下的 ACOS / CPA 三档预估。
   *
   * ## ⚠️ ACOS 该由前端按用户的毛利率算，本方法返回的是参考值
   *
   * 审计实测 `/conversion-rate` 页的「ACOS[自定义毛利率]」列是
   * **前端按用户填的毛利率实时算**的，那个输入框是必填项。
   * 所以：
   *   - `cpa*` 三列是计算基础，前端必须用它
   *   - `acos*` 三列是**源侧给的默认毛利率下的参考值**，不是唯一事实
   * 前端不要直接把 acos 当结论显示，要么让用户填毛利率后自己算，
   * 要么明确标注「按默认毛利率估算」。
   *
   * ## 两组列方向相反，别共用渲染逻辑
   *
   *     ACOS  start > median > end   递减（实测 33,019 行 100% 满足）
   *     CPA   start < median < end   递增
   * 统一按「start 是上界」渲染会把 CPA 画反。
   *
   * ## 不是每词都有 6 种组合
   *
   * 实测 5,118 词齐全、409 词只有 auto、362 词只有 legacy。
   * 按 2×3 矩阵渲染要容忍整行缺失。
   */
  async listAcosEstimate(dto: AcosEstimateQueryDto) {
    const country = dto.country ?? 'US'
    const week =
      dto.statWeek ??
      (await this.latestWeek(
        'fact_keyword_acos_estimate',
        'stat_week',
        country,
        dto.keyword,
      ))
    const limit = normalizeLimit(dto.limit)
    const desc = (dto.order ?? 'desc') === 'desc'

    const SORT_COLUMNS: Record<string, string> = {
      acosMedian: 'acos_median',
      cpaMedian: 'cpa_median',
      keyword: 'keyword',
    }
    const sortCol = SORT_COLUMNS[dto.sortBy ?? 'acosMedian'] ?? 'acos_median'

    const where: string[] = ['country = ?']
    const params: any[] = [country]
    if (week) {
      where.push('stat_week = ?')
      params.push(week)
    }
    if (dto.keyword) {
      where.push('keyword = ?')
      params.push(dto.keyword)
    }
    // 两维各自可选，不传则返回该词全部组合
    if (dto.matchType) {
      where.push('match_type = ?')
      params.push(dto.matchType)
    }
    if (dto.bidStrategy) {
      where.push('bid_strategy = ?')
      params.push(dto.bidStrategy)
    }

    // 游标 tie-break 要用**全部主键剩余成员**：主键是
    // (keyword, country, stat_week, match_type, bid_strategy)，
    // 单用 keyword 会在同词多组合时漏行（同词 6 行的 keyword 相同）。
    // 这里用 keyword + match_type + bid_strategy 三元组保证唯一。
    const cur = decodeCursor(dto.cursor)
    if (cur && cur.length === 4) {
      const op = desc ? '<' : '>'
      where.push(
        `(${sortCol} ${op} ? OR (${sortCol} = ? AND ` +
          `CONCAT(keyword, '|', match_type, '|', bid_strategy) ${op} ?))`,
      )
      params.push(cur[0], cur[0], `${cur[1]}|${cur[2]}|${cur[3]}`)
    }

    const dir = desc ? 'DESC' : 'ASC'
    const rows = await this.db.query<any>(
      `SELECT keyword, country, stat_week, match_type, bid_strategy,
              acos_start, acos_median, acos_end,
              cpa_start, cpa_median, cpa_end
         FROM fact_keyword_acos_estimate
        WHERE ${where.join(' AND ')}
        ORDER BY ${sortCol} ${dir},
                 CONCAT(keyword, '|', match_type, '|', bid_strategy) ${dir}
        LIMIT ${limit + 1}`,
      params,
    )

    const page = buildPage(rows, limit, (last: any) => [
      Number(last[sortCol] ?? 0),
      String(last.keyword),
      String(last.match_type),
      String(last.bid_strategy),
    ])

    return {
      country,
      statWeek: week,
      items: page.items.map((r: any) => ({
        keyword: r.keyword,
        statWeek: fmtWeek(r.stat_week),
        matchType: r.match_type,
        bidStrategy: r.bid_strategy,
        /** 页面 UI 文案：auto=「提升与降低」legacy=「仅降低/固定」 */
        bidStrategyLabel: BID_STRATEGY_LABELS[r.bid_strategy] ?? r.bid_strategy,
        // ⚠️ 递减：start 是悲观档（值最大）
        acosStart: numOrNull(r.acos_start),
        acosMedian: numOrNull(r.acos_median),
        acosEnd: numOrNull(r.acos_end),
        // ⚠️ 递增：与 ACOS 方向相反
        cpaStart: numOrNull(r.cpa_start),
        cpaMedian: numOrNull(r.cpa_median),
        cpaEnd: numOrNull(r.cpa_end),
      })),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      dataScope:
        'ACOS 为源侧默认毛利率下的参考值 —— 页面应让用户填自定义毛利率后' +
        '基于 CPA 实时计算。ACOS 三档递减、CPA 三档递增，方向相反。',
    }
  }

  // ====================================================================
  // 5. 建议竞价 —— /cpc-browsetree
  // ====================================================================

  /**
   * 某词在各类目 × 匹配方式 × 投放策略下的建议竞价三档。
   *
   * ## ⚠️ 本页数据是 seed，前端必须显示「模拟数据」标记
   *
   * 源 `search/cpc/category` 不在爬虫覆盖的 41 个 endpoint 里，
   * 本期数据由 `db/gen-seed-unbuilt.mjs` 生成（`source='seed'`）。
   * 关键词挂的是真实词（竞价页按词查，挂假词会让用户查真词全空白），
   * 但**类目和竞价数值是造的**。
   *
   * ## 类目是核心维度，不是可选筛选项
   *
   * 原站页面说明第 1 条：「建议竞价与产品无关，**与品类强相关**，
   * 与产品的权重没有关系」。所以同一个词在不同类目下竞价差异很大，
   * 不带类目看竞价数字没有意义 —— 前端要按类目分组渲染。
   *
   * ## 三档递增，与 ACOS 相反
   *
   * 实测样例 0.37 → 0.49 → 0.61。这是区间的低/中/高档，
   * 与 ACOS 的「悲观/中位/乐观」语义不同，不要共用渲染组件。
   *
   * ## 时间粒度是月不是周
   *
   * 官方口径第 4 条：「以周 ABA 为数据源，**每月更新一次**竞价数据」。
   */
  async listBidEstimate(dto: BidEstimateQueryDto) {
    const country = dto.country ?? 'US'
    const limit = normalizeLimit(dto.limit)
    const desc = (dto.order ?? 'desc') === 'desc'

    // 月份用 VARCHAR(7) 存，MAX() 的字典序与时间序一致（YYYY-MM 定长）。
    //
    // 传了 keyword 就按该词取最新月 —— 与本文件 latestWeek 同一个理由：
    // 各词的数据周期不齐时，按全库最新月过滤会把「上月有数据」
    // 误判成「无数据」。当前 seed 的 200 个词月份恰好齐（统一生成），
    // 但真实数据接入后不会这么整齐。
    const monthRow = await this.db.queryOne<any>(
      `SELECT MAX(stat_month) AS m FROM fact_keyword_bid_estimate
        WHERE country = ?${dto.keyword ? ' AND keyword = ?' : ''}`,
      dto.keyword ? [country, dto.keyword] : [country],
    )
    const month = dto.statMonth ?? monthRow?.m ?? null

    const SORT_COLUMNS: Record<string, string> = {
      bidMedian: 'bid_median',
      bidStart: 'bid_start',
      categorySaleNum: 'category_sale_num',
    }
    const sortCol = SORT_COLUMNS[dto.sortBy ?? 'bidMedian'] ?? 'bid_median'

    const where: string[] = ['country = ?']
    const params: any[] = [country]
    if (month) {
      where.push('stat_month = ?')
      params.push(month)
    }
    if (dto.keyword) {
      where.push('keyword = ?')
      params.push(dto.keyword)
    }
    if (dto.categoryId) {
      where.push('category_id = ?')
      params.push(dto.categoryId)
    }
    if (dto.matchType) {
      where.push('match_type = ?')
      params.push(dto.matchType)
    }
    if (dto.bidStrategy) {
      where.push('bid_strategy = ?')
      params.push(dto.bidStrategy)
    }

    // 主键五元组（除 country/stat_month 已固定）：
    // keyword + category_id + match_type + bid_strategy
    const tie = `CONCAT(keyword, '|', category_id, '|', match_type, '|', bid_strategy)`
    const cur = decodeCursor(dto.cursor)
    if (cur && cur.length === 2) {
      const op = desc ? '<' : '>'
      where.push(`(${sortCol} ${op} ? OR (${sortCol} = ? AND ${tie} ${op} ?))`)
      params.push(cur[0], cur[0], cur[1])
    }

    const dir = desc ? 'DESC' : 'ASC'
    const rows = await this.db.query<any>(
      `SELECT keyword, country, category_id, category_name, category_href,
              category_sale_num, match_type, bid_strategy, stat_month,
              bid_start, bid_median, bid_end, source,
              ${tie} AS tie_key
         FROM fact_keyword_bid_estimate
        WHERE ${where.join(' AND ')}
        ORDER BY ${sortCol} ${dir}, ${tie} ${dir}
        LIMIT ${limit + 1}`,
      params,
    )

    const page = buildPage(rows, limit, (last: any) => [
      Number(last[sortCol] ?? 0),
      String(last.tie_key),
    ])

    const items = page.items.map((r: any) => ({
      keyword: r.keyword,
      categoryId: r.category_id,
      categoryName: r.category_name,
      categoryHref: r.category_href,
      categorySaleNum: numOrNull(r.category_sale_num),
      matchType: r.match_type,
      bidStrategy: r.bid_strategy,
      bidStrategyLabel: BID_STRATEGY_LABELS[r.bid_strategy] ?? r.bid_strategy,
      statMonth: r.stat_month,
      // ⚠️ 递增：低/中/高档
      bidStart: numOrNull(r.bid_start),
      bidMedian: numOrNull(r.bid_median),
      bidEnd: numOrNull(r.bid_end),
      source: r.source,
    }))

    return {
      country,
      statMonth: month,
      items,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      /** 本页数据全部为模拟。前端必须显示「模拟数据」标记 */
      isSeed: items.length > 0 && items.every((i) => i.source === 'seed'),
      dataScope:
        '⚠️ 建议竞价为模拟数据（真实源未接入）。竞价与品类强相关、与产品无关，' +
        '请按类目分组查看；三档为低/中/高，每月更新一次。',
    }
  }
}

/** 投放策略的页面文案。库里存源键名，展示用中文（审计 §4 页面说明第 3 条） */
const BID_STRATEGY_LABELS: Record<string, string> = {
  auto: '提升与降低',
  legacy: '仅降低/固定',
}

/** DATE 列转 YYYY-MM-DD。mysql2 给的是 Date 对象，按 UTC 取，不能用本地时区 API */
function fmtWeek(v: any): string | null {
  if (v === null || v === undefined) return null
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v)
}

/** DECIMAL/BIGINT 转 number，NULL 保持 NULL（不要变成 0，会让「无数据」看起来像「零」） */
function numOrNull(v: any): number | null {
  return v === null || v === undefined ? null : Number(v)
}

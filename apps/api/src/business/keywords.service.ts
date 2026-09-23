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

    /**
     * 按**变体组**查，不是单个 ASIN。
     *
     * 实测该组 16 个变体各有自己的头部词（尺寸词完全不同：
     * 父体是 `18x18 pillow inserts`，子体是 `22x22 pillow insert` /
     * `12x12 pillow` / `26x26 pillow inserts` …），合并后 60 行 / 50 个去重词。
     * 只查父体只会返回 4 个词，漏掉 46 个 —— 用户会以为这组只有 4 个流量词。
     */
    const asins = await this.resolveAsinScope(dto.asin, country)
    if (!asins.length) {
      return {
        asin: dto.asin, country, timePieceValue: month,
        items: [], nextCursor: null, hasMore: false,
      }
    }

    /**
     * 组内各变体的权重 = 该变体「全部流量词的总得分」，即 listing_score_ratio 的分母。
     *
     * ⚠️ 这个分母**不能用 fact_asin_traffic_channel 的 total 得分代替**，两者不是同一个量。
     *   实测 B01NBNDC1T 2026-08：
     *     traffic_channel total        = 46,334.5
     *     keyword_score 已存词合计      = 145,330.7
     *     listing_score_ratio 的真实分母 = 372,061.8   ← 三者互不相等
     *
     *   真实分母只能**反解**出来：同一 ASIN 内 `score / listing_score_ratio` 对
     *   每个词都得到同一个常数（实测三个 ASIN 分别稳定在 372,061.8 / 124,754.1 /
     *   53,259.3，逐词误差在浮点精度内），说明源侧确实用的是 Listing 全量词总分。
     *
     *   之所以比「已存词合计」大，是因为我们只落了各变体的**头部 4 个词**
     *   （实测 listing_score_ratio 合计只有 0.39 / 0.38 / 0.56，即覆盖了
     *   38%~56% 的流量）。用已存词合计做分母会把占比系统性放大约 2 倍。
     *
     * 所以这里反解分母：取该变体任一词的 score / ratio。用 MAX 而非 AVG ——
     * 挑得分最高的那个词反解，相对误差最小（分母相同时分子越大、除法的相对精度越高）。
     */
    const weightRows = await this.db.query<any>(
      `SELECT s.asin, MAX(sc.score / s.listing_score_ratio) AS w
         FROM fact_asin_keyword_snapshot s
         JOIN fact_asin_keyword_score sc
           ON sc.asin = s.asin AND sc.keyword = s.keyword AND sc.country = s.country
          AND sc.time_piece_type = s.time_piece_type
          AND sc.time_piece_value = s.time_piece_value
          AND sc.channel = 'total'
        WHERE s.country = ? AND s.time_piece_type = 'month'
          AND s.time_piece_value = ?
          AND s.listing_score_ratio > 0
          AND s.asin IN (${asins.map(() => '?').join(', ')})
        GROUP BY s.asin`,
      [country, month, ...asins],
    )
    const weightOf = new Map<string, number>(
      weightRows.map((r: any) => [String(r.asin), Number(r.w ?? 0)]),
    )
    /**
     * 分母 = 有权重的变体的权重和（常数，与词无关）。
     * ⚠️ 只累加**反解成功**的变体：某变体一个词都没落（或 ratio 全为 0）时
     * 它的词也不会出现在结果里，把它计入分母只会无端压低所有占比。
     */
    const totalWeight = [...weightOf.values()].reduce((acc, w) => acc + w, 0)

    /**
     * 排序字段白名单。
     *
     * 值都是**聚合表达式**而不是裸列 —— 因为下面按 keyword 分组：
     * 同一个词可能被组内多个变体同时占位（实测 `pillow inserts` 有 5 个变体、
     * `throw pillows` 有 4 个），分组后要合并成一个词一行。
     * 排名取 MIN（最好的名次）。
     *
     * ⚠️ 占比**不能 SUM**（这是本次修的 Bug）。
     *
     * `listing_score_ratio` 的语义是「该词占**该变体自己**总流量的比例」，
     * 分母是各变体各自的总流量。直接 `SUM(listing_score_ratio)` 相当于
     * 把 10 个不同分母的分数当同分母相加 —— 实测父体 B01NBNDC1T 的
     * top20 合计 664%，首行 `pillow inserts` 显示 56.755%，页面上没法解释。
     * （旧注释说「合并成整组视角时要相加才是总占比」，那是错的，已改掉。）
     *
     * 正确做法：先把占比**还原成绝对得分**再聚合，最后除以组总得分：
     *
     *   ratio_A = score_词,A / w_A     （w_A = 变体 A 的总流量得分）
     *   → ratio_A × w_A = score_词,A   （还原回绝对得分）
     *   → Σ_A(ratio_A × w_A) / Σ_A(w_A) = 该词总得分 / 组总得分
     *
     * 这不是近似，是恒等变形 —— 结果就是该词占整组流量的真实占比，
     * 所有词合计 ≤ 1.0。
     *
     * 这里的表达式只算**分子**（加权和），除以 totalWeight 放在 JS 里做：
     * 分母是正的常数，不影响排序，而把它留在 SQL 外面可以避免
     * 往 ORDER BY / HAVING 里插浮点字面量。
     * ⚠️ 游标也用这个分子表达式（见下方 buildPage），两边必须一致。
     */
    const scoreExpr = `SUM(COALESCE(s.listing_score_ratio, 0) * COALESCE(w.w, 1))`

    /**
     * 排序/游标用的是 **ROUND 后**的分子，返回值用未 ROUND 的（见 score_weighted）。
     *
     * ⚠️ 不 ROUND 会导致翻页重复。Doris 的 SUM 在分布式下**加法顺序不保证**，
     * 浮点加法又不满足结合律，所以同一个查询跑两次，聚合值可能在末位比特上不同。
     * 游标条件是 `(expr < ? OR (expr = ? AND keyword < ?))` ——
     * 上一页存下的值与本页重算的值差一个末位比特时，两个分支都不成立，
     * 该行就会**再出现一次**（实测 `26 x 26 pillow insert` 在第 3/4 页各出现一次）。
     *
     * 旧实现侥幸没暴露：那时分子是纯占比之和（量级 0.45），末位误差在 1e-17，
     * 而现在乘了权重（量级 3000），误差被放大到 1e-12，就撞上了。
     * ROUND 到 4 位小数后比较是稳定的，且 4 位相对于上千的量级远小于
     * 任何真实差异，不会把不同的词错并成并列（真并列由 keyword 兜底）。
     */
    const SORT_COLUMNS: Record<string, string> = {
      score: `ROUND(${scoreExpr}, 4)`,
      rank: 'MIN(s.nf_last_rank)',
      searches: 'MAX(k.est_searches_num)',
    }
    const sortCol = SORT_COLUMNS[dto.sortBy ?? 'score'] ?? SORT_COLUMNS.score

    const where: string[] = [
      `s.asin IN (${asins.map(() => '?').join(', ')})`,
      's.country = ?',
      "s.time_piece_type = 'month'",
      's.time_piece_value = ?',
    ]
    const params: any[] = [...asins, country, month]

    /**
     * 关键词搜索走 dim_keyword 的倒排索引。
     *
     * 输入先净化：MATCH_ANY 的参数是**查询表达式**而非普通字符串，
     * 保留的标点在部分 Doris 版本上会被当语法解析（当前版本实测容忍，
     * 但不同版本行为不一致，不能依赖）。
     * 这里只保留字母数字、空格、连字符和下划线，其余一律替换成空格。
     * 净化后为空说明用户只输了标点，直接忽略该条件而不是拼一个空表达式。
     */
    if (dto.keyword) {
      const safe = dto.keyword
        .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ')
      if (safe) {
        where.push('k.keyword MATCH_ANY ?')
        params.push(safe)
      }
    }

    /**
     * 游标：上一页最后一行的 (排序值, keyword)
     *
     * tie-break 用 keyword 文本而不是 keyword_id —— 后者可空，
     * NULL 参与比较时结果为 UNKNOWN，整行被 WHERE 过滤掉，翻页会漏数据。
     *
     * ⚠️ 因为下面按 keyword 分组，排序值是**聚合表达式**，
     * 所以游标条件必须放在 HAVING 而不是 WHERE ——
     * WHERE 里不允许出现聚合函数，放进去会直接报语法错误。
     */
    const having: string[] = []
    const havingParams: any[] = []
    const cur = decodeCursor(dto.cursor)
    if (cur && cur.length === 2) {
      const op = desc ? '<' : '>'
      having.push(`(${sortCol} ${op} ? OR (${sortCol} = ? AND s.keyword ${op} ?))`)
      havingParams.push(cur[0], cur[0], cur[1])
    }

    const dir = desc ? 'DESC' : 'ASC'
    const havingSql = having.length ? ` HAVING ${having.join(' AND ')}` : ''

    // 多取一条用于判断 hasMore，避免额外跑 COUNT(*)
    const rows = await this.db.query<any>(
      `SELECT s.keyword,
              MAX(k.translate_keyword)     AS translate_keyword,
              MAX(k.est_searches_num)      AS est_searches_num,
              MAX(s.keyword_id)            AS keyword_id,
              MAX(s.is_core)               AS is_core,
              MAX(s.is_target)             AS is_target,
              MIN(s.nf_last_rank)          AS nf_last_rank,
              MIN(s.sp_last_rank)          AS sp_last_rank,
              ${scoreExpr} AS score_weighted,
              MAX(s.exposure_positions)    AS exposure_positions,
              MAX(s.piece_max_time)        AS piece_max_time,
              COUNT(DISTINCT s.asin)       AS variant_cnt
    FROM fact_asin_keyword_snapshot s
         JOIN dim_keyword k
           ON k.keyword = s.keyword AND k.country = s.country
    LEFT JOIN (SELECT s2.asin, s2.country,
                      MAX(sc2.score / s2.listing_score_ratio) AS w
                 FROM fact_asin_keyword_snapshot s2
                 JOIN fact_asin_keyword_score sc2
                   ON sc2.asin = s2.asin AND sc2.keyword = s2.keyword
                  AND sc2.country = s2.country
                  AND sc2.time_piece_type = s2.time_piece_type
                  AND sc2.time_piece_value = s2.time_piece_value
                  AND sc2.channel = 'total'
                WHERE s2.time_piece_type = 'month' AND s2.time_piece_value = ?
                  AND s2.listing_score_ratio > 0
                GROUP BY s2.asin, s2.country) w
           ON w.asin = s.asin AND w.country = s.country
 WHERE ${where.join(' AND ')}
 GROUP BY s.keyword${havingSql}
   ORDER BY ${sortCol} ${dir}, s.keyword ${dir}
   LIMIT ${limit + 1}`,
      // ⚠️ 权重子查询的 `?`（time_piece_value）在 SQL 文本里位于 WHERE 之前，
      //    占位符按出现顺序绑定，所以 month 必须排在 params 最前面
      [month, ...params, ...havingParams],
    )

    const page = buildPage(rows, limit, (last: any) => [
      dto.sortBy === 'rank'
        ? Number(last.nf_last_rank ?? 0)
        : dto.sortBy === 'searches'
   ? Number(last.est_searches_num ?? 0)
          // 游标存的是**加权分子**（不是最终占比 —— 归一分母是常数，
          // 除不除都不影响排序）。必须与 SORT_COLUMNS.score 完全同形：
          // 那边是 ROUND(expr, 4)，这里也要 ROUND 到 4 位，
          // 否则游标比较两边量不一致，翻页会重复或漏行
          : Math.round(Number(last.score_weighted ?? 0) * 1e4) / 1e4,
      String(last.keyword),
    ])

    // 批量取各词的分渠道得分，避免 N+1 查询。按 keyword 文本取，与主键一致
    const kws = page.items.map((r: any) => String(r.keyword))
    const scoreMap = new Map<string, Record<string, any>>()
    if (kws.length) {
      const scores = await this.db.query<any>(
    `SELECT keyword, channel, score, score_ratio, score_change_ratio
       FROM fact_asin_keyword_score
    WHERE asin IN (${asins.map(() => '?').join(', ')})
      AND country = ? AND time_piece_type = 'month'
     AND time_piece_value = ?
AND keyword IN (${kws.map(() => '?').join(', ')})`,
      [...asins, country, month, ...kws],
      )
      for (const s of scores) {
        const key = String(s.keyword)
        const cur2 = scoreMap.get(key) ?? {}
        /**
         * ⚠️ 同一个词可能来自组内多个变体。**score 累加、ratio 重算**。
         *
         * 按变体组查时，`pillow inserts` 这类公共词会有 5 行（5 个变体各一行，
         * channel 都是 'total'）。
         *
         * - `score` 是绝对得分，累加是对的。直接赋值只留下最后一行，
         *   页面显示的「流量得分」会比真实值小好几倍，且随查询顺序变化。
         * - `score_ratio` 是「占**该变体自己**流量的比例」，各变体分母不同，
         *   **不能相加**（旧实现在这里相加，与外层 listing_score_ratio 是同一个 Bug）。
         *   实测 `pillow inserts` 在 5 个变体上的 score_ratio 是
         *   0.0707 / 0.0494 / 0.0587 / 0.1619 / 0.2269，相加得 0.568 毫无意义。
         *
         * 这里的分子（该词该渠道的绝对得分）已经有了，所以直接用
         * 累加后的 score ÷ 组总得分 重算占比，不需要加权还原。
         */
        const prev = cur2[s.channel]
        const score = Number(s.score ?? 0)
        cur2[s.channel] = prev
          ? {
              score: (prev.score ?? 0) + score,
              changeRatio: prev.changeRatio,
            }
          : {
              score,
              changeRatio:
                s.score_change_ratio === null ? null : Number(s.score_change_ratio),
            }
        scoreMap.set(key, cur2)
      }

      /**
       * 累加完再统一算占比：分子是该词该渠道的绝对得分，分母是组总得分。
       * 必须等所有行累加完成后再算，边累加边算会用到不完整的分子。
       */
      for (const chMap of scoreMap.values()) {
        for (const ch of Object.keys(chMap)) {
          const v = chMap[ch]
          v.ratio = totalWeight > 0 ? (v.score ?? 0) / totalWeight : null
        }
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
        /**
         * 该词占**整组**流量的比例（0-1 小数，前端乘 100 展示）。
         *
         * score_weighted 是各变体「占比 × 该变体总得分」的和，即该词的绝对得分；
         * 除以组总得分 totalWeight 得到真实占比。见 scoreExpr 处的推导。
         *
         * ⚠️ 与 `channels.total.ratio` 数值上**同义但不完全相等**：
         * 这里是 `Σ(ratio × w) / Σw`（用占比反推得分），那边是
         * `Σscore / Σw`（直接用得分）。数学上恒等，但浮点路径不同，
         * 实测偏差量级 1e-9（36/50 个词有偏差，最大 2.8e-9）。
         * 前端只展示到小数点后 3 位百分比，这个量级不可见；
         * **但不要写「两者必须严格 ===」的断言**，会随机失败。
         */
        listingScoreRatio:
          r.score_weighted === null || totalWeight <= 0
            ? null
            : Number(r.score_weighted) / totalWeight,
        exposurePositions: r.exposure_positions ? String(r.exposure_positions).split(',') : [],
        /** 该词被组内多少个变体同时占位（多变体自然位的核心信号） */
        variantCnt: Number(r.variant_cnt ?? 1),
      channels: scoreMap.get(String(r.keyword)) ?? {},
      })),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    }
  }

  /**
   * 把输入的 ASIN 解析成要统计的 ASIN 集合。
   *
   * 流量词是**子体**维度的（每个变体有自己的头部词），
   * 但用户常输入父体想看整组。传父体就展开成全部子体，传子体就只返回它自己。
   */
  /**
   * 流量变化归因：这个词变了多少、为什么变。
   *
   * 对应原站「查流量(词)」页的归因面板三列：关键词 / 流量变化 / 影响原因。
   *
   * 两种粒度存在同一张表里（granularity 列区分），默认取 month：
   *   month  源 sif-cli diag，覆盖面广（实测该 ASIN 3,079 词，已落 300）
   *   day    源 sif-cli rvs，只给当日 top 变化词（实测 10 词）
   *
   * ⚠️ 与 listKeywords 不同，这里**不做变体组展开**。归因是按输入 ASIN
   * 采集的，父体有父体自己的归因结论，展开成子体会把不存在的行拼出来。
   *
   * 表结构与口径（reason_summary 怎么来的、change_reasons 为什么存 JSON）
   * 详见 `db/schema-10-daily-grain.sql`。
   *
   * 排序按 |流量变化| 降序 —— 运营关心的是「哪个词变化最大」，
   * 不是正向优先或负向优先，所以取绝对值。
   */
  async getKeywordAttribution(
    asin: string,
    country: string,
    opts?: { granularity?: string; statDate?: string; limit?: number },
  ) {
    const granularity = opts?.granularity === 'day' ? 'day' : 'month'
    const limit = Math.min(Math.max(Number(opts?.limit) || 50, 1), 500)

    /**
     * 期没指定就取该 ASIN 该粒度下最新的一期。
     * 不能取全库最新期 —— 各 ASIN 的采集时间不同，
     * 用别人的期会查出 0 行然后被读成「这个词没变化」。
     */
    const statDate =
      opts?.statDate ??
      (
        await this.db.queryOne<any>(
          `SELECT MAX(stat_date) AS d FROM fact_asin_keyword_attribution
            WHERE asin = ? AND country = ? AND granularity = ?`,
          [asin, country, granularity],
        )
      )?.d

    if (!statDate) {
      return {
        asin,
        country,
        granularity,
        statDate: null,
        items: [],
        /** 没有数据时明确告知原因，避免前端把空表显示成「该 ASIN 无流量变化」 */
        dataScope: `该 ASIN 尚未采集 ${granularity === 'day' ? '日' : '月'}粒度归因数据`,
      }
    }

    const fmtDay = (v: any) => {
      if (!v) return null
      if (v instanceof Date) {
        const p = (x: number) => String(x).padStart(2, '0')
        return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`
      }
      return String(v).slice(0, 10)
    }

    const rows = await this.db.query<any>(
      `SELECT keyword, translate_keyword, contri_change, contri_change_ratio,
              contri_change_total, score, score_before, score_ratio,
              search_volume, search_rank, reason_summary, change_reasons, positive
         FROM fact_asin_keyword_attribution
        WHERE asin = ? AND country = ? AND granularity = ? AND stat_date = ?
        ORDER BY ABS(COALESCE(contri_change, 0)) DESC
        LIMIT ${limit}`,
      [asin, country, granularity, fmtDay(statDate)],
    )

    const num = (v: any) => (v === null || v === undefined ? null : Number(v))

    return {
      asin,
      country,
      granularity,
      statDate: fmtDay(statDate),
      items: rows.map((r: any) => ({
        keyword: r.keyword,
        translateKeyword: r.translate_keyword,
        /** 流量变化量，可负。原站显示为 "+4,609" / "-37,248" */
        contriChange: num(r.contri_change),
        contriChangeRatio: num(r.contri_change_ratio),
        contriChangeTotal: num(r.contri_change_total),
        score: num(r.score),
        scoreBefore: num(r.score_before),
        scoreRatio: num(r.score_ratio),
        searchVolume: num(r.search_volume),
        searchRank: num(r.search_rank),
        /** 预格式化的中文原因，可直接渲染。NULL=源未归因 */
        reasonSummary: r.reason_summary,
        /** 原始 JSON，前端要做更细的展示时才解析 */
        changeReasons: r.change_reasons,
        positive: num(r.positive),
      })),
    }
  }

  /**
   * ABA 搜索趋势（供「产品时光机」的双轴图）。
   *
   * 三条线共用一个时间轴：
   *   searchesNum     该词自身搜索量
   *   extSearchesNum  以该词为词根的综合搜索量（实测约为自身量的 25 倍）
   *   searchesRank    ABA 排名，**越小越靠前** —— 画图要用倒置轴
   *
   * ⚠️ 本方法只出数据，「产品时光机」页面本期未做（见文档遗留项）。
   */
  async getAbaTrend(keyword: string, country: string, granularity = 'week') {
    const rows = await this.db.query<any>(
      `SELECT stat_date, searches_num, ext_searches_num, searches_rank
         FROM fact_keyword_search_trend
        WHERE keyword = ? AND country = ? AND granularity = ?
          AND is_prev_period = 0
        ORDER BY stat_date`,
      [keyword, country, granularity],
    )

    const num = (v: any) => (v === null || v === undefined ? null : Number(v))
    const fmtDay = (v: any) => {
      if (!v) return null
      if (v instanceof Date) {
        const p = (x: number) => String(x).padStart(2, '0')
        return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`
      }
      return String(v).slice(0, 10)
    }

    return {
      keyword,
      country,
      granularity,
      periods: rows.length,
      dates: rows.map((r: any) => fmtDay(r.stat_date)),
      searchesNum: rows.map((r: any) => num(r.searches_num)),
      /** 词根综合搜索量。⚠️ 老数据（本次扩列之前灌的）此列为 NULL */
      extSearchesNum: rows.map((r: any) => num(r.ext_searches_num)),
      /** ABA 排名，越小越靠前，画图用倒置轴 */
      searchesRank: rows.map((r: any) => num(r.searches_rank)),
    }
  }

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
      const list = children.map((c: any) => c.child_asin)
      // 变体关系表里父体自己也可能作为在售变体出现，去重后返回
      return list.length ? [...new Set(list)] : [asin]
    }
    return [asin]
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

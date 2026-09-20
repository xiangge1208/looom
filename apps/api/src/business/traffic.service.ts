import { Injectable } from '@nestjs/common'
import { DorisService } from '../database/doris.service'

/**
 * 查流量结构
 *
 * 对应原站 /search（注意不是 /compare-structure，那是多产品对比）。
 *
 * 渠道数据存在长表 fact_asin_traffic_channel 里（用户已裁决用长表），
 * 这里负责把长表 pivot 成前端要的分组结构。
 */
@Injectable()
export class TrafficService {
  constructor(private readonly db: DorisService) {}

  /**
   * Listing 流量结构总览。
   *
   * 返回三层，对应原站页面顶部的三块分布图：
   *   1. 自然 vs 广告
   *   2. 广告内部细分（SP常规/SP推荐/SB常规/SBV）
   *   3. 推荐专栏分布
   */
  async getTrafficStructure(asin: string, country: string, timePieceValue?: string) {
    const month = timePieceValue ?? (await this.latestMonth(country))

    // 解析出要统计的 ASIN 集合：传父体则汇总该组全部子体
    const { asins, isGroup } = await this.resolveAsinScope(asin, country)
    if (!asins.length) {
      return {
        asin,
        country,
        timePieceValue: month,
        isGroup,
        overview: { total: null, natural: null, ad: null },
        adBreakdown: [],
        recommendColumns: [],
      }
    }

    const ph = asins.map(() => '?').join(', ')
    // 按渠道汇总。注意占比不能求和 —— 各子体的占比是各自的分母，
    // 汇总后要用 汇总得分 / 汇总总分 重算，所以这里先取 score 的和，占比在下面算。
    const rows = await this.db.query<any>(
      `SELECT channel, SUM(score) AS score
         FROM fact_asin_traffic_channel
        WHERE country = ? AND time_piece_type = 'month' AND time_piece_value = ?
          AND asin IN (${ph})
        GROUP BY channel`,
      [country, month, ...asins],
    )

    // 用渠道合计重算占比（原站的占比也是 0-1 小数，保持一致）
    const totalScore = rows
      .filter((r: any) => r.channel !== 'total' && r.channel !== 'ad' && r.channel !== 'allSp' && r.channel !== 'allSb')
      .reduce((acc: number, r: any) => acc + Number(r.score ?? 0), 0)
    for (const r of rows) {
      const sc = Number(r.score ?? 0)
      r.score_ratio = totalScore > 0 ? sc / totalScore : 0
      r.score_change = null
      r.score_change_ratio = null
      r.contri_change_ratio = null
    }

    const byChannel = new Map(rows.map((r: any) => [r.channel, r]))
    const num = (v: any) => (v === null || v === undefined ? null : Number(v))
    const pick = (code: string) => {
      const r = byChannel.get(code)
      if (!r) return null
      return {
        channel: code,
        score: num(r.score),
 // 占比是 0-1 小数（与实测一致），前端负责乘 100 展示
        ratio: num(r.score_ratio),
        change: num(r.score_change),
        changeRatio: num(r.score_change_ratio),
      }
    }

    // 渠道中文名从字典表取，不在代码里硬编码
    const dict = await this.db.query<any>(
      'SELECT code, name_cn, extra FROM dict_traffic_channel ORDER BY sort_order',
    )
    const dictMap = new Map(dict.map((d: any) => [d.code, d]))
    const withName = (item: any) =>
      item
        ? { ...item, name: dictMap.get(item.channel)?.name_cn ?? item.channel,
            color: dictMap.get(item.channel)?.extra || null }
        : null

    const recRows = await this.db.query<any>(
      `SELECT p.rec_title, c.display_name_cn, c.short_code,
        SUM(p.ratio) AS ratio, SUM(p.campaign_cnt) AS campaign_cnt,
SUM(p.keyword_cnt) AS keyword_cnt
    FROM fact_asin_rec_column_period p
     LEFT JOIN dim_recommend_column c
       ON c.rec_title = p.rec_title AND c.country = p.country
     WHERE p.asin IN (${asins.map(() => '?').join(', ')}) AND p.country = ?
     GROUP BY p.rec_title, c.display_name_cn, c.short_code
        ORDER BY ratio DESC`,
      [...asins, country],
    )

    return {
      asin,
      country,
      timePieceValue: month,
      /** true 表示输入的是父体，数据是整组汇总 */
      isGroup,
      /** 区块 1：自然 vs 广告 */
      overview: {
 total: withName(pick('total')),
 natural: withName(pick('nf')),
        ad: withName(pick('ad')),
      },
      /** 区块 2：广告内部细分 */
      adBreakdown: [
 withName(pick('sp')),
        withName(pick('spRec')),
        withName(pick('sb')),
        withName(pick('sbv')),
      ].filter(Boolean),
      /** 区块 3：推荐专栏。专栏是动态实体，标题可能出现字典里没有的新值 */
      recommendColumns: recRows.map((r: any) => ({
 recTitle: r.rec_title,
        name: r.display_name_cn ?? r.rec_title,
        shortCode: r.short_code ?? 'other',
 ratio: num(r.ratio),
        campaignCount: Number(r.campaign_cnt ?? 0),
 keywordCount: Number(r.keyword_cnt ?? 0),
      })),
    }
  }

  /**
   * 分变体的流量结构（页面下方表格）。
   *
   * 支持按变体 / Color / Size 维度切换 —— 维度名来自父体的 dim_asin_feature，
   * 不硬编码，因为不同商品的维度不一样（SSD 只有 Size，服装有 Size+Color）。
   */
  async getVariantTraffic(
    asin: string,
    country: string,
    dimension?: string,
    timePieceValue?: string,
  ) {
    const month = timePieceValue ?? (await this.latestMonth(country))

    const target = await this.db.queryOne<any>(
      'SELECT asin, is_parent_asin, parent_asin FROM dim_asin WHERE asin = ? AND country = ? LIMIT 1',
      [asin, country],
    )
    if (!target) return { dimension: dimension ?? 'variant', rows: [] }

    const parentAsin = target.is_parent_asin ? target.asin : target.parent_asin
    const asins = parentAsin
      ? (
          await this.db.query<any>(
     'SELECT child_asin FROM rel_asin_variant WHERE parent_asin = ? AND country = ? ORDER BY display_order',
            [parentAsin, country],
          )
        ).map((r: any) => r.child_asin)
      : [asin]

    if (!asins.length) return { dimension: dimension ?? 'variant', rows: [] }

    const ph = asins.map(() => '?').join(', ')
    const rows = await this.db.query<any>(
      `SELECT asin, channel, score, score_ratio
         FROM fact_asin_traffic_channel
        WHERE country = ? AND time_piece_type = 'month' AND time_piece_value = ?
   AND asin IN (${ph})`,
      [country, month, ...asins],
    )

    // pivot：长表转成「每个变体一行，各渠道一列」
    const LEAF = ['nf', 'sp', 'spRec', 'sb', 'sbv']
    const byAsin = new Map<string, any>()
    for (const r of rows) {
      const cur = byAsin.get(r.asin) ?? { asin: r.asin, channels: {}, total: 0 }
      cur.channels[r.channel] = {
        score: Number(r.score),
 ratio: r.score_ratio === null ? null : Number(r.score_ratio),
      }
      if (r.channel === 'total') cur.total = Number(r.score)
      byAsin.set(r.asin, cur)
    }

    // 变体属性，用于维度切换时分组
    const features = await this.db.query<any>(
      `SELECT asin, feature_name, feature_value FROM dim_asin_feature
        WHERE country = ? AND asin IN (${ph}) AND feature_value IS NOT NULL`,
      [country, ...asins],
    )
    const featMap = new Map<string, Record<string, string>>()
    for (const f of features) {
      const cur = featMap.get(f.asin) ?? {}
      cur[f.feature_name] = f.feature_value
      featMap.set(f.asin, cur)
    }

    const result = asins.map((a: string) => {
      const hit = byAsin.get(a)
      return {
        asin: a,
        features: featMap.get(a) ?? {},
 total: hit?.total ?? 0,
        channels: LEAF.reduce((acc: any, ch) => {
   acc[ch] = hit?.channels[ch] ?? { score: 0, ratio: 0 }
          return acc
 }, {}),
      }
    })

    return { dimension: dimension ?? 'variant', timePieceValue: month, rows: result }
  }

  /**
   * 把输入的 ASIN 解析成「要统计的 ASIN 集合」。
   *
   * 流量数据是子体维度的，但用户可能输入父体（想看整个变体组）。
   * 传父体就返回该组全部子体，传子体就只返回它自己。
   */
  private async resolveAsinScope(
    asin: string,
    country: string,
  ): Promise<{ asins: string[]; isGroup: boolean }> {
    const target = await this.db.queryOne<any>(
      'SELECT asin, is_parent_asin, parent_asin FROM dim_asin WHERE asin = ? AND country = ? LIMIT 1',
      [asin, country],
    )
    if (!target) return { asins: [], isGroup: false }

    if (target.is_parent_asin) {
      const children = await this.db.query<any>(
        'SELECT child_asin FROM rel_asin_variant WHERE parent_asin = ? AND country = ? ORDER BY display_order',
        [asin, country],
      )
      return { asins: children.map((c: any) => c.child_asin), isGroup: true }
    }
    return { asins: [asin], isGroup: false }
  }

  /**
   * 数据最新月份。对应原站的 rankingUpdateTime 探针。
   *
   * ⚠️ 必须按 country 取，不能取全局 MAX：
   * 各站点数据进度可能不一致（比如 US 已到 2026-08、JP 只到 2026-06），
   * 取全局最新月去查 JP 会得到空结果，被上层当成「该 ASIN 无数据」。
   * 当前 seed 只有单站点，掩盖了这个问题。
   */
  private async latestMonth(country: string): Promise<string> {
    const r = await this.db.queryOne<any>(
      `SELECT MAX(time_piece_value) AS m FROM fact_asin_traffic_channel
        WHERE time_piece_type = ? AND country = ?`,
      ['month', country],
    )
    return r?.m ?? '2026-08'
  }
}

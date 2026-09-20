import { Injectable, NotFoundException } from '@nestjs/common'
import { DorisService } from '../database/doris.service'

/**
 * 查销量
 *
 * 对应原站 /Sales。实测要点已固化进实现：
 *   - 父体自身无销量数据，销量只存在于子体层
 *   - 月序列固定 40 个月，起点 2023-05
 *   - 销量是字符串分档（"200+"/"<50"），故库里双列并存
 *   - features 是「维度名 → 取值」的两层结构，不是固定 Color/Size
 */
@Injectable()
export class SalesService {
  constructor(private readonly db: DorisService) {}

  /**
   * 取变体组的销量概览。
   *
   * 输入可以是父体也可以是子体：
   *   传父体 → 返回其全部子体
   *   传子体 → 返回同组的所有兄弟变体（原站也是这个行为，
   *            页面上会提示「搜索到 1 个结果，其余 N 个为同组变体」）
   */
  async getSalesOverview(asin: string, country: string) {
 const target = await this.db.queryOne<any>(
      `SELECT asin, country, title, img, price, brand, brand_href, score, star,
   rating_num, is_best_seller, is_parent_asin, parent_asin,
     first_available_day, seller
    FROM dim_asin WHERE asin = ? AND country = ? LIMIT 1`,
      [asin, country],
    )
    if (!target) {
      throw new NotFoundException(`未找到 ASIN ${asin}（站点 ${country}）`)
    }

    // 定位变体组的父体：传父体就是自己，传子体则取其 parent_asin
    const parentAsin = target.is_parent_asin ? target.asin : target.parent_asin

    const variants = parentAsin
      ? await this.db.query<any>(
       `SELECT a.asin, a.title, a.img, a.price, a.score, a.star, a.rating_num,
        a.is_best_seller, v.display_order, v.ratio
       FROM rel_asin_variant v
       JOIN dim_asin a ON a.asin = v.child_asin AND a.country = v.country
   WHERE v.parent_asin = ? AND v.country = ?
    ORDER BY v.display_order`,
     [parentAsin, country],
      )
   : [target]

    // 变体属性。父体存维度名，子体存取值，按 feature_name 对齐
    const features = await this.db.query<any>(
   `SELECT asin, feature_name, feature_value
         FROM dim_asin_feature WHERE country = ?
   AND asin IN (${[parentAsin, ...variants.map((v: any) => v.asin)]
   .filter(Boolean)
       .map(() => '?')
.join(', ')})`,
      [country, parentAsin, ...variants.map((v: any) => v.asin)].filter(Boolean),
    )

    // 维度名来自父体（feature_value 为空的那些行）
    const dimensions = features
    .filter((f: any) => f.asin === parentAsin && !f.feature_value)
.map((f: any) => f.feature_name)

 const featureMap = new Map<string, Record<string, string>>()
    for (const f of features) {
      if (!f.feature_value) continue
      const cur = featureMap.get(f.asin) ?? {}
      cur[f.feature_name] = f.feature_value
      featureMap.set(f.asin, cur)
    }

    // 各子体近一个月销量
    const asinList = variants.map((v: any) => v.asin)
    const latest = asinList.length
      ? await this.db.query<any>(
       // 子查询也要按 country 过滤：否则各站点数据进度不一致时，
          // 会拿别的站点的最新月去筛当前站点，结果为空被当成「无销量数据」
          `SELECT asin, stat_month, bought_lower_bound, bought_label
    FROM fact_asin_bought_monthly
        WHERE country = ? AND asin IN (${asinList.map(() => '?').join(', ')})
   AND stat_month = (
              SELECT MAX(stat_month) FROM fact_asin_bought_monthly WHERE country = ?
            )`,
       [country, ...asinList, country],
     )
   : []
    const latestMap = new Map(latest.map((r: any) => [r.asin, r]))

    return {
      target: {
  asin: target.asin,
        title: target.title,
        img: target.img,
        isParentAsin: !!target.is_parent_asin,
      },
      parentAsin,
      /** 变体属性维度名，如 ["Size","Color"]。数量随商品变化，前端不要写死两列 */
      dimensions,
      variantCount: variants.length,
      variants: variants.map((v: any) => ({
asin: v.asin,
     title: v.title,
        img: v.img,
        price: v.price === null ? null : Number(v.price),
        // score 是真实评分(4.8)，star 是半星展示值(5.0)，实测二者并存且含义不同
      score: v.score === null ? null : Number(v.score),
     star: v.star === null ? null : Number(v.star),
      ratingNum: v.rating_num === null ? null : Number(v.rating_num),
        isBestSeller: !!v.is_best_seller,
        features: featureMap.get(v.asin) ?? {},
 trafficRatio: v.ratio === null ? null : Number(v.ratio),
        // 销量是分档字符串，不是精确值
        boughtLabel: latestMap.get(v.asin)?.bought_label ?? null,
        boughtLowerBound: latestMap.get(v.asin)
          ? Number(latestMap.get(v.asin).bought_lower_bound)
  : null,
      })),
    }
  }

  /**
   * 月度销量趋势（折线图数据）。
   *
 * 返回 40 个月的完整序列。各变体共用同一条横轴，前端直接画多条线。
*/
  async getSalesTrend(asin: string, country: string) {
    const target = await this.db.queryOne<any>(
      'SELECT asin, is_parent_asin, parent_asin FROM dim_asin WHERE asin = ? AND country = ? LIMIT 1',
  [asin, country],
    )
    if (!target) {
      throw new NotFoundException(`未找到 ASIN ${asin}（站点 ${country}）`)
    }

    const parentAsin = target.is_parent_asin ? target.asin : target.parent_asin
    const asins = parentAsin
      ? (
 await this.db.query<any>(
       'SELECT child_asin FROM rel_asin_variant WHERE parent_asin = ? AND country = ? ORDER BY display_order',
  [parentAsin, country],
       )
  ).map((r: any) => r.child_asin)
      : [asin]

    if (!asins.length) return { dates: [], series: [] }

    const rows = await this.db.query<any>(
 `SELECT asin, stat_month, bought_lower_bound, bought_label
  FROM fact_asin_bought_monthly
   WHERE country = ? AND asin IN (${asins.map(() => '?').join(', ')})
   ORDER BY stat_month`,
      [country, ...asins],
    )

    // 统一横轴：所有变体共用同一组月份
    const dates = [...new Set(rows.map((r: any) => r.stat_month))].sort()
    const byAsin = new Map<string, Map<string, any>>()
    for (const r of rows) {
      if (!byAsin.has(r.asin)) byAsin.set(r.asin, new Map())
      byAsin.get(r.asin)!.set(r.stat_month, r)
 }

    return {
  dates,
    series: asins.map((a: string) => ({
        asin: a,
   // 缺失月份补 null，ECharts 会自动断线，不要补 0（会误导为「销量归零」）
   values: dates.map((d) => {
     const hit = byAsin.get(a)?.get(d)
       return hit ? Number(hit.bought_lower_bound) : null
      }),
        labels: dates.map((d) => byAsin.get(a)?.get(d)?.bought_label ?? null),
      })),
  }
  }
}

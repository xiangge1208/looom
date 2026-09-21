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

    /**
     * 父体自身的记录。
     *
     * ⚠️ 不能直接用 target 当父体行：用户传子体时 target 就是那个子体，
     * 拿它构造「父体行」会让同一个 ASIN 重复出现两次、还被错标成父体
     * （实测查 B0SEEDSS02 时就复现了这个问题）。
     * 所以传子体时要按 parentAsin 单独查一次。
     */
    const parentRow =
      !parentAsin || target.is_parent_asin
        ? target.is_parent_asin
          ? target
          : null
        : await this.db.queryOne<any>(
            `SELECT asin, title, img, price, score, star, rating_num, is_best_seller
               FROM dim_asin WHERE asin = ? AND country = ? LIMIT 1`,
            [parentAsin, country],
          )

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

    /**
     * 变体属性维度名。
     *
     * 优先取父体那些 feature_value 为空的「声明行」—— 这是维度的权威来源，
     * 且保留了原站的维度顺序。
     *
     * ⚠️ 但父体**可能自己也是一个在售变体**（实测 B0FVNPKGJ8 就是：它既是
     * 390 个子体的 parent_asin，又是其中一条 child_asin）。这种情况下
     * dim_asin_feature 的主键 (asin,country,feature_name) 决定了同一个
     * ASIN 的同一维度只能存一行 —— 要么存维度声明（值为空），要么存它自己的
     * 属性值，不能两者兼得。ETL 会优先存真实属性值，于是声明行不存在。
     *
     * 所以声明行缺失时，退而用**全组 feature_name 的并集**。
     * 不这么兜底的话 dimensions 会是空数组，前端的属性列整列消失。
     */
    const declared = features
      .filter((f: any) => f.asin === parentAsin && !f.feature_value)
      .map((f: any) => f.feature_name)

    const dimensions = declared.length
      ? declared
      : [...new Set(features.map((f: any) => f.feature_name as string))].sort()

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
       // 子查询的过滤条件要与外层**完全一致**（country + 同一批 ASIN）。
          //
          // ⚠️ 只按 country 取最新月是隐患：那是「全站点最新月」，而各 ASIN
          // 的数据进度并不齐。一旦某组变体只到上个月，就会一行都查不到，
          // 页面把「上月有销量」显示成「无销量数据」。同类问题在
          // traffic.service.ts / keywords.service.ts 都实际发生过
          // （keywords 那张表实测 19% 的 ASIN 落后一个月）。
          // 本表当前各组进度恰好一致，但不能依赖这个巧合。
          `SELECT asin, stat_month, bought_lower_bound, bought_label
    FROM fact_asin_bought_monthly
        WHERE country = ? AND asin IN (${asinList.map(() => '?').join(', ')})
   AND stat_month = (
              SELECT MAX(stat_month) FROM fact_asin_bought_monthly
               WHERE country = ? AND asin IN (${asinList.map(() => '?').join(', ')})
            )`,
       [country, ...asinList, country, ...asinList],
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
      /**
       * 变体行。
       *
       * ⚠️ 当输入/定位到的是父体时，**父体自身也作为一行排在最前**
       * （对齐原站：第 1 行是父体，其余标「变体」）。
       *
       * 父体行的 boughtLabel 恒为 null —— 销量只存在于子体，这是实测结论。
       * 用 isParent 标识让前端能区别渲染，而不是显示成「销量 0」：
       * 那会被读成「父体卖了 0 个」，而真相是「父体维度不存在销量这个概念」。
       */
      variants: [
        // 只有当这个变体组确实有父体、且父体不在 variants 里时才插入
        ...(parentRow && !variants.some((v: any) => v.asin === parentRow.asin)
          ? [
              {
                asin: parentRow.asin,
                title: parentRow.title,
                img: parentRow.img,
                price: parentRow.price === null ? null : Number(parentRow.price),
                score: parentRow.score === null ? null : Number(parentRow.score),
                star: parentRow.star === null ? null : Number(parentRow.star),
                ratingNum:
                  parentRow.rating_num === null ? null : Number(parentRow.rating_num),
                isBestSeller: !!parentRow.is_best_seller,
                features: featureMap.get(parentRow.asin) ?? {},
                // 父体自身没有独立的流量占比，它就是整组的 100%
                trafficRatio: null,
                boughtLabel: null,
                boughtLowerBound: null,
                isParent: true,
              },
            ]
          : []),
        ...variants.map((v: any) => ({
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
          /**
           * 父体也可能**出现在自己的子体列表里**。
           *
           * 实测 B0FVNPKGJ8（真实数据）在 rel_asin_variant 里既是 390 个
           * 子体的 parent_asin，又是其中一条 child_asin（display_order=215）——
           * 上游 web-asin-variants 就是这么给的：这个 ASIN 既是变体组的锚点，
           * 也是一个可下单的具体变体。
           *
           * 上面那段插入逻辑遇到这种情况会跳过（父体已在 variants 里），
           * 于是父体被当成普通变体排在第 216 位，前端的「父体钉首行」失效。
           * 所以这里要按 ASIN 比对补上标记，不能硬编码 false。
           *
           * 注意：这种行**保留自己的销量和流量占比**，不像插入的纯父体行置 null ——
           * 它确实作为一个变体在卖，有真实销量，抹成 null 才是失真。
           */
          isParent: v.asin === parentAsin,
        })),
      ],
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

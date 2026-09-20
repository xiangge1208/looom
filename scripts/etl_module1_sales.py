# -*- coding: utf-8 -*-
"""
模块 1「查销量」ETL —— PG(amazon_data) → Doris(looom)

灌入 4 张表：
  1. dim_asin                 ASIN 商品主档
  2. rel_asin_variant         父子体变体组关系
  3. dim_asin_feature         变体属性（Size/Color …）
  4. fact_asin_bought_monthly ASIN 月度销量

执行顺序（有依赖，不要调换）：
  dim_asin → rel_asin_variant → 回填 dim_asin.parent_asin
           → dim_asin_feature → fact_asin_bought_monthly

======================== 幂等性说明 ========================
Doris 侧这 4 张表全部是 UNIQUE KEY + enable_unique_key_merge_on_write=true，
写入走 merge-on-write：主键相同的新行会**整行覆盖**旧行，不会产生重复行。
因此本脚本可以反复执行，结果收敛一致，不需要先 DELETE/TRUNCATE。

⚠️ merge-on-write 是**整行覆盖**而不是按列部分更新。所以同一张表绝对不能分
两批各写一部分列（后写的那批会把前一批的列打成 NULL）。本脚本的做法是：
先在 Python 内存里把整行拼装齐全，再一次性 INSERT。
`dim_asin.parent_asin` 的「回填」也是把内存里那一整行重新 INSERT 一遍，
不是 UPDATE SET 单列。

======================== 几个必须注意的坑 ========================
* PG 侧 `sif_asin_sales_monthly` 同一 (site, asin, period) 可能同时存在
  variant_key='' 的汇总行和具名变体行，两者值重复（实测 blank 恒等于
  sum(named)）。直接灌会让销量虚高，所以按 (site,asin,period) 取
  max(bought_num) 去重。
* `variant_key` 本身还有乱序问题（'Black, Blue/Medium' 与
  'Medium/Black, Blue' 指同一变体，实测排序归一后仍有 216 个组合重复）。
  本表不按 variant 维度拆分，所以不受这个问题影响；但将来若要建
  variant 级事实表，必须先做 variant_key 归一化。
* `web-asin-variants` 的 variants[] 第 0 个元素是 Listing 汇总行
  （order=0 且 asin=''），必须过滤掉，否则会造出 child_asin='' 的脏关系。
* `jsonb_array_elements` 对非数组会直接报错，所有展开处都加了
  jsonb_typeof(...)='array' 守卫。
* Doris 是 MySQL 协议但不支持 ON DUPLICATE KEY UPDATE，UNIQUE KEY 表
  直接 INSERT 即可。
* PG 连接设为 readonly，本脚本不修改 PG 任何数据。
"""

import sys
import io
import time
import datetime as dt

if hasattr(sys.stdout, 'buffer'):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import psycopg2
import psycopg2.extras
import pymysql

# --------------------------------------------------------------------------
# 连接配置
# --------------------------------------------------------------------------
PG_DSN = dict(host='120.76.216.136', port=15432, dbname='amazon_data',
              user='xiezhiyang', password='***REMOVED-PG-PASSWORD***')
DORIS_DSN = dict(host='120.24.248.175', port=9030, user='etl_user',
                 password='***REMOVED-DORIS-PASSWORD***', database='looom',
                 charset='utf8mb4', autocommit=False)

BATCH = 2000
NOW = dt.datetime.now().replace(microsecond=0)

# JSON 里带 asins[] 的两个接口，字段结构一致，一起抽
SALES_ENDPOINTS = ("web-sales-keyword", "web-sales-asin")


# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------
def log(msg):
    print('[%s] %s' % (dt.datetime.now().strftime('%H:%M:%S'), msg), flush=True)


def clip(s, n):
    """按 Doris 列宽截断，避免 strict mode 下整批 INSERT 失败。"""
    if s is None:
        return None
    s = str(s)
    return s[:n] if len(s) > n else s


def to_float(v):
    if v is None or v == '':
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f


def to_int(v):
    f = to_float(v)
    return None if f is None else int(f)


def to_bool(v):
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    s = str(v).lower()
    if s in ('true', '1'):
        return True
    if s in ('false', '0'):
        return False
    return None


def to_date(v):
    """'YYYY-MM-DD' → date；其它形态一律丢弃。"""
    if not v:
        return None
    s = str(v)[:10]
    try:
        return dt.datetime.strptime(s, '%Y-%m-%d').date()
    except ValueError:
        return None


def ms_to_dt(v):
    """epoch 毫秒 → datetime。"""
    n = to_int(v)
    if not n:
        return None
    try:
        return dt.datetime.fromtimestamp(n / 1000.0).replace(microsecond=0)
    except (ValueError, OSError, OverflowError):
        return None


def insert_batches(doris, table, cols, rows, label=None):
    """分批 executemany + 每批 commit。返回写入行数。"""
    label = label or table
    if not rows:
        log('  %s: 0 行，跳过' % label)
        return 0
    sql = 'INSERT INTO looom.%s (%s) VALUES (%s)' % (
        table, ', '.join(cols), ', '.join(['%s'] * len(cols)))
    cur = doris.cursor()
    done = 0
    t0 = time.time()
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i + BATCH]
        cur.executemany(sql, chunk)
        doris.commit()
        done += len(chunk)
        if done % (BATCH * 25) == 0 or done == len(rows):
            log('  %s: %d/%d (%.1fs)' % (label, done, len(rows), time.time() - t0))
    cur.close()
    log('  %s: 完成 %d 行，耗时 %.1fs' % (label, done, time.time() - t0))
    return done


def pg_iter(pg, name, sql, itersize=5000):
    """服务端游标流式读，避免 80 万行一次性进内存。"""
    cur = pg.cursor(name=name)
    cur.itersize = itersize
    cur.execute(sql)
    for row in cur:
        yield row
    cur.close()


# ==========================================================================
# STEP 0  从 PG 抽取各数据源到内存
# ==========================================================================
def extract_meta(pg):
    """sif_asin_meta：title / img / price / score / star / rating_num。
    ⚠️ 实测 brand 与 is_best_seller 在本表 100% 为 NULL，不从这里取。"""
    cur = pg.cursor()
    cur.execute("""
        SELECT upper(site), asin, title, img, price, score, star, rating_num,
               bought_past_month
        FROM sif_asin_meta
        WHERE asin IS NOT NULL AND asin <> ''
    """)
    meta, bpm = {}, {}
    for country, asin, title, img, price, score, star, rn, b in cur:
        k = (asin, country)
        meta[k] = dict(title=clip(title, 1024), img=clip(img, 512),
                       price=to_float(price), score=to_float(score),
                       star=to_float(star), rating_num=to_int(rn))
        if b is not None and str(b) != '':
            bpm[k] = clip(b, 16)
    cur.close()
    log('meta: %d 个 (asin,country)，其中 bought_past_month 非空 %d' % (len(meta), len(bpm)))
    return meta, bpm


def extract_sales_json(pg):
    """web-sales-keyword / web-sales-asin 的 data.asins[]
       → brand / brandHref / firstAvailableDay / snapshotUpdateTime
    同一 (site,params_hash) 抓过多次只取最新一次；同一 ASIN 可能出现在多个
    请求里，按 fetched_at 从旧到新遍历，后写覆盖前写（即保留最新观测）。"""
    cur = pg.cursor()
    cur.execute("""
        WITH latest AS (
          SELECT upper(site) AS country, resp, fetched_at,
                 row_number() OVER (PARTITION BY upper(site), params_hash
                                    ORDER BY fetched_at DESC) AS rn
          FROM sif_api_log
          WHERE endpoint IN %s AND ok
            AND jsonb_typeof(resp->'data'->'asins') = 'array'
        )
        SELECT l.country,
               a->>'asin', a->>'brand', a->>'brandHref',
               a->>'firstAvailableDay', a->>'snapshotUpdateTime',
               a->>'title', a->>'img', a->>'price',
               a->>'score', a->>'star', a->>'ratingNum'
        FROM latest l, jsonb_array_elements(l.resp->'data'->'asins') a
        WHERE l.rn = 1 AND coalesce(a->>'asin','') <> ''
        ORDER BY l.fetched_at ASC
    """, (SALES_ENDPOINTS,))
    out = {}
    for (country, asin, brand, href, fad, sut,
         title, img, price, score, star, rn) in cur:
        d = out.setdefault((asin, country), {})
        # 每个字段各自「非空才覆盖」，避免新一次抓取的 NULL 抹掉旧值
        if brand:
            d['brand'] = clip(brand, 255)
        if href:
            d['brand_href'] = clip(href, 512)
        if fad:
            v = to_date(fad)
            if v:
                d['first_available_day'] = v
        if sut:
            v = ms_to_dt(sut)
            if v:
                d['data_updated_at'] = v
        if title:
            d['title'] = clip(title, 1024)
        if img:
            d['img'] = clip(img, 512)
        if price is not None:
            v = to_float(price)
            if v is not None:
                d['price'] = v
        if score is not None:
            v = to_float(score)
            if v is not None:
                d['score'] = v
        if star is not None:
            v = to_float(star)
            if v is not None:
                d['star'] = v
        if rn is not None:
            v = to_int(rn)
            if v is not None:
                d['rating_num'] = v
    cur.close()
    log('sales JSON: %d 个 (asin,country) 有补充属性' % len(out))
    return out


def extract_is_parent(pg):
    """web-sales-asin 的 data.isParentAsin。

    ⚠️ 入参键是 `asins`（数组）而不是 `asin`，且 isParentAsin 是**整个响应
    一个标量**，不是每个 ASIN 一个。因此只有 `asins` 恰好 1 个元素的请求
    才能把这个标量归属到具体 ASIN 上。
    实测：单元素请求 205 条（189 个 distinct ASIN）→ false 201 / true 4；
    多元素请求 527 条 isParentAsin 恒为 false，属于响应级默认值，不可用，全部排除。
    另有少量老格式用 `asin` 标量键，一并兼容。
    """
    cur = pg.cursor()
    cur.execute("""
        SELECT DISTINCT upper(site),
               coalesce(params->'asins'->>0, params->>'asin') AS asin,
               (resp->'data'->>'isParentAsin')
        FROM sif_api_log
        WHERE endpoint = 'web-sales-asin' AND ok
          AND resp->'data'->>'isParentAsin' IS NOT NULL
          AND coalesce(params->'asins'->>0, params->>'asin') <> ''
          AND (
                (jsonb_typeof(params->'asins') = 'array'
                 AND jsonb_array_length(params->'asins') = 1)
             OR (params->'asins' IS NULL AND params->>'asin' IS NOT NULL)
          )
    """)
    out = {}
    for country, asin, flag in cur:
        b = to_bool(flag)
        if b is None:
            continue
        # true 优先：同一 ASIN 多次请求只要有一次报 true 就算父体
        k = (asin, country)
        if b or k not in out:
            out[k] = b
    cur.close()
    log('is_parent_asin: %d 个，其中 true %d 个'
        % (len(out), sum(1 for v in out.values() if v)))
    return out


def extract_seller(pg):
    """sif_asin_traffic_daily.buybox_seller，取该 (site,asin) 最新一天。"""
    cur = pg.cursor()
    cur.execute("""
        SELECT asin, country, seller FROM (
          SELECT asin, upper(site) AS country, buybox_seller AS seller,
                 row_number() OVER (PARTITION BY upper(site), asin
                                    ORDER BY stat_date DESC) AS rn
          FROM sif_asin_traffic_daily
          WHERE buybox_seller IS NOT NULL AND buybox_seller <> ''
        ) t WHERE rn = 1
    """)
    out = {(a, c): clip(s, 255) for a, c, s in cur}
    cur.close()
    log('seller: %d 个 (asin,country)' % len(out))
    return out


def extract_variants(pg):
    """web-asin-variants → rel_asin_variant 原料 + isBestSeller。

    * parent_asin 取请求入参 params->>'asin'
    * child_asin 取 data.variants[].asin，排除空串
    * order=0 且 asin='' 的是 Listing 汇总行，被上面的空串过滤掉
    * 同一 (site, params.asin) 抓过多次，用 row_number() 只取 fetched_at 最新那次
    """
    cur = pg.cursor()
    cur.execute("""
        WITH latest AS (
          SELECT upper(site) AS country, params->>'asin' AS parent_asin, resp,
                 row_number() OVER (PARTITION BY upper(site), params->>'asin'
                                    ORDER BY fetched_at DESC) AS rn
          FROM sif_api_log
          WHERE endpoint = 'web-asin-variants' AND ok
            AND coalesce(params->>'asin','') <> ''
            AND jsonb_typeof(resp->'data'->'variants') = 'array'
        )
        SELECT l.parent_asin, v->>'asin', l.country,
               v->>'order', v->>'ratio', v->>'isBestSeller',
               v->>'title', v->>'img', v->>'price',
               v->>'score', v->>'star', v->>'ratingNum'
        FROM latest l, jsonb_array_elements(l.resp->'data'->'variants') v
        WHERE l.rn = 1 AND coalesce(v->>'asin','') <> ''
    """)
    rel, best, attrs = {}, {}, {}
    for (p, ch, country, order_, ratio, ibs,
         title, img, price, score, star, rn) in cur:
        rel[(p, ch, country)] = (to_int(order_), to_float(ratio))
        b = to_bool(ibs)
        if b is not None:
            k = (ch, country)
            if b or k not in best:
                best[k] = b
        d = attrs.setdefault((ch, country), {})
        if title:
            d['title'] = clip(title, 1024)
        if img:
            d['img'] = clip(img, 512)
        for name, raw, fn in (('price', price, to_float), ('score', score, to_float),
                              ('star', star, to_float), ('rating_num', rn, to_int)):
            if raw is not None:
                v = fn(raw)
                if v is not None:
                    d[name] = v
    cur.close()
    log('variants: %d 条父子关系，isBestSeller %d 个，附带属性 %d 个'
        % (len(rel), len(best), len(attrs)))
    return rel, best, attrs


def extract_asin_pool(pg):
    """dim_asin 的 ASIN 池 —— 全域并集。

    ⚠️ 不能只取 sif_asin_meta（实测仅 6,888 个）。销量榜的主表是
    sif_asin_sales_monthly（实测 38,283 个 distinct ASIN），如果 dim_asin
    只装 meta 的 ASIN，销量榜 JOIN dim_asin 命中率只有 2% 出头。
    这里把 meta / sales_monthly / traffic_daily 三张表的 ASIN 全部并进来，
    没有属性的就只有 asin + country 两列，其余留 NULL。
    JSON 侧（asins[] / variants[]）的 ASIN 在 build_dim_asin 里再并入。
    """
    cur = pg.cursor()
    cur.execute("""
        SELECT upper(site), asin FROM sif_asin_meta
         WHERE asin IS NOT NULL AND asin <> ''
        UNION
        SELECT upper(site), asin FROM sif_asin_sales_monthly
         WHERE asin IS NOT NULL AND asin <> ''
        UNION
        SELECT upper(site), asin FROM sif_asin_traffic_daily
         WHERE asin IS NOT NULL AND asin <> ''
    """)
    pool = {(a, c) for c, a in cur}
    cur.close()
    log('ASIN 池（meta ∪ sales_monthly ∪ traffic_daily）: %d' % len(pool))
    return pool


# ==========================================================================
# STEP 1  dim_asin
# ==========================================================================
DIM_ASIN_COLS = ['asin', 'country', 'title', 'img', 'price', 'brand', 'brand_href',
                 'score', 'star', 'rating_num', 'is_best_seller', 'is_parent_asin',
                 'parent_asin', 'first_available_day', 'seller', 'data_updated_at',
                 'created_at', 'updated_at']


def build_dim_asin(pool, meta, sales_json, is_parent, seller, best, var_attrs):
    """把各数据源在内存里合并成整行。

    属性优先级（低 → 高）：variants 附带属性 < sales JSON asins[] < sif_asin_meta。
    结构化表 meta 最可信，放最后覆盖。
    """
    keys = set(pool) | set(meta) | set(sales_json) | set(is_parent) \
        | set(seller) | set(best) | set(var_attrs)
    rows = {}
    for k in keys:
        asin, country = k
        r = dict.fromkeys(DIM_ASIN_COLS)
        r['asin'] = clip(asin, 16)
        r['country'] = clip(country, 8)
        r.update(var_attrs.get(k, {}))
        r.update(sales_json.get(k, {}))
        for name, v in (meta.get(k) or {}).items():
            if v is not None:
                r[name] = v
        r['is_best_seller'] = best.get(k)
        r['is_parent_asin'] = is_parent.get(k)
        r['seller'] = seller.get(k)
        r['created_at'] = NOW
        r['updated_at'] = NOW
        rows[k] = r
    log('dim_asin: 合并后 %d 行' % len(rows))
    return rows


def load_dim_asin(doris, rows, label='dim_asin'):
    payload = [tuple(r[c] for c in DIM_ASIN_COLS) for r in rows.values()]
    return insert_batches(doris, 'dim_asin', DIM_ASIN_COLS, payload, label)


# ==========================================================================
# STEP 2  rel_asin_variant
# ==========================================================================
def load_rel_variant(doris, rel):
    cols = ['parent_asin', 'child_asin', 'country', 'display_order', 'ratio', 'created_at']
    payload = [(clip(p, 16), clip(ch, 16), clip(c, 8), o, ra, NOW)
               for (p, ch, c), (o, ra) in rel.items()]
    return insert_batches(doris, 'rel_asin_variant', cols, payload)


# ==========================================================================
# STEP 3  dim_asin_feature
# ==========================================================================
def load_dim_feature(pg, doris):
    """sif_asin_sales_monthly.features 展开。

    feature_name ← features[].code，feature_value ← features[].value。
    实测 code 与 feature 有 1.24% 不相等，按约定取 code。
    Doris 主键是 (asin, country, feature_name)，同一 ASIN 同一 code 出现多个
    不同 value 时（实测 48 组）由 merge-on-write 取最后写入的那个，
    这里在 Python 侧用 dict 先去重，保证同一次运行结果确定。
    """
    cols = ['asin', 'country', 'feature_name', 'feature_value', 'created_at']
    sql = """
        SELECT s.asin, upper(s.site), e->>'code', e->>'value'
        FROM sif_asin_sales_monthly s,
             jsonb_array_elements(s.features) e
        WHERE s.features IS NOT NULL
          AND jsonb_typeof(s.features) = 'array'
          AND coalesce(e->>'code','') <> ''
          AND s.asin IS NOT NULL AND s.asin <> ''
    """
    seen = {}
    n_elem = 0
    for asin, country, code, value in pg_iter(pg, 'cur_feature', sql):
        n_elem += 1
        seen[(clip(asin, 16), clip(country, 8), clip(code, 64))] = clip(value, 255)
    log('dim_asin_feature: 展开 %d 个数组元素 → 去重后 %d 行' % (n_elem, len(seen)))
    payload = [(a, c, n, v, NOW) for (a, c, n), v in seen.items()]
    return insert_batches(doris, 'dim_asin_feature', cols, payload)


# ==========================================================================
# STEP 4  fact_asin_bought_monthly
# ==========================================================================
def load_fact_bought(pg, doris, bpm, cur_month):
    """sif_asin_sales_monthly → 月度销量。

    ⚠️ 必须按 (site, asin, period) 取 max(bought_num) 去重：
       同组可能并存 variant_key='' 的汇总行与具名变体行，两者值重复
       （实测 267 个组合并存，且 blank 恒等于 sum(named)，0 个反例）。
       直接灌会虚高。
    ⚠️ variant_key 另有乱序问题（'Black, Blue/Medium' 与 'Medium/Black, Blue'
       是同一变体，实测排序归一后仍有 216 个组合重复）。本表不按 variant
       拆分，所以不受影响；将来若建 variant 级表必须先归一化。

    bought_label 只有当月（= PG 侧 max(period)）能从 sif_asin_meta.bought_past_month
    回填，历史月 PG 侧没有原始分档串，留 NULL。
    """
    cols = ['asin', 'country', 'stat_month', 'bought_lower_bound', 'bought_label', 'created_at']
    sql = """
        SELECT asin, upper(site) AS country, period, max(bought_num) AS bought
        FROM sif_asin_sales_monthly
        WHERE asin IS NOT NULL AND asin <> ''
          AND period IS NOT NULL AND period <> ''
        GROUP BY asin, upper(site), period
    """
    payload = []
    total = 0
    for asin, country, period, bought in pg_iter(pg, 'cur_fact', sql):
        total += 1
        label = bpm.get((asin, country)) if period == cur_month else None
        payload.append((clip(asin, 16), clip(country, 8), clip(period, 7),
                        to_int(bought), label, NOW))
    log('fact_asin_bought_monthly: 去重后 %d 行（当月 %s 可回填 label）' % (total, cur_month))
    return insert_batches(doris, 'fact_asin_bought_monthly', cols, payload)


# ==========================================================================
# main
# ==========================================================================
def main():
    t_all = time.time()
    log('=== 模块 1「查销量」ETL 开始 ===')

    pg = psycopg2.connect(**PG_DSN)
    pg.set_session(readonly=True)          # 只读，绝不动 PG
    doris = pymysql.connect(**DORIS_DSN)

    stats = {}
    try:
        # ---- 抽取 ----
        log('--- STEP 0 抽取 PG 数据源 ---')
        meta, bpm = extract_meta(pg)
        sales_json = extract_sales_json(pg)
        is_parent = extract_is_parent(pg)
        seller = extract_seller(pg)
        rel, best, var_attrs = extract_variants(pg)
        pool = extract_asin_pool(pg)

        cur_cur = pg.cursor()
        cur_cur.execute("SELECT max(period) FROM sif_asin_sales_monthly")
        cur_month = cur_cur.fetchone()[0]
        cur_cur.close()

        # ---- STEP 1 dim_asin ----
        log('--- STEP 1 dim_asin ---')
        dim = build_dim_asin(pool, meta, sales_json, is_parent, seller, best, var_attrs)
        stats['dim_asin'] = load_dim_asin(doris, dim)

        # ---- STEP 2 rel_asin_variant ----
        log('--- STEP 2 rel_asin_variant ---')
        stats['rel_asin_variant'] = load_rel_variant(doris, rel)

        # ---- STEP 3 回填 dim_asin.parent_asin ----
        # merge-on-write 是整行覆盖，所以这里不是 UPDATE 单列，
        # 而是把内存里补好 parent_asin 的整行重新 INSERT 一遍。
        log('--- STEP 3 回填 dim_asin.parent_asin ---')
        child2parent = {}
        for (p, ch, country) in rel:
            k = (ch, country)
            if k not in child2parent or p == ch:
                child2parent[k] = p
        touched = {}
        for k, p in child2parent.items():
            if k in dim:
                dim[k]['parent_asin'] = clip(p, 16)
                touched[k] = dim[k]
        log('  需回填 %d 个子体，命中 dim_asin %d 个' % (len(child2parent), len(touched)))
        stats['dim_asin.parent_asin'] = load_dim_asin(doris, touched, 'dim_asin(parent回填)')

        # ---- STEP 4 dim_asin_feature ----
        log('--- STEP 4 dim_asin_feature ---')
        stats['dim_asin_feature'] = load_dim_feature(pg, doris)

        # ---- STEP 5 fact_asin_bought_monthly ----
        log('--- STEP 5 fact_asin_bought_monthly ---')
        stats['fact_asin_bought_monthly'] = load_fact_bought(pg, doris, bpm, cur_month)

    finally:
        pg.close()
        doris.close()

    log('=== 全部完成，总耗时 %.1fs ===' % (time.time() - t_all))
    for k, v in stats.items():
        log('  %-28s %d 行' % (k, v))


if __name__ == '__main__':
    main()

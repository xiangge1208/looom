# -*- coding: utf-8 -*-
"""
模块 13 ETL：选词 / 关键词竞争分析 —— PG(amazon_data) → Doris(looom)

建表与字段依据：docs/M13_PROBE_FINDINGS.md（2026-09-21 实测 200 条采样）
DDL：db/schema-06-m13-wordpick.sql

本脚本处理**两个此前未结构化的 endpoint**（PG 里只有原始 JSON，无解析表）：

    web-compete-keyword    376 条 ok  → 竞品数量 7 列 + 份额 3 列（UPDATE 既有行）
    web-keyword-conversion 511 条 ok  → 转化漏斗 1 列 + ACOS/CPA 新表 + topAsin 2 列

## 目标（4 项）

    1. fact_keyword_metric_snapshot   加灌 10 列（竞品数量 + 销量 + 份额）
    2. fact_keyword_bid_estimate      新表，ACOS/CPA 六种投放类型 × 三档
    3. rel_keyword_top_asin           回填 asin_role，新增 conv 角色行
    4. fact_keyword_conversion_funnel 加灌 click_purchase_ratio

## 时间维度对齐（关键，弄错会写出重复行）

`fact_keyword_metric_snapshot` 主键是 (keyword, country, granularity, stat_date)，
实测 stat_date 是 **ABA 周起始日（周日）**，7 个值：2026-07-26 ~ 2026-09-06。

- `web-keyword-conversion` 响应自带 `data.weekDate`（100% 填充，6 个值），直接用。
- `web-compete-keyword` **响应里没有周维度**（data 只有 total 和 keywords），
  只能用 `fetched_at` 反推所属 ABA 周 —— 按周日对齐取当周起始日。
  ⚠️ 这是推断而非源数据，所以竞品数量列走 UPDATE 既有行而不是 INSERT 新行：
  只给「该周确实存在的关键词行」补列，避免因周次推断偏差造出孤立行。

## Doris 没有 UPDATE ... FROM，用 Unique Key 覆盖语义

Doris Unique Key 模型下 INSERT 同主键即整行覆盖，**不是部分更新** ——
所以补列必须先把该行的既有列读出来，与新列拼成完整行再 INSERT。
这里的做法：先 SELECT 出目标周的既有行到内存 dict，再与 PG 侧新列合并后整行写回。
（另一种做法是开 partial_update 会话变量，但那要求表属性支持，且 4.1 版本行为
需另行验证，这里选更保守的读-改-写。）

用法：
    python scripts/etl_module13_wordpick.py [--dry] [--only compete|conv|bid|topasin]
"""

import sys
import io
import argparse
import datetime as dt

if hasattr(sys.stdout, 'buffer'):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import psycopg2
import pymysql

# 数据库凭据从环境变量读取，不硬编码 —— 见 scripts/_dsn.py
from _dsn import pg_dsn, doris_dsn


BATCH = 2000
NOW = dt.datetime.now().replace(microsecond=0)

# 六种投放类型，与源 JSON 的键名严格一致（acos 和 cpa 共用这套键）
MATCH_TYPES = [
    'autoForSales_broad', 'autoForSales_phrase', 'autoForSales_exact',
    'legacyForSales_broad', 'legacyForSales_phrase', 'legacyForSales_exact',
]


def log(msg):
    print('[%s] %s' % (dt.datetime.now().strftime('%H:%M:%S'), msg), flush=True)


def clip(s, n):
    if s is None:
        return None
    s = str(s)
    return s[:n] if len(s) > n else s


def norm_kw(k):
    """关键词归一，规则与 schema-04 一致：btrim(lower())"""
    return None if k is None else str(k).strip().lower()


def num(v):
    """JSON 数值容错：字符串数字也接受，非数值返回 None"""
    if v is None or v == '':
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def to_int(v):
    f = num(v)
    return None if f is None else int(f)


#
# 曾有一个 aba_week_start(d) 把 fetched_at 归到所属 ABA 周（周日对齐），
# 用于给 web-compete-keyword 的数据推断周次。实测命中率极低（14/796），
# 已废弃并改为「按词匹配最新周行」，见 run_compete 的说明。
# 若日后 compete 响应带上了周维度，可以恢复按周匹配。


class Writer:
    """批量 INSERT。Doris Unique Key 下同主键即覆盖，可重复执行。"""

    def __init__(self, conn, table, columns, dry=False):
        self.conn, self.table, self.columns, self.dry = conn, table, columns, dry
        self.buf, self.total = [], 0
        self._head = 'INSERT INTO `%s` (%s) VALUES ' % (
            table, ', '.join('`%s`' % c for c in columns))
        self._ph = '(' + ', '.join(['%s'] * len(columns)) + ')'

    def add(self, row):
        assert len(row) == len(self.columns), \
            '%s: 列数不符 %d vs %d' % (self.table, len(row), len(self.columns))
        self.buf.append(row)
        if len(self.buf) >= BATCH:
            self.flush()

    def flush(self):
        if not self.buf:
            return
        n = len(self.buf)
        if not self.dry:
            cur = self.conn.cursor()
            cur.execute(self._head + ', '.join([self._ph] * n),
                        [v for row in self.buf for v in row])
            cur.close()
        self.total += n
        self.buf = []


# ======================================================================
# 1. 竞品数量 + 份额 ← web-compete-keyword
# ======================================================================

# 按 fetched_at 倒序取每个 (site, keyword) 的最新一条，避免同词多次抓取产生冲突。
# jsonb_typeof 守卫必须保留：遇到非数组行会报
# "cannot extract elements from a scalar"（ETL_GAP_ANALYSIS.md:33 的教训）。
SQL_COMPETE = """
SELECT upper(l.site) AS country,
       btrim(lower(el->>'keyword')) AS keyword,
       l.fetched_at::date AS fetched_date,
       el->>'nfAsinNum', el->>'ppcAsinNum', el->>'spAsinNum',
       el->>'spRecommendedAsinNum', el->>'recommendedAsinNum',
       el->>'brandAsinNum', el->>'acAsinNum', el->>'videoAsinNum',
       el->>'saleNum', el->>'clickShared', el->>'conversionShared',
       el->>'estSearchesNum', el->>'searchesRank'
FROM sif_api_log l
CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(l.resp->'data'->'keywords') = 'array'
         THEN l.resp->'data'->'keywords' ELSE '[]'::jsonb END) el
WHERE l.endpoint = 'web-compete-keyword' AND l.ok
  AND el->>'keyword' IS NOT NULL
ORDER BY l.fetched_at DESC
"""

METRIC_COLS = ['keyword', 'country', 'granularity', 'stat_date', 'stat_date_end',
               'keyword_id', 'est_searches_num', 'searches_rank',
               'cpc_bid', 'click_purchase_ratio',
               'nf_asin_num', 'ppc_asin_num', 'sp_asin_num',
               'sp_recommended_asin_num', 'recommended_asin_num',
               'brand_asin_num', 'ac_asin_num', 'video_asin_num',
               'sale_num', 'click_shared', 'conversion_shared', 'created_at']


def run_compete(pg, doris, dry):
    """
    给 fact_keyword_metric_snapshot 补 10 列。

    Doris 不支持部分更新（同主键 INSERT 是整行覆盖），所以先把既有行读进内存，
    合并新列后整行写回 —— 否则会把 est_searches_num 等既有列清成 NULL。

    ## 为什么按「词的最新周」匹配而不按推断周次匹配

    第一版按 aba_week_start(fetched_at) 推断周次再匹配，实测**只命中 14 条，
    782 条对不上**。诊断结论：
      - compete 响应里没有周维度，fetched_at 与 ABA 周归属对不上
      - 789 个去重词里只有 318 个在 metric 表里存在（词级交集），
        另 471 个是 compete 独有的词

    竞品数量（自然位/广告位有多少个竞品 ASIN）本质是**词级属性**，
    不随周剧烈变化，硬绑推断周次没有意义。改为匹配该词的**最新一周行**：
    命中率从 14/796 提到词级交集的上限 318。

    ⚠️ 代价：这 10 列的时间语义变成「最近一次抓取的竞品格局」而非「该周的」。
    这个取舍写进了 DDL COMMENT 和 M13_PROBE_FINDINGS.md。
    """
    log('  读取 fact_keyword_metric_snapshot 既有行…')
    cur = doris.cursor()
    cur.execute("""SELECT keyword, country, granularity, stat_date, stat_date_end,
                          keyword_id, est_searches_num, searches_rank,
                          cpc_bid, click_purchase_ratio
                     FROM fact_keyword_metric_snapshot
                    ORDER BY stat_date ASC""")
    # key=(keyword,country) -> 该词最新一周的整行。
    # SQL 按 stat_date 升序，后写覆盖前写，循环结束后留下的就是最新周那行。
    existing = {}
    for r in cur.fetchall():
        existing[(r[0], r[1])] = r
    cur.close()
    log('  既有词级行 %d 条（每词取最新周）' % len(existing))

    w = Writer(doris, 'fact_keyword_metric_snapshot', METRIC_COLS, dry)
    pcur = pg.cursor(name='compete_cur')
    pcur.itersize = 5000
    pcur.execute(SQL_COMPETE)

    seen = set()          # 同一 (kw,country) 只取最新一条（SQL 已按 fetched_at 倒序）
    matched = miss = 0
    for row in pcur:
        (country, kw, fetched, nf, ppc, sp, sprec, rec, brand, ac, video,
         sale, cshared, convshared, est, srank) = row
        k = clip(norm_kw(kw), 128)
        if not k or not country:
            continue
        key = (k, country)
        if key in seen:
            continue
        seen.add(key)

        old = existing.get(key)
        if old is None:
            # metric 表里没有这个词 —— compete 独有的词（实测 789 里有 471 个）。
            # 不在这里造新行：metric 表的 est_searches_num / searches_rank 来自
            # sif_keyword_overview，这里造出来的行那两列会是空的，混在一起
            # 会让「有搜索量数据」的判断失真。这些词留给后续单独决策。
            miss += 1
            continue
        matched += 1

        # old 的列序：keyword, country, granularity, stat_date, stat_date_end,
        #             keyword_id, est_searches_num, searches_rank,
        #             cpc_bid, click_purchase_ratio
        w.add([
            k, country, old[2], old[3], old[4],
            old[5], old[6], old[7], old[8], old[9],
            to_int(nf), to_int(ppc), to_int(sp), to_int(sprec), to_int(rec),
            to_int(brand), to_int(ac), to_int(video),
            to_int(sale), num(cshared), num(convshared), NOW,
        ])

    w.flush()
    pcur.close()
    log('  命中 %d 词，metric 表无此词 %d（未造新行）' % (matched, miss))
    return {'fact_keyword_metric_snapshot(+竞品数量)': w.total}


# ======================================================================
# 2. ACOS / CPA 分档 ← web-keyword-conversion
# ======================================================================

SQL_CONV = """
SELECT upper(l.site) AS country,
       (l.resp->'data'->>'weekDate')::date AS week_date,
       btrim(lower(el->>'keyword')) AS keyword,
       el->'acos' AS acos, el->'cpa' AS cpa,
       el->>'clickPurchaseRatio' AS cpr,
       el->'topAsins' AS top_asins,
       el->'asinsClickPurchaseRatio' AS conv_asins
FROM sif_api_log l
CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(l.resp->'data'->'keywords') = 'array'
         THEN l.resp->'data'->'keywords' ELSE '[]'::jsonb END) el
WHERE l.endpoint = 'web-keyword-conversion' AND l.ok
  AND l.resp->'data'->>'weekDate' IS NOT NULL
  AND el->>'keyword' IS NOT NULL
ORDER BY l.fetched_at DESC
"""


def pick3(bucket, mtype):
    """
    从 acos/cpa 对象里取某投放类型的三档值。

    源结构：{"autoForSales_broad": [{"start":..,"median":..,"end":..}], ...}
    数组长度实测恒 1；profitRate 的对应数组恒空，调用方不传它。
    """
    if not isinstance(bucket, dict):
        return (None, None, None)
    arr = bucket.get(mtype)
    if not isinstance(arr, list) or not arr:
        return (None, None, None)
    d = arr[0]
    if not isinstance(d, dict):
        return (None, None, None)
    return (num(d.get('start')), num(d.get('median')), num(d.get('end')))


def run_bid(pg, doris, dry):
    """
    ACOS/CPA 六种投放类型各一行，写 fact_keyword_acos_estimate。

    ## 2026-09-21 返工：表改名 + 拆维（schema-07）

    原先写 fact_keyword_bid_estimate，match_type 列存 'autoForSales_exact'
    这种源 JSON 拼接键。审计实测原站「查关键词竞价」是**另一个指标**
    （带类目维、每月更新、三档递增），本表装的 ACOS/CPA 不是竞价，
    所以表正名 fact_keyword_acos_estimate，拼接键拆成两列：

        'autoForSales_exact'   → match_type='exact',  bid_strategy='auto'
        'legacyForSales_broad' → match_type='broad',  bid_strategy='legacy'

    fact_keyword_bid_estimate 这个名字现在是真正的竞价表（无源，走 seed）。
    ⚠️ 不要往那张表写本函数的数据。
    """
    w = Writer(doris, 'fact_keyword_acos_estimate',
               ['keyword', 'country', 'stat_week', 'match_type', 'bid_strategy',
                'keyword_id', 'acos_start', 'acos_median', 'acos_end',
                'cpa_start', 'cpa_median', 'cpa_end', 'created_at'], dry)
    pcur = pg.cursor(name='bid_cur')
    pcur.itersize = 2000
    pcur.execute(SQL_CONV)

    seen = set()
    kw_n = 0
    for country, week, kw, acos, cpa, _cpr, _ta, _ca in pcur:
        k = clip(norm_kw(kw), 128)
        if not k or not country or not week:
            continue
        if (k, country, week) in seen:
            continue
        seen.add((k, country, week))
        kw_n += 1

        for mt in MATCH_TYPES:
            a_s, a_m, a_e = pick3(acos, mt)
            c_s, c_m, c_e = pick3(cpa, mt)
            # 六种类型里某一种全空就不落行，避免造一堆全 NULL 行
            if a_s is None and a_m is None and a_e is None \
               and c_s is None and c_m is None and c_e is None:
                continue
            # 拆维：源键名 '<strategy>ForSales_<match>' → 两列
            strategy, match = mt.split('ForSales_')
            w.add([k, country, week, match, strategy, None,
                   a_s, a_m, a_e, c_s, c_m, c_e, NOW])

    w.flush()
    pcur.close()
    log('  覆盖 %d 个 (关键词,站点,周) 组合' % kw_n)
    return {'fact_keyword_acos_estimate': w.total}


# ======================================================================
# 3. 转化漏斗补 click_purchase_ratio ← web-keyword-conversion
# ======================================================================

FUNNEL_COLS = ['keyword', 'country', 'stat_week', 'keyword_id',
               'search_volume', 'click_volume', 'purchase_volume',
               'search_click_ratio', 'search_purchase_ratio',
               'click_shared', 'conversion_shared',
               'avg_kw_price', 'max_kw_price', 'min_kw_price',
               'source', 'click_purchase_ratio', 'created_at']

SQL_FUNNEL = """
SELECT upper(l.site) AS country,
       btrim(lower(el->>'keyword')) AS keyword,
       (l.resp->'data'->>'weekDate')::date AS week_date,
       el->>'clickPurchaseRatio'
FROM sif_api_log l
CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(l.resp->'data'->'keywords') = 'array'
         THEN l.resp->'data'->'keywords' ELSE '[]'::jsonb END) el
WHERE l.endpoint = 'web-keyword-conversion' AND l.ok
  AND l.resp->'data'->>'weekDate' IS NOT NULL
  AND el->>'keyword' IS NOT NULL
  AND el->>'clickPurchaseRatio' IS NOT NULL
ORDER BY l.fetched_at DESC
"""


def run_conv(pg, doris, dry):
    """
    给 fact_keyword_conversion_funnel 补 click_purchase_ratio。

    同 run_compete 的理由：Doris 同主键 INSERT 是整行覆盖，
    必须先读既有行再整行写回。

    这里的周维度**来自源响应的 data.weekDate**（100% 填充），
    不是推断的，所以命中率应该很高。
    """
    log('  读取 fact_keyword_conversion_funnel 既有行…')
    cur = doris.cursor()
    cur.execute("""SELECT keyword, country, stat_week, keyword_id,
                          search_volume, click_volume, purchase_volume,
                          search_click_ratio, search_purchase_ratio,
                          click_shared, conversion_shared,
                          avg_kw_price, max_kw_price, min_kw_price, source
                     FROM fact_keyword_conversion_funnel""")
    existing = {(r[0], r[1], r[2]): r for r in cur.fetchall()}
    cur.close()
    log('  既有行 %d 条' % len(existing))

    w = Writer(doris, 'fact_keyword_conversion_funnel', FUNNEL_COLS, dry)
    pcur = pg.cursor(name='funnel_cur')
    pcur.itersize = 5000
    pcur.execute(SQL_FUNNEL)

    seen = set()
    matched = miss = 0
    for country, kw, week, cpr in pcur:
        k = clip(norm_kw(kw), 128)
        if not k or not country or week is None:
            continue
        key = (k, country, week)
        if key in seen:
            continue
        seen.add(key)

        old = existing.get(key)
        if old is None:
            miss += 1
            continue
        matched += 1
        # old[3:15] 是 keyword_id 到 source 的既有列，原样带回
        w.add([k, country, week] + list(old[3:15]) + [num(cpr), NOW])

    w.flush()
    pcur.close()
    log('  命中既有行 %d，无既有行 %d（未造新行）' % (matched, miss))
    return {'fact_keyword_conversion_funnel(+点击购买率)': w.total}


# ======================================================================
# 4. rel_keyword_top_asin：回填 asin_role + 新增 conv 角色行
# ======================================================================

TOPASIN_COLS = ['keyword', 'country', 'asin', 'keyword_id', 'rank_position',
                'img', 'title', 'price', 'asin_role', 'click_purchase_ratio',
                'created_at']

# 有转化率数据的 ASIN（每词 0~3 个，100% 填充）。
# 与 topAsins 的字段重叠但语义不同，靠 asin_role 区分。
SQL_CONV_ASIN = """
SELECT upper(l.site) AS country,
       btrim(lower(el->>'keyword')) AS keyword,
       a->>'asin', a->>'img', a->>'price', a->>'clickPurchaseRatio'
FROM sif_api_log l
CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(l.resp->'data'->'keywords') = 'array'
         THEN l.resp->'data'->'keywords' ELSE '[]'::jsonb END) el
CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(el->'asinsClickPurchaseRatio') = 'array'
         THEN el->'asinsClickPurchaseRatio' ELSE '[]'::jsonb END) a
WHERE l.endpoint = 'web-keyword-conversion' AND l.ok
  AND el->>'keyword' IS NOT NULL AND a->>'asin' IS NOT NULL
ORDER BY l.fetched_at DESC
"""


def run_topasin(pg, doris, dry):
    """
    两件事：
      1. 把既有行的 asin_role 回填成 'top'（它们全部来自 topAsins[]，实测 46,451 行）
      2. 新增 asinsClickPurchaseRatio[] 的行，asin_role='conv'

    ⚠️ 主键是 (keyword, country, asin)，不含 asin_role —— 所以同一个 ASIN
    既是头部又有转化数据时，conv 行会覆盖 top 行。这是有意的：
    conv 行信息更全（多一个 click_purchase_ratio），且 rank_position 会带回来。

    ⚠️ **返回的 w.total 是写入次数，不是表行数**。本函数先回填 top 再写 conv，
    同 ASIN 的 conv 会覆盖 top，所以写 57,225 次最终只剩 56,795 行。
    引用行数时查库，不要引用这个日志数字 —— 曾有文档拿它当表行数写进计划
    （AUDIT §11.1 记录了这个坑）。

    实测分布：top 46,451 行 + conv 10,344 行 = 56,795。
    conv 行里只有 430 行带 rank_position/title（conv 响应无 title，
    只有能对上既有 top 行的才继承）。查「Top N 产品」时要按 asin_role='top' 筛。
    """
    log('  读取 rel_keyword_top_asin 既有行…')
    cur = doris.cursor()
    cur.execute("""SELECT keyword, country, asin, keyword_id, rank_position,
                          img, title, price, asin_role
                     FROM rel_keyword_top_asin""")
    existing = {(r[0], r[1], r[2]): r for r in cur.fetchall()}
    cur.close()
    log('  既有行 %d 条' % len(existing))

    w = Writer(doris, 'rel_keyword_top_asin', TOPASIN_COLS, dry)

    # ---- 4.1 回填既有行的 asin_role='top' ----
    backfilled = 0
    for (k, country, asin), old in existing.items():
        if old[8] is not None:      # 已有 role，跳过（幂等）
            continue
        backfilled += 1
        w.add([k, country, asin, old[3], old[4], old[5], old[6], old[7],
               'top', None, NOW])
    w.flush()
    log('  回填 asin_role=top：%d 行' % backfilled)

    # ---- 4.2 灌入 conv 角色行 ----
    pcur = pg.cursor(name='convasin_cur')
    pcur.itersize = 5000
    pcur.execute(SQL_CONV_ASIN)

    seen = set()
    conv_n = 0
    for country, kw, asin, img, price, cpr in pcur:
        k = clip(norm_kw(kw), 128)
        if not k or not country or not asin:
            continue
        key = (k, country, asin)
        if key in seen:
            continue
        seen.add(key)
        conv_n += 1

        old = existing.get(key)
        # 能对上既有行就保留它的 rank_position / title（conv 响应里没有 title）
        w.add([k, country, asin,
               old[3] if old else None,
               old[4] if old else None,
               clip(img, 512),
               old[6] if old else None,
               num(price),
               'conv', num(cpr), NOW])

    w.flush()
    pcur.close()
    log('  写入 asin_role=conv：%d 行' % conv_n)
    return {'rel_keyword_top_asin(+角色/转化率)': w.total}


# ======================================================================
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', action='append', default=[],
                    choices=['compete', 'bid', 'conv', 'topasin'])
    ap.add_argument('--dry', action='store_true',
                    help='只读 PG 和 Doris、不写入，用于核对行数')
    args = ap.parse_args()
    want = set(args.only) if args.only else {'compete', 'bid', 'conv', 'topasin'}
    log('模块 13 选词 ETL%s | 目标: %s'
        % ('（dry-run）' if args.dry else '', ', '.join(sorted(want))))

    pg = psycopg2.connect(**pg_dsn())
    pg.set_session(readonly=True)
    doris = pymysql.connect(**doris_dsn())
    stats = {}
    try:
        if 'compete' in want:
            log('[1/4] 竞品数量 + 份额 ← web-compete-keyword')
            stats.update(run_compete(pg, doris, args.dry))
        if 'bid' in want:
            log('[2/4] ACOS/CPA 分档 ← web-keyword-conversion')
            stats.update(run_bid(pg, doris, args.dry))
        if 'conv' in want:
            log('[3/4] 转化漏斗补列 ← web-keyword-conversion')
            stats.update(run_conv(pg, doris, args.dry))
        if 'topasin' in want:
            log('[4/4] topAsin 角色 + 转化率 ← web-keyword-conversion')
            stats.update(run_topasin(pg, doris, args.dry))
    finally:
        pg.close()
        doris.close()

    log('%s完成：' % ('预演' if args.dry else '写入'))
    for t in sorted(stats):
        print('  %8d  %s' % (stats[t], t))


if __name__ == '__main__':
    main()

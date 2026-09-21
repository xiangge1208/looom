# -*- coding: utf-8 -*-
"""
模块 2「查多变体自然位」ETL —— PG(amazon_data) → Doris(looom)

对应 docs/MODULE_DATA_FLOW.md 模块 2，三张表：

    fact_asin_multinf_keyword_variant  ← sif_asin_keyword.raw->'multiNfInfo'（明细，最厚）
    fact_asin_multinf_keyword          ← 同源聚合（avg_rank/appear_days/asin_cnt 需自算）
    fact_asin_multinf_daily            ← 同源按日聚合

## 源的位置（文档称这是「本次核实的最大发现」）

数据藏在 `sif_asin_keyword.raw->'multiNfInfo'->'dateAsins'[]->'asins'[]`，
不是独立 endpoint，所以按 endpoint 名搜索找不到。实测展开后 56,779 行明细。

文档建议走已结构化的 `sif_asin_keyword.raw` 而不是 `sif_api_log`，省一层 JSON 解析，
本脚本照此执行。

## 两个必须避开的坑

1. **同名字段分两层**：`dateAsins[].pageNum` 实测全为 NULL，
   而 `dateAsins[].asins[].pageNum` 100% 有值。取错层会得到空列。
2. **`fact_asin_multinf_daily` 有两路源**，文档要求决策：
   A 路 `web-asin-day-trend` 六列全覆盖但只有 21 个 ASIN（且 asinCnt 抽样全为 0）；
   B 路 multiNfInfo 聚合覆盖 1,797 个 ASIN 但缺 extra_score/listing_asin_cnt。
   **本脚本走 B 路**：21 个 ASIN 的页面等于出不来，而缺的两列是次要指标，
   留 NULL 比整张表只有 21 个 ASIN 更有用。A 路可日后单独补那两列。

用法：
    python scripts/etl_module2_multinf.py [--dry] [--asin B0XXX] [--only variant|keyword|daily]
"""

import sys
import io
import argparse
import datetime as dt
from collections import defaultdict

if hasattr(sys.stdout, 'buffer'):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import psycopg2
import pymysql

# 数据库凭据从环境变量读取，不硬编码 —— 见 scripts/_dsn.py
from _dsn import pg_dsn, doris_dsn


BATCH = 2000
NOW = dt.datetime.now().replace(microsecond=0)


def log(msg):
    print('[%s] %s' % (dt.datetime.now().strftime('%H:%M:%S'), msg), flush=True)


def clip(s, n):
    if s is None:
        return None
    s = str(s)
    return s[:n] if len(s) > n else s


def norm_kw(k):
    return None if k is None else str(k).strip().lower()


def as_int(v):
    if v is None or isinstance(v, bool):
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


class Writer:
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
# 源：一条 SQL 把 multiNfInfo 的四层嵌套展开成扁平明细
# ======================================================================

# 层级：sif_asin_keyword 行 → multiNfInfo.dateAsins[] → .asins[]
#
# ⚠️ CASE WHEN jsonb_typeof(...)='array' 守卫必须保留 —— 少了它遇到
#    非数组的行会直接报 cannot extract elements from a scalar。
SQL_DETAIL = """
SELECT upper(k.site)          AS country,
       k.asin                 AS parent_asin,
       k.keyword              AS keyword,
       k.keyword_id           AS keyword_id,
       (da->>'date')::date    AS stat_date,
       a->>'asin'             AS variant_asin,
       (a->>'rank')::int      AS rank_position,
       -- ⚠️ 这三个页码字段必须取 asins[] 这一层。父层 dateAsins[].pageNum
       --    实测全为 NULL，取错层整列都是空
       (a->>'pageNum')::int   AS page_num,
       (a->>'pageRank')::int  AS page_rank,
       (a->>'pageSize')::int  AS page_size,
       a->>'img'              AS img
FROM sif_asin_keyword k
CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(k.raw->'multiNfInfo'->'dateAsins') = 'array'
         THEN k.raw->'multiNfInfo'->'dateAsins' ELSE '[]'::jsonb END) da
CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(da->'asins') = 'array'
         THEN da->'asins' ELSE '[]'::jsonb END) a
WHERE a->>'asin' IS NOT NULL
  AND da->>'date' IS NOT NULL
  {asin_filter}
"""


def run(pg, doris, asins, dry, want):
    # 这张表有专门的 rank_position / page_num / page_rank / page_size / img 列
    # （schema-03 补缺表时已加），所以四个页码字段能原样落，
    # 不需要挤进别的列 —— 只有全局 rank 是没法还原「第几页第几位」的
    var_w = Writer(doris, 'fact_asin_multinf_keyword_variant',
                   ['parent_asin', 'variant_asin', 'keyword', 'country',
                    'time_piece_type', 'time_piece_value', 'keyword_id',
                    'rank_position', 'page_num', 'page_rank', 'page_size',
                    'img', 'created_at'], dry)
    kw_w = Writer(doris, 'fact_asin_multinf_keyword',
                  ['asin', 'country', 'keyword', 'time_piece_type',
                   'time_piece_value', 'keyword_id', 'avg_rank',
                   'appear_days', 'asin_cnt', 'created_at'], dry)
    day_w = Writer(doris, 'fact_asin_multinf_daily',
                   ['asin', 'country', 'stat_date', 'asin_cnt', 'keyword_cnt',
                    'score', 'extra_score', 'listing_asin_cnt', 'created_at'], dry)

    flt, params = '', []
    if asins:
        flt = 'AND k.asin IN %s'
        params.append(tuple(asins))

    cur = pg.cursor(name='mn_cur')
    cur.itersize = 5000
    cur.execute(SQL_DETAIL.format(asin_filter=flt), params)

    # 明细去重：主键是 (parent,variant,keyword,country,tp_type,tp_value)，
    # 而源是逐日的 —— 同一个月多天会撞同一个主键。取 rank 最小（最好名次）的那天：
    # 页面问的是「这个变体在这个词上能排到多少位」，月内最好成绩比随机某天更有意义。
    var_best = {}
    # 关键词级聚合：avg_rank/appear_days/asin_cnt 三个指标文档明确要求 ETL 自算
    kw_agg = defaultdict(lambda: {'ranks': [], 'days': set(), 'asins': set()})
    # 日级聚合（B 路）
    day_agg = defaultdict(lambda: {'asins': set(), 'kws': set()})

    n = 0
    for (country, parent_asin, keyword, keyword_id, stat_date, variant_asin,
         rank_position, page_num, page_rank, page_size, img) in cur:
        n += 1
        kw = clip(norm_kw(keyword), 128)
        if not kw or not variant_asin:
            continue
        month = stat_date.strftime('%Y-%m')

        if 'variant' in want:
            vk = (parent_asin, variant_asin, kw, country, 'month', month)
            prev = var_best.get(vk)
            # 取 rank 最小（名次最好）的那天。页面问的是「这个变体在这个词上
            # 能排到第几位」，月内最好成绩比随机某天更有意义；
            # 同时把该天的页码三件套一起带走，保证 rank 与页码来自同一天
            if prev is None or (rank_position is not None
                                and (prev[0] is None or rank_position < prev[0])):
                var_best[vk] = (rank_position, keyword_id, page_num,
                                page_rank, page_size, img)

        if 'keyword' in want:
            ka = kw_agg[(parent_asin, country, kw, 'month', month)]
            if rank_position is not None:
                ka['ranks'].append(rank_position)
            ka['days'].add(stat_date)
            ka['asins'].add(variant_asin)
            ka['kid'] = keyword_id

        if 'daily' in want:
            da = day_agg[(parent_asin, country, stat_date)]
            da['asins'].add(variant_asin)
            if keyword_id is not None:
                da['kws'].add(keyword_id)
            else:
                da['kws'].add(kw)

        if n % 20000 == 0:
            log('  已读 %d 行明细' % n)

    cur.close()

    for (p, v, kw, country, tpt, tpv), vals in var_best.items():
        rank, kid, pnum, prank, psize, vimg = vals
        var_w.add([p, v, kw, country, tpt, tpv, kid, rank,
                   pnum, prank, psize, clip(vimg, 512), NOW])
    for (asin, country, kw, tpt, tpv), agg in kw_agg.items():
        ranks = agg['ranks']
        kw_w.add([asin, country, kw, tpt, tpv, agg.get('kid'),
                  (sum(ranks) / len(ranks)) if ranks else None,
                  len(agg['days']), len(agg['asins']), NOW])
    for (asin, country, d), agg in day_agg.items():
        # score / extra_score / listing_asin_cnt 走 B 路拿不到，留 NULL。
        # 不写 0 —— 0 会被读成「当日没有多变体占位」，而真相是「这个口径没采集」
        day_w.add([asin, country, d, len(agg['asins']), len(agg['kws']),
                   None, None, None, NOW])

    var_w.flush()
    kw_w.flush()
    day_w.flush()
    log('读 %d 行明细 → variant %d, keyword %d, daily %d'
        % (n, var_w.total, kw_w.total, day_w.total))
    return {'fact_asin_multinf_keyword_variant': var_w.total,
            'fact_asin_multinf_keyword': kw_w.total,
            'fact_asin_multinf_daily': day_w.total}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--asin', action='append', default=[])
    ap.add_argument('--only', action='append', default=[],
                    choices=['variant', 'keyword', 'daily'])
    ap.add_argument('--dry', action='store_true')
    args = ap.parse_args()

    want = set(args.only) if args.only else {'variant', 'keyword', 'daily'}
    asins = set(args.asin) if args.asin else None
    log('模块 2 多变体自然位 ETL%s | 目标: %s'
        % ('（dry-run）' if args.dry else '', ', '.join(sorted(want))))

    pg = psycopg2.connect(**pg_dsn())
    pg.set_session(readonly=True)
    doris = pymysql.connect(**doris_dsn())
    try:
        stats = run(pg, doris, asins, args.dry, want)
    finally:
        pg.close()
        doris.close()

    log('%s完成：' % ('预演' if args.dry else '写入'))
    for t in sorted(stats):
        print('  %8d  %s' % (stats[t], t))


if __name__ == '__main__':
    main()

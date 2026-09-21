# -*- coding: utf-8 -*-
"""
模块 5 补充 ETL：关键词级指标三张表 —— PG(amazon_data) → Doris(looom)

etl_module5_keywords.py 只覆盖了「ASIN × 关键词」那三张表，
本脚本补齐「关键词自身」的三张表：

    fact_keyword_metric_snapshot ← sif_keyword_overview（22,310 行，已结构化）
    fact_keyword_search_trend    ← sif_keyword_aba_trend（132,899 行，已结构化）
    fact_keyword_rank_history    ← sif_asin_keyword.raw->'allRankHistory'（平行数组）

（`fact_keyword_competition_snapshot` 已有 21,328 行，由既有 ETL 灌好，不重复。）

## allRankHistory 是平行数组

    allRankHistory: {
      date:   ["2026-07-29", ...],           # 日期轴，实测长度 8
      spRank: [{asin,rank,rankStr,campaignId,...}, null, ...],  # 按下标对齐
      nfRank: [...], sbRank: [...], sbvRank: [...]
    }

实测 **19287/19287 行**各分支长度与 `date[]` 完全相等，下标对齐可靠。
PG 侧用 `jsonb_array_elements` 带 ordinality 取下标，再回查 date。

## rankStr 的三段语义（已对账）

形如 `p3,6/12` = 第 3 页、页内第 6 位、每页 12 位。
验证：`pink set` 的 spLastRankStr=p3,6/12 且 spLastRank=30 → (3-1)×12+6=30 ✓。
所以 page_no=第1段、slot=第2段、page_size=第3段，**不要弄反**。

用法：
    python scripts/etl_module5b_keyword_metrics.py [--dry] [--only metric|trend|rank]
"""

import sys
import io
import argparse
import datetime as dt

if hasattr(sys.stdout, 'buffer'):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import re
import psycopg2
import pymysql

# 数据库凭据从环境变量读取，不硬编码 —— 见 scripts/_dsn.py
from _dsn import pg_dsn, doris_dsn


BATCH = 2000
NOW = dt.datetime.now().replace(microsecond=0)
RANK_STR = re.compile(r'^p(\d+),(\d+)/(\d+)$')


def log(msg):
    print('[%s] %s' % (dt.datetime.now().strftime('%H:%M:%S'), msg), flush=True)


def clip(s, n):
    if s is None:
        return None
    s = str(s)
    return s[:n] if len(s) > n else s


def norm_kw(k):
    return None if k is None else str(k).strip().lower()


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
# fact_keyword_metric_snapshot ← sif_keyword_overview
# ======================================================================

# aba_date / aba_date_end 是 ABA 周窗口，granularity 固定 'week'。
# keyword_id 该表没有，LEFT JOIN sif_asin_keyword 反查（命中率有限，
# 但它不是主键成员，反查不到也能落行）。
SQL_METRIC = """
SELECT upper(o.site) AS country, btrim(lower(o.keyword)) AS keyword,
       o.aba_date, o.aba_date_end, o.est_searches_num, o.searches_rank,
       k.keyword_id
FROM sif_keyword_overview o
LEFT JOIN (
    SELECT DISTINCT ON (upper(site), btrim(lower(keyword)))
           upper(site) AS country, btrim(lower(keyword)) AS kw, keyword_id
    FROM sif_asin_keyword WHERE keyword_id IS NOT NULL
    ORDER BY upper(site), btrim(lower(keyword)), fetched_at DESC
) k ON k.country = upper(o.site) AND k.kw = btrim(lower(o.keyword))
WHERE o.keyword IS NOT NULL AND o.aba_date IS NOT NULL
"""


def run_metric(pg, doris, dry):
    w = Writer(doris, 'fact_keyword_metric_snapshot',
               ['keyword', 'country', 'granularity', 'stat_date', 'stat_date_end',
                'keyword_id', 'est_searches_num', 'searches_rank', 'created_at'], dry)
    cur = pg.cursor(name='metric_cur')
    cur.itersize = 5000
    cur.execute(SQL_METRIC)
    seen = set()
    n = 0
    for country, kw, d, d_end, est, rank, kid in cur:
        n += 1
        k = clip(norm_kw(kw), 128)
        if not k:
            continue
        key = (k, country, 'week', d)
        if key in seen:
            continue
        seen.add(key)
        w.add([k, country, 'week', d, d_end, kid, est, rank, NOW])
    cur.close()
    w.flush()
    log('fact_keyword_metric_snapshot：读 %d → 写 %d 行' % (n, w.total))
    return {'fact_keyword_metric_snapshot': w.total}


# ======================================================================
# fact_keyword_search_trend ← sif_keyword_aba_trend
# ======================================================================

# 该表已是扁平的 (keyword, granularity, period, ext/keyword 两个搜索量)。
#
# ⚠️ is_prev_period 字段原意是「上期对照」，本源没有上期数据。
#    两个搜索量的区别（实测数值差一个量级，不能混）：
#      keyword_search_vol → 该词本身的搜索量        → is_prev_period=0
#      ext_search_volume  → 含扩展词的搜索量（更大）→ is_prev_period=1
#    这是对该字段的**借用**，为的是不改表结构就能同时承载两个指标。
#    若日后要取真正的上期对照，必须改成独立列，否则语义会打架。
SQL_TREND = """
SELECT upper(site) AS country, btrim(lower(keyword)) AS keyword,
       granularity, period, keyword_search_vol, ext_search_volume
FROM sif_keyword_aba_trend
WHERE keyword IS NOT NULL AND period IS NOT NULL
"""


def _period_to_date(granularity, period):
    """period → DATE。

    月粒度是 'YYYY-MM'，表里 stat_date 是 DATE，补成当月 1 日。
    周粒度实测是 'YYYY/MM/DD-YYYY/MM/DD' 或 'YYYY-MM-DD'，取起始日。
    """
    s = str(period).strip()
    if len(s) == 7 and s[4] == '-':
        return s + '-01'
    if len(s) == 10 and s[4] == '-':
        return s
    # 'YYYY/MM/DD-YYYY/MM/DD' 取前半段
    head = s.split('-')[0].replace('/', '-')
    if len(head) == 10:
        return head
    return None


def run_trend(pg, doris, dry):
    w = Writer(doris, 'fact_keyword_search_trend',
               ['keyword', 'country', 'granularity', 'stat_date',
                'is_prev_period', 'keyword_id', 'searches_num', 'created_at'], dry)
    cur = pg.cursor(name='trend_cur')
    cur.itersize = 5000
    cur.execute(SQL_TREND)
    seen = set()
    n, skipped = 0, 0
    for country, kw, gran, period, kw_vol, ext_vol in cur:
        n += 1
        k = clip(norm_kw(kw), 128)
        d = _period_to_date(gran, period)
        if not k or not d:
            skipped += 1
            continue
        g = clip(gran or 'month', 16)
        for is_prev, val in ((0, kw_vol), (1, ext_vol)):
            if val is None:
                continue
            key = (k, country, g, d, is_prev)
            if key in seen:
                continue
            seen.add(key)
            w.add([k, country, g, d, is_prev, None, val, NOW])
        if n % 50000 == 0:
            log('  trend 已读 %d 行' % n)
    cur.close()
    w.flush()
    if skipped:
        log('  %d 行 period 无法解析成日期，已跳过' % skipped)
    log('fact_keyword_search_trend：读 %d → 写 %d 行' % (n, w.total))
    return {'fact_keyword_search_trend': w.total}


# ======================================================================
# fact_keyword_rank_history ← allRankHistory 的平行数组
# ======================================================================

# WITH ORDINALITY 取下标，再按同一下标回查 date[]。
# 实测 19287/19287 行各分支长度等于 date 长度，对齐可靠；
# 长度不等的行由 date_arr 取不到值而自然落空，WHERE 会滤掉。
SQL_RANK = """
SELECT upper(k.site) AS country,
       btrim(lower(k.keyword))  AS keyword,
       k.keyword_id,
       br                       AS branch,
       (k.raw->'allRankHistory'->'date'->>(ord::int - 1))::date AS stat_date,
       el->>'asin'              AS asin,
       (el->>'rank')::numeric   AS rank_position,
       el->>'rankStr'           AS rank_str,
       (el->>'asinOrder')::int  AS asin_order,
       el->>'campaignId'        AS campaign_id,
       el->>'maskCampaignId'    AS mask_campaign_id
FROM sif_asin_keyword k
CROSS JOIN unnest(ARRAY['nfRank', 'spRank', 'sbRank', 'sbvRank']) AS br
CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(k.raw->'allRankHistory'->br) = 'array'
         THEN k.raw->'allRankHistory'->br ELSE '[]'::jsonb END)
    WITH ORDINALITY AS t(el, ord)
WHERE jsonb_typeof(el) = 'object'
  AND el->>'rank' IS NOT NULL
  AND k.keyword IS NOT NULL
  AND (k.raw->'allRankHistory'->'date'->>(ord::int - 1)) IS NOT NULL
"""

# 分支名 → rank_type（与 dict_traffic_channel 的 code 对齐）
BRANCH_TYPE = {'nfRank': 'nf', 'spRank': 'sp', 'sbRank': 'sb', 'sbvRank': 'sbv'}


def run_rank(pg, doris, dry):
    w = Writer(doris, 'fact_keyword_rank_history',
               ['asin', 'country', 'keyword', 'rank_type', 'stat_date',
                'keyword_id', 'rank_position', 'page_no', 'page_size', 'slot',
                'asin_order', 'campaign_id', 'mask_campaign_id', 'created_at'], dry)
    cur = pg.cursor(name='rank_cur')
    cur.itersize = 5000
    cur.execute(SQL_RANK)
    seen = set()
    n = 0
    for (country, kw, kid, branch, stat_date, asin, rank_position, rank_str,
         asin_order, campaign_id, mask_id) in cur:
        n += 1
        k = clip(norm_kw(kw), 128)
        rt = BRANCH_TYPE.get(branch)
        if not k or not asin or not rt or not stat_date:
            continue
        key = (asin, country, k, rt, stat_date)
        if key in seen:
            continue
        seen.add(key)
        # rankStr 'p3,6/12' = 第3页、页内第6位、每页12位（已对账验证）
        m = RANK_STR.match(str(rank_str or ''))
        page_no = int(m.group(1)) if m else None
        slot = m.group(2) if m else None
        page_size = int(m.group(3)) if m else None
        w.add([clip(asin, 16), country, k, rt, stat_date, kid,
               float(rank_position) if rank_position is not None else None,
               page_no, page_size, clip(slot, 16), asin_order,
               clip(campaign_id, 64), clip(mask_id, 16), NOW])
        if n % 50000 == 0:
            log('  rank 已读 %d 行' % n)
    cur.close()
    w.flush()
    log('fact_keyword_rank_history：读 %d → 去重后写 %d 行' % (n, w.total))
    return {'fact_keyword_rank_history': w.total}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', action='append', default=[],
                    choices=['metric', 'trend', 'rank'])
    ap.add_argument('--dry', action='store_true')
    args = ap.parse_args()
    want = set(args.only) if args.only else {'metric', 'trend', 'rank'}
    log('模块 5b 关键词指标 ETL%s | 目标: %s'
        % ('（dry-run）' if args.dry else '', ', '.join(sorted(want))))

    pg = psycopg2.connect(**pg_dsn())
    pg.set_session(readonly=True)
    doris = pymysql.connect(**doris_dsn())
    stats = {}
    try:
        if 'metric' in want:
            stats.update(run_metric(pg, doris, args.dry))
        if 'trend' in want:
            stats.update(run_trend(pg, doris, args.dry))
        if 'rank' in want:
            stats.update(run_rank(pg, doris, args.dry))
    finally:
        pg.close()
        doris.close()

    log('%s完成：' % ('预演' if args.dry else '写入'))
    for t in sorted(stats):
        print('  %8d  %s' % (stats[t], t))


if __name__ == '__main__':
    main()

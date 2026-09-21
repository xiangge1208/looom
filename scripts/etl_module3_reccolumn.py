# -*- coding: utf-8 -*-
"""
模块 3「查推荐专栏」ETL —— PG(amazon_data) → Doris(looom)

对应 docs/MODULE_DATA_FLOW.md 模块 3，两张表：

    dim_recommend_column            ← 四源并集（专栏名是开放集合）
    rel_rec_column_campaign_keyword ← sif_asin_keyword.raw->'allRankHistory'->'recRanks'

`fact_asin_rec_column_period` **不做**：文档实测 `stat_date`/`campaign_cnt`/
`keyword_cnt` 三列确证无源（`flow-overview` 是区间聚合、没有日期维度也没有计数），
只有 `ratio` 有 214 个 (asin,recTitle) 对。硬造 stat_date=fetched_at 会让
「某天的专栏流量占比」变成假的时间序列。该表已有 64 行既有数据，保持不动。

## recRanks 的真实结构（文档只说了键名数量，没说层级）

**它是数组不是对象**，与同级的 `date[]` 按下标平行对齐：

    allRankHistory: {
      date:     ["2026-07-29", "2026-07-30", ...],      # 日期轴
      recRanks: [null, {"Customers frequently viewed": {...}}, ...]  # 逐日
    }

非 null 元素才是 `{专栏名: {campaignId, maskCampaignId}}`。
实测数组元素里共 **120 个 distinct 专栏名**，与文档的 119 一致。

（我最初按「对象」解析得到 0 个键 —— 类型判断错了一层，实测才发现。）

## 多语言归一

文档实测 141 个专栏名里约 10 个是同一专栏的德/法语变体。
本脚本把已确认的映射归一到英文主名，并把原文记进 display_name_cn 之外的
`short_code` 分类里；未确认的长尾保持原样（宁可留长尾，不要错并）。

用法：
    python scripts/etl_module3_reccolumn.py [--dry] [--only dim|rel]
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


BATCH = 1000
NOW = dt.datetime.now().replace(microsecond=0)


def log(msg):
    print('[%s] %s' % (dt.datetime.now().strftime('%H:%M:%S'), msg), flush=True)


def clip(s, n):
    if s is None:
        return None
    s = str(s)
    return s[:n] if len(s) > n else s


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
# 专栏名归一与分类
# ======================================================================

# 已确认的多语言变体 → 英文主名（文档实测列出的那几个）。
# 只收录能确认对应关系的；长尾类目模板不并（宁可留长尾，不要错并）。
ALIAS = {
    'Von Kunden häufig angesehen': 'Customers frequently viewed',
    'Fréquemment consulté par les clients': 'Customers frequently viewed',
    'Auswahl aus sozialen Medien': 'Seen on social media',
    'Choix sur les réseaux sociaux': 'Seen on social media',
    'Hoch bewertet': 'Highly rated',
}

# short_code 的 9 个枚举只覆盖高频的十几个专栏，长尾一律归 other（文档结论）。
# 这里同时给中文名 —— 上游的 wholeName 实测 33/33 等于英文原文，中文只能自造。
KNOWN = {
    'Customers frequently viewed': ('fView', '顾客常看'),
    '4 stars and above': ('4Star', '四星以上'),
    'Seen on social media': ('social', '社交媒体推荐'),
    'Highly rated': ('hiRate', '高分好评'),
    'New arrivals': ('New', '新品上架'),
    'Picks from Amazon Influencers': ('KOL', '达人推荐'),
    "Today's deals": ('deal', '今日特惠'),
    'Trending now': ('trend', '当下热门'),
    'Trending styles': ('trend', '流行款式'),
    'Inspired by similar searches': ('simSrch', '相似搜索推荐'),
    'Other items to consider': ('other', '其他可选'),
    'Recently bought and rated': ('recBuy', '近期购买并评价'),
    'Best Sellers': ('BS', '畅销榜'),
    'Related searches': ('relSrch', '相关搜索'),
}


def normalize(title):
    """归一专栏名，返回 (rec_title, short_code, display_name_cn)。"""
    t = str(title).strip()
    t = ALIAS.get(t, t)
    code, cn = KNOWN.get(t, (None, None))
    if code is None:
        # 长尾是 Shop/Explore/Discover/Find/Browse + <类目词> 的模板，
        # 会随类目无限增长，统一归 other；中文名留原文，前端至少能显示
        code, cn = 'other', t
    return clip(t, 255), clip(code, 16), clip(cn, 255)


# ======================================================================
# dim_recommend_column：四源并集
# ======================================================================

# 源 1（主力）：recRanks 数组元素的对象键。实测 120 个 distinct。
SQL_SRC_RECRANKS = """
SELECT upper(k.site) AS country, kv.key AS rec_title,
       min(k.fetched_at) AS first_seen, max(k.fetched_at) AS last_seen
FROM sif_asin_keyword k
CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(k.raw->'allRankHistory'->'recRanks') = 'array'
         THEN k.raw->'allRankHistory'->'recRanks' ELSE '[]'::jsonb END) el
CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(el) = 'object' THEN el ELSE '{}'::jsonb END) kv
GROUP BY 1, 2
"""

# 源 2：change_reasons[].recTitle（我最初唯一找到的源，仅 16 个）
SQL_SRC_CHANGE = """
SELECT upper(c.site) AS country, el->>'recTitle' AS rec_title,
       min(c.fetched_at) AS first_seen, max(c.fetched_at) AS last_seen
FROM sif_asin_traffic_change c
CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(c.change_reasons) = 'array'
         THEN c.change_reasons ELSE '[]'::jsonb END) el
WHERE el->>'recTitle' IS NOT NULL
GROUP BY 1, 2
"""

# 源 3：asin-keyword-rank-history 的 recSpRankHistories 对象键（25 个，时间跨度最长）
SQL_SRC_RANKHIST = """
SELECT upper(l.site) AS country, kv.key AS rec_title,
       min(l.fetched_at) AS first_seen, max(l.fetched_at) AS last_seen
FROM sif_api_log l
CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(l.resp->'data'->'recSpRankHistories') = 'object'
         THEN l.resp->'data'->'recSpRankHistories' ELSE '{}'::jsonb END) kv
WHERE l.endpoint = 'asin-keyword-rank-history' AND l.ok
GROUP BY 1, 2
"""

# 源 4：web-asin-flow-overview 的 recommend 对象键（33 个，带 ratio/score）
SQL_SRC_FLOW = """
SELECT upper(l.site) AS country, kv.key AS rec_title,
       min(l.fetched_at) AS first_seen, max(l.fetched_at) AS last_seen
FROM sif_api_log l
CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(l.resp->'data'->'recommend') = 'object'
         THEN l.resp->'data'->'recommend' ELSE '{}'::jsonb END) kv
WHERE l.endpoint = 'web-asin-flow-overview' AND l.ok
GROUP BY 1, 2
"""


def run_dim(pg, doris, dry):
    w = Writer(doris, 'dim_recommend_column',
               ['rec_title', 'country', 'short_code', 'display_name_cn',
                'first_seen_at', 'last_seen_at'], dry)
    cur = pg.cursor()
    merged = {}
    per_src = {}
    for name, sql in (('recRanks', SQL_SRC_RECRANKS),
                      ('change_reasons', SQL_SRC_CHANGE),
                      ('rank-history', SQL_SRC_RANKHIST),
                      ('flow-overview', SQL_SRC_FLOW)):
        cur.execute(sql)
        rows = cur.fetchall()
        per_src[name] = len(set(r[1] for r in rows if r[1]))
        for country, title, first_seen, last_seen in rows:
            if not title or not str(title).strip():
                continue
            rec_title, _, _ = normalize(title)
            key = (rec_title, country or 'US')
            prev = merged.get(key)
            if prev is None:
                merged[key] = [first_seen, last_seen]
            else:
                # 并集：first_seen 取最早、last_seen 取最晚
                if first_seen and (prev[0] is None or first_seen < prev[0]):
                    prev[0] = first_seen
                if last_seen and (prev[1] is None or last_seen > prev[1]):
                    prev[1] = last_seen
    cur.close()

    for (rec_title, country), (first_seen, last_seen) in merged.items():
        _, code, cn = normalize(rec_title)
        w.add([rec_title, country, code, cn,
               first_seen or NOW, last_seen or NOW])
    w.flush()
    log('dim_recommend_column：各源 distinct = %s' %
        ', '.join('%s=%d' % (k, v) for k, v in per_src.items()))
    log('  并集 %d 个 (rec_title, country) → 写入 %d 行'
        % (len(merged), w.total))
    return {'dim_recommend_column': w.total}


# ======================================================================
# rel_rec_column_campaign_keyword：专栏 × 广告活动 × 关键词
# ======================================================================

# recRanks 数组元素是 {专栏名: {campaignId, maskCampaignId}}，
# 而 asin / keyword / keyword_id 来自 sif_asin_keyword 的行本身 ——
# 这就凑齐了主键 (asin, country, rec_title, keyword, encrypt_campaign_id)。
SQL_REL = """
SELECT upper(k.site)   AS country,
       k.asin          AS asin,
       k.keyword       AS keyword,
       k.keyword_id    AS keyword_id,
       kv.key          AS rec_title,
       kv.value->>'campaignId'     AS campaign_id,
       kv.value->>'maskCampaignId' AS mask_campaign_id
FROM sif_asin_keyword k
CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(k.raw->'allRankHistory'->'recRanks') = 'array'
         THEN k.raw->'allRankHistory'->'recRanks' ELSE '[]'::jsonb END) el
CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(el) = 'object' THEN el ELSE '{}'::jsonb END) kv
WHERE kv.value->>'campaignId' IS NOT NULL
"""


def run_rel(pg, doris, dry):
    w = Writer(doris, 'rel_rec_column_campaign_keyword',
               ['asin', 'country', 'rec_title', 'keyword',
                'encrypt_campaign_id', 'keyword_id', 'mask_campaign_id',
                'created_at'], dry)
    cur = pg.cursor(name='rel_cur')
    cur.itersize = 5000
    cur.execute(SQL_REL)
    seen = set()
    n = 0
    for country, asin, keyword, keyword_id, rec_title, campaign_id, mask_id in cur:
        n += 1
        kw = clip(str(keyword).strip().lower(), 128) if keyword else None
        if not kw or not asin or not campaign_id:
            continue
        title, _, _ = normalize(rec_title)
        key = (asin, country, title, kw, campaign_id)
        if key in seen:
            continue
        seen.add(key)
        w.add([asin, country, title, kw, clip(campaign_id, 64), keyword_id,
               clip(mask_id, 16), NOW])
    cur.close()
    w.flush()
    log('rel_rec_column_campaign_keyword：读 %d 个元素 → 去重后 %d 行' % (n, w.total))
    return {'rel_rec_column_campaign_keyword': w.total}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', action='append', default=[], choices=['dim', 'rel'])
    ap.add_argument('--dry', action='store_true')
    args = ap.parse_args()
    want = set(args.only) if args.only else {'dim', 'rel'}
    log('模块 3 推荐专栏 ETL%s | 目标: %s'
        % ('（dry-run）' if args.dry else '', ', '.join(sorted(want))))

    pg = psycopg2.connect(**pg_dsn())
    pg.set_session(readonly=True)
    doris = pymysql.connect(**doris_dsn())
    stats = {}
    try:
        if 'dim' in want:
            stats.update(run_dim(pg, doris, args.dry))
        if 'rel' in want:
            stats.update(run_rel(pg, doris, args.dry))
    finally:
        pg.close()
        doris.close()

    log('%s完成：' % ('预演' if args.dry else '写入'))
    for t in sorted(stats):
        print('  %8d  %s' % (stats[t], t))


if __name__ == '__main__':
    main()

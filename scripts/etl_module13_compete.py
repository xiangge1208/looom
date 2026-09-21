# -*- coding: utf-8 -*-
"""
M13 /compete 流量位竞争格局 ETL：PG(amazon_data) → Doris(looom)

目标表：rel_keyword_asin_traffic_share（关键词 × ASIN × 8 个流量位份额）
建表依据：db/schema-07-m13-rework.sql §4
审计依据：docs/SIF_UI_AUDIT_2026-09-21.md §2、§11.9

## 源就绪度：🟡 真实但覆盖极窄

    web-compete-pattern   753 条请求 / 82 条 ok
      其中 asins = null    60 条   ← 73% 的成功响应是空的
          asins = array    22 条   ← 1,637 行，覆盖 9 个去重关键词

⚠️ **82 是 ok=true 的计数，不是有数据的计数**。判断源就绪度不能只看 SUM(ok)，
要看目标数组的 jsonb_typeof —— 这条教训写在 AUDIT §11.9。

9 个词够验证 ETL 与前端渲染，但演示时大量词查不到。灌完真实数据后
需要 seed 补覆盖（走 gen-seed-unbuilt.mjs），靠 source 列区分 real/seed。

## 三个必须照做的口径

1. **源响应无周维度**。data 顶层只有 total/boughtMonth/dutyFinishDate。
   所以 stat_date 是**抓取日**且**不进主键**，语义是「最近一次抓取的竞争格局」。
   主键 (keyword, country, asin) —— 同词同 ASIN 被多次抓取时后写覆盖前写。

2. **源字段有两处拼写错误，照抄不要「修正」**：
       vedioAdScoreRatio   ← video 误拼 vedio
       hasVaiants          ← variants 误拼
   列名用正确拼写，取值时用源侧拼写。

3. **数据是分页的**。同一个词有多条日志（pageNum 1..N，每页 50~100 行），
   必须**合并所有页**而不是只取最新一条 —— 只取一条会丢掉 90% 的 ASIN。
   实测 classroom caddy 有 9 页共 417 行。

## ASIN 属性冗余存，不 JOIN dim_asin

实测 1,142 个去重 ASIN 里只有 283 个在 dim_asin（缺 859 个 = 75%）。
/compete 页的图片列是核心内容，JOIN 取会让四分之三的行没图。
所以 title/img/price 等 7 列冗余存在本表。详见 AUDIT §12.5b。

用法：
    python scripts/etl_module13_compete.py [--dry]
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

COLS = ['keyword', 'country', 'asin', 'rank_position', 'title', 'img', 'price',
        'rating_num', 'star', 'score', 'bought_in_past_month',
        'nf_score_ratio', 'sp_score_ratio', 'sp_rec_score_ratio',
        'brand_ad_score_ratio', 'video_ad_score_ratio', 'ac_score_ratio',
        'er_score_ratio', 'tr_score_ratio',
        'has_variants', 'is_focus', 'ac', 'stat_date', 'source', 'created_at']

# 按 fetched_at 升序：同词同 ASIN 后写覆盖前写，留下最新一次抓取的值。
# jsonb_typeof 守卫必须保留 —— 60/82 条响应的 asins 是 null，
# 不守卫会报 "cannot extract elements from a scalar"（ETL_GAP_ANALYSIS.md:33 的教训）。
SQL = """
SELECT upper(l.site) AS country,
       btrim(lower(l.params->>'keyword')) AS keyword,
       l.fetched_at::date AS fetched_date,
       a->>'asin', a->>'title', a->>'img', a->>'price',
       a->>'ratingNum', a->>'star', a->>'score', a->>'boughtInPastMonth',
       a->>'nfScoreRatio', a->>'spScoreRatio', a->>'spRecScoreRatio',
       a->>'brandAdScoreRatio', a->>'vedioAdScoreRatio', a->>'acScoreRatio',
       a->>'erScoreRatio', a->>'trScoreRatio',
       a->>'hasVaiants', a->>'isFocus', a->>'ac'
FROM sif_api_log l
CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(l.resp->'data'->'asins') = 'array'
         THEN l.resp->'data'->'asins' ELSE '[]'::jsonb END) a
WHERE l.endpoint = 'web-compete-pattern' AND l.ok
  AND l.params->>'keyword' IS NOT NULL
  AND a->>'asin' IS NOT NULL
ORDER BY l.fetched_at ASC
"""


def log(msg):
    print('[%s] %s' % (dt.datetime.now().strftime('%H:%M:%S'), msg), flush=True)


def clip(s, n):
    if s is None:
        return None
    s = str(s)
    return s[:n] if len(s) > n else s


def num(v):
    if v is None or v == '':
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def to_int(v):
    f = num(v)
    return None if f is None else int(f)


def to_bool(v):
    """源里 true/false 直接来自 JSON，转成字符串后是 'true'/'false'"""
    if v is None:
        return None
    return 1 if str(v).lower() == 'true' else 0


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry', action='store_true', help='只读不写，核对行数')
    args = ap.parse_args()
    log('M13 /compete 份额 ETL%s' % ('（dry-run）' if args.dry else ''))

    pg = psycopg2.connect(**pg_dsn())
    pg.set_session(readonly=True)
    doris = pymysql.connect(**doris_dsn())
    try:
        w = Writer(doris, 'rel_keyword_asin_traffic_share', COLS, args.dry)
        pcur = pg.cursor(name='compete_pattern_cur')
        pcur.itersize = 5000
        pcur.execute(SQL)

        # (keyword, country, asin) -> 该组合的最后一行。
        # SQL 已按 fetched_at 升序，dict 后写覆盖前写，留下最新抓取的值。
        # 不能边读边 add —— 同词多页里同一个 ASIN 可能重复出现，
        # 直接写会产生重复行（Doris 会覆盖，但白白多写一倍）。
        merged = {}
        raw_n = 0
        for row in pcur:
            (country, kw, fetched, asin, title, img, price, rating, star,
             score, bought, nf, sp, sprec, brand, video, ac_r, er, tr,
             has_var, is_focus, ac) = row
            k = clip(kw, 128)
            if not k or not country or not asin:
                continue
            raw_n += 1
            merged[(k, country, asin)] = [
                k, country, clip(asin, 16),
                None,                       # rank_position 见下方说明
                clip(title, 512), clip(img, 512), num(price),
                to_int(rating), num(star), num(score), clip(bought, 32),
                num(nf), num(sp), num(sprec), num(brand), num(video),
                num(ac_r), num(er), num(tr),
                to_bool(has_var),
                None,                       # is_focus：原站的用户态，不灌
                clip(ac, 64), fetched, 'real', NOW,
            ]
        pcur.close()
        log('  源行 %d，去重后 %d 个 (词,站点,ASIN)' % (raw_n, len(merged)))

        # rank_position：页面「#」列，按自然份额降序编号（页面说明「默认以自然流量份额排序」）。
        # 源响应里没有这个字段 —— 它是分页序号的产物，跨页合并后已失真，
        # 所以这里按 nf_score_ratio 重新算，与页面排序口径一致。
        by_kw = {}
        for key, row in merged.items():
            by_kw.setdefault((key[0], key[1]), []).append(row)
        for rows in by_kw.values():
            rows.sort(key=lambda r: (r[11] is None, -(r[11] or 0)))
            for i, r in enumerate(rows, 1):
                r[3] = i

        for rows in by_kw.values():
            for r in rows:
                w.add(r)
        w.flush()

        log('  覆盖 %d 个关键词' % len(by_kw))
        log('%s完成：%d 行 → rel_keyword_asin_traffic_share'
            % ('预演' if args.dry else '写入', w.total))
    finally:
        pg.close()
        doris.close()


if __name__ == '__main__':
    main()

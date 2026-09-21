# -*- coding: utf-8 -*-
"""
rel_keyword_top_asin ETL —— PG(amazon_data) → Doris(looom)

一张表：关键词 → 该词下的 ASIN 榜（原站「查关键词」页的搜索结果列表）。

源：`sif_api_log`[endpoint='web-sales-keyword'] → `data.asins[]`
实测 52,120 行、2,062 个关键词、36,027 个 ASIN。

## 排名用数组下标

`asins[]` 元素**自身不带排名字段**，但数组顺序就是原站的展示顺序
（实测同一关键词多次抓取顺序稳定）。所以用 WITH ORDINALITY 取下标作为
rank_position —— 这是「第几位」的唯一来源。

⚠️ 同一关键词被抓过多次（2,062 个词 / 3,240 条日志），主键
(keyword, country, asin) 只能留一行。取**最近一次抓取**的排名：
旧快照的排名已经过时，而 upsert 无法表达「哪次更新」。

## 未落的两张表

`rel_keyword_group` / `fact_word_frequency` **确证无源**：
唯一候选 `web-keyword-extend` 实测返回的是 CPC 竞价数据
（`cpc.autoForSales_broad[].median` 这种），既没有 group_id 也没有词根词频。
建表是空表，不做。

用法：
    python scripts/etl_keyword_top_asin.py [--dry]
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


def log(msg):
    print('[%s] %s' % (dt.datetime.now().strftime('%H:%M:%S'), msg), flush=True)


def clip(s, n):
    if s is None:
        return None
    s = str(s)
    return s[:n] if len(s) > n else s


def to_price(v):
    if v is None or v == '':
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    # DECIMAL(12,2) 的量级上限，超了整批 INSERT 会失败
    return None if abs(f) >= 10 ** 10 else round(f, 2)


# ORDER BY l.id 保证后读到的是较新抓取，Python 侧后写覆盖先写 →
# 主键上留下的自然是最近一次的排名
SQL = """
SELECT upper(l.site)              AS country,
       btrim(lower(l.params->>'keyword')) AS keyword,
       el->>'asin'                AS asin,
       ord::int                   AS rank_position,
       el->>'img'                 AS img,
       el->>'title'               AS title,
       el->>'price'               AS price
FROM sif_api_log l
CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(l.resp->'data'->'asins') = 'array'
         THEN l.resp->'data'->'asins' ELSE '[]'::jsonb END)
    WITH ORDINALITY AS t(el, ord)
WHERE l.endpoint = 'web-sales-keyword' AND l.ok
  AND l.params->>'keyword' IS NOT NULL
  AND el->>'asin' IS NOT NULL
ORDER BY l.id
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry', action='store_true')
    args = ap.parse_args()
    log('rel_keyword_top_asin ETL%s' % ('（dry-run）' if args.dry else ''))

    pg = psycopg2.connect(**pg_dsn())
    pg.set_session(readonly=True)
    doris = pymysql.connect(**doris_dsn())

    cols = ['keyword', 'country', 'asin', 'keyword_id', 'rank_position',
            'img', 'title', 'price', 'created_at']
    head = 'INSERT INTO `rel_keyword_top_asin` (%s) VALUES ' % \
           ', '.join('`%s`' % c for c in cols)
    ph = '(' + ', '.join(['%s'] * len(cols)) + ')'

    try:
        # keyword_id 从 dim_keyword 反查（该表已由模块 5 灌入 13,070 个词）
        dcur = doris.cursor()
        dcur.execute('SELECT keyword, country, keyword_id FROM dim_keyword '
                     'WHERE keyword_id IS NOT NULL')
        kid_map = {(r[0], r[1]): r[2] for r in dcur.fetchall()}
        dcur.close()
        log('dim_keyword 反查表 %d 条' % len(kid_map))

        cur = pg.cursor(name='top_cur')
        cur.itersize = 5000
        cur.execute(SQL)

        # 主键 (keyword,country,asin) → 行，后写覆盖先写（即保留最新抓取）
        best = {}
        n = 0
        for country, keyword, asin, rank_position, img, title, price in cur:
            n += 1
            kw = clip(keyword, 128)
            if not kw or not asin:
                continue
            best[(kw, country, clip(asin, 16))] = (
                rank_position, clip(img, 512), clip(title, 1024), to_price(price))
            if n % 20000 == 0:
                log('  已读 %d 行' % n)
        cur.close()

        rows = []
        with_kid = 0
        for (kw, country, asin), (rank, img, title, price) in best.items():
            kid = kid_map.get((kw, country))
            if kid is not None:
                with_kid += 1
            rows.append([kw, country, asin, kid, rank, img, title, price, NOW])

        total = 0
        if not args.dry:
            dcur = doris.cursor()
            for i in range(0, len(rows), BATCH):
                chunk = rows[i:i + BATCH]
                dcur.execute(head + ', '.join([ph] * len(chunk)),
                             [v for r in chunk for v in r])
                total += len(chunk)
            dcur.close()
        else:
            total = len(rows)

        log('读 %d 行 → 去重后 %d 行（keyword_id 命中 %d = %.1f%%）'
            % (n, total, with_kid, 100.0 * with_kid / max(len(rows), 1)))
        log('%s完成：\n  %8d  rel_keyword_top_asin'
            % ('预演' if args.dry else '写入', total))
    finally:
        pg.close()
        doris.close()


if __name__ == '__main__':
    main()

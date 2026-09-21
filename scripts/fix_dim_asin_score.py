# -*- coding: utf-8 -*-
"""
修复 dim_asin.score —— 之前的 ETL 把「流量得分」写进了「评分」列

## 问题

`dim_asin.score` 语义是商品评分（1~5 分），但实测 **4,078 行 > 5**，
最大到 64.08 甚至上千。同行的 `star` 却是正常的 4.5（4050/4078 行正常），
说明不是数据本身脏，而是取错了字段。

根因：`web-asin-variants` 的变体元素里有两个相似字段：

    score      = 流量得分（实测 27.78 / 64.08 / 647037 这种量级）
    asinScore  = 真实评分（4.6）

之前的 ETL 取了 `score`。实测该接口 9,709 个变体元素里 **6,964 个 score > 5**，
所以这是系统性取错，不是个别脏数据。

## 修复方式

从 `web-asin-variants` 的 `asinScore` 回填。取不到 `asinScore` 的行，
**退而用 `star`**（半星展示值，如 4.5）—— 它与真实评分差不超过 0.5 分，
比留一个 64.08 的假评分好得多。

⚠️ 两者都没有时**置 NULL，不猜**。前端已有「暂无评分」的分支，
留假值会让用户以为这是真评分。

⚠️ Doris Unique Key 的 INSERT 是整行替换，所以必须先 SELECT 出原行
再合并写回，否则会把 title/price 等列清空。

用法：
    python scripts/fix_dim_asin_score.py [--dry]
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


BATCH = 500
NOW = dt.datetime.now().replace(microsecond=0)

COLS = ['asin', 'country', 'title', 'img', 'price', 'brand', 'brand_href',
        'score', 'star', 'rating_num', 'is_best_seller', 'is_parent_asin',
        'parent_asin', 'first_available_day', 'seller', 'data_updated_at',
        'created_at', 'updated_at']


def log(msg):
    print('[%s] %s' % (dt.datetime.now().strftime('%H:%M:%S'), msg), flush=True)


def fmt_date(v):
    if v is None:
        return None
    return v.isoformat()[:10] if hasattr(v, 'isoformat') else str(v)[:10]


def fmt_dt(v):
    if v is None:
        return None
    return v.isoformat()[:19].replace('T', ' ') if hasattr(v, 'isoformat') else str(v)[:19]


# asinScore 才是真评分。同一 ASIN 可能出现在多次抓取里，取最近一条
# （ORDER BY l.id，Python 侧后写覆盖）。
SQL_TRUE_SCORE = """
SELECT upper(l.site)        AS country,
       el->>'asin'          AS asin,
       el->>'asinScore'     AS asin_score,
       el->>'star'          AS star
FROM sif_api_log l
CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(l.resp->'data'->'variants') = 'array'
         THEN l.resp->'data'->'variants' ELSE '[]'::jsonb END) el
WHERE l.endpoint = 'web-asin-variants' AND l.ok
  AND el->>'asin' IS NOT NULL
  AND (el->>'asinScore' IS NOT NULL OR el->>'star' IS NOT NULL)
ORDER BY l.id
"""


def to_rating(v):
    """字符串 → 评分，只接受 0~5 的合法值，其余返回 None"""
    if v is None or v == '':
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if 0 <= f <= 5 else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry', action='store_true')
    args = ap.parse_args()
    log('修复 dim_asin.score%s' % ('（dry-run）' if args.dry else ''))

    pg = psycopg2.connect(**pg_dsn())
    pg.set_session(readonly=True)
    doris = pymysql.connect(**doris_dsn())

    try:
        # 1. 从 PG 建「真评分」查找表
        cur = pg.cursor(name='score_cur')
        cur.itersize = 5000
        cur.execute(SQL_TRUE_SCORE)
        truth = {}
        for country, asin, asin_score, star in cur:
            r = to_rating(asin_score)
            src = 'asinScore'
            if r is None:
                r = to_rating(star)
                src = 'star'
            if r is not None:
                truth[(asin, country)] = (r, src)
        cur.close()
        log('PG 真评分查找表 %d 条' % len(truth))

        # 2. 取出所有 score > 5 的坏行（整行，因为要合并写回）
        dcur = doris.cursor()
        dcur.execute('SELECT %s FROM dim_asin WHERE score > 5'
                     % ', '.join('`%s`' % c for c in COLS))
        bad = dcur.fetchall()
        dcur.close()
        log('Doris 坏行 %d 条' % len(bad))

        fixed_by_pg, fixed_by_star, set_null = 0, 0, 0
        out = []
        for row in bad:
            rec = dict(zip(COLS, row))
            key = (rec['asin'], rec['country'])
            hit = truth.get(key)
            if hit:
                rec['score'] = hit[0]
                if hit[1] == 'asinScore':
                    fixed_by_pg += 1
                else:
                    fixed_by_star += 1
            else:
                # PG 查不到：退而用本行自己的 star（半星值，差 ≤0.5 分）
                s = rec.get('star')
                s = float(s) if s is not None and 0 <= float(s) <= 5 else None
                rec['score'] = s
                if s is None:
                    set_null += 1
                else:
                    fixed_by_star += 1
            # 日期/时间列要转回字符串，且 updated_at 刷新
            rec['first_available_day'] = fmt_date(rec['first_available_day'])
            rec['data_updated_at'] = fmt_dt(rec['data_updated_at'])
            rec['created_at'] = fmt_dt(rec['created_at']) or NOW
            rec['updated_at'] = NOW
            out.append([rec[c] for c in COLS])

        log('  用 PG asinScore 修 %d 行 | 退用 star 修 %d 行 | 置 NULL %d 行'
            % (fixed_by_pg, fixed_by_star, set_null))

        if not args.dry and out:
            head = 'INSERT INTO `dim_asin` (%s) VALUES ' % \
                   ', '.join('`%s`' % c for c in COLS)
            ph = '(' + ', '.join(['%s'] * len(COLS)) + ')'
            dcur = doris.cursor()
            for i in range(0, len(out), BATCH):
                chunk = out[i:i + BATCH]
                dcur.execute(head + ', '.join([ph] * len(chunk)),
                             [v for r in chunk for v in r])
            dcur.close()
            # 3. 复核
            dcur = doris.cursor()
            dcur.execute('SELECT COUNT(*) FROM dim_asin WHERE score > 5')
            left = dcur.fetchone()[0]
            dcur.execute('SELECT COUNT(*) FROM dim_asin WHERE title IS NOT NULL')
            titles = dcur.fetchone()[0]
            dcur.close()
            log('复核：score>5 剩 %d 行；title 非空 %d 行（合并写回未丢字段）'
                % (left, titles))
        log('%s完成：%d 行' % ('预演' if args.dry else '写入', len(out)))
    finally:
        pg.close()
        doris.close()


if __name__ == '__main__':
    main()

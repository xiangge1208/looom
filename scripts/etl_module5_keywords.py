# -*- coding: utf-8 -*-
"""
模块 5「反查流量词」ETL —— PG(amazon_data) → Doris(looom)

对应 docs/MODULE_DATA_FLOW.md 模块 5，本脚本覆盖 3 张表：

    dim_keyword                 ← sif_asin_keyword（关键词主档）
    fact_asin_keyword_snapshot  ← sif_asin_keyword（ASIN×关键词 主表）
    fact_asin_keyword_score     ← sif_asin_keyword.raw->'scoreInfo'（只落 total 渠道）

## 为什么 fact_asin_keyword_score 只落 total 一个渠道

文档实测结论：`sif_asin_keyword` 里的 `scoreInfo` 是**单一汇总得分，不分渠道**。
分渠道数据确实在别处（`sif_asin_keyword_diagnose.p_change_reason`），但那是
**排名/频次**（rankAvg/inFre）而非得分，语义不同；`web-traffic-diagnose.extraData`
有真正的分渠道得分，但那是 **ASIN 级**不是关键词级。
两者都不能直接填进「ASIN×关键词×渠道」的三维表 —— 强行填会让同一列混入
三种不同语义的数值。所以这里只落 channel='total'，等业务裁决后再补。

## 时间片主键的来源（文档指出这是最大的坑）

`time_piece_type/value/is_listing_search` 三个主键成员在 PG 里覆盖率仅
1.39%/1.39%/0.76%，文档要求「ETL 按抓取批次赋常量」。

这里改用 **piece_max_time 推导月份**（该列 100% 填充，实测只落在
2026-08 / 2026-09 两个月）—— 比赋死常量更有依据，也让同一 ASIN 不同
批次的数据能按月份自然区分开，而不是全挤进一个常量键里互相覆盖。

用法：
    python scripts/etl_module5_keywords.py [--dry] [--asin B0XXX] [--only dim|snapshot|score]

PG 连接只读。
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

# 曝光位渠道码归一。
# ⚠️ PG 实测值是 recSp（4069 行），Doris 字典和前端用的都是 spRec ——
#    文档原话「拼写相反必须映射」。不映射页面会直接显示原始码。
CHANNEL_ALIAS = {'recSp': 'spRec'}


def log(msg):
    print('[%s] %s' % (dt.datetime.now().strftime('%H:%M:%S'), msg), flush=True)


def f(v):
    return None if v is None else float(v)


def clip(s, n):
    if s is None:
        return None
    s = str(s)
    return s[:n] if len(s) > n else s


def norm_kw(k):
    """关键词归一：btrim(lower())，与 schema-04 的约定一致。

    主键是 (keyword, country)，不归一会让 'Pink Sweatsuit' 和
    'pink sweatsuit' 变成两行。
    """
    return None if k is None else str(k).strip().lower()


def jnum(node, key):
    """从 JSON 对象取数值，取不到返回 None（不返回 0 冒充）"""
    if not isinstance(node, dict):
        return None
    v = node.get(key)
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v)


class Writer:
    """分批写入 Doris（同 etl_module4_traffic.py）"""

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
# 一次扫表，分三路写出
# ======================================================================

SQL_KEYWORDS = """
SELECT upper(site) AS country, asin, keyword, keyword_id, translate_keyword,
       piece_max_time,
       nf_last_rank, nf_last_rank_date,
       sp_last_rank, sp_last_rank_date, sp_campaign_id,
       exposure_positions,
       raw->'scoreInfo'            AS score_info,
       raw->>'monthSearchVolume'   AS month_search_volume,
       raw->>'nfLastRankAsin'      AS nf_last_rank_asin,
       raw->>'spLastRankAsin'      AS sp_last_rank_asin,
       raw->>'nfLastRankTimeStr'   AS nf_last_rank_time_str,
       raw->>'spLastRankTimeStr'   AS sp_last_rank_time_str,
       raw->'keywordTags'          AS keyword_tags
FROM sif_asin_keyword
WHERE TRUE {asin_filter}
"""


def run(pg, doris, asins, dry, want):
    dim_w = Writer(doris, 'dim_keyword',
                   ['keyword', 'country', 'keyword_id', 'translate_keyword',
                    'est_searches_num', 'created_at', 'updated_at'], dry)
    snap_w = Writer(doris, 'fact_asin_keyword_snapshot',
                    ['asin', 'country', 'keyword', 'time_piece_type',
                     'time_piece_value', 'is_listing_search', 'keyword_id',
                     'is_core', 'is_target', 'piece_max_time',
                     'nf_last_rank', 'nf_last_rank_time', 'nf_last_rank_asin',
                     'sp_last_rank', 'sp_last_rank_time', 'sp_last_rank_asin',
                     'sp_campaign_id', 'listing_score_ratio',
                     'exposure_positions', 'est_searches_num', 'created_at'], dry)
    score_w = Writer(doris, 'fact_asin_keyword_score',
                     ['asin', 'country', 'keyword', 'time_piece_type',
                      'time_piece_value', 'channel', 'keyword_id', 'score',
                      'score_ratio', 'score_change', 'score_change_ratio',
                      'contri_change_ratio', 'created_at'], dry)

    flt, params = '', []
    if asins:
        flt = 'AND asin IN %s'
        params.append(tuple(asins))

    cur = pg.cursor(name='kw_cur')
    cur.itersize = 5000
    cur.execute(SQL_KEYWORDS.format(asin_filter=flt), params)

    # dim_keyword 按 (keyword,country) 去重：19090 行里只有 13069 个不同关键词，
    # 不去重会产生 6000 多条无谓的重复 upsert
    dim_seen = {}
    snap_seen = set()
    n = 0
    skipped_no_kw = 0

    for row in cur:
        (country, asin, keyword, keyword_id, translate_keyword, piece_max_time,
         nf_rank, nf_rank_date, sp_rank, sp_rank_date, sp_campaign_id,
         exposure_positions, score_info, msv, nf_rank_asin, sp_rank_asin,
         nf_time_str, sp_time_str, keyword_tags) = row
        n += 1

        kw = norm_kw(keyword)
        if not kw:
            skipped_no_kw += 1
            continue
        kw = clip(kw, 128)

        est = None
        if msv is not None:
            try:
                est = int(float(msv))
            except (TypeError, ValueError):
                est = None

        # ---- dim_keyword ----
        if 'dim' in want:
            dk = (kw, country)
            prev = dim_seen.get(dk)
            # 同一关键词多行时，补齐各自缺的字段（translate 99%、msv 75.8%）
            if prev is None:
                dim_seen[dk] = [keyword_id, clip(translate_keyword, 512), est]
            else:
                if prev[0] is None:
                    prev[0] = keyword_id
                if prev[1] is None:
                    prev[1] = clip(translate_keyword, 512)
                if prev[2] is None:
                    prev[2] = est

        # ---- 时间片：由 piece_max_time 推导月份（该列 100% 填充）----
        if piece_max_time is None:
            continue
        tp_value = piece_max_time.strftime('%Y-%m')
        tp_type = 'month'
        is_ls = 0   # PG 无源（覆盖率 0.76%），统一按「非 listing 内搜索」

        # ---- fact_asin_keyword_snapshot ----
        if 'snapshot' in want:
            key = (asin, country, kw, tp_type, tp_value, is_ls)
            if key not in snap_seen:
                snap_seen.add(key)
                tags = keyword_tags if isinstance(keyword_tags, list) else []
                # exposure_positions 是 text[]，逗号拼接前先归一渠道码
                ep = None
                if exposure_positions:
                    ep = clip(','.join(
                        CHANNEL_ALIAS.get(p, p) for p in exposure_positions), 255)
                snap_w.add([
                    asin, country, kw, tp_type, tp_value, is_ls, keyword_id,
                    # 文档实测 isCore 有值但 100% 为 false、无区分度；
                    # 这里只认真实标签，不用 isMainKw 之类冒充核心词
                    1 if 'isCore' in tags else 0,
                    1 if 'isTarget' in tags else 0,
                    piece_max_time,
                    nf_rank,
                    # ⚠️ 只用 *TimeStr（日期串）。平铺的 nfLastRankTime 是
                    #    epoch 毫秒，直接 CAST 会得到 1970 年
                    nf_time_str or (nf_rank_date.isoformat() if nf_rank_date else None),
                    clip(nf_rank_asin, 16),
                    sp_rank,
                    sp_time_str or (sp_rank_date.isoformat() if sp_rank_date else None),
                    clip(sp_rank_asin, 16),
                    clip(sp_campaign_id, 64),
                    # listing_score_ratio 文档确证无源。但 scoreInfo.scoreRatio
                    # 正是「该词占本 Listing 流量的比例」，语义吻合且 100% 填充，
                    # 后端排序默认就按这一列 —— 留空页面排序会全平
                    jnum(score_info, 'scoreRatio'),
                    ep, est, NOW,
                ])

        # ---- fact_asin_keyword_score（只 total 渠道）----
        if 'score' in want and isinstance(score_info, dict):
            score_w.add([
                asin, country, kw, tp_type, tp_value, 'total', keyword_id,
                jnum(score_info, 'score'), jnum(score_info, 'scoreRatio'),
                jnum(score_info, 'scoreChange'),
                jnum(score_info, 'scoreChangeRatio'),
                jnum(score_info, 'contriChangeRatio'), NOW,
            ])

        if n % 5000 == 0:
            log('  已读 %d 行' % n)

    cur.close()

    if 'dim' in want:
        for (kw, country), (kid, tk, est) in dim_seen.items():
            dim_w.add([kw, country, kid, tk, est, NOW, NOW])
    dim_w.flush()
    snap_w.flush()
    score_w.flush()

    if skipped_no_kw:
        log('%d 行关键词为空，已跳过' % skipped_no_kw)
    log('读 %d 行 → dim_keyword %d, snapshot %d, score %d'
        % (n, dim_w.total, snap_w.total, score_w.total))
    return {'dim_keyword': dim_w.total,
            'fact_asin_keyword_snapshot': snap_w.total,
            'fact_asin_keyword_score': score_w.total}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--asin', action='append', default=[])
    ap.add_argument('--only', action='append', default=[],
                    choices=['dim', 'snapshot', 'score'])
    ap.add_argument('--dry', action='store_true')
    args = ap.parse_args()

    want = set(args.only) if args.only else {'dim', 'snapshot', 'score'}
    asins = set(args.asin) if args.asin else None
    log('模块 5 反查流量词 ETL%s | 目标: %s'
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

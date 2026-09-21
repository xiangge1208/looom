# -*- coding: utf-8 -*-
"""
模块 7-9「广告域」ETL —— PG(amazon_data) → Doris(looom)

对应 docs/MODULE_DATA_FLOW.md 模块 7-9，三张表：

    dim_ad_campaign            ← 四源并集的 campaignId（**只有 ID，属性无源**）
    dim_ad_product_ad          ← web-variant-ad-keywords 的 adIds[]（全库唯一 adId 源）
    rel_ad_campaign_product_ad ← 同源，**仅收无歧义配对**

`fact_ad_search_term_exposure` **不做**：文档实测四元组主键在 `keyword_id` 上
闭合不了 —— `web-variant-ad-keywords.keywords[]` 只有关键词文本没有 keywordId，
回查字典 835 个 keyword 仅 15 个可解（1.8%）。建表也是空表。

## 这三张表落地后仍然「做不了页面」，要说清楚

文档判定模块 7-9 是 🔴，原因不是没数据而是**只有 ID 没有属性**：
`ad_type` / `product_type` / `strategy` / `asin_num` / `ad_num` /
`campaign_created_at` / `last_ad_created_at` 七列确证无源（逐个搜过 0 命中）。

所以本脚本灌的是**ID 骨架**：页面能列出有哪些广告活动、哪些广告，
但「这个活动是什么类型、投了多少 ASIN」一律为空。
这比表全空要好（至少下钻链路能通），但别指望页面完整。

⚠️ **不给无源列编造默认值**。文档提到 `ad_type` 可从 JSON 分支反推
（spRank→1 / sbRank→2 / sbvRank→3，仅 303 个可推），本脚本**只对能反推的填**，
其余留 NULL 而不是「一律归 1」—— 全填 1 会让页面显示「全部都是 SP 广告」，
那是编造出来的结论。

## 配对的不可靠性（文档重点警告）

`campaignIds[]` 与 `adIds[]` 是**两个平行数组，无元素级对应关系**。
笛卡尔积能得 156 对，但只有 `campaignIdNum=1 AND adIdNum=1` 的行
才能给出无歧义配对。本脚本只收后者，其余丢弃。

用法：
    python scripts/etl_module789_ads.py [--dry] [--only campaign|ad|rel]
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
# dim_ad_campaign：campaignId 四源并集
# ======================================================================

# allRankHistory 的各 Rank 分支是主力源（实测并集 5,701 个）。
# 各分支同时决定 ad_type：spRank→1、sbRank→2、sbvRank→3。
# nfRank 是自然位不是广告，它的 campaignId 不参与 ad_type 推导。
SQL_CAMPAIGN_RANK = """
SELECT upper(k.site) AS country,
       el->>'campaignId'     AS campaign_id,
       el->>'maskCampaignId' AS mask_campaign_id,
       br                    AS branch
FROM sif_asin_keyword k
CROSS JOIN unnest(ARRAY['spRank', 'sbRank', 'sbvRank', 'nfRank']) AS br
CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(k.raw->'allRankHistory'->br) = 'array'
         THEN k.raw->'allRankHistory'->br ELSE '[]'::jsonb END) el
WHERE el->>'campaignId' IS NOT NULL
"""

# 平铺列 + spMaskCampaignId：天然成对，是 fake_campaign_id 的最佳源
# （文档实测 3,824 个，是 core/head-keywords 那条路的 15 倍）
SQL_CAMPAIGN_FLAT = """
SELECT upper(site) AS country, sp_campaign_id AS campaign_id,
       raw->>'spMaskCampaignId' AS mask_campaign_id
FROM sif_asin_keyword
WHERE sp_campaign_id IS NOT NULL
"""

# ⚠️ `sif_asin_traffic_daily.campaign_id` **不是 campaignId，是活动「数量」**。
#
# 文档把它列为 campaignId 的第四个源（34 个 distinct），但实测该列
# **24,518 行 100% 是纯数字、取值范围 1~82** —— 真正的 campaignId 形如
# `A08351851QIAUO9ZFHZF0`（20 位字母数字混合）。
# 把 '1'、'2'、'17' 当成加密活动 ID 灌进 dim_ad_campaign 会造出 34 条垃圾主键。
#
# 同源的 ad_id 列实测整列为空（0 个 distinct），文档也已标注。
#
# 这一路**不采**。该列的正确用途是「当日在投活动数」，
# 属于 fact_asin_op_event 的 campaignCnt 变化（见 etl_module6_timemachine.py）。

# rank-history 端点：226 个里 205 个是其他源没有的（文档实测）
SQL_CAMPAIGN_HIST = """
SELECT upper(l.site) AS country,
       el->>'campaignId'     AS campaign_id,
       el->>'maskCampaignId' AS mask_campaign_id,
       br                    AS branch
FROM sif_api_log l
CROSS JOIN unnest(ARRAY['spRankHistory', 'sbRankHistory', 'sbvRankHistory']) AS br
CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(l.resp->'data'->br) = 'array'
         THEN l.resp->'data'->br ELSE '[]'::jsonb END) el
WHERE l.endpoint = 'asin-keyword-rank-history' AND l.ok
  AND el->>'campaignId' IS NOT NULL
"""

# 分支名 → ad_type。nf 不参与（自然位不是广告类型）
BRANCH_AD_TYPE = {
    'spRank': 1, 'spRankHistory': 1,
    'sbRank': 2, 'sbRankHistory': 2,
    'sbvRank': 3, 'sbvRankHistory': 3,
}


def run_campaign(pg, doris, dry):
    w = Writer(doris, 'dim_ad_campaign',
               ['encrypt_campaign_id', 'country', 'fake_campaign_id', 'ad_type',
                'product_type', 'strategy', 'asin_num', 'ad_num',
                'campaign_created_at', 'last_ad_created_at',
                'created_at', 'updated_at'], dry)
    cur = pg.cursor()
    # key=(campaign_id,country) → {mask, ad_type}
    merged = {}
    per_src = {}

    def take(cid, country, mask, branch):
        if not cid:
            return
        s = str(cid).strip()
        # 长度守卫：真实 campaignId 要么是 20 位字母数字混合（SP，形如
        # A08351851QIAUO9ZFHZF0），要么是 13~15 位纯数字（SB/SBV，形如
        # 200000626476241）—— 二者都 >= 10 位。
        #
        # ⚠️ 不能简单地"排除纯数字"：实测 allRankHistory 里有 1,284 个纯数字
        #    campaignId 是**真 ID**（SB 广告就用数字 ID）。我第一版按
        #    `^[0-9]+$` 清理，误删了 1,353 条真实活动。
        #    真正的垃圾只有 traffic_daily 那列的 1~2 位「活动数量」（1~82）。
        if len(s) < 10:
            return
        k = (clip(s, 64), country or 'US')
        cur_rec = merged.setdefault(k, {'mask': None, 'ad_type': None})
        if mask and not cur_rec['mask']:
            cur_rec['mask'] = clip(mask, 16)
        t = BRANCH_AD_TYPE.get(branch)
        if t is not None and cur_rec['ad_type'] is None:
            cur_rec['ad_type'] = t

    cur.execute(SQL_CAMPAIGN_RANK)
    rows = cur.fetchall()
    per_src['allRankHistory'] = len(set(r[1] for r in rows))
    for country, cid, mask, branch in rows:
        take(cid, country, mask, branch)

    cur.execute(SQL_CAMPAIGN_FLAT)
    rows = cur.fetchall()
    per_src['sp_campaign_id'] = len(set(r[1] for r in rows))
    for country, cid, mask in rows:
        # 平铺列就是 SP 活动，ad_type=1
        take(cid, country, mask, 'spRank')

    cur.execute(SQL_CAMPAIGN_HIST)
    rows = cur.fetchall()
    per_src['rank-history'] = len(set(r[1] for r in rows))
    for country, cid, mask, branch in rows:
        take(cid, country, mask, branch)

    cur.close()

    typed = 0
    for (cid, country), rec in merged.items():
        if rec['ad_type'] is not None:
            typed += 1
        # ⚠️ product_type / strategy / asin_num / ad_num / 两个日期列
        #    文档逐个搜过 0 命中，确证无源 —— 留 NULL，不编造默认值
        w.add([cid, country, rec['mask'], rec['ad_type'],
               None, None, None, None, None, None, NOW, NOW])
    w.flush()
    log('dim_ad_campaign：各源 distinct = %s'
        % ', '.join('%s=%d' % (k, v) for k, v in per_src.items()))
    log('  并集 %d 个 → 写入 %d 行（其中 ad_type 可反推 %d 个，其余留 NULL）'
        % (len(merged), w.total, typed))
    return {'dim_ad_campaign': w.total}


# ======================================================================
# dim_ad_product_ad + rel_ad_campaign_product_ad
# ======================================================================

# web-variant-ad-keywords 是全库唯一的 adId 源（实测 82 个，仅 US）。
# keywords[] 每个元素带 adIds[] / campaignIds[] / adIdNum / campaignIdNum。
SQL_ADS = """
SELECT upper(l.site) AS country,
       l.fetched_at::date AS stat_date,
       kwel AS kw
FROM sif_api_log l
CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(l.resp->'data'->'keywords') = 'array'
         THEN l.resp->'data'->'keywords' ELSE '[]'::jsonb END) kwel
WHERE l.endpoint = 'web-variant-ad-keywords' AND l.ok
"""


def run_ads(pg, doris, dry, want):
    ad_w = Writer(doris, 'dim_ad_product_ad',
                  ['encrypt_ad_id', 'country', 'fake_ad_id', 'ad_created_at',
                   'created_at'], dry)
    rel_w = Writer(doris, 'rel_ad_campaign_product_ad',
                   ['encrypt_campaign_id', 'encrypt_ad_id', 'country',
                    'stat_date', 'created_at'], dry)

    cur = pg.cursor()
    cur.execute(SQL_ADS)
    rows = cur.fetchall()
    cur.close()

    ad_seen = {}
    rel_seen = set()
    ambiguous = 0

    for country, stat_date, kw in rows:
        if not isinstance(kw, dict):
            continue
        ad_ids = kw.get('adIds') or []
        camp_ids = kw.get('campaignIds') or []
        if not isinstance(ad_ids, list):
            ad_ids = []
        if not isinstance(camp_ids, list):
            camp_ids = []

        for aid in ad_ids:
            if aid:
                # fake_ad_id / ad_created_at 文档确证无源（搜 maskAdId 0 命中）
                ad_seen.setdefault((clip(aid, 64), country), True)

        # ⚠️ campaignIds[] 与 adIds[] 是两个平行数组，**无元素级对应关系**。
        #    只有各自恰好 1 个时配对才无歧义；多对多做笛卡尔积会造出假关系
        #    （文档实测笛卡尔积 156 对里只有 77 对可信）。
        if len(ad_ids) == 1 and len(camp_ids) == 1 and ad_ids[0] and camp_ids[0]:
            key = (clip(camp_ids[0], 64), clip(ad_ids[0], 64), country, stat_date)
            rel_seen.add(key)
        elif ad_ids and camp_ids:
            ambiguous += 1

    if 'ad' in want:
        for (aid, country) in ad_seen:
            ad_w.add([aid, country, None, None, NOW])
        ad_w.flush()
        log('dim_ad_product_ad：%d 个 adId（fake_ad_id/ad_created_at 无源，留 NULL）'
            % ad_w.total)

    if 'rel' in want:
        for (cid, aid, country, stat_date) in rel_seen:
            rel_w.add([cid, aid, country, stat_date, NOW])
        rel_w.flush()
        log('rel_ad_campaign_product_ad：%d 对无歧义配对（丢弃 %d 个多对多元素）'
            % (rel_w.total, ambiguous))

    out = {}
    if 'ad' in want:
        out['dim_ad_product_ad'] = ad_w.total
    if 'rel' in want:
        out['rel_ad_campaign_product_ad'] = rel_w.total
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', action='append', default=[],
                    choices=['campaign', 'ad', 'rel'])
    ap.add_argument('--dry', action='store_true')
    args = ap.parse_args()
    want = set(args.only) if args.only else {'campaign', 'ad', 'rel'}
    log('模块 7-9 广告域 ETL%s | 目标: %s'
        % ('（dry-run）' if args.dry else '', ', '.join(sorted(want))))
    log('⚠️ 本域只有 ID 有源，7 个属性列确证无源 —— 灌进去是 ID 骨架，页面仍不完整')

    pg = psycopg2.connect(**pg_dsn())
    pg.set_session(readonly=True)
    doris = pymysql.connect(**doris_dsn())
    stats = {}
    try:
        if 'campaign' in want:
            stats.update(run_campaign(pg, doris, args.dry))
        if 'ad' in want or 'rel' in want:
            stats.update(run_ads(pg, doris, args.dry, want))
    finally:
        pg.close()
        doris.close()

    log('%s完成：' % ('预演' if args.dry else '写入'))
    for t in sorted(stats):
        print('  %8d  %s' % (stats[t], t))


if __name__ == '__main__':
    main()

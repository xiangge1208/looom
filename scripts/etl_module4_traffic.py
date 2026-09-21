# -*- coding: utf-8 -*-
"""
模块 4「查流量结构」ETL —— PG(amazon_data) → Doris(looom)

对应 docs/MODULE_DATA_FLOW.md 模块 4 的 SQL1~SQL4，共 4 张表：

    fact_asin_traffic_channel   ← sif_asin_traffic_daily（7 列宽表 → 长表）
    fact_asin_listing_snapshot  ← sif_asin_traffic_daily（price/star/review/bsr）
    fact_asin_subbsr_snapshot   ← sif_asin_traffic_daily.sub_bsr（JSONB 展开）
    fact_asin_keyword_overview  ← sif_api_log[endpoint='web-asin-keyword-overview']

## 为什么必须走 PG，不能走 sif CLI

`traffic-trend` 是**单 ASIN** 接口：一个变体组 390 个子体就要 390 次调用，
而网关按调用次数计费（实测 43 个 endpoint 扫一遍就把额度打穿了）。
PG 的 sif_asin_traffic_daily 已经有 150 万行结构化日粒度数据、覆盖 2452 个 ASIN，
一次全量扫表即可，零网关消耗。

## 一次扫表分三路写出

前三张表同源（sif_asin_traffic_daily，150 万行），扫三遍很贵，
所以 SQL 层做一次 GROUP BY 月聚合，Python 侧分发到三张表。
sub_bsr 是日粒度、不聚合，单独一条流式查询。

## 月内聚合口径（文档要求「必须先定」，这里固化）

- 各渠道 score：取**月内最后一个非空日**。流量得分是存量型指标，
  日与日之间会重复计同一批流量词，求和会得出远超真实的数值。
- price / star / review / bsr：同样取月内最后一个非空日。
  文档明确指出 rating_num 是累计评价数，取月均在业务上是错的。
- 关键实现：用 PG 的 DISTINCT ON + ORDER BY 各列自己的最后非空日，
  **不能让各列取到不同日期**——那会造出「子渠道 > 总量」的不一致快照。

用法：
    python scripts/etl_module4_traffic.py                 # 全量
    python scripts/etl_module4_traffic.py --asin B0XXX    # 只跑一个 ASIN（调试）
    python scripts/etl_module4_traffic.py --dry           # 只统计不写入
    python scripts/etl_module4_traffic.py --only channel  # 只跑某张表

PG 连接只读，本脚本不修改 PG 任何数据。
"""

import sys
import io
import json
import argparse
import datetime as dt

if hasattr(sys.stdout, 'buffer'):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import psycopg2
import psycopg2.extras
import pymysql

# 数据库凭据从环境变量读取，不硬编码 —— 见 scripts/_dsn.py
from _dsn import pg_dsn, doris_dsn


BATCH = 2000
NOW = dt.datetime.now().replace(microsecond=0)

# 渠道映射：PG 列名 → Doris 规范 code
# ⚠️ rec_sp_score → spRec（不是 recSp）。文档明确警告这里三套命名：
#    PG 列 rec_sp_score / 上游 key recSpScore / Doris 规范值 spRec
CHANNEL_COLS = [
    ('total_score', 'total'),
    ('nf_score', 'nf'),
    ('ad_score', 'ad'),
    ('sp_score', 'sp'),
    ('rec_sp_score', 'spRec'),
    ('sb_score', 'sb'),
    ('sbv_score', 'sbv'),
]


def log(msg):
    print('[%s] %s' % (dt.datetime.now().strftime('%H:%M:%S'), msg), flush=True)


def f(v):
    """numeric → float，None 透传"""
    return None if v is None else float(v)


def clip(s, n):
    """按 Doris 列宽截断，避免 strict mode 下整批 INSERT 失败"""
    if s is None:
        return None
    s = str(s)
    return s[:n] if len(s) > n else s


class Writer:
    """分批写入 Doris。

    Doris 每条 INSERT 都是一次导入事务，逐行写会产生大量小版本
    （拖慢 compaction）。所以攒够 BATCH 行再发一条多值 INSERT。
    """

    def __init__(self, conn, table, columns, dry=False):
        self.conn = conn
        self.table = table
        self.columns = columns
        self.dry = dry
        self.buf = []
        self.total = 0
        self._sql_head = 'INSERT INTO `%s` (%s) VALUES ' % (
            table, ', '.join('`%s`' % c for c in columns))
        self._row_ph = '(' + ', '.join(['%s'] * len(columns)) + ')'

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
            sql = self._sql_head + ', '.join([self._row_ph] * n)
            flat = [v for row in self.buf for v in row]
            cur.execute(sql, flat)
            cur.close()
        self.total += n
        self.buf = []


# ======================================================================
# SQL1 + SQL2：渠道长表 + Listing 月度快照
# ======================================================================

# 月聚合：每个 (asin, site, month) 一行。
#
# ⚠️ 渠道用**同一个锚点日**，不是各列各取自己的最后非空日。
#    实测后者会让同月 total 取到 09-18（0.065）而 sp 取到 09-17（8.25），
#    子渠道大于总量，页面按「渠道/合计」算占比会得出 0.0077（应接近 1.0）。
#    锚点取「total_score 非空的最后一日」：total 是全渠道汇总口径，
#    它有值那天各子渠道必然也在采集范围内。
#
# ⚠️ Listing 指标（price/star/review/bsr）则**各列各取自己的最后非空日**。
#    它们彼此独立、不存在加总一致性约束，而填充率差异很大
#    （buybox_price 86%、bsr 85%），强行绑同一天会丢掉大量本来有值的格子。
SQL_MONTHLY = """
WITH base AS (
    SELECT asin, upper(site) AS country, to_char(stat_date, 'YYYY-MM') AS month,
           stat_date,
           total_score, nf_score, ad_score, sp_score, rec_sp_score,
           sb_score, sbv_score,
           buybox_price, star, review, bsr
    FROM sif_asin_traffic_daily
    WHERE TRUE {asin_filter}
),
-- 渠道锚点：total_score 非空的最后一日，取该日全部渠道
anchor AS (
    SELECT DISTINCT ON (asin, country, month)
           asin, country, month,
           total_score, nf_score, ad_score, sp_score, rec_sp_score,
           sb_score, sbv_score
    FROM base
    WHERE total_score IS NOT NULL
    ORDER BY asin, country, month, stat_date DESC
),
-- Listing 各指标：逐列取自己的最后非空日
lst AS (
    SELECT asin, country, month,
      -- 「月内最后一个非空日」的写法：FILTER 掉 NULL 后按日期排成数组，
      -- 取第 COUNT(非空) 个即最后一个。已与人工逐行核算对账一致
      -- （B0FVNPKGJ8 2026-08：price=39.94 star=4.2 review=137 bsr=5979）
      (ARRAY_AGG(buybox_price ORDER BY stat_date)
         FILTER (WHERE buybox_price IS NOT NULL))[COUNT(buybox_price)] AS price,
      (ARRAY_AGG(star ORDER BY stat_date) FILTER (WHERE star IS NOT NULL))[
        COUNT(star)] AS star,
      (ARRAY_AGG(review ORDER BY stat_date) FILTER (WHERE review IS NOT NULL))[
        COUNT(review)] AS review,
      (ARRAY_AGG(bsr ORDER BY stat_date) FILTER (WHERE bsr IS NOT NULL))[
        COUNT(bsr)] AS bsr
    FROM base
    GROUP BY asin, country, month
)
SELECT COALESCE(a.asin, l.asin)       AS asin,
       COALESCE(a.country, l.country) AS country,
       COALESCE(a.month, l.month)     AS month,
       a.total_score, a.nf_score, a.ad_score, a.sp_score, a.rec_sp_score,
       a.sb_score, a.sbv_score,
       l.price, l.star, l.review, l.bsr
FROM anchor a
FULL OUTER JOIN lst l
  ON l.asin = a.asin AND l.country = a.country AND l.month = a.month
"""


def run_monthly(pg, doris, asins, dry, want):
    """一次扫表，分两路写出 channel 与 listing_snapshot。"""
    ch_w = Writer(doris, 'fact_asin_traffic_channel',
                  ['asin', 'country', 'time_piece_type', 'time_piece_value',
                   'channel', 'score', 'score_ratio', 'score_change',
                   'score_change_ratio', 'contri_change_ratio', 'created_at'], dry)
    ls_w = Writer(doris, 'fact_asin_listing_snapshot',
                  ['asin', 'country', 'stat_month', 'price', 'score',
                   'rating_num', 'bsr', 'created_at'], dry)

    flt = ''
    params = []
    if asins:
        flt = 'AND asin IN %s'
        params.append(tuple(asins))
    sql = SQL_MONTHLY.format(asin_filter=flt)

    cur = pg.cursor(name='monthly_cur')   # 服务端游标，避免 5 万行全进内存
    cur.itersize = 5000
    cur.execute(sql, params)

    n = 0
    for row in cur:
        (asin, country, month,
         total, nf, ad, sp, recsp, sb, sbv,
         price, star, review, bsr) = row
        n += 1

        if 'channel' in want:
            scores = dict(zip(
                ['total_score', 'nf_score', 'ad_score', 'sp_score',
                 'rec_sp_score', 'sb_score', 'sbv_score'],
                [total, nf, ad, sp, recsp, sb, sbv]))
            tot = f(total)
            for col, code in CHANNEL_COLS:
                v = f(scores[col])
                # 长表展开跳过 NULL：各渠道填充率差异极大（sb 仅 6.8%），
                # 不跳过会产出大量空行（文档第 3 条映射要求）
                if v is None:
                    continue
                # score_ratio 用同一锚点日的 total 现算，分母为 0/空则留 None
                ratio = (v / tot) if (tot not in (None, 0)) else None
                ch_w.add([asin, country, 'month', month, code, v, ratio,
                          # 这三列 PG 无源（文档实测 0%），留 NULL 而非写 0
                          None, None, None, NOW])

        if 'listing' in want:
            # 整月四个指标全空就不写（否则每个 ASIN 每月都造一条空快照）
            if any(x is not None for x in (price, star, review, bsr)):
                ls_w.add([asin, country, month, f(price), f(star),
                          # Doris score ← PG star，rating_num ← PG review
                          # （文档特别标注这两处列名不对应）
                          int(review) if review is not None else None,
                          int(bsr) if bsr is not None else None, NOW])

        if n % 20000 == 0:
            log('  月聚合已读 %d 组 | channel=%d listing=%d'
                % (n, ch_w.total + len(ch_w.buf), ls_w.total + len(ls_w.buf)))

    cur.close()
    ch_w.flush()
    ls_w.flush()
    log('月聚合完成：读 %d 组 → channel %d 行, listing_snapshot %d 行'
        % (n, ch_w.total, ls_w.total))
    return {'fact_asin_traffic_channel': ch_w.total,
            'fact_asin_listing_snapshot': ls_w.total}


# ======================================================================
# SQL3：子类目 BSR（日粒度，不聚合）
# ======================================================================

# sub_bsr 实测是单层扁平对象 {"Bracelets": 248}，100% object、value 100% 整数。
# 展开后主键 (asin,country,cat_name,stat_date) 天然唯一，无需去重。
SQL_SUBBSR = """
SELECT upper(site) AS country, asin, kv.key AS cat_name, stat_date,
       (kv.value)::bigint AS bsr
FROM sif_asin_traffic_daily, jsonb_each(sub_bsr) AS kv
WHERE sub_bsr IS NOT NULL {asin_filter}
"""


def run_subbsr(pg, doris, asins, dry):
    w = Writer(doris, 'fact_asin_subbsr_snapshot',
               ['asin', 'country', 'cat_name', 'stat_date', 'bsr', 'created_at'], dry)
    flt = ''
    params = []
    if asins:
        flt = 'AND asin IN %s'
        params.append(tuple(asins))

    cur = pg.cursor(name='subbsr_cur')
    cur.itersize = 5000
    cur.execute(SQL_SUBBSR.format(asin_filter=flt), params)
    n = 0
    for country, asin, cat_name, stat_date, bsr in cur:
        n += 1
        # cat_name 上游有截断脏值（"Toys & Game"、"Home & Kitche" 被砍尾），
        # 文档明确要求**保持原样不要修**，否则与上游对不上
        w.add([asin, country, clip(cat_name, 255), stat_date, bsr, NOW])
        if n % 200000 == 0:
            log('  subbsr 已读 %d 行' % n)
    cur.close()
    w.flush()
    log('subbsr 完成：%d 行' % w.total)
    return {'fact_asin_subbsr_snapshot': w.total}


# ======================================================================
# SQL4：各渠道流量词计数 ← sif_api_log[web-asin-keyword-overview]
# ======================================================================

# 源 JSON 每个渠道一个 *KeywordCnt 键，各带 total/in/out/prev 四个维度。
# Doris 的 fact_asin_keyword_overview 只有 keyword_cnt 一列，
# 所以这里**只落 total**；in/out 属于 fact_asin_keyword_inout 的语义，
# 归模块 6，不在本脚本范围（硬塞进 keyword_cnt 会让同一列混三种含义）。
OVERVIEW_CHANNELS = [
    # totalPeriod 就是「全部流量」的计数（实测与各渠道同为 {in,out,prev,total} 结构），
    # 对应字典里的 total。少了它页面上「全部流量」一栏没有词数
    ('totalPeriod', 'total'),
    ('nfKeywordCnt', 'nf'),
    ('adKeywordCnt', 'ad'),
    ('spKeywordCnt', 'sp'),
    ('recSpKeywordCnt', 'spRec'),   # 同样注意 recSp → spRec 的归一
    ('sbKeywordCnt', 'sb'),
    ('sbvKeywordCnt', 'sbv'),
    ('allSpKeywordCnt', 'allSp'),   # 文档实测 405/405，有直接源，不要加总派生
    ('allSbKeywordCnt', 'allSb'),
]

# ⚠️ 请求参数列叫 params（不是 req）。asin 和时间片只在这一列里，
#    响应体不带 asin，所以必须连 params 一起读。
SQL_OVERVIEW = """
SELECT l.site, l.params, l.resp
FROM sif_api_log l
WHERE l.endpoint = 'web-asin-keyword-overview' AND l.ok
ORDER BY l.id
"""


def _pick_cnt(node):
    """从渠道节点里取 total 计数。

    源可能是 {"total":24,"in":3,"out":1,"prev":22} 这种对象，
    也可能直接是个数字——两种都认，取不到就返回 None（不写 0 冒充）。
    """
    if node is None:
        return None
    if isinstance(node, dict):
        v = node.get('total')
        return int(v) if isinstance(v, (int, float)) else None
    if isinstance(node, (int, float)):
        return int(node)
    return None


def run_overview(pg, doris, asins, dry):
    w = Writer(doris, 'fact_asin_keyword_overview',
               ['asin', 'country', 'time_piece_type', 'time_piece_value',
                'is_listing_search', 'channel', 'keyword_cnt', 'created_at'], dry)
    cur = pg.cursor()
    cur.execute(SQL_OVERVIEW)
    rows = cur.fetchall()
    cur.close()

    seen = set()
    skipped_no_asin = 0
    for site, params, resp in rows:
        data = (resp or {}).get('data')
        if not isinstance(data, dict):
            continue
        # asin 与时间片在请求参数里，响应体不带
        rq = params if isinstance(params, dict) else {}
        asin = rq.get('asin') or data.get('asin')
        if not asin:
            skipped_no_asin += 1
            continue
        if asins and asin not in asins:
            continue
        country = (site or 'US').upper()

        tp_type, tp_value = _parse_time_piece(rq)
        if tp_value is None:
            continue
        is_ls = 1 if rq.get('listingSearch') else 0

        for src_key, code in OVERVIEW_CHANNELS:
            cnt = _pick_cnt(data.get(src_key))
            if cnt is None:
                continue
            # 同一主键可能出现在多条日志里（重复调用），后者覆盖前者由
            # Doris upsert 负责；这里去重只为减少无谓的 INSERT 行数
            key = (asin, country, tp_type, tp_value, is_ls, code)
            if key in seen:
                continue
            seen.add(key)
            w.add([asin, country, tp_type, tp_value, is_ls, code, cnt, NOW])

    w.flush()
    if skipped_no_asin:
        log('keyword_overview: %d 条日志缺 asin，已跳过' % skipped_no_asin)
    log('keyword_overview 完成：%d 行（源日志 %d 条）' % (w.total, len(rows)))
    return {'fact_asin_keyword_overview': w.total}


def _parse_time_piece(rq):
    """解析时间片。

    ⚠️ 实测 timePieceValue 混用四种形态，且**不能只看值的格式**：
        type=month     value='2026-09'    → month
        type=week      value='2026-09-06' → week  ← 值也是 10 位日期！
        type=latelyDay value='30' / '7'   → latelyDay（相对天数）
    所以优先信 timePieceType，只在它缺失时才靠值的形状猜 ——
    只看值会把 week 的 '2026-09-06' 误判成 day，两种粒度混进同一列。

    相对天数保留原样并标 type=latelyDay，**不能写成 month**：
    后端按 time_piece_value='2026-08' 这种绝对月份查，
    写个 '30' 进去永远查不出来，还会和真实月份混在一列里。
    """
    tp_type = rq.get('timePieceType')
    tp_value = rq.get('timePieceValue')
    if tp_value is None:
        return 'month', None
    s = str(tp_value)
    if tp_type:
        return str(tp_type), s
    # 没有 type 时的兜底推断
    if len(s) == 7 and s[4] == '-':
        return 'month', s
    if len(s) == 10 and s[4] == '-':
        return 'day', s
    if s.isdigit():
        return 'latelyDay', s
    return 'month', s


# ======================================================================
# 主流程
# ======================================================================

ALL_STEPS = ('channel', 'listing', 'subbsr', 'overview')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--asin', action='append', default=[],
                    help='只处理指定 ASIN，可重复传。不传 = 全量')
    ap.add_argument('--only', action='append', default=[],
                    choices=list(ALL_STEPS), help='只跑某些表，可重复传')
    ap.add_argument('--dry', action='store_true', help='只统计不写入')
    args = ap.parse_args()

    want = set(args.only) if args.only else set(ALL_STEPS)
    asins = set(args.asin) if args.asin else None

    log('模块 4 流量结构 ETL%s | 目标表: %s'
        % ('（dry-run）' if args.dry else '', ', '.join(sorted(want))))
    if asins:
        log('限定 ASIN: %s' % ', '.join(sorted(asins)))

    pg = psycopg2.connect(**pg_dsn())
    pg.set_session(readonly=True)     # 明确只读，防止误写 PG
    doris = pymysql.connect(**doris_dsn())

    stats = {}
    try:
        if 'channel' in want or 'listing' in want:
            stats.update(run_monthly(pg, doris, asins, args.dry, want))
        if 'subbsr' in want:
            stats.update(run_subbsr(pg, doris, asins, args.dry))
        if 'overview' in want:
            stats.update(run_overview(pg, doris, asins, args.dry))
    finally:
        pg.close()
        doris.close()

    log('%s完成：' % ('预演' if args.dry else '写入'))
    for t in sorted(stats):
        print('  %8d  %s' % (stats[t], t))


if __name__ == '__main__':
    main()

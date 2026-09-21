# -*- coding: utf-8 -*-
"""
模块 6「运营时光机」ETL —— PG(amazon_data) → Doris(looom)

对应 docs/MODULE_DATA_FLOW.md 模块 6，两张表：

    fact_asin_op_event      ← sif_asin_traffic_daily 的**相邻日 diff**（需加工）
    fact_asin_keyword_inout ← sif_asin_traffic_change（kind 直接映射）

（SQL2 用的 fact_asin_traffic_channel / fact_asin_listing_snapshot 已由
 etl_module4_traffic.py 灌好，本脚本不重复。）

## fact_asin_op_event 是全项目唯一「加工生成」而非「搬运」的表

PG 存的是**逐日快照**，不是事件。要对 buybox_price / campaign_id / promotion /
coupon_info / title_img 做相邻日比较，变化处生成一条事件。
用 PG 的 lag() 窗口函数算，比拉回 Python 比对快得多（源表 150 万行）。

⚠️ **NULL 不算变化**。快照缺采集那天所有列都是 NULL，若把
`有值 → NULL` 也当成事件，68,073 个价格变化点里会混进大量「降价到无」的假事件。
只在**前后都有值且不相等**时才记一条。

⚠️ **主键 (asin,country,stat_date,event_type) 不含变化内容**：
同一天同一类型只能有一条。实测同日同列不会变化两次（快照是日粒度），
但价格与优惠券同日变化会各占一条（event_type 不同），不冲突。

## coupon_info 的四段串

实测形如 `0.0_1_$0.00_12.74`，文档说「语义未确认」。
本脚本**原样存进 event_detail 并加前缀标注**，不擅自解析 ——
猜错分段含义会让前端展示出错误的优惠金额。

用法：
    python scripts/etl_module6_timemachine.py [--dry] [--asin B0XXX] [--only event|inout]
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
# fact_asin_op_event：相邻日 diff
# ======================================================================

# 五个被监控列 → event_type。取值需与 dict_op_event_type 对齐。
#
# ⚠️ 价格用 `priceChange` 而不是 `price` —— dict_op_event_type 里已有的码是
#    `priceChange`（name_cn=价格变动）。写 `price` 会新增一个重复语义的码，
#    页面按 code 查字典拿不到中文名，且字典里出现两个价格类型。
#    其余四个码（titleImg/campaignId/coupon）与字典完全一致，promotion 需新增。
WATCH = [
    ('buybox_price', 'priceChange'),
    # ⚠️ `campaign_id` 这一列**存的是活动数量，不是活动 ID**：
    #    实测 24,518 行 100% 纯数字、范围 1~82，而真实 campaignId 形如
    #    `A08351851QIAUO9ZFHZF0`。所以事件语义是「在投活动数变化」，
    #    用 campaignCnt 而不是字典里的 campaignId（那个是「新增广告活动」）。
    #    标成 campaignId 会让页面把「2 → 1」读成活动 ID 从 2 改成 1。
    ('campaign_id', 'campaignCnt'),
    ('promotion', 'promotion'),
    ('coupon_info', 'coupon'),
    ('title_img', 'titleImg'),
]

# lag() 按 (asin,site) 分区、按日期排序，逐列取前一日值。
#
# ⚠️ WHERE 里只保留「前后都有值且不相等」的行：
#    NULL 是「当日未采集」而不是「该属性被清空」，把 有值→NULL 当事件
#    会造出大量假的「降价到无 / 活动取消」记录。
SQL_DIFF = """
WITH t AS (
    SELECT upper(site) AS country, asin, stat_date,
           buybox_price, campaign_id, promotion, coupon_info, title_img,
           lag(buybox_price) OVER w AS p_buybox_price,
           lag(campaign_id)  OVER w AS p_campaign_id,
           lag(promotion)    OVER w AS p_promotion,
           lag(coupon_info)  OVER w AS p_coupon_info,
           lag(title_img)    OVER w AS p_title_img
    FROM sif_asin_traffic_daily
    WHERE TRUE {asin_filter}
    WINDOW w AS (PARTITION BY site, asin ORDER BY stat_date)
)
SELECT country, asin, stat_date,
       buybox_price, p_buybox_price,
       campaign_id,  p_campaign_id,
       promotion,    p_promotion,
       coupon_info,  p_coupon_info,
       title_img,    p_title_img
FROM t
WHERE (buybox_price IS NOT NULL AND p_buybox_price IS NOT NULL AND buybox_price <> p_buybox_price)
   OR (campaign_id  IS NOT NULL AND p_campaign_id  IS NOT NULL AND campaign_id  <> p_campaign_id)
   OR (promotion    IS NOT NULL AND p_promotion    IS NOT NULL AND promotion    <> p_promotion)
   OR (coupon_info  IS NOT NULL AND p_coupon_info  IS NOT NULL AND coupon_info  <> p_coupon_info)
   OR (title_img    IS NOT NULL AND p_title_img    IS NOT NULL AND title_img    <> p_title_img)
"""


def run_events(pg, doris, asins, dry):
    w = Writer(doris, 'fact_asin_op_event',
               ['asin', 'country', 'stat_date', 'event_type', 'event_detail',
                'created_at'], dry)
    flt, params = '', []
    if asins:
        flt = 'AND asin IN %s'
        params.append(tuple(asins))

    cur = pg.cursor(name='diff_cur')
    cur.itersize = 5000
    cur.execute(SQL_DIFF.format(asin_filter=flt), params)

    by_type = {}
    n = 0
    for row in cur:
        country, asin, stat_date = row[0], row[1], row[2]
        n += 1
        # 之后每两个一组：(当日值, 前日值)
        for i, (col, ev_type) in enumerate(WATCH):
            cur_v, prev_v = row[3 + i * 2], row[4 + i * 2]
            if cur_v is None or prev_v is None or cur_v == prev_v:
                continue
            if col == 'coupon_info':
                # 四段串语义未确认，原样保留并标注，不擅自解析
                detail = 'coupon(raw): %s → %s' % (prev_v, cur_v)
            elif col == 'title_img':
                # URL 很长，只标明变更事实，完整 URL 放后面
                detail = '主图变更: %s → %s' % (prev_v, cur_v)
            elif col == 'campaign_id':
                # 说清是「数量」，否则 "2 → 1" 会被读成活动 ID
                detail = '在投活动数: %s → %s 个' % (prev_v, cur_v)
            else:
                detail = '%s → %s' % (prev_v, cur_v)
            w.add([asin, country, stat_date, ev_type, clip(detail, 60000), NOW])
            by_type[ev_type] = by_type.get(ev_type, 0) + 1
        if n % 20000 == 0:
            log('  diff 已读 %d 个变化日' % n)

    cur.close()
    w.flush()
    log('op_event 完成：%d 个变化日 → %d 条事件' % (n, w.total))
    for t in sorted(by_type, key=lambda k: -by_type[k]):
        log('    %-12s %d' % (t, by_type[t]))
    return {'fact_asin_op_event': w.total}, by_type


# ======================================================================
# fact_asin_keyword_inout：进出词
# ======================================================================

# kind 实测 3 个取值：nf_in / nf_out / main。
# main 的语义是「主要变化关键词」，不是进出场 —— 本表不收（文档结论）。
KIND_MAP = {'nf_in': 'in', 'nf_out': 'out'}

SQL_INOUT = """
SELECT upper(c.site) AS country, c.asin, c.data_date, c.kind, c.keyword,
       k.keyword_id
FROM sif_asin_traffic_change c
LEFT JOIN (
    SELECT DISTINCT ON (upper(site), btrim(lower(keyword)))
           upper(site) AS country, btrim(lower(keyword)) AS kw, keyword_id
    FROM sif_asin_keyword
    WHERE keyword_id IS NOT NULL
    ORDER BY upper(site), btrim(lower(keyword)), fetched_at DESC
) k ON k.country = upper(c.site) AND k.kw = btrim(lower(c.keyword))
WHERE c.kind IN ('nf_in', 'nf_out')
  AND c.keyword IS NOT NULL
  AND c.data_date IS NOT NULL
  {asin_filter}
"""


def run_inout(pg, doris, asins, dry):
    w = Writer(doris, 'fact_asin_keyword_inout',
               ['asin', 'country', 'keyword', 'stat_date', 'change_type',
                'keyword_id', 'created_at'], dry)
    flt, params = '', []
    if asins:
        flt = 'AND c.asin IN %s'
        params.append(tuple(asins))

    cur = pg.cursor()
    cur.execute(SQL_INOUT.format(asin_filter=flt), params)
    rows = cur.fetchall()
    cur.close()

    seen = set()
    with_id = 0
    for country, asin, data_date, kind, keyword, keyword_id in rows:
        ct = KIND_MAP.get(kind)
        if ct is None:
            continue
        kw = clip(str(keyword).strip().lower(), 128)
        if not kw:
            continue
        # 主键含 change_type（实测建表时已包含），所以同日 in/out 各占一行，
        # 不会像文档担心的那样静默覆盖
        key = (asin, country, kw, data_date, ct)
        if key in seen:
            continue
        seen.add(key)
        if keyword_id is not None:
            with_id += 1
        # ⚠️ keyword_id 反查命中率低（文档实测 5.22%），但它在本表**不是主键成员**
        #    （主键是 asin+country+keyword+stat_date+change_type），
        #    所以反查不到也能正常落行 —— 文档担心的「只能落 463 行」不成立
        w.add([asin, country, kw, data_date, ct, keyword_id, NOW])

    w.flush()
    log('keyword_inout 完成：%d 行（源 %d 行，keyword_id 命中 %d = %.1f%%）'
        % (w.total, len(rows), with_id, 100.0 * with_id / max(w.total, 1)))
    return {'fact_asin_keyword_inout': w.total}


# ======================================================================
# dict_op_event_type：由 diff 结果反推枚举
# ======================================================================

# 字典是人工初始化而非 ETL（文档标黄），但 event_type 的取值由 diff 决定，
# 所以在这里顺带补齐，避免页面拿不到中文名而显示原始码。
EVENT_TYPE_CN = {
    'priceChange': ('价格变动', 'priceChange'),
    'campaignCnt': ('在投广告活动数变化', 'campaignCnt'),
    'promotion': ('促销活动', 'promotion'),
    'coupon': ('优惠券活动', 'coupon'),
    'titleImg': ('修改标题或图片', 'titleImg'),
}


def sync_dict(doris, by_type, dry):
    """把 diff 实际产出的 event_type 补进字典表。"""
    if not by_type:
        return {}
    cur = doris.cursor()
    cur.execute('SELECT code FROM dict_op_event_type')
    have = set(r[0] for r in cur.fetchall())
    missing = [t for t in by_type if t not in have]
    if not missing:
        cur.close()
        log('dict_op_event_type 已覆盖全部 %d 个 event_type' % len(by_type))
        return {}
    rows = []
    for i, t in enumerate(sorted(missing)):
        cn, en = EVENT_TYPE_CN.get(t, (t, t))
        rows.append((t, cn, en, 100 + i, ''))
    if not dry:
        cur.execute(
            'INSERT INTO dict_op_event_type (code, name_cn, name_en, sort_order, extra) '
            'VALUES ' + ', '.join(['(%s,%s,%s,%s,%s)'] * len(rows)),
            [v for r in rows for v in r])
    cur.close()
    log('dict_op_event_type 补入 %d 个：%s' % (len(rows), ', '.join(m for m in missing)))
    return {'dict_op_event_type': len(rows)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--asin', action='append', default=[])
    ap.add_argument('--only', action='append', default=[],
                    choices=['event', 'inout'])
    ap.add_argument('--dry', action='store_true')
    args = ap.parse_args()

    want = set(args.only) if args.only else {'event', 'inout'}
    asins = set(args.asin) if args.asin else None
    log('模块 6 运营时光机 ETL%s | 目标: %s'
        % ('（dry-run）' if args.dry else '', ', '.join(sorted(want))))

    pg = psycopg2.connect(**pg_dsn())
    pg.set_session(readonly=True)
    doris = pymysql.connect(**doris_dsn())
    stats = {}
    try:
        if 'event' in want:
            s, by_type = run_events(pg, doris, asins, args.dry)
            stats.update(s)
            stats.update(sync_dict(doris, by_type, args.dry))
        if 'inout' in want:
            stats.update(run_inout(pg, doris, asins, args.dry))
    finally:
        pg.close()
        doris.close()

    log('%s完成：' % ('预演' if args.dry else '写入'))
    for t in sorted(stats):
        print('  %8d  %s' % (stats[t], t))


if __name__ == '__main__':
    main()

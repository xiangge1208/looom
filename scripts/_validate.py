# -*- coding: utf-8 -*-
"""模块 1 灌数后验证（临时脚本）。"""
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
import pymysql, psycopg2

D = pymysql.connect(host='120.24.248.175', port=9030, user='etl_user',
                    password='***REMOVED-DORIS-PASSWORD***', database='looom', charset='utf8mb4')
dc = D.cursor()
P = psycopg2.connect(host='120.76.216.136', port=15432, dbname='amazon_data',
                     user='xiezhiyang', password='***REMOVED-PG-PASSWORD***')
P.set_session(readonly=True); pc = P.cursor()

def d(l, s, n=30):
    print('###', l)
    dc.execute(s)
    cols = [x[0] for x in dc.description]
    rows = dc.fetchall()[:n]
    print('   ', cols)
    for r in rows: print('   ', r)
    print()
    return rows

# ---------- 1. 行数 ----------
d('行数', """select
  (select count(*) from dim_asin) dim_asin,
  (select count(*) from rel_asin_variant) rel_variant,
  (select count(*) from dim_asin_feature) dim_feature,
  (select count(*) from fact_asin_bought_monthly) fact_bought""")

# ---------- 2. dim_asin 填充率 ----------
d('dim_asin 填充率 %', """select count(*) tot,
  round(count(title)*100/count(*),1) title, round(count(img)*100/count(*),1) img,
  round(count(price)*100/count(*),1) price, round(count(brand)*100/count(*),1) brand,
  round(count(brand_href)*100/count(*),1) brand_href,
  round(count(score)*100/count(*),1) score, round(count(star)*100/count(*),1) star,
  round(count(rating_num)*100/count(*),1) rating_num,
  round(count(is_best_seller)*100/count(*),1) is_bs,
  round(count(is_parent_asin)*100/count(*),1) is_parent,
  round(count(parent_asin)*100/count(*),1) parent_asin,
  round(count(first_available_day)*100/count(*),1) first_day,
  round(count(seller)*100/count(*),1) seller,
  round(count(data_updated_at)*100/count(*),1) data_upd
  from dim_asin""")

d('dim_asin country 分布', "select country, count(*) from dim_asin group by 1 order by 2 desc")
d('is_parent_asin=true', "select count(*) from dim_asin where is_parent_asin=true")
d('is_best_seller=true', "select count(*) from dim_asin where is_best_seller=true")

# ---------- 3. 其余三表填充率 ----------
d('rel_asin_variant', """select count(*) tot, count(distinct parent_asin) parents,
  count(distinct child_asin) children,
  round(count(display_order)*100/count(*),1) ord_pct, round(count(ratio)*100/count(*),1) ratio_pct,
  min(display_order) min_ord, sum(case when child_asin='' then 1 else 0 end) empty_child
  from rel_asin_variant""")

d('dim_asin_feature', """select count(*) tot, count(distinct asin) asins,
  round(count(feature_value)*100/count(*),1) val_pct from dim_asin_feature""")
d('feature_name 分布', """select feature_name, count(*) from dim_asin_feature
  group by 1 order by 2 desc limit 12""")

d('fact_bought', """select count(*) tot, count(distinct asin) asins,
  count(distinct stat_month) months, min(stat_month) mn, max(stat_month) mx,
  round(count(bought_lower_bound)*100/count(*),1) lb_pct,
  round(count(bought_label)*100/count(*),1) label_pct from fact_asin_bought_monthly""")
d('fact label 只在当月', """select stat_month, count(bought_label) from fact_asin_bought_monthly
  where bought_label is not null group by 1 order by 1 desc limit 5""")

# ---------- 4. JOIN 命中率 ----------
d('销量榜 JOIN dim_asin 命中率（灌后）', """
  select count(*) fact_asins, count(a.asin) hit, round(count(a.asin)*100.0/count(*),2) pct
  from (select distinct asin, country from fact_asin_bought_monthly) f
  left join dim_asin a on a.asin=f.asin and a.country=f.country""")

d('反事实：若 dim_asin 只装 meta 的 ASIN（有 title 的行）', """
  select count(*) fact_asins, count(a.asin) hit, round(count(a.asin)*100.0/count(*),2) pct
  from (select distinct asin, country from fact_asin_bought_monthly) f
  left join (select asin,country from dim_asin where seller is not null or rating_num is not null) a
    on a.asin=f.asin and a.country=f.country""")

d('销量榜 JOIN 后能拿到 title 的比例', """
  select count(*) n, count(a.title) has_title, round(count(a.title)*100.0/count(*),2) pct
  from (select distinct asin, country from fact_asin_bought_monthly) f
  left join dim_asin a on a.asin=f.asin and a.country=f.country""")

# ---------- 5. 找一个数据最全的父体做变体列表查询 ----------
rows = d('候选父体（子体在 4 张表都有数据）', """
  select v.parent_asin, count(*) n_child,
    count(a.title) with_title, count(fx.asin) with_feat, count(tr.asin) with_trend
  from rel_asin_variant v
  left join dim_asin a on a.asin=v.child_asin and a.country=v.country
  left join (select distinct asin,country from dim_asin_feature) fx
    on fx.asin=v.child_asin and fx.country=v.country
  left join (select distinct asin,country from fact_asin_bought_monthly) tr
    on tr.asin=v.child_asin and tr.country=v.country
  where v.country='US'
  group by 1 having count(*)>=4 and count(a.title)=count(*)
    and count(fx.asin)=count(*) and count(tr.asin)=count(*)
  order by n_child desc limit 5""")

if rows:
    pasin = rows[0][0]
    print('>>> 用父体', pasin, '跑 docs/sql/variant_sales_list.sql\n')
    d('variant_sales_list.sql 实测', """
    SELECT v.display_order AS seq, v.child_asin AS asin, a.title, a.price, a.score,
      a.rating_num, fx.size_text, tr.n_points, tr.latest_label,
      substr(tr.trend_csv, greatest(1, length(tr.trend_csv)-60)) AS trend_tail
    FROM looom.rel_asin_variant v
    LEFT JOIN looom.dim_asin a ON a.asin=v.child_asin AND a.country=v.country
    LEFT JOIN (SELECT asin,country,
        GROUP_CONCAT(feature_value ORDER BY feature_name SEPARATOR ' / ') size_text
      FROM looom.dim_asin_feature GROUP BY asin,country) fx
      ON fx.asin=v.child_asin AND fx.country=v.country
    LEFT JOIN (SELECT asin,country, COUNT(*) n_points,
        MAX_BY(bought_label, stat_month) latest_label,
        GROUP_CONCAT(CONCAT(stat_month,':',CAST(bought_lower_bound AS STRING))
          ORDER BY stat_month SEPARATOR ',') trend_csv
      FROM looom.fact_asin_bought_monthly GROUP BY asin,country) tr
      ON tr.asin=v.child_asin AND tr.country=v.country
    WHERE v.country='US' AND v.parent_asin='%s'
    ORDER BY v.display_order""" % pasin, 12)

# ---------- 6. 抽查销量数值 vs PG ----------
print('### 抽查销量：Doris vs PG 原始值（验证无虚高）')
dc.execute("""select asin, country from (
   select f.asin, f.country, count(*) n from fact_asin_bought_monthly f
   join (select site, asin from (select upper(site) site, asin, period,
            count(case when variant_key='' then 1 end) nb,
            count(case when variant_key<>'' then 1 end) nn
         from sif_asin_sales_monthly_dummy) x) y on 1=0
   group by 1,2) z limit 1""" if False else
   """select asin, country, count(*) from fact_asin_bought_monthly
      group by 1,2 order by count(*) desc limit 40""")
cands = dc.fetchall()

# 优先挑 PG 侧存在 blank+named 并存（易虚高）的 ASIN
pc.execute("""
  select asin, upper(site) from (
    select asin, site, period,
      count(case when variant_key='' then 1 end) nb,
      count(case when variant_key<>'' then 1 end) nn
    from sif_asin_sales_monthly group by 1,2,3) t
  where nb>0 and nn>0 group by 1,2 limit 4""")
risky = [(a, c) for a, c in pc.fetchall()]
picks = risky + [(a, c) for a, c, _ in cands[:2]]
picks = picks[:6]

for asin, country in picks:
    pc.execute("""select period, max(bought_num), count(*),
        count(case when variant_key='' then 1 end)
      from sif_asin_sales_monthly where asin=%s and upper(site)=%s
      group by 1 order by 1 desc limit 4""", (asin, country))
    pg_rows = {p: (m, n, nb) for p, m, n, nb in pc.fetchall()}
    dc.execute("""select stat_month, bought_lower_bound, bought_label
      from fact_asin_bought_monthly where asin=%s and country=%s
      order by stat_month desc limit 4""", (asin, country))
    do_rows = {m: (v, l) for m, v, l in dc.fetchall()}
    ok = all(pg_rows.get(m, (None,))[0] == v for m, (v, l) in do_rows.items())
    print('  %s/%s  一致=%s' % (asin, country, ok))
    for m in sorted(do_rows, reverse=True):
        pgv = pg_rows.get(m)
        print('     %s  doris=%-8s label=%-8s pg_max=%-8s pg_rows=%s blank=%s' %
              (m, do_rows[m][0], do_rows[m][1], pgv[0] if pgv else '-',
               pgv[1] if pgv else '-', pgv[2] if pgv else '-'))
print()

# ---------- 7. 虚高验证：US 2026-08 汇总 ----------
print('### US 2026-08 总量：去重后 vs 直灌（虚高对照）')
pc.execute("""select
   (select sum(mx) from (select max(bought_num) mx from sif_asin_sales_monthly
      where upper(site)='US' and period='2026-08' group by asin) a) dedup,
   (select sum(bought_num) from sif_asin_sales_monthly
      where upper(site)='US' and period='2026-08') raw""")
pg_dedup, pg_raw = pc.fetchone()
dc.execute("select sum(bought_lower_bound) from fact_asin_bought_monthly where country='US' and stat_month='2026-08'")
doris_sum = dc.fetchone()[0]
print('   PG 去重(max)=%s   PG 直接 sum=%s   虚高=%s' % (pg_dedup, pg_raw, pg_raw - pg_dedup))
print('   Doris 实际=%s   与 PG 去重一致=%s' % (doris_sum, int(doris_sum) == int(pg_dedup)))
print()

# ---------- 8. 表间一致性 ----------
d('表间一致性', """select
  (select count(*) from fact_asin_bought_monthly f left join dim_asin a
     on a.asin=f.asin and a.country=f.country where a.asin is null) fact_orphan,
  (select count(*) from dim_asin_feature x left join dim_asin a
     on a.asin=x.asin and a.country=x.country where a.asin is null) feat_orphan,
  (select count(*) from rel_asin_variant v left join dim_asin a
     on a.asin=v.child_asin and a.country=v.country where a.asin is null) rel_child_orphan""")

D.close(); P.close()

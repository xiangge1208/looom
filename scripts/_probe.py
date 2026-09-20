# -*- coding: utf-8 -*-
"""验证 is_parent_asin 正确取法。用完即删。"""
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
import psycopg2
pg = psycopg2.connect(host='120.76.216.136', port=15432, dbname='amazon_data',
                      user='xiezhiyang', password='***REMOVED-PG-PASSWORD***')
pg.set_session(readonly=True); c = pg.cursor()

def q(l, s, n=20):
    print('###', l)
    c.execute(s)
    for r in c.fetchall()[:n]: print('   ', r)
    print()

q('单元素 asins 请求数', """
  select count(*) from sif_api_log
  where endpoint='web-sales-asin' and ok
    and jsonb_typeof(params->'asins')='array'
    and jsonb_array_length(params->'asins')=1""")

q('单元素 + isParentAsin 非空', """
  select resp->'data'->>'isParentAsin' v, count(*), count(distinct params->'asins'->>0)
  from sif_api_log
  where endpoint='web-sales-asin' and ok
    and jsonb_typeof(params->'asins')='array'
    and jsonb_array_length(params->'asins')=1
    and resp->'data'->>'isParentAsin' is not null
  group by 1""")

q('多元素请求的 isParentAsin 分布(说明不可用)', """
  select resp->'data'->>'isParentAsin' v, count(*)
  from sif_api_log
  where endpoint='web-sales-asin' and ok
    and jsonb_typeof(params->'asins')='array'
    and jsonb_array_length(params->'asins')>1
  group by 1""")
pg.close()

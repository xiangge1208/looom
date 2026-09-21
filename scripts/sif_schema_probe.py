#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 sif_api_log.resp 按 endpoint 采样，推断每个 endpoint 的 JSON 结构。

输出每个字段的：JSON 路径、类型、填充率、取值样例。
数组统一折叠成 `[]`，同一层所有元素合并统计 —— 这样 1 万条 list
也只产出一份字段清单。

用法：
  python scripts/sif_schema_probe.py                 # 全部 endpoint
  python scripts/sif_schema_probe.py --endpoint web-sales-asin
  python scripts/sif_schema_probe.py --limit 200 --json out.json
"""
import argparse
import io
import json
import re
import sys
from collections import defaultdict

import psycopg2

# 数据库凭据从环境变量读取，不硬编码 —— 见 scripts/_dsn.py
from _dsn import pg_dsn

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8",
                                  errors="replace")


MAX_SAMPLES = 3       # 每个字段留几个样例值
MAX_STR = 60          # 样例值截断长度
MAX_DEPTH = 8

# 有些接口把 ASIN / 关键词 / 日期当成对象的 key（而不是数组元素），
# 直接打平会炸出上万个「字段」。这里把动态 key 折叠成占位符，
# 例如 data.B005CXG1X0.asin -> data.{asin}.asin
RE_ASIN = re.compile(r"^B0[A-Z0-9]{8}$")
RE_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
RE_MONTH = re.compile(r"^\d{4}-\d{2}$")
RE_NUMID = re.compile(r"^\d{5,}$")


def fold_key(k: str) -> str:
    """把动态 key 归一成占位符；静态字段名原样返回。"""
    if RE_ASIN.match(k):
        return "{asin}"
    if RE_DATE.match(k):
        return "{date}"
    if RE_MONTH.match(k):
        return "{month}"
    if RE_NUMID.match(k):
        return "{id}"
    # 关键词做 key：含空格，或纯小写且不像驼峰字段名
    if " " in k:
        return "{keyword}"
    return k


class FieldStat:
    __slots__ = ("types", "present", "nulls", "samples", "min_n", "max_n",
                 "arr_lens")

    def __init__(self):
        self.types = set()
        self.present = 0      # 该字段在其所属容器出现的次数
        self.nulls = 0
        self.samples = []
        self.min_n = None
        self.max_n = None
        self.arr_lens = []

    def observe(self, value):
        self.present += 1
        if value is None:
            self.nulls += 1
            self.types.add("null")
            return
        if isinstance(value, bool):
            self.types.add("bool")
        elif isinstance(value, int):
            self.types.add("int")
            self._num(value)
        elif isinstance(value, float):
            self.types.add("float")
            self._num(value)
        elif isinstance(value, str):
            self.types.add("str")
        elif isinstance(value, list):
            self.types.add("array")
            self.arr_lens.append(len(value))
            return
        elif isinstance(value, dict):
            self.types.add("object")
            return
        self._sample(value)

    def _num(self, v):
        self.min_n = v if self.min_n is None else min(self.min_n, v)
        self.max_n = v if self.max_n is None else max(self.max_n, v)

    def _sample(self, v):
        if len(self.samples) >= MAX_SAMPLES:
            return
        s = str(v)
        if len(s) > MAX_STR:
            s = s[:MAX_STR] + "…"
        if s not in self.samples:
            self.samples.append(s)

    def type_str(self):
        order = ["object", "array", "str", "int", "float", "bool", "null"]
        real = [t for t in order if t in self.types and t != "null"]
        base = "|".join(real) or "null"
        if "null" in self.types and real:
            base += "?"
        return base

    def range_str(self):
        if self.min_n is None:
            return ""
        if self.min_n == self.max_n:
            return f"={self.min_n}"
        return f"{self.min_n} ~ {self.max_n}"

    def arr_str(self):
        if not self.arr_lens:
            return ""
        return f"len {min(self.arr_lens)}~{max(self.arr_lens)}"


def walk(node, path, stats, dyn_keys, opportunities, depth=0):
    """把一份 JSON 打平成 path -> FieldStat。数组折叠成 []。"""
    if depth > MAX_DEPTH:
        return
    if isinstance(node, dict):
        # 一个 dict 里若有 N 个动态 key（如 N 个 ASIN），它们折叠成同一条
        # 路径，于是那条路径被 observe N 次。它自己的分母得是 N 而不是 1，
        # 否则填充率会算成 713% 这种数。这里按「折叠后路径」单独记机会数。
        for k in node:
            folded = fold_key(k)
            child = f"{path}.{folded}" if path else folded
            opportunities[child] += 1

        for k, v in node.items():
            folded = fold_key(k)
            if folded != k:
                # 动态 key：记一笔，便于在文档里标注「这是 map 不是 array」
                dyn_keys[path].add(folded)
            child = f"{path}.{folded}" if path else folded
            stats[child].observe(v)
            if isinstance(v, (dict, list)):
                walk(v, child, stats, dyn_keys, opportunities, depth + 1)
    elif isinstance(node, list):
        elem = f"{path}[]"
        for item in node:
            walk(item, elem, stats, dyn_keys, opportunities, depth + 1)
            # 每个元素都要 observe，否则当数组里既有 object 又有 null 时，
            # 只统计到 null，`nfRank[]` 会显示成「null 0.0%」而看不出
            # 它其实是一个对象数组。
            stats[elem].observe(item)
            opportunities[elem] += 1


def probe(cur, endpoint, limit):
    cur.execute(
        """SELECT resp FROM sif_api_log
           WHERE endpoint = %s AND ok IS TRUE AND resp IS NOT NULL
           ORDER BY id DESC LIMIT %s""", (endpoint, limit))
    rows = cur.fetchall()
    if not rows:
        return None

    stats = defaultdict(FieldStat)
    dyn_keys = defaultdict(set)
    opportunities = defaultdict(int)
    for (resp,) in rows:
        walk(resp, "", stats, dyn_keys, opportunities)

    out = []
    for path in sorted(stats):
        st = stats[path]
        # opportunities[path] = 该路径在所有样本里「本可以出现」的次数。
        # 对折叠的动态 key（data.{asin}）等于所有 ASIN 的总个数，
        # 对数组元素 [] 等于元素总个数，对普通字段等于父容器出现次数。
        denom = opportunities.get(path, 0) or st.present
        fill = (st.present - st.nulls) / denom * 100 if denom else 0.0
        out.append({
            "path": path,
            "type": st.type_str(),
            "fill_pct": round(fill, 1),
            "n": st.present,
            "range": st.range_str(),
            "arr": st.arr_str(),
            "samples": st.samples,
        })
    return {"endpoint": endpoint, "sampled": len(rows), "fields": out,
            "dynamic_maps": {k: sorted(v) for k, v in sorted(dyn_keys.items())}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--endpoint", action="append",
                    help="只探某个 endpoint，可重复")
    ap.add_argument("--limit", type=int, default=150,
                    help="每个 endpoint 采样条数（默认 150）")
    ap.add_argument("--json", help="结果写到这个文件")
    ap.add_argument("--max-fields", type=int, default=0,
                    help="终端每个 endpoint 最多打印几个字段（0=全部）")
    args = ap.parse_args()

    conn = psycopg2.connect(**pg_dsn())
    cur = conn.cursor()

    if args.endpoint:
        eps = args.endpoint
    else:
        cur.execute("""SELECT endpoint FROM sif_api_log
                       WHERE ok IS TRUE GROUP BY 1 ORDER BY 1""")
        eps = [r[0] for r in cur.fetchall()]

    results = []
    for ep in eps:
        r = probe(cur, ep, args.limit)
        if r is None:
            print(f"\n## {ep}\n  (无成功样本)")
            continue
        results.append(r)
        print(f"\n## {ep}  (采样 {r['sampled']} 条, {len(r['fields'])} 字段)")
        fields = r["fields"]
        if args.max_fields:
            fields = fields[:args.max_fields]
        for f in fields:
            extra = " ".join(x for x in (f["range"], f["arr"]) if x)
            samp = ("  e.g. " + " | ".join(f["samples"])) if f["samples"] else ""
            print(f"  {f['path']:<52s} {f['type']:<14s} "
                  f"{f['fill_pct']:5.1f}%  n={f['n']:<6d}{extra}{samp}")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(results, fh, ensure_ascii=False, indent=2)
        print(f"\n[probe] wrote {args.json}")


if __name__ == "__main__":
    main()

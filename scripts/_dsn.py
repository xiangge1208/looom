# -*- coding: utf-8 -*-
"""
ETL 脚本的数据库连接配置 —— 从环境变量读，不硬编码凭据。

## 为什么有这个模块

原先 14 个 ETL 脚本各自硬编码了 PG 和 Doris 的账号密码。那些是**外网可达的
生产库**，密码一旦进 git 历史就等于公开（哪怕后来删掉，历史里还在）。
集中到这里读环境变量，脚本里只留 `from _dsn import PG_DSN, DORIS_DSN`。

## 用法

    export PG_PASSWORD=...
    export DORIS_PASSWORD=...
    python scripts/etl_module13_compete.py

也可以写进项目根的 `.env`（已在 .gitignore 里）后用 direnv / dotenv 加载。

## 主机与库名为什么可以留默认值

主机 IP、端口、库名、用户名不是秘密（知道了也连不上）。留默认值让脚本
开箱可跑；**密码没有默认值**，缺了就抛 MissingCredential 并说明该设哪个变量。

⚠️ 曾经试过「惰性 dict」的写法：模块顶层导出 dict 子类，把校验推迟到取值时。
   实测**不可行** —— `psycopg2.connect(**DSN)` 解包空 dict 不会触发任何
   自定义钩子，结果是静默连到 localhost:5432 然后报「连接被拒」，
   完全看不出真实原因是「忘了设密码」。所以这里改成模块导入时就校验。
"""

import os


class MissingCredential(RuntimeError):
    """缺少必要的环境变量。信息里带上该设哪个变量，免得让人猜。"""


def _require(name: str, hint: str) -> str:
    v = os.environ.get(name)
    if not v:
        raise MissingCredential(
            f'\n缺少环境变量 {name}（{hint}）。\n'
            f'  设置方式：export {name}=...\n'
            f'  或写进项目根的 .env（该文件已在 .gitignore 中，不会进仓库）\n'
        )
    return v


def pg_dsn() -> dict:
    """PG（amazon_data，爬虫落库）的连接参数。"""
    return dict(
        host=os.environ.get('PG_HOST', '120.76.216.136'),
        port=int(os.environ.get('PG_PORT', '15432')),
        dbname=os.environ.get('PG_DATABASE', 'amazon_data'),
        user=os.environ.get('PG_USER', 'xiezhiyang'),
        password=_require('PG_PASSWORD', 'PG 源库密码'),
    )


def doris_dsn(autocommit: bool = True) -> dict:
    """
    Doris（looom，数仓）的连接参数。

    autocommit 默认 True（多数 ETL 脚本靠 Unique Key 覆盖，不需要事务）；
    etl_module1_sales.py 用手动事务，它传 False。
    """
    return dict(
        host=os.environ.get('DORIS_HOST', '120.24.248.175'),
        port=int(os.environ.get('DORIS_PORT', '9030')),
        user=os.environ.get('DORIS_USER', 'etl_user'),
        password=_require('DORIS_PASSWORD', 'Doris ETL 账号密码'),
        database=os.environ.get('DORIS_DATABASE', 'looom'),
        charset='utf8mb4',
        autocommit=autocommit,
    )

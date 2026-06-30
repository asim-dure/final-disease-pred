"""
Read-only connector to the FMOH warehouse Postgres instance.
Mirrors ODC 3.0's app/core/warehouse.py safe_select pattern. This module
NEVER issues mutating SQL and enforces a session-level read-only flag on
every connection, in addition to the app-level keyword filter below.
"""
import os
import re
from functools import lru_cache

import pandas as pd
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

_BLOCKED = ("insert", "update", "delete", "drop", "alter", "create", "truncate", "grant")
_BLOCKED_RE = re.compile(r"\b(" + "|".join(_BLOCKED) + r")\b", re.IGNORECASE)


@lru_cache
def _engine() -> Engine:
    url = os.getenv("WAREHOUSE_DATABASE_URL", "").strip()
    if not url:
        raise RuntimeError("WAREHOUSE_DATABASE_URL is not set in .env")
    return create_engine(
        url,
        pool_pre_ping=True,
        pool_recycle=300,
        connect_args={"connect_timeout": 12, "options": "-c default_transaction_read_only=on"},
    )


def get_engine() -> Engine:
    return _engine()


def safe_select(sql: str, params: dict | None = None) -> pd.DataFrame:
    """Execute a read-only SELECT/WITH query. Raises ValueError on anything else."""
    lowered = sql.strip().lower()
    if not (lowered.startswith("select") or lowered.startswith("with")):
        raise ValueError("Only SELECT/WITH queries are permitted")
    if _BLOCKED_RE.search(lowered):
        raise ValueError("Mutating keywords are not permitted")
    return pd.read_sql(text(sql), get_engine(), params=params or {})


def normalize_lga_name(s: str) -> str:
    """Python-side equivalent of the SQL join-time normalization."""
    if s is None:
        return ""
    return re.sub(r"[^a-zA-Z0-9]", "", str(s)).lower()


NORMALIZE_SQL = "lower(regexp_replace({col}, '[^a-zA-Z0-9]', '', 'g'))"


def engine_ok() -> bool:
    try:
        safe_select("select 1 as ok")
        return True
    except Exception:
        return False

"""Source-side SQL for the chunked row check: chunk ids, aggregates and chunk predicates per database."""

from __future__ import annotations

import calendar
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Literal

from watersync.common import quote_sql_string
from watersync.sql_dialect import SqlDialect, sql_timestamp_literal

# MySQL is not a SqlDialect because ingestion needs nothing MySQL-specific; chunk hashing does.
CheckDialect = Literal["postgres", "sqlserver", "oracle", "mysql", "unknown"]
ChunkKind = Literal["numeric", "month", "none"]

TARGET_CHUNK_COUNT = 100


def check_dialect(sql_dialect: SqlDialect, jdbc_url: str = "") -> CheckDialect:
    if sql_dialect == "unknown" and "mysql" in jdbc_url.lower():
        return "mysql"
    return sql_dialect


def quote_identifier(name: str, dialect: CheckDialect) -> str:
    """Quotes a column name exactly as the source reported it, so mixed-case and reserved names work."""
    if dialect == "sqlserver":
        return "[" + name.replace("]", "]]") + "]"
    if dialect == "mysql":
        return "`" + name.replace("`", "``") + "`"
    if dialect in ("postgres", "oracle"):
        return '"' + name.replace('"', '""') + '"'
    return name


def decimal_sum_sql(expr: str, scale: int) -> str:
    # DECIMAL(38) keeps SUM from overflowing BIGINT (SQL Server) and makes every engine return the same type.
    return f"SUM(CAST({expr} AS DECIMAL(38, {scale})))"


def string_hash_sql(column: str, dialect: CheckDialect) -> str | None:
    """First 32 bits of the MD5 of a string column's UTF-8 bytes as an integer, 0 for NULL.

    Summing it per chunk gives an order-independent fingerprint that Spark reproduces on the target
    with ``conv(substring(md5(col), 1, 8), 16, 10)``. Returns None when the database has no MD5.
    """
    if dialect == "postgres":
        hashed = f"('x' || substr(md5({column}::text), 1, 8))::bit(32)::bigint"
    elif dialect == "sqlserver":
        # HASHBYTES hashes the stored bytes; convert to UTF-8 first (SQL Server 2019+) to match Spark.
        utf8 = f"CONVERT(VARCHAR(MAX), CAST({column} AS NVARCHAR(MAX)) COLLATE Latin1_General_100_BIN2_UTF8)"
        hashed = f"CAST(SUBSTRING(HASHBYTES('MD5', {utf8}), 1, 4) AS BIGINT)"
    elif dialect == "oracle":
        hashed = f"TO_NUMBER(SUBSTR(RAWTOHEX(STANDARD_HASH(TO_CHAR({column}), 'MD5')), 1, 8), 'XXXXXXXX')"
    elif dialect == "mysql":
        hashed = f"CAST(CONV(SUBSTRING(MD5({column}), 1, 8), 16, 10) AS UNSIGNED)"
    else:
        return None
    return f"COALESCE({hashed}, 0)"


def month_chunk_sql(column: str, dialect: CheckDialect) -> str:
    if dialect == "sqlserver":
        return f"(YEAR({column}) * 100 + MONTH({column}))"
    return f"(EXTRACT(YEAR FROM {column}) * 100 + EXTRACT(MONTH FROM {column}))"


def timestamp_literal(value: datetime, dialect: CheckDialect) -> str:
    text = value.strftime("%Y-%m-%d %H:%M:%S")
    if dialect in ("postgres", "sqlserver", "oracle"):
        return sql_timestamp_literal(text, dialect)
    # MySQL compares DATETIME columns with plain string literals.
    return f"'{text}'"


@dataclass(frozen=True)
class ChunkPlan:
    """How a table is split into chunks: ranges of an integer column, calendar months, or one chunk."""

    kind: ChunkKind
    column: str = ""
    minimum: int = 0
    width: int = 1

    @classmethod
    def numeric(cls, column: str, minimum: int, maximum: int, chunk_count: int = TARGET_CHUNK_COUNT) -> ChunkPlan:
        span = maximum - minimum + 1
        return cls("numeric", column, minimum, max(1, -(-span // chunk_count)))

    def source_sql(self, dialect: CheckDialect) -> str:
        column = quote_identifier(self.column, dialect)
        if self.kind == "numeric":
            # Decimal division, so rows below the planned minimum still floor like Spark does.
            return f"FLOOR((CAST({column} AS DECIMAL(38, 0)) - {self.minimum}) / {self.width})"
        if self.kind == "month":
            return month_chunk_sql(column, dialect)
        return "0"

    def spark_sql(self) -> str:
        column = "`" + self.column.replace("`", "``") + "`"
        if self.kind == "numeric":
            return f"FLOOR((CAST({column} AS DECIMAL(38, 0)) - {self.minimum}) / {self.width})"
        if self.kind == "month":
            return f"(YEAR({column}) * 100 + MONTH({column}))"
        return "0"

    def label(self, chunk_id: int | None) -> str:
        if self.kind == "none":
            return "all rows"
        if chunk_id is None:
            return f"{self.column} IS NULL"
        if self.kind == "numeric":
            low = self.minimum + chunk_id * self.width
            return f"{self.column} {low}–{low + self.width - 1}"
        return f"{self.column} {chunk_id // 100:04d}-{chunk_id % 100:02d}"

    def source_predicate(self, chunk_ids: list[int | None], dialect: CheckDialect) -> str:
        """WHERE clause that reads at least the rows of the given chunks from the source."""
        if self.kind == "none":
            return "1=1"
        column = quote_identifier(self.column, dialect)
        parts = [f"{column} IS NULL" for chunk_id in chunk_ids if chunk_id is None]
        for chunk_id in sorted(c for c in chunk_ids if c is not None):
            if self.kind == "numeric":
                low = self.minimum + chunk_id * self.width
                parts.append(f"({column} >= {low} AND {column} < {low + self.width})")
            else:
                year, month = divmod(chunk_id, 100)
                start = datetime(year, month, 1)
                end = start + timedelta(days=calendar.monthrange(year, month)[1])
                # A day of margin covers time zone differences between the source and Spark; the
                # rows are then narrowed to the chunk in Spark, the same way on both sides.
                parts.append(
                    f"({column} >= {timestamp_literal(start - timedelta(days=1), dialect)} "
                    f"AND {column} < {timestamp_literal(end + timedelta(days=1), dialect)})"
                )
        return " OR ".join(parts) or "1=0"


def chunk_aggregate_query(
    table: str,
    chunk_sql: str,
    sums: list[tuple[str, str, int]],
    hashes: list[tuple[str, str]],
    where: str = "1=1",
) -> str:
    """One row per chunk: ``ws_chunk_id``, ``row_count`` and an alias per sum (alias, column, scale) and hash."""
    aggregates = ["COUNT(*) AS row_count"]
    aggregates += [f"{decimal_sum_sql(column, scale)} AS {alias}" for alias, column, scale in sums]
    aggregates += [f"{decimal_sum_sql(expr, 0)} AS {alias}" for alias, expr in hashes]
    # The derived table lets GROUP BY use the alias, which SQL Server and Oracle do not allow directly.
    return (
        f"(SELECT ws_chunk_id, {', '.join(aggregates)} FROM ("
        f"SELECT {chunk_sql} AS ws_chunk_id, src.* FROM {table} src WHERE {where}"
        f") chunked GROUP BY ws_chunk_id) chunk_aggregates"
    )


RangeKind = Literal["number", "timestamp", "string"]
_RELATIVE_DAYS = re.compile(r"^-(\d{1,5})d$")


@dataclass(frozen=True)
class RowRange:
    """Rows with ``start <= column < end``; either bound may be missing. Values are typed, never raw SQL."""

    column: str
    kind: RangeKind
    start: Decimal | datetime | str | None = None
    end: Decimal | datetime | str | None = None

    @classmethod
    def parse(cls, column: str, kind: RangeKind, start: str, end: str, now: datetime | None = None) -> RowRange:
        return cls(column, kind, parse_range_bound(start, kind, now), parse_range_bound(end, kind, now))

    def source_sql(self, dialect: CheckDialect) -> str:
        quoted = quote_identifier(self.column, dialect)
        parts = []
        if self.start is not None:
            parts.append(f"{quoted} >= {range_literal(self.start, dialect)}")
        if self.end is not None:
            parts.append(f"{quoted} < {range_literal(self.end, dialect)}")
        return " AND ".join(parts) or "1=1"

    def describe(self) -> str:
        parts = []
        if self.start is not None:
            parts.append(f">= {_display(self.start)}")
        if self.end is not None:
            parts.append(f"< {_display(self.end)}")
        return f"{self.column} {' and '.join(parts)}"


def parse_range_bound(value: str, kind: RangeKind, now: datetime | None = None) -> Decimal | datetime | str | None:
    """Parses a user-supplied bound for a column of the given kind; '' means no bound."""
    text = (value or "").strip()
    if not text:
        return None
    if kind == "number":
        try:
            number = Decimal(text)
        except InvalidOperation:
            raise ValueError(f"Range bound '{text}' is not a number") from None
        if not number.is_finite():
            raise ValueError(f"Range bound '{text}' is not a number")
        return number
    if kind == "timestamp":
        relative = _RELATIVE_DAYS.match(text)
        if relative:
            # Relative bounds start at midnight, so every table of a run gets the same whole days.
            today = (now or datetime.now()).replace(hour=0, minute=0, second=0, microsecond=0)
            return today - timedelta(days=int(relative.group(1)))
        try:
            return datetime.fromisoformat(text)
        except ValueError:
            raise ValueError(
                f"Range bound '{text}' is not a date or timestamp; use YYYY-MM-DD, 'YYYY-MM-DD HH:MM:SS' or -<days>d"
            ) from None
    return text


def range_literal(value: Decimal | datetime | str, dialect: CheckDialect) -> str:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return timestamp_literal(value, dialect)
    return "'" + quote_sql_string(value) + "'"


def _display(value: Decimal | datetime | str) -> str:
    return value.strftime("%Y-%m-%d %H:%M:%S") if isinstance(value, datetime) else str(value)

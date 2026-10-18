-- @param config_table STRING
-- @param row_check_table STRING
-- @param days INT
-- @param refresh_token INT
-- Per day (UTC) and enabled table: the day's last whole-table basic check, and the rows the target gained since
-- the previous checked day (net of deletes). One extra day is read so the first day shown has a previous day; a
-- day with no earlier day falls back to the growth between its own first and last check.
WITH daily AS (
  SELECT
    r.ingestion_group,
    r.source_table_name,
    to_date(r.checked_at) AS day,
    max_by(r.source_count, r.checked_at) AS source_count,
    max_by(r.target_count, r.checked_at) AS target_count,
    max_by(r.count_diff, r.checked_at) AS count_diff,
    CASE WHEN count(*) > 1
      THEN max_by(r.target_count, r.checked_at) - min_by(r.target_count, r.checked_at)
    END AS growth_within_day
  FROM IDENTIFIER(:row_check_table) r
  JOIN IDENTIFIER(:config_table) c
    ON c.ingestion_group = r.ingestion_group AND c.source_table_name = r.source_table_name
  WHERE :refresh_token >= 0
    AND coalesce(c.enabled, true)
    AND r.check_mode = 'basic'
    AND r.status <> 'ERROR'
    AND r.checked_range IS NULL
    AND r.checked_at >= date_sub(current_date(), :days)
  GROUP BY r.ingestion_group, r.source_table_name, to_date(r.checked_at)
),
with_previous AS (
  SELECT
    *,
    coalesce(
      target_count - lag(target_count) OVER (PARTITION BY ingestion_group, source_table_name ORDER BY day),
      growth_within_day
    ) AS rows_ingested
  FROM daily
)
SELECT
  date_format(day, 'yyyy-MM-dd') AS day,
  ingestion_group,
  source_table_name,
  source_count,
  target_count,
  rows_ingested,
  count_diff
FROM with_previous
WHERE day > date_sub(current_date(), :days)
ORDER BY day, ingestion_group, source_table_name;

-- @param config_table STRING
-- @param ingestion_group STRING
-- @param search STRING
-- @param refresh_token INT
-- Enabled tables offered by the daily row count chart's table picker: at most 50 per search.
SELECT ingestion_group, source_table_name
FROM IDENTIFIER(:config_table)
WHERE :refresh_token >= 0
  AND coalesce(enabled, true)
  AND (:ingestion_group = '' OR ingestion_group = :ingestion_group)
  AND (:search = '' OR lower(source_table_name) LIKE concat('%', lower(:search), '%'))
ORDER BY ingestion_group, source_table_name
LIMIT 50;

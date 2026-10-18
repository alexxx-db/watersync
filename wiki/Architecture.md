# Architecture

```
jdbc_ingestion_config (Delta)          jdbc_ingestion_watermark (Delta)
        │                                          │
        ▼                                          │
IngestionConfigPlanner                             │
  └─ one for-each input per enabled table          │
        │                                          │
        ▼                                          │
JdbcIngestionOrchestrator                          │
  └─ one worker per config row                     │
        │                                          │
        ├─ TimestampWatermarkIngestionWorker ───────┤ read/write watermark state
        └─ EpicCsaIngestionWorker ─────────────────┘
                │
                ▼
        Bronze: staging Delta tables  (staging_table_fqn, append-only changes)
                │
                ▼
        CDC SCD2 pipeline  (cdc_pipeline.py / pipeline_bootstrap.py)
                │
                ▼
        Silver: SCD Type 2 history tables  (target_table_fqn)
```

Staging tables are the Bronze layer: raw changed rows exactly as read from the source. The `AUTO CDC` targets are the Silver layer: deduplicated SCD Type 2 history per business key. Gold models are built downstream. Full loads without `auto_cdc_from_snapshot` skip staging and the pipeline: they overwrite `target_table_fqn` directly.

A Lakeflow Job runs one ingestion group:

1. **`ingestion_configs`** — `notebooks/Task - Plan Configs` publishes the `table_configs` and `full_refresh_targets` task values
2. **`ingestion_worker`** — for-each task running `notebooks/Task - Run Ingestion` once per table (concurrency set by `foreach_concurrency`)
3. **`selective_pipeline_refresh`** — `src/watersync/utils/selective_pipeline_refresh` fully refreshes only the pipeline tables flagged `FULL_REFRESH`
4. **`cdc_scd2_pipeline`** — pipeline task that applies Bronze staged changes to the Silver SCD Type 2 targets

Steps 3 and 4 are added only when the group has incremental or snapshot-CDC sources. Jobs created by the Python `IngestionJobProvisioner` do not include step 3.

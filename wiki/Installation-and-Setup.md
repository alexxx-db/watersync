# Installation and Setup

## Installation

Install in editable mode from a notebook:

```python
%pip install -e /Workspace/Users/<user>/watersync
```

Or build a wheel for production jobs:

```bash
pip install build
python -m build --wheel
# upload dist/watersync-0.3.0-py3-none-any.whl to a UC volume
```

Optional extras: `watersync[lakebase]` (Lakebase test setup) and `watersync[zerobus]` (ZeroBus log handler).

## One-Time Setup

Create the Unity Catalog schema and the metadata tables:

```python
from watersync.utils import UnityCatalogSetup

setup = UnityCatalogSetup(spark, catalog="main", schema="watersync")
setup.create_all()
# Tables created:
#   main.watersync.jdbc_ingestion_config
#   main.watersync.jdbc_ingestion_watermark
#   main.watersync.watersync_logs
```

Or via the CLI:

```bash
watersync-setup-uc --catalog main --schema watersync
```

Setup is idempotent: existing tables and watermark state are kept, and missing config columns are added. Pass `--truncate-existing` to truncate every table in the schema except `jdbc_ingestion_config`, which resets watermark state.

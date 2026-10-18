# watersync-control-plane

The WaterSync Control Plane: a Databricks App ([AppKit](https://www.databricks.com/devhub/docs/appkit/v0/), React,
TypeScript, Tailwind CSS) to configure, schedule and monitor WaterSync ingestion without writing SQL.

- **Using the app:** [Control Plane App](../../wiki/Control-Plane-App.md) (pages, deployment, job settings) and
  [Import and Export](../../wiki/Import-and-Export.md).
- **Working on the app:** [App Development](../../wiki/App-Development.md) (local setup, API routes, migrations,
  logging, project structure).

## Quick start

Requires Node.js v22+, the Databricks CLI and a workspace.

```bash
cp .env.example .env   # set DATABRICKS_HOST and DATABRICKS_WAREHOUSE_ID
npm ci
npm run dev            # hot reload; the URL is printed in the console
```

Before pushing, run the same checks as CI:

```bash
npm run typecheck && npm run lint && npx vitest run
```

Deploy with the bundle in the repository root (`databricks bundle deploy -t dev`).

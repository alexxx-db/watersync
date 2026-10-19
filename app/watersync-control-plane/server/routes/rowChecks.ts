import type { Application } from 'express';
import { locationSchema, rowCheckJobPayloadSchema, rowCheckRunPayloadSchema } from '../schemas.js';
import { readRowCheckJob, runRowCheck, saveRowCheckJob } from '../rowChecks.js';
import { apiRoute } from '../logging.js';

/** Registers the row check routes: read and save the location's check job, and start a check. */
export function registerRowCheckRoutes(app: Application) {
  app.get(
    '/api/row-checks/job',
    apiRoute('row_checks_job_read', async (req, res) => {
      const { catalog, schema } = locationSchema.parse(req.query);
      res.json({ job: await readRowCheckJob(catalog, schema) });
    })
  );

  app.post(
    '/api/row-checks/job',
    apiRoute('row_checks_job_save', async (req, res) => {
      res.json(await saveRowCheckJob(rowCheckJobPayloadSchema.parse(req.body)));
    })
  );

  app.post(
    '/api/row-checks/run',
    apiRoute('row_checks_run', async (req, res) => {
      res.json(await runRowCheck(rowCheckRunPayloadSchema.parse(req.body)));
    })
  );
}

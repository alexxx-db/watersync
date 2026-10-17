import { z } from 'zod';
import type { Application } from 'express';
import { jobPayloadSchema, jobSchedulePayloadSchema } from '../schemas.js';
import { workspace, workspaceBaseUrl } from '../sql.js';
import { saveJob } from '../ingestionJobs.js';
import { apiRoute, logger } from '../logging.js';

/**
 * Registers job management routes (list, create/update, run, schedule).
 * Extracted from the monolithic server.ts for maintainability.
 */
export function registerJobRoutes(app: Application) {
  app.get(
    '/api/jobs',
    apiRoute('jobs_list', async (_req, res) => {
      const visibleJobs = [];
      for await (const job of workspace.jobs.list({ limit: 100, expand_tasks: false })) visibleJobs.push(job);
      const workspaceUrl = workspaceBaseUrl();
      const result = [];
      for (let offset = 0; offset < visibleJobs.length; offset += 8) {
        const batch = visibleJobs.slice(offset, offset + 8);
        const summaries = await Promise.all(
          batch.map(async (job) => {
            const recentRuns = [];
            if (job.job_id) {
              for await (const run of workspace.jobs.listRuns({
                job_id: job.job_id,
                limit: 10,
                expand_tasks: false,
              })) {
                recentRuns.push({
                  run_id: run.run_id,
                  run_url:
                    job.job_id && run.run_id
                      ? `${workspaceBaseUrl()}/jobs/${job.job_id}/runs/${run.run_id}`
                      : undefined,
                  run_name: run.run_name,
                  start_time: run.start_time,
                  end_time: run.end_time,
                  setup_duration: run.setup_duration,
                  execution_duration: run.execution_duration,
                  cleanup_duration: run.cleanup_duration,
                  state: run.state,
                });
              }
            }
            return {
              ...job,
              workspace_url: job.job_id ? `${workspaceUrl}/jobs/${job.job_id}` : workspaceUrl,
              runs: recentRuns,
            };
          })
        );
        result.push(...summaries);
      }
      logger.debug('jobs.listed', { jobCount: result.length });
      res.json({ jobs: result });
    })
  );

  app.get(
    '/api/node-types',
    apiRoute('node_types_list', async (_req, res) => {
      const response = await workspace.clusters.listNodeTypes();
      const nodeTypes = (response.node_types ?? [])
        .filter((nodeType) => !nodeType.is_deprecated && !nodeType.is_hidden && !nodeType.num_gpus)
        .sort((a, b) => a.memory_mb - b.memory_mb || a.num_cores - b.num_cores);
      // Smallest general-purpose node with at least 4 cores, falling back to any node with 4 cores.
      const preferred =
        nodeTypes.find((nodeType) => nodeType.num_cores >= 4 && /general/i.test(nodeType.category)) ??
        nodeTypes.find((nodeType) => nodeType.num_cores >= 4);
      res.json({
        nodeTypeIds: nodeTypes.map((nodeType) => nodeType.node_type_id),
        defaultNodeTypeId: preferred?.node_type_id ?? null,
      });
    })
  );

  app.post(
    '/api/jobs',
    apiRoute('jobs_save', async (req, res) => {
      const body = jobPayloadSchema.parse(req.body);
      res.json(await saveJob(body));
    })
  );

  app.post(
    '/api/jobs/:jobId/run',
    apiRoute('jobs_run', async (req, res) => {
      const jobId = z.coerce.number().int().positive().parse(req.params.jobId);
      const fullRefresh = (req.body as { fullRefresh?: unknown } | undefined)?.fullRefresh === true;

      if (fullRefresh) {
        // runNow cannot combine job_parameters with pipeline_params, so we
        // temporarily flip the pipeline task's full_refresh flag on the job
        // definition, trigger the run, then reset it.  The run captures the
        // setting at creation time so the immediate reset is safe.
        const job = await workspace.jobs.get({ job_id: jobId });
        const cdcTask = job.settings?.tasks?.find((t) => t.pipeline_task);
        if (cdcTask?.pipeline_task) {
          cdcTask.pipeline_task.full_refresh = true;
          await workspace.jobs.update({ job_id: jobId, new_settings: job.settings! });
        }

        const run = await workspace.jobs.runNow({
          job_id: jobId,
          job_parameters: { full_refresh: 'true' },
        });

        // Reset the pipeline task back to incremental
        if (cdcTask?.pipeline_task) {
          cdcTask.pipeline_task.full_refresh = false;
          await workspace.jobs.update({ job_id: jobId, new_settings: job.settings! });
        }

        logger.info('jobs.run_started', { jobId, runId: run.run_id, fullRefresh });
        res.json({ runId: run.run_id, fullRefresh });
      } else {
        const run = await workspace.jobs.runNow({ job_id: jobId });
        logger.info('jobs.run_started', { jobId, runId: run.run_id, fullRefresh });
        res.json({ runId: run.run_id, fullRefresh });
      }
    })
  );

  app.patch(
    '/api/jobs/:jobId/schedule',
    apiRoute('jobs_schedule', async (req, res) => {
      const body = jobSchedulePayloadSchema.parse({
        ...req.body,
        jobId: z.coerce.number().parse(req.params.jobId),
      });
      if (body.enabled) {
        await workspace.jobs.update({
          job_id: body.jobId,
          new_settings: {
            schedule: {
              quartz_cron_expression: body.quartzCronExpression,
              timezone_id: body.timezoneId,
              pause_status: body.pauseStatus,
            },
          },
        });
      } else {
        await workspace.jobs.update({ job_id: body.jobId, fields_to_remove: ['schedule'] });
      }
      logger.info('jobs.schedule_updated', {
        jobId: body.jobId,
        enabled: body.enabled,
        pauseStatus: body.pauseStatus,
      });
      res.json({ ok: true });
    })
  );
}

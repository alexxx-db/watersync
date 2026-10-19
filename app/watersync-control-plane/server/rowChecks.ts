import type { jobs } from '@databricks/sdk-experimental';
import { toRunAs } from './schemas.js';
import type { RowCheckJobPayload, RowCheckRunPayload } from './schemas.js';
import { workspace, workspaceBaseUrl } from './sql.js';
import { watersyncDependency } from './pipelines.js';
import { logger } from './logging.js';
import { jobCompute, readJobCompute, runAsIdentity, runAsTarget } from './jobCompute.js';

export const rowCheckNotebookPath = 'notebooks/Task - Row Check';
const taskKey = 'row_check';

// One job per metadata location: it checks every enabled table of every group there.
export const rowCheckJobName = (catalog: string, schema: string) => `[${catalog}.${schema}] Row Checks`;
const rowCheckFqn = (catalog: string, schema: string) => `${catalog}.${schema}._watersync_row_checks`;

async function findRowCheckJob(catalog: string, schema: string) {
  const name = rowCheckJobName(catalog, schema);
  for await (const job of workspace.jobs.list({ name, limit: 25, expand_tasks: false })) {
    if (job.settings?.name === name && job.job_id) return job.job_id;
  }
  return undefined;
}

const parameterValue = (run: jobs.BaseRun, name: string) => {
  const item = run.job_parameters?.find((parameter) => parameter.name === name);
  return item?.value ?? item?.default ?? '';
};

/** Creates or updates the location's row check job. Its default run is the basic check, on the schedule. */
export async function saveRowCheckJob(body: RowCheckJobPayload) {
  const name = rowCheckJobName(body.catalog, body.schema);
  const compute = jobCompute(body.compute, watersyncDependency(body.gitUrl, body.gitBranch));
  const runAs = toRunAs(body.runAs);
  const settings: jobs.JobSettings = {
    name,
    description: 'Compares WaterSync source tables with their targets. Created by the WaterSync control plane.',
    // Lets a detailed check started from the app run while the scheduled basic check is still going.
    max_concurrent_runs: 4,
    ...compute.settings,
    ...(body.compute.mode === 'SERVERLESS' ? { performance_target: body.compute.performanceTarget } : {}),
    ...(runAs ? { run_as: runAs } : {}),
    parameters: [
      { name: 'configuration_fqn', default: `${body.catalog}.${body.schema}.jdbc_ingestion_config` },
      { name: 'watermark_fqn', default: `${body.catalog}.${body.schema}.jdbc_ingestion_watermark` },
      { name: 'row_check_fqn', default: rowCheckFqn(body.catalog, body.schema) },
      { name: 'check_mode', default: 'basic' },
      { name: 'ingestion_group', default: '' },
      { name: 'source_table_name', default: '' },
      { name: 'max_parallel_tables', default: String(body.maxParallelTables) },
      { name: 'range_column', default: '' },
      { name: 'range_from', default: '' },
      { name: 'range_to', default: '' },
    ],
    tasks: [
      {
        task_key: taskKey,
        ...compute.task,
        notebook_task: {
          notebook_path: rowCheckNotebookPath,
          source: 'GIT',
          base_parameters: { job_run_id: '{{job.run_id}}' },
        },
      },
    ],
    git_source: { git_url: body.gitUrl, git_provider: 'gitHub', git_branch: body.gitBranch },
    ...(body.schedule.enabled
      ? {
          schedule: {
            quartz_cron_expression: body.schedule.quartzCronExpression,
            timezone_id: body.schedule.timezoneId,
            pause_status: body.schedule.pauseStatus,
          },
        }
      : {}),
  };
  const existingJobId = await findRowCheckJob(body.catalog, body.schema);
  let jobId = existingJobId;
  if (existingJobId) {
    await workspace.jobs.reset({ job_id: existingJobId, new_settings: settings });
  } else {
    jobId = (await workspace.jobs.create(settings as jobs.CreateJob)).job_id;
  }
  const action: 'created' | 'updated' = existingJobId ? 'updated' : 'created';
  logger.info('row_checks.job_saved', {
    action,
    jobId,
    name,
    scheduled: body.schedule.enabled,
    computeMode: body.compute.mode,
    runAs: body.runAs.mode,
  });
  return { jobId, action };
}

/** The location's row check job as the Databricks API reports it, with its recent runs; null when there is none. */
export async function readRowCheckJob(catalog: string, schema: string) {
  const jobId = await findRowCheckJob(catalog, schema);
  if (!jobId) return null;
  const job = await workspace.jobs.get({ job_id: jobId });
  const settings = job.settings;
  const parameters = new Map((settings?.parameters ?? []).map((item) => [item.name, item.default]));
  const runs = [];
  for await (const run of workspace.jobs.listRuns({ job_id: jobId, limit: 10, expand_tasks: false })) {
    runs.push({
      runId: run.run_id,
      runUrl: run.run_id ? `${workspaceBaseUrl()}/jobs/${jobId}/runs/${run.run_id}` : undefined,
      startTime: run.start_time,
      endTime: run.end_time,
      lifeCycleState: run.state?.life_cycle_state,
      resultState: run.state?.result_state,
      stateMessage: run.state?.state_message,
      checkMode: parameterValue(run, 'check_mode') || 'basic',
      ingestionGroup: parameterValue(run, 'ingestion_group'),
      sourceTableName: parameterValue(run, 'source_table_name'),
      rangeColumn: parameterValue(run, 'range_column'),
      rangeFrom: parameterValue(run, 'range_from'),
      rangeTo: parameterValue(run, 'range_to'),
    });
    if (runs.length >= 10) break;
  }
  return {
    jobId,
    workspaceUrl: `${workspaceBaseUrl()}/jobs/${jobId}`,
    gitUrl: settings?.git_source?.git_url ?? '',
    gitBranch: settings?.git_source?.git_branch ?? 'main',
    maxParallelTables: Number(parameters.get('max_parallel_tables') ?? 4) || 4,
    schedule: settings?.schedule ?? null,
    compute: readJobCompute(settings),
    runAs: runAsTarget(
      job.run_as_user_name ?? runAsIdentity(settings?.run_as) ?? job.creator_user_name,
      job.creator_user_name
    ),
    runs,
  };
}

/** Starts the row check job; the default is a basic check of every table, detailed checks name their table. */
export async function runRowCheck(body: RowCheckRunPayload) {
  const jobId = await findRowCheckJob(body.catalog, body.schema);
  if (!jobId) throw new Error('Set up the row check job for this location first');
  const run = await workspace.jobs.runNow({
    job_id: jobId,
    job_parameters: {
      check_mode: body.checkMode,
      ingestion_group: body.ingestionGroup,
      source_table_name: body.sourceTableName,
      // Always sent, so a run never inherits a range from the job defaults.
      range_column: body.rangeColumn,
      range_from: body.rangeFrom,
      range_to: body.rangeTo,
    },
  });
  logger.info('row_checks.run_started', {
    jobId,
    runId: run.run_id,
    checkMode: body.checkMode,
    ingestionGroup: body.ingestionGroup,
    sourceTableName: body.sourceTableName,
    rangeColumn: body.rangeColumn,
    rangeFrom: body.rangeFrom,
    rangeTo: body.rangeTo,
  });
  return { runId: run.run_id, runUrl: `${workspaceBaseUrl()}/jobs/${jobId}/runs/${run.run_id}` };
}

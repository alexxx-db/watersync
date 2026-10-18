import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { jobs } from '@databricks/sdk-experimental';
import { rowCheckJobPayloadSchema, rowCheckRunPayloadSchema } from './schemas.js';

// A minimal in-memory workspace: whatever saveRowCheckJob creates is what readRowCheckJob reads back.
const state: { job?: jobs.JobSettings; runs: jobs.BaseRun[] } = { runs: [] };
async function* listed<T>(items: T[]) {
  await Promise.resolve();
  yield* items;
}
const workspace = {
  jobs: {
    list: vi.fn(() => listed(state.job ? [{ job_id: 9, settings: { name: state.job.name } }] : [])),
    create: vi.fn((settings: jobs.JobSettings) => {
      state.job = settings;
      return Promise.resolve({ job_id: 9 });
    }),
    reset: vi.fn(({ new_settings }: { new_settings: jobs.JobSettings }) => {
      state.job = new_settings;
      return Promise.resolve();
    }),
    get: vi.fn(() => Promise.resolve({ job_id: 9, settings: state.job })),
    listRuns: vi.fn(() => listed(state.runs)),
    runNow: vi.fn(() => Promise.resolve({ run_id: 101 })),
  },
};
vi.mock('./sql.js', () => ({ workspace, workspaceBaseUrl: () => 'https://example.cloud.databricks.com' }));

const { readRowCheckJob, runRowCheck, saveRowCheckJob } = await import('./rowChecks.js');

const payload = (overrides: Record<string, unknown> = {}) =>
  rowCheckJobPayloadSchema.parse({
    catalog: 'dev',
    schema: 'watersync',
    gitUrl: 'https://github.com/databricks-industry-solutions/watersync',
    gitBranch: 'main',
    maxParallelTables: 6,
    schedule: { enabled: true, quartzCronExpression: '0 0 6 * * ?', timezoneId: 'UTC', pauseStatus: 'UNPAUSED' },
    ...overrides,
  });

beforeEach(() => {
  state.job = undefined;
  state.runs = [];
  vi.clearAllMocks();
});

describe('row check job', () => {
  it('creates one scheduled job per location that runs the basic check by default', async () => {
    expect(await saveRowCheckJob(payload())).toEqual({ jobId: 9, action: 'created' });
    const parameters = Object.fromEntries((state.job?.parameters ?? []).map((item) => [item.name, item.default]));
    expect(state.job?.name).toBe('[dev.watersync] Row Checks');
    expect(parameters).toMatchObject({
      configuration_fqn: 'dev.watersync.jdbc_ingestion_config',
      row_check_fqn: 'dev.watersync.watersync_row_checks',
      check_mode: 'basic',
      source_table_name: '',
      max_parallel_tables: '6',
      range_from: '',
    });
    expect(state.job?.schedule?.quartz_cron_expression).toBe('0 0 6 * * ?');
    expect(state.job?.tasks?.[0]?.notebook_task?.notebook_path).toBe('notebooks/Task - Row Check');
  });

  it('updates the existing job in place and drops a disabled schedule', async () => {
    await saveRowCheckJob(payload());
    const schedule = { enabled: false, quartzCronExpression: '0 0 6 * * ?', timezoneId: 'UTC', pauseStatus: 'PAUSED' };
    expect(await saveRowCheckJob(payload({ schedule }))).toEqual({ jobId: 9, action: 'updated' });
    expect(state.job?.schedule).toBeUndefined();
  });

  it('reads the settings and recent runs back from the job', async () => {
    await saveRowCheckJob(payload());
    state.runs = [
      {
        run_id: 5,
        state: { life_cycle_state: 'RUNNING' },
        job_parameters: [
          { name: 'check_mode', value: 'detailed', default: 'basic' },
          { name: 'source_table_name', value: 'public.orders', default: '' },
        ],
      },
    ];
    const job = await readRowCheckJob('dev', 'watersync');
    expect(job).toMatchObject({ jobId: 9, gitBranch: 'main', maxParallelTables: 6 });
    expect(job?.runs[0]).toMatchObject({
      runId: 5,
      checkMode: 'detailed',
      sourceTableName: 'public.orders',
      lifeCycleState: 'RUNNING',
    });
  });

  it('returns null when the location has no job', async () => {
    expect(await readRowCheckJob('dev', 'watersync')).toBeNull();
  });

  it('starts a detailed check for one table', async () => {
    await saveRowCheckJob(payload());
    const run = await runRowCheck(
      rowCheckRunPayloadSchema.parse({
        catalog: 'dev',
        schema: 'watersync',
        checkMode: 'detailed',
        ingestionGroup: 'sales',
        sourceTableName: 'public.orders',
        rangeFrom: '-30d',
      })
    );
    expect(run.runId).toBe(101);
    expect(workspace.jobs.runNow).toHaveBeenCalledWith({
      job_id: 9,
      job_parameters: {
        check_mode: 'detailed',
        ingestion_group: 'sales',
        source_table_name: 'public.orders',
        range_column: '',
        range_from: '-30d',
        range_to: '',
      },
    });
  });

  it('refuses to run before the job exists', async () => {
    await expect(
      runRowCheck(rowCheckRunPayloadSchema.parse({ catalog: 'dev', schema: 'watersync', checkMode: 'basic' }))
    ).rejects.toThrow('Set up the row check job');
  });
});

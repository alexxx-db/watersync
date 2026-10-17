import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { jobs, pipelines } from '@databricks/sdk-experimental';
import { jobPayloadSchema } from './schemas.js';

// A minimal in-memory workspace: whatever saveJob creates is what readJobSettings reads back, with the
// identity fields Databricks adds (the creator is the app service principal; run_as_user_name is effective).
const appServicePrincipal = '11111111-2222-3333-4444-555555555555';
const state: { job?: jobs.JobSettings; pipeline?: pipelines.CreatePipeline } = {};
const identity = (runAs?: { user_name?: string; service_principal_name?: string }) =>
  runAs?.user_name ?? runAs?.service_principal_name ?? appServicePrincipal;
// The SDK's list methods return async iterables.
async function* listed<T>(items: T[]) {
  await Promise.resolve();
  yield* items;
}
const workspace = {
  jobs: {
    list: vi.fn(() => listed(state.job ? [{ job_id: 7, settings: { name: state.job.name } }] : [])),
    create: vi.fn((settings: jobs.JobSettings) => {
      state.job = settings;
      return Promise.resolve({ job_id: 7 });
    }),
    reset: vi.fn(),
    get: vi.fn(() =>
      Promise.resolve({
        job_id: 7,
        creator_user_name: appServicePrincipal,
        run_as_user_name: identity(state.job?.run_as),
        settings: state.job,
      })
    ),
  },
  pipelines: {
    listPipelines: vi.fn(() => listed([])),
    create: vi.fn((settings: pipelines.CreatePipeline) => {
      state.pipeline = settings;
      return Promise.resolve({ pipeline_id: 'generated-pipeline' });
    }),
    get: vi.fn(({ pipeline_id }: { pipeline_id: string }) =>
      Promise.resolve(
        pipeline_id === 'generated-pipeline'
          ? {
              pipeline_id,
              name: state.pipeline?.name,
              creator_user_name: appServicePrincipal,
              run_as_user_name: identity(state.pipeline?.run_as),
              spec: state.pipeline,
            }
          : { pipeline_id, name: 'Hand-made pipeline', creator_user_name: 'someone@example.com' }
      )
    ),
  },
  workspace: { mkdirs: vi.fn(), import: vi.fn() },
};
vi.mock('./sql.js', () => ({
  workspace,
  // groupNeedsCdcPipeline: the group has incremental sources.
  execute: vi.fn(() => Promise.resolve({ result: { data_array: [['true']] } })),
  parameter: vi.fn(),
  tableName: vi.fn(),
}));

const { saveJob, readJobSettings } = await import('./ingestionJobs.js');

const payload = (overrides: Record<string, unknown> = {}) =>
  jobPayloadSchema.parse({
    catalog: 'dev',
    schema: 'watersync',
    ingestionGroup: 'sales',
    gitUrl: 'https://github.com/databricks-industry-solutions/watersync',
    gitBranch: 'feature/x',
    foreachConcurrency: 6,
    cdcPipelineId: null,
    schedule: {
      enabled: false,
      quartzCronExpression: '0 0 8 * * ?',
      timezoneId: 'America/New_York',
      pauseStatus: 'UNPAUSED',
    },
    compute: {
      mode: 'SERVERLESS',
      performanceTarget: 'PERFORMANCE_OPTIMIZED',
      sparkVersion: '',
      driverNodeTypeId: '',
      workerNodeTypeId: '',
      minWorkers: 1,
      maxWorkers: 4,
    },
    ...overrides,
  });
const roundTrip = async (body: ReturnType<typeof payload>) => {
  await saveJob(body);
  const { catalog: _catalog, schema: _schema, ...settings } = body;
  expect(await readJobSettings('dev', 'watersync', ['sales'])).toEqual([settings]);
};

describe('readJobSettings', () => {
  beforeEach(() => {
    state.job = undefined;
    state.pipeline = undefined;
  });

  it('reads back serverless settings run as the owner', async () => {
    await roundTrip(payload());
  });

  it('reads back job cluster, classic pipeline, schedule and explicit identities', async () => {
    await roundTrip(
      payload({
        schedule: { enabled: true, quartzCronExpression: '0 30 2 * * ?', timezoneId: 'UTC', pauseStatus: 'PAUSED' },
        compute: {
          mode: 'JOB_CLUSTER',
          performanceTarget: 'STANDARD',
          sparkVersion: '18.x-scala2.13',
          driverNodeTypeId: 'i3.2xlarge',
          workerNodeTypeId: 'i3.xlarge',
          minWorkers: 2,
          maxWorkers: 8,
        },
        pipelineCompute: {
          mode: 'CLASSIC',
          nodeTypeId: 'm5.xlarge',
          driverNodeTypeId: 'm5.2xlarge',
          minWorkers: 1,
          maxWorkers: 3,
          photon: true,
        },
        runAs: {
          job: { mode: 'USER', principal: 'data.engineer@example.com' },
          pipeline: { mode: 'SERVICE_PRINCIPAL', principal: '99999999-8888-7777-6666-555555555555' },
        },
      })
    );
  });

  it('keeps a pipeline supplied by ID', async () => {
    await roundTrip(payload({ cdcPipelineId: 'existing-pipeline' }));
  });

  it('ignores a job with the group name that belongs to another location', async () => {
    await saveJob(payload({ catalog: 'prod' }));
    expect(await readJobSettings('dev', 'watersync', ['sales'])).toEqual([]);
  });
});

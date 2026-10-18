import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { sql } from '@databricks/appkit-ui/js';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Input,
  Label,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useAnalyticsQuery,
} from '@databricks/appkit-ui/react';
import {
  CheckCircle2,
  ExternalLink,
  Play,
  RefreshCw,
  ScanSearch,
  Settings2,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import type { QueryRegistry } from '@databricks/appkit-ui/react';
import { api } from '../lib/api';
import { reportError, reportWarning, useReportedFailure } from '../lib/logging';
import type { Location, RowCheckJob, RowCheckMode, RowCheckRun } from '../types';
import { displayTime, formString, fqn } from '../utils';
import { useControl } from '../lib/control';
import { PageTitle, ErrorState, Metric, ScheduleFields, Toggle } from './shared';

type RowCheckRow = QueryRegistry['row_check_results']['result'][number];

const activeStates = ['PENDING', 'QUEUED', 'RUNNING', 'BLOCKED', 'TERMINATING', 'WAITING_FOR_RETRY'];
const isActive = (run: RowCheckRun) => activeStates.includes(run.lifeCycleState ?? '');
// Empty run parameters mean "every group" or "every table".
const runCovers = (run: RowCheckRun, row: RowCheckRow) =>
  (!run.ingestionGroup || run.ingestionGroup === row.ingestion_group) &&
  (!run.sourceTableName || run.sourceTableName === row.source_table_name);
const count = (value: number | string | null | undefined) => (value == null ? '—' : Number(value).toLocaleString());
const signed = (value: number | string | null | undefined) =>
  value == null ? '—' : `${Number(value) > 0 ? '+' : ''}${Number(value).toLocaleString()}`;
const pollIntervalMs = 15_000;

function CheckStatus({ status, running = false }: { status: string | null; running?: boolean }) {
  if (running) return <Badge variant="secondary">RUNNING</Badge>;
  if (!status) return <Badge variant="outline">NOT CHECKED</Badge>;
  return <Badge variant={status === 'MATCH' ? 'default' : 'destructive'}>{status}</Badge>;
}

export function RowChecksPage() {
  const { location, revision, refresh } = useControl();
  const [search, setSearch] = useState('');
  const [job, setJob] = useState<RowCheckJob | null>(null);
  const [jobLoading, setJobLoading] = useState(true);
  const [jobError, setJobError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [details, setDetails] = useState<RowCheckRow | null>(null);
  const [detailedFor, setDetailedFor] = useState<RowCheckRow | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const params = useMemo(
    () => ({
      config_table: sql.string(fqn(location, 'jdbc_ingestion_config')),
      row_check_table: sql.string(fqn(location, 'watersync_row_checks')),
      search: sql.string(search),
      refresh_token: sql.int(revision),
    }),
    [location, search, revision]
  );
  const { data, loading, error } = useAnalyticsQuery('row_check_results', params);
  useReportedFailure('query.row_check_results', error, { ...location, search });

  const loadJob = useCallback(async () => {
    try {
      const query = new URLSearchParams(location).toString();
      const result = await api<{ job: RowCheckJob | null }>(`/api/row-checks/job?${query}`);
      setJob(result.job);
      setJobError(null);
    } catch (x) {
      setJobError(reportError('row_checks.job_read', x, location));
    } finally {
      setJobLoading(false);
    }
  }, [location]);
  useEffect(() => {
    setJobLoading(true);
    void loadJob();
  }, [loadJob, revision]);

  // While a check is running, poll the job and reload the results once the run ends.
  const activeRuns = useMemo(() => job?.runs.filter(isActive) ?? [], [job]);
  const previousActive = useRef(0);
  useEffect(() => {
    if (previousActive.current > activeRuns.length) refresh();
    previousActive.current = activeRuns.length;
    if (!activeRuns.length) return;
    const timer = window.setTimeout(() => void loadJob(), pollIntervalMs);
    return () => window.clearTimeout(timer);
  }, [activeRuns, loadJob, refresh]);

  const start = async (checkMode: RowCheckMode, row?: RowCheckRow, range: RowCheckRange = noRange) => {
    const key = row ? `${row.ingestion_group}/${row.source_table_name}` : checkMode;
    setStarting(key);
    setRunError(null);
    try {
      await api('/api/row-checks/run', {
        method: 'POST',
        body: JSON.stringify({
          ...location,
          checkMode,
          ingestionGroup: row?.ingestion_group ?? '',
          sourceTableName: row?.source_table_name ?? '',
          ...range,
        }),
      });
      await loadJob();
    } catch (x) {
      setRunError(
        reportError('row_checks.run', x, { ...location, checkMode, sourceTableName: row?.source_table_name })
      );
    } finally {
      setStarting(null);
    }
  };

  const summary = useMemo(() => {
    const rows = data ?? [];
    return {
      tables: rows.length,
      match: rows.filter((row) => row.basic_status === 'MATCH').length,
      mismatch: rows.filter((row) => row.basic_status === 'MISMATCH').length,
      error: rows.filter((row) => row.basic_status === 'ERROR').length,
      lastCheck: rows.reduce<string | null>(
        (latest, row) =>
          row.basic_checked_at && (!latest || row.basic_checked_at > latest) ? row.basic_checked_at : latest,
        null
      ),
    };
  }, [data]);

  return (
    <>
      <PageTitle
        title="Source and target row checks"
        description="Compare each enabled source table with its target. Basic checks compare row counts and run on the job schedule; detailed checks compare per-chunk sums and hashes, then the rows of the chunks that differ, and are started here."
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setSetupOpen(true)} disabled={jobLoading}>
              <Settings2 className="mr-2 h-4 w-4" />
              {job ? 'Job settings' : 'Set up job'}
            </Button>
            <Button
              onClick={() => void start('basic')}
              disabled={
                !job || starting !== null || activeRuns.some((run) => run.checkMode === 'basic' && !run.sourceTableName)
              }
              title="Count the rows of every enabled table now"
            >
              <Play className="mr-2 h-4 w-4" />
              {starting === 'basic' ? 'Starting…' : 'Run basic check'}
            </Button>
          </div>
        }
      />
      {jobError && <ErrorState message={jobError} />}
      {runError && <ErrorState message={runError} />}
      {!jobLoading && !job && !jobError && (
        <Alert className="mb-6">
          <ScanSearch className="h-4 w-4" />
          <AlertTitle>No row check job for this location yet</AlertTitle>
          <AlertDescription>
            Set up the job to run the basic check every day and to start detailed checks from this page.
          </AlertDescription>
        </Alert>
      )}
      {job && <RunStrip job={job} activeRuns={activeRuns} />}
      <div className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Metric
          icon={CheckCircle2}
          tone="success"
          title="Counts match"
          value={summary.match}
          note={`of ${summary.tables} enabled tables · last basic check`}
        />
        <Metric
          icon={TriangleAlert}
          title="Counts differ"
          value={summary.mismatch}
          note="source and target row counts are not equal"
          destructive={summary.mismatch > 0}
        />
        <Metric
          icon={XCircle}
          title="Check errors"
          value={summary.error}
          note="the table could not be checked"
          destructive={summary.error > 0}
        />
        <Metric
          icon={RefreshCw}
          title="Latest basic check"
          value={displayTime(summary.lastCheck)}
          note={
            job?.schedule
              ? `schedule: ${job.schedule.quartz_cron_expression} (${job.schedule.timezone_id})`
              : 'not scheduled'
          }
        />
      </div>
      <div className="mb-4 flex gap-2">
        <Input
          aria-label="Filter row checks"
          placeholder="Filter group or source table"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button variant="outline" onClick={refresh} aria-label="Refresh">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>
      {loading ? (
        <Skeleton className="h-80" />
      ) : error ? (
        <ErrorState message={error} />
      ) : !data?.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No enabled tables</EmptyTitle>
            <EmptyDescription>Row checks run on the enabled rows of the configuration table.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Group</TableHead>
                <TableHead>Source → target</TableHead>
                <TableHead className="text-right">Source rows</TableHead>
                <TableHead className="text-right">Target rows</TableHead>
                <TableHead className="text-right">Difference</TableHead>
                <TableHead>Basic check</TableHead>
                <TableHead>Detailed check</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((row) => {
                const key = `${row.ingestion_group}/${row.source_table_name}`;
                const basicRunning = activeRuns.some((run) => run.checkMode === 'basic' && runCovers(run, row));
                const detailedRunning = activeRuns.some((run) => run.checkMode === 'detailed' && runCovers(run, row));
                return (
                  <TableRow key={key}>
                    <TableCell>{row.ingestion_group}</TableCell>
                    <TableCell>
                      <div className="font-mono text-xs">{row.source_table_name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{row.target_table_fqn}</div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{count(row.basic_source_count)}</TableCell>
                    <TableCell className="text-right tabular-nums">{count(row.basic_target_count)}</TableCell>
                    <TableCell
                      className={`text-right tabular-nums ${Number(row.basic_count_diff) ? 'font-semibold text-destructive' : ''}`}
                    >
                      {signed(row.basic_count_diff)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-1" title={row.basic_error ?? ''}>
                        <CheckStatus status={row.basic_status} running={basicRunning} />
                        <span className="text-xs text-muted-foreground">{displayTime(row.basic_checked_at)}</span>
                        <CheckedRange range={row.basic_checked_range} />
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-1" title={row.detailed_error ?? ''}>
                        <CheckStatus status={row.detailed_status} running={detailedRunning} />
                        {row.detailed_status && row.detailed_status !== 'ERROR' && (
                          <span className="text-xs text-muted-foreground">
                            {count(row.detailed_mismatched_chunks)} of {count(row.detailed_chunk_count)} chunks differ
                            {Number(row.detailed_drilled_chunks) > 0 &&
                              ` · ${count(row.detailed_missing_in_target)} missing · ${count(row.detailed_extra_in_target)} extra · ${row.detailed_mismatched_rows == null ? '—' : count(row.detailed_mismatched_rows)} changed`}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground">{displayTime(row.detailed_checked_at)}</span>
                        <CheckedRange range={row.detailed_checked_range} />
                      </div>
                    </TableCell>
                    <TableCell className="space-x-1 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDetailedFor(row)}
                        disabled={!job || starting !== null || detailedRunning}
                        title="Compare chunk aggregates, then the rows of the chunks that differ"
                      >
                        <ScanSearch className="mr-1 h-3.5 w-3.5" />
                        {starting === key ? 'Starting…' : 'Detailed check'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDetails(row)}
                        disabled={!row.basic_status && !row.detailed_status}
                      >
                        Details
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
      <RowCheckJobDialog
        open={setupOpen}
        job={job}
        location={location}
        onClose={() => setSetupOpen(false)}
        onSaved={() => {
          setSetupOpen(false);
          void loadJob();
        }}
      />
      <DetailedCheckDialog
        key={detailedFor ? `${detailedFor.ingestion_group}/${detailedFor.source_table_name}` : 'closed'}
        row={detailedFor}
        onClose={() => setDetailedFor(null)}
        onStart={(row, range) => {
          setDetailedFor(null);
          void start('detailed', row, range);
        }}
      />
      <RowCheckDetailsDialog row={details} onClose={() => setDetails(null)} />
    </>
  );
}

type RowCheckRange = { rangeColumn: string; rangeFrom: string; rangeTo: string };
const noRange: RowCheckRange = { rangeColumn: '', rangeFrom: '', rangeTo: '' };

function CheckedRange({ range }: { range: string | null }) {
  if (!range) return null;
  return (
    <span className="font-mono text-xs text-muted-foreground" title="Only these rows were checked">
      range: {range}
    </span>
  );
}

function DetailedCheckDialog({
  row,
  onClose,
  onStart,
}: {
  row: RowCheckRow | null;
  onClose: () => void;
  onStart: (row: RowCheckRow, range: RowCheckRange) => void;
}) {
  // Remounted per table (see the key where it is rendered), so this starts unchecked each time.
  const [ranged, setRanged] = useState(false);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!row) return;
    const form = new FormData(e.currentTarget);
    onStart(
      row,
      ranged
        ? {
            rangeColumn: formString(form, 'rangeColumn', ''),
            rangeFrom: formString(form, 'rangeFrom', ''),
            rangeTo: formString(form, 'rangeTo', ''),
          }
        : noRange
    );
  };
  return (
    <Dialog open={!!row} onOpenChange={(value) => !value && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Detailed check</DialogTitle>
          <DialogDescription>
            Compares per-chunk counts, sums and hashes of <span className="font-mono">{row?.source_table_name}</span>{' '}
            with its target, then the rows of the chunks that differ.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Toggle name="ranged" label="Check a range of rows only" checked={ranged} onCheckedChange={setRanged} />
          {ranged && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="range-column">Column</Label>
                <Input
                  id="range-column"
                  name="rangeColumn"
                  placeholder={row?.detailed_chunk_column ?? 'the table\u2019s chunk column'}
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty to use the chunk column: the integer partition column or key, else the timestamp watermark
                  column.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="range-from">From (inclusive)</Label>
                <Input id="range-from" name="rangeFrom" placeholder="-30d" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="range-to">To (exclusive)</Label>
                <Input id="range-to" name="rangeTo" placeholder="no limit" />
              </div>
              <p className="text-xs text-muted-foreground md:col-span-2">
                A number, a date (<span className="font-mono">2026-09-01</span>), a timestamp (
                <span className="font-mono">2026-09-01 12:00:00</span>) or a number of days back from today (
                <span className="font-mono">-30d</span>). Leave a bound empty for no limit on that side.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">
              <ScanSearch className="mr-2 h-4 w-4" />
              {ranged ? 'Check range' : 'Check whole table'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RunStrip({ job, activeRuns }: { job: RowCheckJob; activeRuns: RowCheckRun[] }) {
  const runs = job.runs.slice(0, 5);
  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Recent check runs</CardTitle>
            <CardDescription>
              {activeRuns.length
                ? `${activeRuns.length} running · this page updates when they finish`
                : 'Results appear in the table below when a run finishes.'}
            </CardDescription>
          </div>
          <Button asChild variant="ghost" size="sm">
            <a href={job.workspaceUrl} target="_blank" rel="noreferrer">
              Open job <ExternalLink className="ml-1 h-3.5 w-3.5" />
            </a>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {runs.length === 0 ? (
          <span className="text-sm text-muted-foreground">The job has not run yet.</span>
        ) : (
          runs.map((run) => {
            const state = run.resultState ?? run.lifeCycleState ?? 'UNKNOWN';
            return (
              <a
                key={run.runId}
                href={run.runUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
                title={run.stateMessage ?? ''}
              >
                <Badge variant={state === 'SUCCESS' ? 'default' : isActive(run) ? 'secondary' : 'destructive'}>
                  {state}
                </Badge>
                <span className="font-medium">{run.checkMode}</span>
                <span className="font-mono text-muted-foreground">
                  {run.sourceTableName || run.ingestionGroup || 'all tables'}
                  {(run.rangeFrom || run.rangeTo) &&
                    ` · ${run.rangeColumn || 'chunk column'} ${[run.rangeFrom && `>= ${run.rangeFrom}`, run.rangeTo && `< ${run.rangeTo}`].filter(Boolean).join(' and ')}`}
                </span>
                <span className="text-muted-foreground">{displayTime(run.startTime)}</span>
              </a>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function RowCheckJobDialog({
  open,
  job,
  location,
  onClose,
  onSaved,
}: {
  open: boolean;
  job: RowCheckJob | null;
  location: Location;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A new job is scheduled daily; an existing one keeps what the Databricks API reports.
  const [scheduleEnabled, setScheduleEnabled] = useState(true);
  const [scheduleActive, setScheduleActive] = useState(true);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setScheduleEnabled(job ? Boolean(job.schedule) : true);
    setScheduleActive(job?.schedule?.pause_status !== 'PAUSED');
  }, [open, job]);
  const schedule = job?.schedule ?? { quartz_cron_expression: '0 0 6 * * ?', timezone_id: 'UTC' };
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    try {
      await api('/api/row-checks/job', {
        method: 'POST',
        body: JSON.stringify({
          ...location,
          gitUrl: form.get('gitUrl'),
          gitBranch: form.get('gitBranch'),
          maxParallelTables: Number(form.get('maxParallelTables')),
          schedule: {
            enabled: scheduleEnabled,
            quartzCronExpression: formString(form, 'quartzCronExpression', '0 0 6 * * ?'),
            timezoneId: formString(form, 'timezoneId', 'UTC'),
            pauseStatus: scheduleActive ? 'UNPAUSED' : 'PAUSED',
          },
        }),
      });
      onSaved();
    } catch (x) {
      setError(reportError('row_checks.job_save', x, location));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{job ? 'Row check job settings' : 'Set up the row check job'}</DialogTitle>
          <DialogDescription>
            One serverless job,{' '}
            <span className="font-mono">
              [{location.catalog}.{location.schema}] Row Checks
            </span>
            , checks every enabled table at this location and writes to{' '}
            <span className="font-mono">{fqn(location, 'watersync_row_checks')}</span>.
          </DialogDescription>
        </DialogHeader>
        <form key={`${open}-${job?.jobId ?? 'new'}`} onSubmit={(event) => void submit(event)} className="space-y-4">
          {error && <ErrorState message={error} />}
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="row-check-git-url">GitHub repository</Label>
              <Input
                id="row-check-git-url"
                name="gitUrl"
                type="url"
                required
                defaultValue={job?.gitUrl || 'https://github.com/databricks-industry-solutions/watersync'}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="row-check-git-branch">Branch</Label>
              <Input id="row-check-git-branch" name="gitBranch" required defaultValue={job?.gitBranch ?? 'main'} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="row-check-parallel">Tables checked in parallel</Label>
              <Input
                id="row-check-parallel"
                name="maxParallelTables"
                type="number"
                min={1}
                max={32}
                required
                defaultValue={job?.maxParallelTables ?? 4}
              />
            </div>
          </div>
          <ScheduleFields
            enabled={scheduleEnabled}
            onEnabledChange={setScheduleEnabled}
            active={scheduleActive}
            onActiveChange={setScheduleActive}
            schedule={schedule}
          />
          <p className="text-xs text-muted-foreground">
            The schedule runs the basic check. Detailed checks only run when started from this page.
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : job ? 'Update job' : 'Create job'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type ChunkDetails = {
  chunking: 'numeric' | 'month' | 'none';
  summed_columns: string[];
  hashed_columns: string[];
  note?: string;
  chunks: Array<{
    chunk: number | null;
    label: string;
    source_rows: number;
    target_rows: number;
    differs: string[];
    drilled: boolean;
    missing_in_target?: number;
    extra_in_target?: number;
    mismatched?: number;
  }>;
};
const chunkingLabels = { numeric: 'ranges of', month: 'months of', none: 'one chunk' } as const;

function ChunkRowResult({ chunk }: { chunk: ChunkDetails['chunks'][number] }) {
  if (!chunk.drilled) return <span className="text-muted-foreground">not compared (chunk limit)</span>;
  const found = (chunk.missing_in_target ?? 0) + (chunk.extra_in_target ?? 0) + (chunk.mismatched ?? 0);
  if (!found) return <span className="text-muted-foreground">no row differences</span>;
  return (
    <span>
      {count(chunk.missing_in_target)} missing · {count(chunk.extra_in_target)} extra
      {chunk.mismatched != null && ` · ${count(chunk.mismatched)} changed`}
    </span>
  );
}

function RowCheckDetailsDialog({ row, onClose }: { row: RowCheckRow | null; onClose: () => void }) {
  const chunkDetails = useMemo(() => {
    if (!row?.detailed_chunk_details) return null;
    try {
      return JSON.parse(row.detailed_chunk_details) as ChunkDetails;
    } catch (x) {
      reportWarning('row_checks.chunk_details_unreadable', 'Chunk details are not valid JSON', { detail: String(x) });
      return null;
    }
  }, [row]);
  const samples = useMemo(() => {
    if (!row?.detailed_sample_keys) return null;
    try {
      return JSON.parse(row.detailed_sample_keys) as Record<string, Array<Record<string, string>>>;
    } catch (x) {
      reportWarning('row_checks.sample_keys_unreadable', 'Sample keys are not valid JSON', { detail: String(x) });
      return null;
    }
  }, [row]);
  const sampleLabels: Record<string, string> = {
    missing_in_target: 'Missing in target',
    extra_in_target: 'Extra in target',
    mismatched: 'Changed values',
  };
  return (
    <Dialog open={!!row} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Row check details</DialogTitle>
          <DialogDescription>
            {row?.ingestion_group} / <span className="font-mono">{row?.source_table_name}</span> →{' '}
            <span className="font-mono">{row?.target_table_fqn}</span>
          </DialogDescription>
        </DialogHeader>
        {row && (
          <div className="space-y-5 text-sm">
            <section className="space-y-1">
              <h3 className="font-semibold">Basic check · {displayTime(row.basic_checked_at)}</h3>
              <CheckedRange range={row.basic_checked_range} />
              {row.basic_error ? (
                <ErrorState message={row.basic_error} />
              ) : (
                <p>
                  Source {count(row.basic_source_count)} rows · target {count(row.basic_target_count)} active rows ·
                  difference {signed(row.basic_count_diff)}
                </p>
              )}
            </section>
            <section className="space-y-2">
              <h3 className="font-semibold">Detailed check · {displayTime(row.detailed_checked_at)}</h3>
              <CheckedRange range={row.detailed_checked_range} />
              {!row.detailed_status ? (
                <p className="text-muted-foreground">No detailed check has run for this table.</p>
              ) : row.detailed_error ? (
                <ErrorState message={row.detailed_error} />
              ) : (
                <>
                  <p>
                    Source {count(row.detailed_source_count)} · target {count(row.detailed_target_count)} ·{' '}
                    {count(row.detailed_mismatched_chunks)} of {count(row.detailed_chunk_count)} chunks differ ·{' '}
                    {count(row.detailed_missing_in_target)} missing in target · {count(row.detailed_extra_in_target)}{' '}
                    extra in target ·{' '}
                    {row.detailed_mismatched_rows == null
                      ? 'changed values not compared (no key columns)'
                      : `${count(row.detailed_mismatched_rows)} with changed values`}
                    {row.detailed_duration_ms != null &&
                      ` · took ${Math.round(Number(row.detailed_duration_ms) / 1000)}s`}
                  </p>
                  {chunkDetails && (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">
                        Aggregates compared over{' '}
                        {chunkDetails.chunking === 'none'
                          ? 'one chunk (no integer key, partition column or timestamp watermark to split by)'
                          : `${count(row.detailed_chunk_count)} chunks: ${chunkingLabels[chunkDetails.chunking]} ${row.detailed_chunk_column}`}
                        . Sums of{' '}
                        <span className="font-mono">
                          {chunkDetails.summed_columns.join(', ') || 'no numeric columns'}
                        </span>
                        ; hashes of{' '}
                        <span className="font-mono">
                          {chunkDetails.hashed_columns.join(', ') || 'no string columns'}
                        </span>
                        .
                      </p>
                      {chunkDetails.note && <p className="text-xs text-muted-foreground">{chunkDetails.note}</p>}
                      {chunkDetails.chunks.length > 0 && (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Chunk</TableHead>
                              <TableHead className="text-right">Source</TableHead>
                              <TableHead className="text-right">Target</TableHead>
                              <TableHead>Differs in</TableHead>
                              <TableHead>Rows</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {chunkDetails.chunks.map((chunk) => (
                              <TableRow key={chunk.label}>
                                <TableCell className="font-mono text-xs">{chunk.label}</TableCell>
                                <TableCell className="text-right tabular-nums">{count(chunk.source_rows)}</TableCell>
                                <TableCell className="text-right tabular-nums">{count(chunk.target_rows)}</TableCell>
                                <TableCell className="font-mono text-xs">{chunk.differs.join(', ')}</TableCell>
                                <TableCell className="text-xs">
                                  <ChunkRowResult chunk={chunk} />
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )}
                    </div>
                  )}
                  {row.detailed_compared_columns && Number(row.detailed_drilled_chunks) > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Rows of the differing chunks compared on:{' '}
                      <span className="font-mono">{row.detailed_compared_columns}</span>
                    </p>
                  )}
                  {samples &&
                    Object.entries(samples).map(([label, keys]) => (
                      <div key={label}>
                        <div className="text-xs font-medium">
                          {sampleLabels[label] ?? label} · first {keys.length} keys
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {keys.map((item) => {
                            const text = Object.entries(item)
                              .map(([column, value]) => `${column}=${value}`)
                              .join(', ');
                            return (
                              <Badge key={text} variant="outline" className="font-mono">
                                {text}
                              </Badge>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                </>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

import { useMemo } from 'react';
import { sql } from '@databricks/appkit-ui/js';
import {
  BarChart,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  LineChart,
  Skeleton,
  useAnalyticsQuery,
  useChartUITokens,
  useThemeColors,
} from '@databricks/appkit-ui/react';
import type { ChartUITokens } from '@databricks/appkit-ui/react';
import type { QueryRegistry } from '@databricks/appkit-ui/react';
import { useReportedFailure } from '../lib/logging';
import type { Location } from '../types';
import { fqn } from '../utils';
import { ErrorState } from './shared';

type DailyRow = QueryRegistry['row_check_daily']['result'][number];

const DAYS = 30;
// The categorical palette has 8 hues; more tables fold into "Other" instead of reusing a color.
const MAX_SERIES = 8;
const OTHER = 'Other tables';
const CHART_HEIGHT = 220;

const dayCount = (days: number) => (days === 1 ? '1 day' : `${days} days`);
const toNumber = (value: number | string | null) => (value == null || value === '' ? null : Number(value));

type Series = { label: string; keys: Set<string> };

/** Series in a fixed alphabetical order, so a table keeps its color in both charts and between reloads. */
function buildSeries(rows: DailyRow[]): Series[] {
  const names = new Map<string, { group: string; table: string; volume: number }>();
  for (const row of rows) {
    const key = `${row.ingestion_group}\u0000${row.source_table_name}`;
    const entry = names.get(key) ?? { group: row.ingestion_group, table: row.source_table_name, volume: 0 };
    entry.volume += Math.abs(toNumber(row.rows_ingested) ?? 0);
    names.set(key, entry);
  }
  const tableCounts = new Map<string, number>();
  for (const { table } of names.values()) tableCounts.set(table, (tableCounts.get(table) ?? 0) + 1);
  // The group is only shown when two groups load a table with the same name.
  const label = ({ group, table }: { group: string; table: string }) =>
    (tableCounts.get(table) ?? 0) > 1 ? `${group} · ${table}` : table;

  const entries = [...names.entries()];
  const kept =
    entries.length <= MAX_SERIES
      ? entries
      : [...entries].sort((a, b) => b[1].volume - a[1].volume).slice(0, MAX_SERIES - 1);
  const keptKeys = new Set(kept.map(([key]) => key));
  const series = kept
    .map(([key, entry]) => ({ label: label(entry), keys: new Set([key]) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const rest = entries.filter(([key]) => !keptKeys.has(key)).map(([key]) => key);
  if (rest.length) series.push({ label: OTHER, keys: new Set(rest) });
  return series;
}

/** One row per day with a column per series; null where a table has no value that day. */
function pivot(rows: DailyRow[], series: Series[], field: 'rows_ingested' | 'count_diff') {
  const byDay = new Map<string, Record<string, string | number | null>>();
  for (const row of rows) {
    const key = `${row.ingestion_group}\u0000${row.source_table_name}`;
    const target = series.find((item) => item.keys.has(key));
    const value = toNumber(row[field]);
    if (!target) continue;
    const day = byDay.get(row.day) ?? { day: row.day };
    if (value != null) day[target.label] = Number(day[target.label] ?? 0) + value;
    byDay.set(row.day, day);
  }
  const days: Array<Record<string, string | number | null>> = [];
  for (const day of byDay.values()) {
    // Every series gets a column, null where the table has no value that day.
    const complete: Record<string, string | number | null> = { day: day.day };
    for (const item of series) complete[item.label] = day[item.label] ?? null;
    days.push(complete);
  }
  return days.sort((a, b) => String(a.day).localeCompare(String(b.day)));
}

/**
 * ECharts options replacing the built-in series and axes, which would title-case table names
 * ("dbo.orders" -> "Dbo.Orders"), smooth lines between days and allow fractional row-count ticks.
 */
function dailyOptions(
  days: Array<Record<string, string | number | null>>,
  labels: string[],
  type: 'bar' | 'line',
  colors: string[],
  ui: ChartUITokens
) {
  return {
    xAxis: {
      type: 'time',
      minInterval: 86_400_000,
      axisLabel: { color: ui.axisLabel, formatter: '{MMM} {d}', hideOverlap: true },
      axisLine: { lineStyle: { color: ui.grid } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { color: ui.axisLabel, formatter: (value: number) => value.toLocaleString() },
      splitLine: { lineStyle: { color: ui.grid } },
    },
    series: labels.map((label, index) => ({
      name: label,
      type,
      data: days.map((day) => [day.day, day[label]]),
      color: colors[index % colors.length],
      tooltip: { valueFormatter: (value: number | null) => (value == null ? '—' : value.toLocaleString()) },
      ...(type === 'bar'
        ? { barMaxWidth: 14, itemStyle: { borderRadius: [4, 4, 0, 0] } }
        : { smooth: false, showSymbol: true, symbolSize: 8, lineStyle: { width: 2 }, connectNulls: false }),
    })),
  };
}

export function RowCheckDailyChart({ location, revision }: { location: Location; revision: number }) {
  const params = useMemo(
    () => ({
      config_table: sql.string(fqn(location, 'jdbc_ingestion_config')),
      row_check_table: sql.string(fqn(location, 'watersync_row_checks')),
      days: sql.int(DAYS),
      refresh_token: sql.int(revision),
    }),
    [location, revision]
  );
  const { data, loading, error } = useAnalyticsQuery('row_check_daily', params);
  useReportedFailure('query.row_check_daily', error, location);

  const chart = useMemo(() => {
    const rows = data ?? [];
    const series = buildSeries(rows);
    const ingested = pivot(rows, series, 'rows_ingested');
    const difference = pivot(rows, series, 'count_diff');
    const days = new Set(rows.map((row) => row.day)).size;
    const daysWithDifference = new Set(rows.filter((row) => Number(row.count_diff)).map((row) => row.day)).size;
    const totalIngested = rows.reduce((sum, row) => sum + (toNumber(row.rows_ingested) ?? 0), 0);
    const hasIngested = rows.some((row) => toNumber(row.rows_ingested) != null);
    return { series, ingested, difference, days, daysWithDifference, totalIngested, hasIngested };
  }, [data]);
  const labels = useMemo(() => chart.series.map((item) => item.label), [chart.series]);
  const colors = useThemeColors('categorical');
  const ui = useChartUITokens();
  const ingestedOptions = useMemo(
    () => dailyOptions(chart.ingested, labels, 'bar', colors, ui),
    [chart.ingested, labels, colors, ui]
  );
  const differenceOptions = useMemo(
    () => dailyOptions(chart.difference, labels, 'line', colors, ui),
    [chart.difference, labels, colors, ui]
  );

  return (
    <Card className="mb-6">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Daily row counts</CardTitle>
        <CardDescription>
          Last {DAYS} days (UTC), from each day&apos;s last whole-table basic check. Rows ingested is the target&apos;s
          growth since the previous checked day, net of deletes; on the first checked day, since that day&apos;s first
          check.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <Skeleton style={{ height: CHART_HEIGHT }} />
            <Skeleton style={{ height: CHART_HEIGHT }} />
          </div>
        ) : error ? (
          <ErrorState message={error} />
        ) : !chart.days ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No basic checks in the last {DAYS} days. The chart fills in as the scheduled check runs each day.
          </p>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            <section aria-label="Rows ingested per day">
              <h3 className="mb-1 text-sm font-medium">
                Rows ingested per day
                <span className="font-normal text-muted-foreground">
                  {chart.hasIngested ? ` · ${chart.totalIngested.toLocaleString()} in ${dayCount(chart.days)}` : ''}
                </span>
              </h3>
              {chart.hasIngested ? (
                <BarChart
                  data={chart.ingested}
                  xKey="day"
                  yKey={labels}
                  height={CHART_HEIGHT}
                  showLegend={labels.length > 1}
                  options={ingestedOptions}
                  ariaLabel="Rows ingested per day, by source table"
                />
              ) : (
                <p
                  className="flex items-center justify-center text-sm text-muted-foreground"
                  style={{ height: CHART_HEIGHT }}
                >
                  Appears once the basic check has run twice.
                </p>
              )}
            </section>
            <section aria-label="Target minus source rows per day">
              <h3 className="mb-1 text-sm font-medium">
                Target − source rows
                <span
                  className={
                    chart.daysWithDifference ? 'font-normal text-destructive' : 'font-normal text-muted-foreground'
                  }
                >
                  {chart.daysWithDifference
                    ? ` · differs on ${chart.daysWithDifference} of ${dayCount(chart.days)}`
                    : chart.days === 1
                      ? ' · equal on the 1 day'
                      : ` · equal on all ${chart.days} days`}
                </span>
              </h3>
              <LineChart
                data={chart.difference}
                xKey="day"
                yKey={labels}
                height={CHART_HEIGHT}
                showLegend={labels.length > 1}
                options={differenceOptions}
                ariaLabel="Target minus source row count per day, by source table"
              />
            </section>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

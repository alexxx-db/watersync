import { useEffect, useMemo, useState } from 'react';
import { sql } from '@databricks/appkit-ui/js';
import {
  BarChart,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  LineChart,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  useAnalyticsQuery,
  useChartUITokens,
  useThemeColors,
} from '@databricks/appkit-ui/react';
import type { ChartUITokens, QueryRegistry } from '@databricks/appkit-ui/react';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { useReportedFailure } from '../lib/logging';
import type { Location } from '../types';
import { fqn } from '../utils';
import { ErrorState } from './shared';

type DailyRow = QueryRegistry['row_check_daily']['result'][number];
type PickedTable = { group: string; table: string; slot: number };

const DAYS = 30;
// The categorical palette has 8 hues: at most 8 picked tables, or the top 7 and "Other tables".
const MAX_PICKED = 8;
const TOP_TABLES = 7;
const ALL_GROUPS = '__all__';
const CHART_HEIGHT = 220;

const dayCount = (days: number) => (days === 1 ? '1 day' : `${days} days`);
const toNumber = (value: number | string | null) => (value == null || value === '' ? null : Number(value));
const isTrue = (value: boolean | string) => value === true || value === 'true';
const tableKey = (group: string, table: string) => `${group}\u0000${table}`;

type Series = { key: string; label: string; color: string };

/**
 * One series per table the query returned, plus "Other tables" last. Picked tables keep the palette slot they
 * were given when picked; the top tables take slots in name order. Either way a table keeps its color in both
 * charts, and removing one table does not repaint the others.
 */
function buildSeries(rows: DailyRow[], picked: PickedTable[], colors: string[], otherColor: string): Series[] {
  const named = new Map<string, { group: string; table: string }>();
  let hasOther = false;
  for (const row of rows) {
    if (isTrue(row.is_other)) hasOther = true;
    else
      named.set(tableKey(row.ingestion_group, row.source_table_name), {
        group: row.ingestion_group,
        table: row.source_table_name,
      });
  }
  const nameCounts = new Map<string, number>();
  for (const { table } of named.values()) nameCounts.set(table, (nameCounts.get(table) ?? 0) + 1);
  const slots = new Map(picked.map((item) => [tableKey(item.group, item.table), item.slot]));
  const series = [...named.entries()]
    .sort((a, b) => a[1].table.localeCompare(b[1].table) || a[1].group.localeCompare(b[1].group))
    .map(([key, { group, table }], index) => ({
      key,
      // The group is only shown when two groups load a table with the same name.
      label: (nameCounts.get(table) ?? 0) > 1 ? `${group} · ${table}` : table,
      color: colors[(slots.get(key) ?? index) % colors.length],
    }));
  if (hasOther) series.push({ key: 'other', label: 'Other tables', color: otherColor });
  return series;
}

/** One row per day with a column per series; null where a series has no value that day. */
function pivot(rows: DailyRow[], series: Series[], field: 'rows_ingested' | 'count_diff') {
  const byKey = new Map(series.map((item) => [item.key, item.label]));
  const byDay = new Map<string, Record<string, string | number | null>>();
  for (const row of rows) {
    const label = byKey.get(isTrue(row.is_other) ? 'other' : tableKey(row.ingestion_group, row.source_table_name));
    if (!label) continue;
    let day = byDay.get(row.day);
    if (!day) {
      // Every series gets a column, null until the series has a value that day.
      day = { day: row.day };
      for (const item of series) day[item.label] = null;
      byDay.set(row.day, day);
    }
    day[label] = toNumber(row[field]);
  }
  return [...byDay.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
}

/**
 * ECharts options replacing the built-in series and axes, which would title-case table names
 * ("dbo.orders" -> "Dbo.Orders"), smooth lines between days and allow fractional row-count ticks.
 */
function dailyOptions(
  days: Array<Record<string, string | number | null>>,
  series: Series[],
  type: 'bar' | 'line',
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
    series: series.map(({ label, color }) => ({
      name: label,
      type,
      data: days.map((day) => [day.day, day[label]]),
      color,
      tooltip: { valueFormatter: (value: number | null) => (value == null ? '—' : value.toLocaleString()) },
      ...(type === 'bar'
        ? { barMaxWidth: 14, itemStyle: { borderRadius: [4, 4, 0, 0] } }
        : { smooth: false, showSymbol: true, symbolSize: 8, lineStyle: { width: 2 }, connectNulls: false }),
    })),
  };
}

/** Searchable, server-side list of enabled tables; picks up to MAX_PICKED. */
function TablePicker({
  location,
  group,
  revision,
  picked,
  onToggle,
}: {
  location: Location;
  group: string;
  revision: number;
  picked: PickedTable[];
  onToggle: (group: string, table: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const params = useMemo(
    () => ({
      config_table: sql.string(fqn(location, 'jdbc_ingestion_config')),
      ingestion_group: sql.string(group),
      search: sql.string(debounced),
      refresh_token: sql.int(revision),
    }),
    [location, group, debounced, revision]
  );
  const { data, loading, error } = useAnalyticsQuery('row_check_table_options', params, { autoStart: open });
  useReportedFailure('query.row_check_table_options', error, { ...location, group });
  const pickedKeys = new Set(picked.map((item) => tableKey(item.group, item.table)));
  const full = picked.length >= MAX_PICKED;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          // A combobox does not take its name from its text, so name it explicitly.
          aria-label="Source tables"
          className="min-w-56 justify-between"
        >
          {picked.length ? `${picked.length} of ${MAX_PICKED} tables` : `Top ${TOP_TABLES} by rows ingested`}
          <ChevronsUpDown className="ml-2 h-3.5 w-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search source tables" value={search} onValueChange={setSearch} />
          <CommandList>
            {loading ? (
              <div className="p-3 text-sm text-muted-foreground">Searching…</div>
            ) : error ? (
              <div className="p-3 text-sm text-destructive">{error}</div>
            ) : (
              <CommandEmpty>No enabled table matches.</CommandEmpty>
            )}
            {!loading &&
              (data ?? []).map((row) => {
                const key = tableKey(row.ingestion_group, row.source_table_name);
                const selected = pickedKeys.has(key);
                return (
                  <CommandItem
                    key={key}
                    value={key}
                    disabled={!selected && full}
                    onSelect={() => onToggle(row.ingestion_group, row.source_table_name)}
                  >
                    <Check className={`mr-2 h-4 w-4 ${selected ? 'opacity-100' : 'opacity-0'}`} />
                    <span className="truncate font-mono text-xs">{row.source_table_name}</span>
                    <span className="ml-auto pl-2 text-xs text-muted-foreground">{row.ingestion_group}</span>
                  </CommandItem>
                );
              })}
          </CommandList>
          <div className="border-t px-3 py-2 text-xs text-muted-foreground">
            {full
              ? `${MAX_PICKED} tables at most, one per chart color.`
              : 'Shows the first 50 matches; type to narrow.'}
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function RowCheckDailyChart({ location, revision }: { location: Location; revision: number }) {
  const [group, setGroup] = useState('');
  const [picked, setPicked] = useState<PickedTable[]>([]);

  const groupParams = useMemo(
    () => ({ table_name: sql.string(fqn(location, 'jdbc_ingestion_config')), refresh_token: sql.int(revision) }),
    [location, revision]
  );
  const { data: groups } = useAnalyticsQuery('ingestion_groups', groupParams);

  const params = useMemo(
    () => ({
      config_table: sql.string(fqn(location, 'jdbc_ingestion_config')),
      row_check_table: sql.string(fqn(location, 'watersync_row_checks')),
      days: sql.int(DAYS),
      ingestion_group: sql.string(group),
      tables: sql.string(
        picked.length ? JSON.stringify(picked.map(({ group: g, table }) => ({ group: g, table }))) : ''
      ),
      top: sql.int(TOP_TABLES),
      refresh_token: sql.int(revision),
    }),
    [location, group, picked, revision]
  );
  const { data, loading, error } = useAnalyticsQuery('row_check_daily', params);
  useReportedFailure('query.row_check_daily', error, { ...location, group, picked: picked.length });

  const colors = useThemeColors('categorical');
  const ui = useChartUITokens();
  const chart = useMemo(() => {
    const rows = data ?? [];
    // "Other tables" is not an entity, so it gets the muted axis color instead of a palette hue.
    const series = buildSeries(rows, picked, colors, ui.axisLabel);
    const days = new Set(rows.map((row) => row.day)).size;
    return {
      series,
      ingested: pivot(rows, series, 'rows_ingested'),
      difference: pivot(rows, series, 'count_diff'),
      days,
      tableCount: Math.max(0, ...rows.map((row) => Number(row.table_count) || 0)),
      daysWithDifference: new Set(rows.filter((row) => Number(row.count_diff)).map((row) => row.day)).size,
      totalIngested: rows.reduce((sum, row) => sum + (toNumber(row.rows_ingested) ?? 0), 0),
      hasIngested: rows.some((row) => toNumber(row.rows_ingested) != null),
    };
  }, [data, picked, colors, ui.axisLabel]);
  const ingestedOptions = useMemo(() => dailyOptions(chart.ingested, chart.series, 'bar', ui), [chart, ui]);
  const differenceOptions = useMemo(() => dailyOptions(chart.difference, chart.series, 'line', ui), [chart, ui]);
  const labels = chart.series.map((item) => item.label);

  const toggleTable = (tableGroup: string, table: string) =>
    setPicked((current) => {
      const key = tableKey(tableGroup, table);
      if (current.some((item) => tableKey(item.group, item.table) === key)) {
        return current.filter((item) => tableKey(item.group, item.table) !== key);
      }
      if (current.length >= MAX_PICKED) return current;
      // Keep the color the table has on screen when that slot is free, else take the lowest free slot, so
      // picking a table does not repaint it and tables already picked keep their colors.
      const used = new Set(current.map((item) => item.slot));
      const shown = chart.series.findIndex((item) => item.key === key);
      const onScreen = shown >= 0 && shown < MAX_PICKED && !current.length ? shown : -1;
      const slot =
        onScreen >= 0 && !used.has(onScreen)
          ? onScreen
          : ([...Array(MAX_PICKED).keys()].find((index) => !used.has(index)) ?? 0);
      return [...current, { group: tableGroup, table, slot }];
    });
  const changeGroup = (value: string) => {
    const next = value === ALL_GROUPS ? '' : value;
    setGroup(next);
    // Tables of other groups would match nothing once the group is narrowed.
    if (next) setPicked((current) => current.filter((item) => item.group === next));
  };
  const scope = picked.length
    ? `${picked.length} picked ${picked.length === 1 ? 'table' : 'tables'}`
    : chart.tableCount > TOP_TABLES
      ? `Top ${TOP_TABLES} of ${chart.tableCount.toLocaleString()} tables by rows ingested · the other ${(chart.tableCount - TOP_TABLES).toLocaleString()} in Other tables`
      : `${chart.tableCount.toLocaleString()} ${chart.tableCount === 1 ? 'table' : 'tables'}`;

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
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Select value={group || ALL_GROUPS} onValueChange={changeGroup}>
            <SelectTrigger className="h-8 w-48" aria-label="Ingestion group">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_GROUPS}>All groups</SelectItem>
              {(groups ?? []).map((item) => (
                <SelectItem key={item.ingestion_group} value={item.ingestion_group}>
                  {item.ingestion_group}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <TablePicker location={location} group={group} revision={revision} picked={picked} onToggle={toggleTable} />
          {picked.map((item) => (
            <span
              key={tableKey(item.group, item.table)}
              className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs"
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: colors[item.slot % colors.length] }}
                aria-hidden
              />
              <span className="font-mono">{item.table}</span>
              <button
                type="button"
                onClick={() => toggleTable(item.group, item.table)}
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${item.table}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {picked.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setPicked([])}>
              Clear
            </Button>
          )}
          {!loading && chart.days > 0 && <span className="ml-auto text-xs text-muted-foreground">{scope}</span>}
        </div>
        {loading ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <Skeleton style={{ height: CHART_HEIGHT }} />
            <Skeleton style={{ height: CHART_HEIGHT }} />
          </div>
        ) : error ? (
          <ErrorState message={error} />
        ) : !chart.days ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {group || picked.length
              ? `No basic checks of the selected ${picked.length ? 'tables' : 'group'} in the last ${DAYS} days.`
              : `No basic checks in the last ${DAYS} days. The chart fills in as the scheduled check runs each day.`}
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

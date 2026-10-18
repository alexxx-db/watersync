import { useMemo, useState } from 'react';
import { sql } from '@databricks/appkit-ui/js';
import {
  Button,
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useAnalyticsQuery,
} from '@databricks/appkit-ui/react';
import { Check, ChevronsUpDown, RefreshCw, Search, X } from 'lucide-react';
import { useReportedFailure } from '../lib/logging';
import { MAX_PICKED, tableKey, useDebounced } from '../lib/rowCheckFilters';
import type { PickedTable } from '../lib/rowCheckFilters';
import type { Location } from '../types';
import { fqn } from '../utils';

const ALL_GROUPS = '__all__';

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
  const debounced = useDebounced(search.trim());
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
          {picked.length ? `${picked.length} of ${MAX_PICKED} tables` : 'All tables'}
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

/** The Row checks page filters: group, picked tables and a table-name search, applied to every section. */
export function RowCheckFilterBar({
  location,
  revision,
  group,
  onGroupChange,
  searchInput,
  onSearchInputChange,
  picked,
  onToggle,
  onClear,
  colors,
  onRefresh,
}: {
  location: Location;
  revision: number;
  group: string;
  onGroupChange: (group: string) => void;
  searchInput: string;
  onSearchInputChange: (value: string) => void;
  picked: PickedTable[];
  onToggle: (group: string, table: string) => void;
  onClear: () => void;
  colors: string[];
  onRefresh: () => void;
}) {
  const groupParams = useMemo(
    () => ({ table_name: sql.string(fqn(location, 'jdbc_ingestion_config')), refresh_token: sql.int(revision) }),
    [location, revision]
  );
  const { data: groups } = useAnalyticsQuery('ingestion_groups', groupParams);
  const filtered = Boolean(group || searchInput || picked.length);
  return (
    <div className="mb-6 flex flex-wrap items-center gap-2 rounded-xl border bg-card px-4 py-3 shadow-sm">
      <span className="mr-1 text-sm font-medium">Filter</span>
      <Select value={group || ALL_GROUPS} onValueChange={(value) => onGroupChange(value === ALL_GROUPS ? '' : value)}>
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
      <TablePicker location={location} group={group} revision={revision} picked={picked} onToggle={onToggle} />
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" aria-hidden />
        <Input
          aria-label="Search table names"
          placeholder="Table name contains…"
          value={searchInput}
          onChange={(e) => onSearchInputChange(e.target.value)}
          className="h-8 w-64 pl-8"
        />
      </div>
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
            onClick={() => onToggle(item.group, item.table)}
            className="text-muted-foreground hover:text-foreground"
            aria-label={`Remove ${item.table}`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      {filtered && (
        <Button variant="ghost" size="sm" onClick={onClear}>
          Clear filters
        </Button>
      )}
      <Button variant="outline" size="sm" className="ml-auto" onClick={onRefresh} aria-label="Refresh">
        <RefreshCw className="h-4 w-4" />
      </Button>
    </div>
  );
}

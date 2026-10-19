import { useEffect, useState } from 'react';

/** A table picked in the Row checks filter bar; slot is its fixed palette color in the daily chart. */
export type PickedTable = { group: string; table: string; slot: number };
/** Filters applied to everything on the Row checks page. */
export type RowCheckFilters = { group: string; search: string; picked: PickedTable[] };

// The chart palette has 8 hues, one per picked table.
export const MAX_PICKED = 8;

export const tableKey = (group: string, table: string) => `${group}\u0000${table}`;

/** The picked tables as the JSON array the row check queries take; empty when none is picked. */
export const pickedTablesParam = (picked: PickedTable[]) =>
  picked.length ? JSON.stringify(picked.map(({ group, table }) => ({ group, table }))) : '';

/** Value after it stopped changing for delayMs, so typing does not send a query per keystroke. */
export function useDebounced<T>(value: T, delayMs = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

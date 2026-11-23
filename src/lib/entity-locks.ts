/**
 * Advisory lock keys for entity-graph writes (td-c6e871). Pure data, so the
 * enrichment worker can import it by relative path, as it does tags.ts.
 *
 * Lock order, always: the graph lock first (app only), then one day lock per
 * affected day in ascending day_id order. The worker takes only the day lock
 * for the one day it is rewriting, so no cycle is possible. Both are
 * transaction-scoped: pg_advisory_xact_lock(class, key).
 */
export const ENTITY_GRAPH_LOCK: readonly [number, number] = [81010, 0];
/** Second argument is the calendar_days.id. */
export const ENTITY_DAY_LOCK_CLASS = 81011;

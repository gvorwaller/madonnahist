/**
 * Admin audit-log viewer (td-310bf7). Read-only — no actions here write to
 * audit_log (viewing the log is not itself logged in v1, per the spec).
 *
 * Filters compose with AND, all via GET params so the page is linkable/
 * bookmarkable and the pager can preserve them, same convention as
 * src/routes/app/search/+page.server.ts. Every filter is a
 * `($n::type IS NULL OR ...)` no-op clause, same pattern as that file's
 * entity/tag/year filters.
 */
import { query } from '$lib/db';
import { error } from '@sveltejs/kit';
import { formatTimestampInAppTz, nextDateStr, startOfDayInAppTzAsUtc } from '$lib/server/time';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 50;
const MAX_SEARCH_LENGTH = 200;

function requireAdmin(locals: App.Locals) {
	if (!locals.user || locals.user.role !== 'admin') {
		error(403, 'Admin access required');
	}
}

function isValidDateParam(s: string | null): s is string {
	if (!s) return false;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
	const d = new Date(s + 'T00:00:00Z');
	return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

interface AuditRow {
	id: number;
	occurred_at: string;
	user_id: number | null;
	user_display_name: string | null;
	action: string;
	entity_type: string;
	entity_id: number;
	description: string;
	before_value: unknown;
	after_value: unknown;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	requireAdmin(locals);

	const actionParam = url.searchParams.get('action');
	const action = actionParam && actionParam.trim() !== '' ? actionParam : null;

	const userParamRaw = url.searchParams.get('user');
	const userIdNum = userParamRaw !== null ? Number(userParamRaw) : NaN;
	const userId = Number.isInteger(userIdNum) && userIdNum > 0 ? userIdNum : null;

	const entityTypeParam = url.searchParams.get('entityType');
	const entityType = entityTypeParam && entityTypeParam.trim() !== '' ? entityTypeParam : null;

	const fromParam = url.searchParams.get('from');
	const fromDate = isValidDateParam(fromParam) ? fromParam : null;
	const toParam = url.searchParams.get('to');
	const toDate = isValidDateParam(toParam) ? toParam : null;

	// Inclusive boundaries: "from" is that day's local midnight (UTC
	// instant); "to" is the NEXT day's local midnight, used as an exclusive
	// upper bound so the entire "to" day is included regardless of what time
	// of day occurred_at falls at.
	const fromInstant = fromDate ? startOfDayInAppTzAsUtc(fromDate) : null;
	const toInstant = toDate ? startOfDayInAppTzAsUtc(nextDateStr(toDate)) : null;

	const qParam = (url.searchParams.get('q') ?? '').slice(0, MAX_SEARCH_LENGTH).trim();
	const q = qParam !== '' ? qParam : null;

	const pageParamRaw = Number(url.searchParams.get('page') ?? '1');
	const page = Number.isFinite(pageParamRaw) && pageParamRaw >= 1 ? Math.floor(pageParamRaw) : 1;
	const offset = (page - 1) * PAGE_SIZE;

	const filterParams = [userId, action, entityType, fromInstant, toInstant, q];
	const whereClause = `
		($1::int IS NULL OR a.user_id = $1)
		AND ($2::text IS NULL OR a.action = $2)
		AND ($3::text IS NULL OR a.entity_type = $3)
		AND ($4::timestamptz IS NULL OR a.occurred_at >= $4)
		AND ($5::timestamptz IS NULL OR a.occurred_at < $5)
		AND ($6::text IS NULL OR a.description ILIKE '%' || $6 || '%')
	`;

	const [countRes, rowsRes, actionOptionsRes, userOptionsRes, entityTypeOptionsRes] = await Promise.all([
		query<{ total: number }>(
			`SELECT COUNT(*)::int AS total FROM audit_log a WHERE ${whereClause}`,
			filterParams
		),
		query<AuditRow>(
			`SELECT a.id, a.occurred_at::text AS occurred_at, a.user_id,
			        u.display_name AS user_display_name, a.action, a.entity_type,
			        a.entity_id, a.description, a.before_value, a.after_value
			   FROM audit_log a
			   LEFT JOIN users u ON u.id = a.user_id
			  WHERE ${whereClause}
			  ORDER BY a.occurred_at DESC, a.id DESC
			  LIMIT $7 OFFSET $8`,
			[...filterParams, PAGE_SIZE, offset]
		),
		query<{ action: string }>(`SELECT DISTINCT action FROM audit_log ORDER BY action`),
		// Only users who actually appear in audit_log — a user with zero rows
		// is not a useful filter option.
		query<{ id: number; display_name: string }>(
			`SELECT DISTINCT u.id, u.display_name
			   FROM audit_log a
			   JOIN users u ON u.id = a.user_id
			  ORDER BY u.display_name`
		),
		query<{ entity_type: string }>(`SELECT DISTINCT entity_type FROM audit_log ORDER BY entity_type`)
	]);

	const total = countRes.rows[0]?.total ?? 0;
	const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

	const rows = rowsRes.rows.map((r) => ({
		id: r.id,
		occurredAtDisplay: formatTimestampInAppTz(r.occurred_at),
		userDisplayName: r.user_display_name ?? '—',
		action: r.action,
		entityType: r.entity_type,
		entityId: r.entity_id,
		description: r.description,
		// JSONB comes back from node-pg as an object already — guard anyway,
		// per cs.md's "never JSON.parse a JSONB result without checking type
		// first" (a defensive habit, not evidence this ever arrives as a
		// string in practice).
		beforeValue:
			r.before_value === null
				? null
				: typeof r.before_value === 'string'
					? JSON.parse(r.before_value)
					: r.before_value,
		afterValue:
			r.after_value === null
				? null
				: typeof r.after_value === 'string'
					? JSON.parse(r.after_value)
					: r.after_value
	}));

	return {
		rows,
		page,
		pageSize: PAGE_SIZE,
		total,
		totalPages,
		filters: {
			action,
			user: userId,
			entityType,
			from: fromDate,
			to: toDate,
			q: qParam
		},
		actionOptions: actionOptionsRes.rows.map((r) => r.action),
		userOptions: userOptionsRes.rows,
		entityTypeOptions: entityTypeOptionsRes.rows.map((r) => r.entity_type)
	};
};

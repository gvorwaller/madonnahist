// refreshAfterNavigation (src/lib/viewer/refresh-core.ts), with a fake clock.
// The rule: refresh exactly once, never while a navigation is in progress,
// however long it takes (td-76a40f, CODEX round 4).
//
// Usage: npx tsx scripts/test-refresh.ts   (or: npm run test:refresh)

import { refreshAfterNavigation } from '../src/lib/viewer/refresh-core';

let pass = 0;
let fail = 0;
function record(label: string, ok: boolean, detail = '') {
	if (ok) pass++;
	else fail++;
	console.log(`${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✖\x1b[0m'} ${label}${ok || !detail ? '' : `\n    ${detail}`}`);
}

/** Runs the helper against a fake clock; `navigatingUntil` lists busy spans in ms. */
async function run(navigatingUntil: Array<[number, number]>) {
	let now = 0;
	const refreshesAt: number[] = [];
	const busyChecks: Array<{ at: number; busy: boolean }> = [];
	const isNavigating = () => {
		const busy = navigatingUntil.some(([from, to]) => now >= from && now < to);
		busyChecks.push({ at: now, busy });
		return busy;
	};
	await refreshAfterNavigation(
		isNavigating,
		async () => {
			refreshesAt.push(now);
		},
		async (ms) => {
			now += ms;
		}
	);
	return { refreshesAt, busyChecks };
}

{
	const r = await run([]);
	record('already settled: refreshes once, at once', r.refreshesAt.length === 1 && r.refreshesAt[0] === 0, JSON.stringify(r.refreshesAt));
}
{
	const r = await run([[0, 2500]]);
	record(
		'settles at 2.5s: one refresh, after it settles',
		r.refreshesAt.length === 1 && r.refreshesAt[0] >= 2500,
		JSON.stringify(r.refreshesAt)
	);
}
{
	const r = await run([[0, 31_000]]);
	record(
		'settles after 31s: still exactly one refresh, after it settles (no time limit)',
		r.refreshesAt.length === 1 && r.refreshesAt[0] >= 31_000,
		JSON.stringify(r.refreshesAt)
	);
}
{
	// One navigation replaced by another, then a third: busy 0–4s, 4–9s, 9–120s.
	const r = await run([
		[0, 4000],
		[4000, 9000],
		[9000, 120_000]
	]);
	record(
		'replacement navigations: waits for the last one, then refreshes once',
		r.refreshesAt.length === 1 && r.refreshesAt[0] >= 120_000,
		JSON.stringify(r.refreshesAt)
	);
}
{
	const r = await run([[0, 31_000]]);
	const refreshAt = r.refreshesAt[0];
	const busyAtRefresh = r.busyChecks.some((c) => c.at === refreshAt && c.busy);
	record('never refreshes while a navigation is in progress', !busyAtRefresh);
}

console.log(`\nPASS: ${pass}\nFAIL: ${fail}`);
if (fail > 0) process.exitCode = 1;

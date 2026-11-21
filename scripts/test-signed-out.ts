// Signed out while a form was open (td-46337c).
// 1. Every enhanced form goes through src/lib/forms.ts, which raises the
//    "You've been signed out" bar; nothing imports enhance from $app/forms.
// 2. The memory editor's kept draft (src/lib/viewer/memory-draft.ts) is only
//    given back to the same account, within a day, and only when well formed.
//
// Usage: npx tsx scripts/test-signed-out.ts   (or: npm run test:signed-out)

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
	DRAFT_MAX_AGE_MS,
	clearPending,
	dropDraftIf,
	isPending,
	keepDraft,
	markPending,
	markOutcomeIf,
	onKeptCopyOutcome,
	onPendingChange,
	newDraftId,
	parseDraft,
	readDraft
} from '../src/lib/viewer/memory-draft';

let pass = 0;
let fail = 0;
function record(label: string, ok: boolean, detail = '') {
	if (ok) pass++;
	else fail++;
	console.log(
		`${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✖\x1b[0m'} ${label}${ok || !detail ? '' : `\n    ${detail}`}`
	);
}

// ── 1. enhance imports ─────────────────────────────────────────────────
const SRC = path.join(import.meta.dirname, '..', 'src');
function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((n) => {
		const p = path.join(dir, n);
		if (statSync(p).isDirectory()) return walk(p);
		return /\.(svelte|ts|js)$/.test(n) ? [p] : [];
	});
}
const files = walk(SRC);
const WRAPPER = path.join(SRC, 'lib', 'forms.ts');
const kitEnhance = files.filter((f) => {
	if (f === WRAPPER) return false;
	const src = readFileSync(f, 'utf8');
	return /import\s*\{[^}]*\benhance\b[^}]*\}\s*from\s*['"]\$app\/forms['"]/.test(src);
});
record(
	'no file imports enhance from $app/forms except src/lib/forms.ts',
	kitEnhance.length === 0,
	kitEnhance.map((f) => path.relative(SRC, f)).join(', ')
);
const usesEnhance = files.filter(
	(f) => f.endsWith('.svelte') && readFileSync(f, 'utf8').includes('use:enhance')
);
const unwrapped = usesEnhance.filter(
	(f) => !/from\s*['"]\$lib\/forms['"]/.test(readFileSync(f, 'utf8'))
);
record(
	`every component with use:enhance imports the wrapper (${usesEnhance.length} files)`,
	usesEnhance.length > 20 && unwrapped.length === 0,
	unwrapped.map((f) => path.relative(SRC, f)).join(', ')
);
const layout = readFileSync(path.join(SRC, 'routes', '+layout.svelte'), 'utf8');
record('the root layout shows the signed-out bar', layout.includes('<SignedOutBar />'));

// ── 2. kept drafts ─────────────────────────────────────────────────────
const NOW = 1_800_000_000_000;
const fields = {
	precision: 'day',
	year: '1984',
	month: '7',
	day: '4',
	body: 'Fireworks — "so loud"\nline two'
};
const good = {
	id: 'c1',
	userId: '7',
	fields,
	version: 'v3',
	at: NOW - 1000,
	reason: 'signed-out'
};
const raw = (o: unknown) => JSON.stringify(o);

const back = parseDraft(raw(good), '7', NOW);
record(
	'same account, fresh: given back exactly (text, date, version)',
	!!back && JSON.stringify(back.fields) === JSON.stringify(fields) && back.version === 'v3'
);
record('another account: not given back', parseDraft(raw(good), '8', NOW) === null);
record('no account (signed out): not given back', parseDraft(raw(good), '', NOW) === null);
record(
	'older than a day: not given back',
	parseDraft(raw({ ...good, at: NOW - DRAFT_MAX_AGE_MS - 1 }), '7', NOW) === null
);
record(
	'just under a day: given back',
	parseDraft(raw({ ...good, at: NOW - DRAFT_MAX_AGE_MS + 1000 }), '7', NOW) !== null
);
record(
	'dated in the future: not given back',
	parseDraft(raw({ ...good, at: NOW + 3_600_000 }), '7', NOW) === null
);
record(
	'nothing kept / junk / not JSON',
	[null, '', 'null', '42', '{', '[]'].every((r) => parseDraft(r, '7', NOW) === null)
);
record(
	'bad precision or missing fields: not given back',
	parseDraft(raw({ ...good, fields: { ...fields, precision: 'week' } }), '7', NOW) === null &&
		parseDraft(raw({ ...good, fields: { ...fields, body: 5 } }), '7', NOW) === null &&
		parseDraft(raw({ ...good, fields: undefined }), '7', NOW) === null &&
		parseDraft(raw({ ...good, version: undefined }), '7', NOW) === null
);
record(
	'reason kept (signed-out / error); anything else refused',
	parseDraft(raw(good), '7', NOW)?.reason === 'signed-out' &&
		parseDraft(raw({ ...good, reason: 'error' }), '7', NOW)?.reason === 'error' &&
		parseDraft(raw({ ...good, reason: 'other' }), '7', NOW) === null &&
		parseDraft(raw({ ...good, reason: undefined }), '7', NOW) === null
);
record(
	'a new memory (no version yet) is given back',
	parseDraft(raw({ ...good, version: '' }), '7', NOW)?.version === ''
);
record(
	'extra keys are dropped, not passed through',
	JSON.stringify(
		Object.keys(parseDraft(raw({ ...good, fields: { ...fields, evil: 1 } }), '7', NOW)!.fields)
	) === JSON.stringify(['precision', 'year', 'month', 'day', 'body'])
);

record(
	'refused copy keeps its reason; a non-text detail is refused',
	parseDraft(raw({ ...good, reason: 'refused', detail: 'Please choose the year.' }), '7', NOW)
		?.detail === 'Please choose the year.' &&
		parseDraft(raw({ ...good, reason: 'refused', detail: 5 }), '7', NOW) === null
);
record(
	'no id: not given back',
	parseDraft(raw({ ...good, id: undefined }), '7', NOW) === null &&
		parseDraft(raw({ ...good, id: '' }), '7', NOW) === null
);
record('ids are fresh each time', newDraftId() !== newDraftId());

// dropDraftIf against an in-memory sessionStorage (round 4: a save retires
// only the copy it sent).
const mem = new Map<string, string>();
(globalThis as { sessionStorage?: unknown }).sessionStorage = {
	getItem: (k: string) => mem.get(k) ?? null,
	setItem: (k: string, v: string) => void mem.set(k, v),
	removeItem: (k: string) => void mem.delete(k)
};
const P = '/app/memories/new';
const copy = (id: string, body: string) =>
	({ ...good, id, at: Date.now(), fields: { ...fields, body } }) as Parameters<typeof keepDraft>[1];
keepDraft(P, copy('sent', 'the text that was saved'));
dropDraftIf(P, 'sent');
record('saved copy retired', readDraft(P, '7') === null);
keepDraft(P, copy('sent', 'the text that was saved'));
keepDraft(P, copy('newer', 'typed on a later visit'));
dropDraftIf(P, 'sent');
record(
	'a newer copy survives the older save',
	readDraft(P, '7')?.fields.body === 'typed on a later visit'
);
dropDraftIf(P, null);
record('no copy sent: nothing dropped', readDraft(P, '7')?.id === 'newer');

// markOutcomeIf: an unsettled save marks only the copy that was sent.
let told = '';
const offU = onKeptCopyOutcome((p, id, reason) => (told = `${p} ${id} ${reason}`));
keepDraft(P, copy('sent2', 'maybe saved'));
markOutcomeIf(P, 'other', 'error');
const untouched = readDraft(P, '7')?.reason;
markOutcomeIf(P, 'sent2', 'error');
const marked = readDraft(P, '7')?.reason;
markOutcomeIf(P, 'sent2', 'signed-out');
offU();
record(
	'unsettled save: only the sent copy takes the outcome; editors told',
	untouched === 'signed-out' &&
		marked === 'error' &&
		readDraft(P, '7')?.reason === 'signed-out' &&
		told === `${P} sent2 signed-out`,
	JSON.stringify({ untouched, marked, told })
);

let heard = 0;
const offP = onPendingChange(() => heard++);
markPending('p1');
const was = isPending('p1');
clearPending('p1');
clearPending('p1'); // a second clear is a no-op
offP();
markPending('p2');
record(
	'pending copies: marked, cleared, listeners told once each, unsubscribe works',
	was && !isPending('p1') && heard === 2 && isPending('p2')
);
clearPending('p2');

console.log(`\nPASS: ${pass}\nFAIL: ${fail}`);
if (fail > 0) process.exitCode = 1;

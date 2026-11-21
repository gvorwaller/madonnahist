// Modal dialogs are native <dialog>s (td-eb28c8).
// - No hand-made role="dialog" overlays: those let Tab reach the page behind.
// - Every <Modal> says how Escape closes it (onclose).
// - Every native <dialog> sends focus back to its opener (Safari doesn't
//   focus a clicked button, so the browser can't do it alone), and keeps
//   Tab inside (a modal <dialog> alone lets Tab out to the browser toolbar).
//
// Usage: npx tsx scripts/test-dialogs.ts   (or: npm run test:dialogs)

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

let pass = 0;
let fail = 0;
function record(label: string, ok: boolean, detail = '') {
	if (ok) pass++;
	else fail++;
	console.log(
		`${ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✖\x1b[0m'} ${label}${ok || !detail ? '' : `\n    ${detail}`}`
	);
}

const SRC = path.join(import.meta.dirname, '..', 'src');
function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((n) => {
		const p = path.join(dir, n);
		if (statSync(p).isDirectory()) return walk(p);
		return n.endsWith('.svelte') ? [p] : [];
	});
}
const files = walk(SRC).map((f) => ({ f, rel: path.relative(SRC, f), src: readFileSync(f, 'utf8') }));

const hand = files.filter((x) => /role="(alert)?dialog"/.test(x.src));
record('no role="dialog" overlays', hand.length === 0, hand.map((x) => x.rel).join(', '));

const modalUses = files.flatMap((x) =>
	[...x.src.matchAll(/<Modal\b[^>]*>/g)].map((m) => ({ rel: x.rel, tag: m[0] }))
);
const noClose = modalUses.filter((m) => !/\bonclose=/.test(m.tag));
const noName = modalUses.filter((m) => !/\b(label|labelledby)=/.test(m.tag));
record(
	`every <Modal> has onclose and a name (${modalUses.length} uses)`,
	modalUses.length >= 20 && noClose.length === 0 && noName.length === 0,
	[...noClose, ...noName].map((m) => `${m.rel}: ${m.tag}`).join('\n    ')
);

const native = files.filter(
	(x) => /<dialog\s/.test(x.src) && !x.rel.endsWith(path.join('components', 'Modal.svelte'))
);
const noRestore = native.filter((x) => !x.src.includes('restoreFocus('));
record(
	`every other <dialog> returns focus to its opener (${native.length} files)`,
	native.length >= 4 && noRestore.length === 0,
	noRestore.map((x) => x.rel).join(', ')
);

const modal = readFileSync(path.join(SRC, 'lib', 'components', 'Modal.svelte'), 'utf8');
record(
	'Modal: showModal, focus on the dialog (autofocus), Tab wraps, Escape handled, focus restored',
	modal.includes('showModal()') &&
		/<dialog[^>]*\bautofocus\b/.test(modal) &&
		modal.includes('onkeydown={trapTab}') &&
		modal.includes('oncancel=') &&
		modal.includes('restoreFocus(')
);
// LocationPicker is left out: its Google map has its own controls, some in
// shadow DOM, which a hand-made Tab order can't see.
const noTrap = native.filter((x) => !x.rel.includes('LocationPicker') && !x.src.includes('onkeydown={trapTab}'));
record(
	'every other <dialog> (but the map picker) wraps Tab inside',
	noTrap.length === 0,
	noTrap.map((x) => x.rel).join(', ')
);
const forms = readFileSync(path.join(SRC, 'lib', 'forms.ts'), 'utf8');
record(
	"forms.ts puts focus back after Kit's update resets it",
	(forms.match(/settleFocus\(\)/g) ?? []).length >= 2
);

console.log(`\nPASS: ${pass}\nFAIL: ${fail}`);
if (fail > 0) process.exitCode = 1;

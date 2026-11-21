<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { beforeNavigate, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { enhance } from '$lib/forms';
	import { MONTHS } from '$lib/viewer/nav';
	import { MEMORY_MAX, type MemoryFields, type Precision } from '$lib/viewer/memories';
	import {
		dropDraft,
		dropDraftIf,
		keepDraft,
		clearPending,
		isPending,
		markPending,
		newDraftId,
		onKeptCopySaved,
		onKeptCopyOutcome,
		markOutcomeIf,
		onPendingChange,
		readDraft,
		type KeptReason
	} from '$lib/viewer/memory-draft';
	import { isSignedOutResult, signInHref } from '$lib/viewer/session';

	/**
	 * Add / edit a memory (plan §3). Every "when" choice is a 48px tap card
	 * (AGY2 #5). Only the selects that matter exist, so the iOS picker's
	 * Prev/Next never steps through one that doesn't apply, and the day is
	 * clamped when the month changes (AGY2 #6). Selects, not type=month,
	 * because desktop Safari has no month picker.
	 */
	const {
		action,
		initial,
		mode,
		version = '',
		from = '',
		maxYear,
		error = null,
		canonical,
		onrestore,
		ondiscard
	}: {
		/** Absolute action path, e.g. "/app/memories/new?/save". */
		action: string;
		initial: MemoryFields;
		/** new: a new memory; draft / shared: editing one. */
		mode: 'new' | 'draft' | 'shared';
		version?: string;
		/** Validated /app path the writer came from; decides where a save lands. */
		from?: string;
		/** Latest selectable year. */
		maxYear: number;
		error?: string | null;
		/** The fields as stored on the server (from the page load); Discard returns to these. Defaults to `initial`. */
		canonical?: MemoryFields;
		/**
		 * A kept edit was put back: the page must send this version with every
		 * action (Save, Unshare, Delete), so none can overwrite or delete a
		 * revision the writer hasn't seen (CODEX td-46337c #2).
		 */
		onrestore?: (version: string) => void;
		/** Discard it: the page goes back to the version of `canonical` (CODEX td-46337c #1). */
		ondiscard?: () => void;
	} = $props();

	// The form keeps its own state; seeded once from the page data.
	// svelte-ignore state_referenced_locally
	let precision = $state<Precision>(initial.precision);
	// svelte-ignore state_referenced_locally
	let year = $state(initial.year);
	// svelte-ignore state_referenced_locally
	let month = $state(initial.month);
	// svelte-ignore state_referenced_locally
	let day = $state(initial.day);
	// svelte-ignore state_referenced_locally
	let body = $state(initial.body);
	let saving = $state(false);

	// Signed out before Save (td-46337c): what was typed is kept in this tab
	// and put back when they return signed in (src/lib/viewer/memory-draft.ts).
	/** Sign-in link shown after a save found the writer signed out. */
	let signInTo = $state<string | null>(null);
	/**
	 * Keeping the on-screen text, and why: after a sign-out (the notice is
	 * up) or after a save with no trustworthy answer (round 8 #2).
	 */
	let keeping = $state<KeptReason | null>(null);
	/** The last save got no trustworthy answer; the editor stays open and says so. */
	let saveFailed = $state(false);
	/** Whether the latest write of that copy succeeded; if not, the notice says copy it first. */
	let keptOnDevice = $state(false);
	/** Why a kept memory was put back into the form on this visit, if it was. */
	let restored = $state<KeptReason | null>(null);
	/** With `refused`: why the server turned it down. */
	let restoredDetail = $state('');
	// The editor page this form lives on; a kept memory belongs to it.
	const here = page.url.pathname;
	const userId = () => String(page.data.user?.id ?? '');
	/** The version the text on screen is based on, captured per submit. */
	let baseVersion = '';
	// Only this visit's latest save may touch the kept copy. An answer for
	// an earlier save, or one arriving after this editor has gone (Back,
	// then Forward to a new editor on the same page), must not overwrite or
	// drop what the current editor is keeping (CODEX td-46337c round 2 #1).
	let mounted = false;
	let latestSave = 0;

	const fields = (): MemoryFields => ({ precision, year, month, day, body });
	function keep(reason: KeptReason, who: string, base: string): boolean {
		return (
			!!who &&
			keepDraft(here, {
				id: newDraftId(),
				userId: who,
				fields: fields(),
				version: base,
				at: Date.now(),
				reason
			})
		);
	}

	/** The restored copy shown on this visit, to recognise it when a save retires it. */
	let restoredCopy: { id: string; fields: MemoryFields } | null = null;
	/** A save made before this visit has saved the restored copy (round 5). */
	let savedMeanwhile = $state<'same' | 'changed' | null>(null);
	/** The restored copy is still being saved from an earlier visit: wait for that answer. */
	let copyPending = $state(false);
	const syncPending = () => (copyPending = !!restoredCopy && isPending(restoredCopy.id));

	onMount(() => {
		mounted = true;
		const kept = readDraft(here, userId());
		if (kept) {
			({ precision, year, month, day, body } = kept.fields);
			onrestore?.(kept.version);
			restored = kept.reason;
			restoredDetail = kept.detail ?? '';
			restoredCopy = { id: kept.id, fields: kept.fields };
			syncPending();
		}
		const offPending = onPendingChange(syncPending);
		// An earlier visit's pending save of this very copy was accepted
		// (CODEX round 5): say so, and don't offer the same text as unsaved.
		const offOutcome = onKeptCopyOutcome((path, id, reason, detail) => {
			if (path !== here || !restoredCopy || id !== restoredCopy.id) return;
			// Typing on screen stays; the note takes the outcome's wording.
			restored = reason;
			restoredDetail = detail;
		});
		const off = onKeptCopySaved((path, id) => {
			if (path !== here || !restoredCopy || id !== restoredCopy.id) return;
			const f = restoredCopy.fields;
			const same =
				precision === f.precision &&
				year === f.year &&
				month === f.month &&
				day === f.day &&
				body === f.body;
			restoredCopy = null;
			copyPending = false;
			restored = null;
			savedMeanwhile = same ? 'same' : 'changed';
			if (same) {
				// Nothing on screen is unsaved: stop keeping (a copy written
				// since holds this same text) and, for a new memory, clear the
				// form so it can't be saved a second time. (An edit can't be
				// duplicated; its version check refuses it.)
				keeping = null;
				keptOnDevice = false;
				signInTo = null;
				saveFailed = false;
				dropDraft(here);
				if (mode === 'new') ({ precision, year, month, day, body } = canonical ?? initial);
			}
			// Changed: newer typing (and any copy kept of it) stays as it is.
		});
		return () => {
			mounted = false;
			off();
			offOutcome();
			offPending();
		};
	});

	// While "signed out" (or "something went wrong") is showing, the kept
	// copy follows what's on screen,
	// including edits made while the save was pending or after the notice
	// (CODEX td-46337c #4), so sign-in brings back exactly that.
	// A failed write (storage full, blocked) switches the notice to "copy it
	// first" rather than promising a copy that's out of date (round 2 #4).
	$effect(() => {
		if (!keeping) return;
		keptOnDevice = keep(keeping, userId(), baseVersion);
	});

	/** Put the form back as the server has it and forget the kept memory. */
	/** Discard is fetching the latest saved text first. */
	let discarding = $state(false);
	// A navigation that starts while Discard is loading may leave this page's
	// data unrefreshed (Kit drops the superseded load): Discard then stops
	// and the kept copy stays (CODEX round 12 #2).
	let discardSuperseded = false;
	beforeNavigate(() => {
		if (discarding) discardSuperseded = true;
	});

	async function discardKept() {
		// An existing memory may have changed since this page loaded (another
		// window saved after we got here): load what's saved now before
		// resetting, so the text and its version are the current pair
		// (CODEX round 11). If that load fails, the kept copy stays.
		if (mode !== 'new') {
			// Typing or a save while it loads also wins over the reset (round 12 #1).
			const typed = JSON.stringify(fields());
			const saveAt = latestSave;
			// Kit can resolve invalidateAll() without applying its result when
			// another refresh overlaps it (round 13): only a newly loaded
			// `canonical` proves the text and version below are fresh.
			const loadedBefore = canonical;
			discarding = true;
			discardSuperseded = false;
			try {
				await invalidateAll();
				await tick();
			} catch {
				return;
			} finally {
				discarding = false;
			}
			if (!mounted || discardSuperseded) return;
			if (JSON.stringify(fields()) !== typed || latestSave !== saveAt) return;
			if (!canonical || canonical === loadedBefore) return;
		}
		// Stop keeping first, so resetting the fields can't write it back (round 2 #3).
		keeping = null;
		keptOnDevice = false;
		signInTo = null;
		saveFailed = false;
		dropDraft(here);
		restoredCopy = null;
		({ precision, year, month, day, body } = canonical ?? initial);
		ondiscard?.();
		restored = null;
	}

	const years = $derived(Array.from({ length: maxYear - 1900 + 1 }, (_, i) => maxYear - i));
	const daysInMonth = $derived(
		year && month ? new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate() : 31
	);
	// 31 → 30, or 29 → 28 outside a leap year, when the month or year changes.
	$effect(() => {
		if (day && Number(day) > daysInMonth) day = String(daysInMonth);
	});

	const near = $derived(body.length >= MEMORY_MAX - 1000);

	const CHOICES: Array<{ value: Precision; label: string; hint: string }> = [
		{ value: 'day', label: 'A specific day', hint: 'Shows on that day' },
		{ value: 'month', label: 'A month', hint: 'Shows on the month page' },
		{ value: 'year', label: 'A year', hint: 'Shows on the year page' }
	];
</script>

<form
	method="POST"
	{action}
	data-signed-out-inline
	use:enhance={() => {
		saving = true;
		signInTo = null;
		// The text is paired with the version it was based on: the one sent.
		const base = version;
		const who = userId();
		const back = signInHref(page.url);
		const save = ++latestSave;
		keeping = null;
		saveFailed = false;
		savedMeanwhile = null;
		// If a copy is being kept, it now holds exactly what is being sent
		// (round 6 #2: edits made before Save included), under a new id that
		// this save owns and that stays "pending" in this document until it
		// is answered. It is stored as "may have been saved" (reason error)
		// until then, so a reload or a later visit before the answer never
		// offers it as plainly unsaved (round 8 #1). If it can't be
		// rewritten (storage full), the older copy is removed rather than
		// left looking unsaved; the text is still on screen (round 7 #1).
		const kept = readDraft(here, who);
		let sentCopy: string | null = null;
		if (kept) {
			const id = newDraftId();
			const sent = { ...kept, id, fields: fields(), version: base, at: Date.now() };
			if (keepDraft(here, { ...sent, reason: 'error' })) {
				sentCopy = id;
				restoredCopy = { id, fields: sent.fields };
				markPending(id);
			} else {
				dropDraft(here);
				restoredCopy = null;
			}
		}
		return async ({ result, update }) => {
			try {
				const signedOutNow = isSignedOutResult(result);
				// Superseded or gone: an obsolete answer must not act on the
				// page (a late redirect or error would navigate away from the
				// editor now on screen, CODEX round 3 #1). It only settles the
				// copy it sent: saved → retired (round 4); unknown → "may have
				// been saved"; refused → plainly unsaved. A newer copy has a
				// different id and stays as it is.
				if (!(mounted && save === latestSave)) {
					if (signedOutNow) markOutcomeIf(here, sentCopy, 'signed-out');
					else if (result.type === 'failure') {
						// A real refusal (no year, changed in another window…):
						// keep its own explanation, not "signed out" (round 9 #2).
						// The server's own conflict text says "reload the page",
						// which here would only restore this stale copy again;
						// the note offers Discard instead (round 10).
						const why = result.data?.error;
						const detail =
							result.status === 409
								? 'This memory was changed in another window since.'
								: typeof why === 'string'
									? why
									: '';
						markOutcomeIf(here, sentCopy, 'refused', detail);
					} else if (result.type === 'error') markOutcomeIf(here, sentCopy, 'error');
					else dropDraftIf(here, sentCopy);
					return;
				}
				// This editor is still here and handles its own answer, which
				// replaces any earlier restoration note (round 9 #1).
				if (sentCopy) restoredCopy = null;
				restored = null;
				if (signedOutNow || result.type === 'error') {
					// Not saved (signed out), or no trustworthy answer (network
					// failure, server error). Either way the editor stays open
					// with the text — no error page (round 8 #2) — and keeps it
					// on this device; the effect above keeps that copy current
					// with any further typing.
					baseVersion = base;
					keeping = who ? (signedOutNow ? 'signed-out' : 'error') : null;
					keptOnDevice = !!keeping && keep(keeping, who, base);
					if (signedOutNow) signInTo = back;
					else saveFailed = true;
					return;
				}
				// Saved, or refused with the text kept on screen as always.
				dropDraft(here);
				await update({ reset: false });
			} finally {
				if (sentCopy) clearPending(sentCopy);
				if (save === latestSave) saving = false;
			}
		};
	}}
	novalidate
>
	{#if version}<input type="hidden" name="version" value={version} />{/if}
	{#if from}<input type="hidden" name="from" value={from} />{/if}

	{#if savedMeanwhile}
		<p class="v-note" role="status">
			{#if savedMeanwhile === 'same'}
				Your memory was saved. You'll find it in <a href="/app/memories">My memories</a>.
			{:else}
				Your earlier text was saved (it's in <a href="/app/memories">My memories</a>). The changes
				below aren't saved yet.
			{/if}
		</p>
	{/if}

	{#if restored}
		<div class="v-note kept" role="status">
			{#if copyPending}
				<p>
					This was still being saved when you left the page. Waiting for the answer before it can
					be saved again…
				</p>
			{:else if restored === 'refused'}
				<p>
					Here's what you wrote. It wasn't saved{restoredDetail ? `: ${restoredDetail}` : '.'}
					To start again from what's saved now, copy anything you want to keep, then choose
					Discard it.
				</p>
			{:else if restored === 'error'}
				<p>
					Here's what you wrote when saving went wrong. It may not have been saved: check your
					memories before saving it again.
				</p>
			{:else}
				<p>Here's what you wrote before you were signed out. It isn't saved yet.</p>
			{/if}
			<button type="button" class="v-btn secondary" onclick={discardKept} disabled={saving || copyPending || discarding}
				>Discard it</button
			>
		</div>
	{/if}

	<fieldset class="when">
		<legend>When was it?</legend>
		<div class="choices">
			{#each CHOICES as c (c.value)}
				<label class="choice" class:on={precision === c.value}>
					<input type="radio" name="precision" value={c.value} bind:group={precision} />
					<span class="c-text"><b>{c.label}</b><small>{c.hint}</small></span>
				</label>
			{/each}
		</div>

		<div class="date-row">
			<label class="v-field">
				<span>Year</span>
				<select name="year" bind:value={year} required>
					<option value="" disabled>Year</option>
					{#each years as y (y)}<option value={String(y)}>{y}</option>{/each}
				</select>
			</label>
			{#if precision !== 'year'}
				<label class="v-field">
					<span>Month</span>
					<select name="month" bind:value={month} required>
						<option value="" disabled>Month</option>
						{#each MONTHS as name, i (name)}<option value={String(i + 1)}>{name}</option>{/each}
					</select>
				</label>
			{/if}
			{#if precision === 'day'}
				<label class="v-field">
					<span>Day</span>
					<select name="day" bind:value={day} required>
						<option value="" disabled>Day</option>
						{#each Array.from({ length: daysInMonth }, (_, i) => i + 1) as n (n)}
							<option value={String(n)}>{n}</option>
						{/each}
					</select>
				</label>
			{/if}
		</div>
	</fieldset>

	<div class="v-field">
		<label for="memory-body"><span class="lbl">Your memory</span></label>
		<textarea
			id="memory-body"
			name="body"
			rows="10"
			maxlength={MEMORY_MAX}
			bind:value={body}
			aria-describedby="memory-count"
		></textarea>
		<small id="memory-count" class:hidden={!near}>
			{body.length.toLocaleString('en-US')} of {MEMORY_MAX.toLocaleString('en-US')} characters
		</small>
	</div>

	{#if signInTo}
		<div class="v-alert" role="alert">
			{#if keptOnDevice}
				<p>
					You've been signed out, so your memory isn't saved yet. It's kept on this device:
					<a href={signInTo}>sign in</a> and it will be back here, ready to save.
				</p>
			{:else}
				<p>
					You've been signed out, so your memory isn't saved. Copy what you wrote first, then
					<a href={signInTo}>sign in</a> and paste it back.
				</p>
			{/if}
		</div>
	{:else if saveFailed}
		<div class="v-alert" role="alert">
			<p>
				Something went wrong while saving, so it may or may not have been saved. Check
				<a href="/app/memories">My memories</a> before saving it again.
				{#if !keptOnDevice}
					This device couldn't keep a copy, so copy your text somewhere first.
				{/if}
			</p>
		</div>
	{:else if error}
		<p class="v-alert" role="alert">{error}</p>
	{/if}

	<div class="v-actions">
		{#if mode === 'shared'}
			<button type="submit" class="v-btn primary" name="intent" value="keep" disabled={saving || copyPending || discarding}>
				{saving ? 'Saving…' : 'Save changes'}
			</button>
		{:else}
			<button type="submit" class="v-btn primary" name="intent" value="share" disabled={saving || copyPending || discarding}>
				{saving ? 'Saving…' : 'Save and share with family'}
			</button>
			<button type="submit" class="v-btn secondary" name="intent" value="keep" disabled={saving || copyPending || discarding}>
				Save draft
			</button>
		{/if}
	</div>
	{#if mode !== 'shared'}
		<p class="fine">A draft is only visible to you until you share it.</p>
	{/if}
</form>

<style>
	.when {
		margin: 12px 0 8px;
		padding: 0;
		border: 0;
	}
	legend {
		padding: 0;
		margin: 0 0 8px;
		font-size: 16px;
		font-weight: 700;
	}
	.choices {
		display: grid;
		gap: 8px;
		grid-template-columns: minmax(0, 1fr);
		margin-bottom: 14px;
	}
	@media (min-width: 600px) {
		.choices {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}
	.choice {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 52px;
		padding: 6px 14px;
		border: 1px solid var(--color-border);
		border-radius: 12px;
		background: var(--color-paper);
		cursor: pointer;
	}
	.choice.on {
		border: 2px solid var(--color-evergreen);
		background: var(--color-evergreen-soft);
		color: var(--color-evergreen-dark);
	}
	.choice input {
		width: 22px;
		height: 22px;
		margin: 0;
		accent-color: var(--color-evergreen);
		flex: none;
	}
	.choice:has(input:focus-visible) {
		outline: 3px solid var(--color-evergreen);
		outline-offset: 1px;
	}
	.c-text {
		display: flex;
		flex-direction: column;
	}
	.c-text small {
		font-size: 15px;
		color: var(--color-ink-muted);
	}
	.choice.on .c-text small {
		color: var(--color-evergreen-dark);
	}
	.date-row {
		display: grid;
		gap: 0 10px;
		grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
	}
	.lbl {
		font-size: 16px;
		font-weight: 700;
	}
	textarea {
		min-height: 220px;
		line-height: 1.55;
		resize: vertical;
	}
	.hidden {
		visibility: hidden;
	}
	.kept {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 16px;
	}
	.kept p,
	.v-alert p {
		margin: 0;
	}
	.v-alert a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		font-weight: 700;
		color: inherit;
	}
	.fine {
		margin: 10px 0 0;
		font-size: 15px;
		color: var(--color-ink-muted);
	}
</style>

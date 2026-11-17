<script lang="ts">
	import { enhance } from '$app/forms';
	import { MONTHS } from '$lib/viewer/nav';
	import { MEMORY_MAX, type MemoryFields, type Precision } from '$lib/viewer/memories';

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
		error = null
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
	use:enhance={() => {
		saving = true;
		return async ({ update }) => {
			await update({ reset: false });
			saving = false;
		};
	}}
	novalidate
>
	{#if version}<input type="hidden" name="version" value={version} />{/if}
	{#if from}<input type="hidden" name="from" value={from} />{/if}

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

	{#if error}
		<p class="v-alert" role="alert">{error}</p>
	{/if}

	<div class="v-actions">
		{#if mode === 'shared'}
			<button type="submit" class="v-btn primary" name="intent" value="keep" disabled={saving}>
				{saving ? 'Saving…' : 'Save changes'}
			</button>
		{:else}
			<button type="submit" class="v-btn primary" name="intent" value="share" disabled={saving}>
				{saving ? 'Saving…' : 'Save and share with family'}
			</button>
			<button type="submit" class="v-btn secondary" name="intent" value="keep" disabled={saving}>
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
	.fine {
		margin: 10px 0 0;
		font-size: 15px;
		color: var(--color-ink-muted);
	}
</style>

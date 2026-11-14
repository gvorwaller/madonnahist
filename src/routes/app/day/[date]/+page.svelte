<script lang="ts">
	import { page } from '$app/state';
	import { tick } from 'svelte';
	import ImageZoom from '$lib/components/viewer/ImageZoom.svelte';
	import { MONTHS, backLabel, backTarget, withFrom } from '$lib/viewer/nav';

	const { data } = $props();

	const DAY_MS = 86_400_000;
	const toDate = (s: string) => new Date(s + 'T00:00:00Z');
	const fmt = (s: string, opts: Intl.DateTimeFormatOptions) =>
		toDate(s).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });

	// Back goes wherever the reader came from (?from=, validated to /app
	// paths), else to Today for this day's month/day.
	const fallback = $derived(`/app?date=${data.entryDate.slice(5, 10)}`);
	const backHref = $derived(backTarget(page.url.searchParams.get('from'), fallback));
	const backText = $derived(backLabel(backHref));
	// Prev/next and chips keep the same origin, so Back survives browsing.
	const fromParam = $derived(page.url.searchParams.get('from'));
	const keepFrom = (href: string) =>
		fromParam && backHref === fromParam ? withFrom(href, fromParam) : href;
	const here = $derived(`/app/day/${data.entryDate}`);

	const year = $derived(data.entryDate.slice(0, 4));
	const monthKey = $derived(data.entryDate.slice(0, 7));
	const monthLabel = $derived(`${MONTHS[Number(data.entryDate.slice(5, 7)) - 1]} ${year}`);

	/** "Thu, Mar 11", plus the year when it differs from this day's year. */
	function navLabel(d: string): string {
		return fmt(d, {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			...(d.slice(0, 4) !== year ? { year: 'numeric' } : {})
		});
	}

	/** "Jul 19–25", "Jul 30 – Aug 2" or "Dec 30, 1975 – Jan 2, 1976". */
	function rangeLabel(start: Date, end: Date): string {
		const iso = (d: Date) => d.toISOString().slice(0, 10);
		const s = iso(start);
		const e = iso(end);
		if (s === e) return fmt(s, { month: 'short', day: 'numeric' });
		if (s.slice(0, 4) !== e.slice(0, 4))
			return `${fmt(s, { month: 'short', day: 'numeric', year: 'numeric' })} – ${fmt(e, { month: 'short', day: 'numeric', year: 'numeric' })}`;
		if (s.slice(5, 7) === e.slice(5, 7))
			return `${fmt(s, { month: 'short', day: 'numeric' })}–${Number(e.slice(8, 10))}`;
		return `${fmt(s, { month: 'short', day: 'numeric' })} – ${fmt(e, { month: 'short', day: 'numeric' })}`;
	}

	/** Note shown when Previous/Next jumps over untranscribed days. */
	function skipNote(neighbor: string | null, dir: 'prev' | 'next'): string | null {
		if (!neighbor) return null;
		const self = toDate(data.entryDate).getTime();
		const there = toDate(neighbor).getTime();
		const gap = Math.round(Math.abs(there - self) / DAY_MS) - 1;
		if (gap < 1) return null;
		const first = new Date(Math.min(self, there) + DAY_MS);
		const last = new Date(Math.max(self, there) - DAY_MS);
		const what = rangeLabel(first, last);
		const verb = gap === 1 ? "isn't" : "aren't";
		return dir === 'next'
			? `${what} ${verb} transcribed yet, so Next skips ahead.`
			: `${what} ${verb} transcribed yet, so Previous skips back.`;
	}

	const monthDayLabel = $derived(fmt(data.entryDate, { month: 'long', day: 'numeric' }));

	// Share (Slice 3): quote, date and link, because a link preview can't see
	// past sign-in (plan: AGY2 #11). Includes Madonna's memory (Gaylon,
	// mockup review 2026-11-07). Cancelling the share sheet does nothing;
	// without a share sheet it copies, and without clipboard access it shows
	// the text to copy by hand (CODEX #9).
	let shareStatus = $state<string | null>(null);
	let shareManual = $state<string | null>(null);
	function shareBody(): string {
		const when = fmt(data.entryDate, {
			weekday: 'long',
			month: 'long',
			day: 'numeric',
			year: 'numeric'
		});
		let text = `“${(data.correctedText ?? '').trim()}”\n— Madonna's calendar, ${when}`;
		if (data.dayNarrative?.trim()) text += `\n\nMadonna remembers: “${data.dayNarrative.trim()}”`;
		return text;
	}
	async function share() {
		shareStatus = null;
		shareManual = null;
		const url = `${location.origin}/app/day/${data.entryDate}`;
		const text = shareBody();
		if (typeof navigator.share === 'function') {
			try {
				await navigator.share({ title: document.title, text, url });
				return;
			} catch (e) {
				if (e instanceof DOMException && e.name === 'AbortError') return;
			}
		}
		const all = `${text}\n\n${url}`;
		try {
			await navigator.clipboard.writeText(all);
			shareStatus = 'Copied. Paste it into a message or email.';
		} catch {
			shareManual = all;
		}
	}

	let zoom: ImageZoom | undefined = $state();
	let imgFailed = $state(false);
	async function openZoom() {
		await tick();
		zoom?.open();
	}
</script>

<svelte:head>
	<title
		>{data.found
			? fmt(data.entryDate, { month: 'long', day: 'numeric', year: 'numeric' })
			: 'Not transcribed yet'}
		— Vorwaller Family History</title
	>
</svelte:head>

<div class="v-page wide">
	<a class="v-back" href={backHref}>◂ {backText}</a>

	{#if !data.found}
		<div class="v-empty">
			<div class="icon" aria-hidden="true">✍️</div>
			<h1 class="v-title">Not transcribed yet</h1>
			<p>
				{#if data.dateLabel}
					{data.dateLabel} hasn't been transcribed yet. Check back as Madonna works through the calendars.
				{:else}
					This day isn't transcribed yet.
				{/if}
			</p>
			<a class="v-btn primary" href={backHref}>◂ {backText}</a>
		</div>
	{:else}
		<p class="v-eyebrow">{fmt(data.entryDate, { weekday: 'long' })}</p>
		<h1 class="v-title">
			{fmt(data.entryDate, { month: 'long', day: 'numeric', year: 'numeric' })}
		</h1>

		<div class="day-grid">
			<div class="day-main">
				<p class="v-diary">{data.correctedText}</p>

				{#if data.dayNarrative}
					<aside class="v-memory" aria-label="Madonna's memory of this day">
						<p class="who">🗨 Madonna remembers</p>
						<p class="text">{data.dayNarrative}</p>
					</aside>
				{/if}

				{#if data.entities.length > 0 || data.tags.length > 0}
					<ul class="v-chips" aria-label="People, places and tags">
						{#each data.entities as ent (ent.entityType + ':' + ent.slug)}
							<li>
								<a class="v-chip" href={withFrom(`/app/${ent.entityType}/${ent.slug}`, here)}>
									<span class="v-chip-kind" aria-hidden="true"
										>{ent.entityType === 'person' ? '👤' : '📍'}</span
									>
									<span class="v-sr">{ent.entityType === 'person' ? 'Person:' : 'Place:'}</span>
									<span class="v-chip-label">{ent.displayName}</span>
								</a>
							</li>
						{/each}
						{#each data.tags as tag (tag.tag_slug)}
							<li>
								<a class="v-chip tag" href="/app/search?tag={tag.tag_slug}">
									<span class="v-sr">Tag:</span>
									<span class="v-chip-label">{tag.tag_label}</span>
								</a>
							</li>
						{/each}
					</ul>
				{/if}

				<div class="v-actions">
					<button type="button" class="v-btn secondary" onclick={share}>↗ Share this day</button>
					{#if data.hasImage && !imgFailed}
						<button type="button" class="v-btn secondary phone-only" onclick={openZoom}>
							✍️ See Madonna's handwriting
						</button>
					{/if}
					<a class="v-btn secondary" href={withFrom(`/app/month/${monthKey}`, here)}>
						📅 {monthLabel} page
					</a>
				</div>

				<p class="share-status" role="status">{shareStatus ?? ''}</p>
				{#if shareManual}
					<label class="share-manual">
						<span>Copy this and paste it into a message:</span>
						<textarea readonly rows="6" onfocus={(e) => e.currentTarget.select()}
							>{shareManual}</textarea
						>
					</label>
				{/if}

				<nav class="prevnext" aria-label="Nearby days">
					{#if data.prevDate}
						<a href={keepFrom(`/app/day/${data.prevDate}`)}
							><small>◂ Previous</small><b>{navLabel(data.prevDate)}</b></a
						>
					{:else}
						<span class="none"><small>◂ Previous</small><b>None yet</b></span>
					{/if}
					{#if data.nextDate}
						<a class="next" href={keepFrom(`/app/day/${data.nextDate}`)}
							><small>Next ▸</small><b>{navLabel(data.nextDate)}</b></a
						>
					{:else}
						<span class="none next"><small>Next ▸</small><b>None yet</b></span>
					{/if}
				</nav>
				{#each [skipNote(data.prevDate, 'prev'), skipNote(data.nextDate, 'next')] as note, i (i)}
					{#if note}
						<p class="skip-note">{note}</p>
					{/if}
				{/each}

				{#if data.otherYears.length > 0}
					<section class="other-years" aria-labelledby="oy-h">
						<h2 id="oy-h">{monthDayLabel} in other years</h2>
						<ul class="v-chips">
							{#each data.otherYears as d (d)}
								<li>
									<a class="v-chip" href={withFrom(`/app/day/${d}`, here)}>
										<span class="v-chip-label">{d.slice(0, 4)}</span>
									</a>
								</li>
							{/each}
						</ul>
						<a class="see-all" href="/app?date={data.entryDate.slice(5, 10)}"
							>Read them together on one page ▸</a
						>
					</section>
				{/if}
			</div>

			<div class="day-side">
				{#if data.hasImage && !imgFailed}
					<button type="button" class="lap-image" onclick={openZoom}>
						<span class="v-eyebrow">Madonna's handwriting</span>
						<img
							src="/app/day/{data.entryDate}/image?w=640"
							alt="Madonna's handwriting for this day"
							loading="lazy"
							onerror={() => (imgFailed = true)}
						/>
						<span class="hint">Click to enlarge</span>
					</button>
				{:else}
					<p class="img-missing">
						The photo of this day's handwriting isn't available right now. The words are complete.
					</p>
				{/if}
			</div>
		</div>
	{/if}
</div>

{#if data.found && data.hasImage}
	<ImageZoom
		bind:this={zoom}
		src="/app/day/{data.entryDate}/image"
		alt="Madonna's handwriting for {fmt(data.entryDate, {
			month: 'long',
			day: 'numeric',
			year: 'numeric'
		})}"
		monthHref={withFrom(`/app/month/${monthKey}`, here)}
		monthLabel="The whole {monthLabel} page"
	/>
{/if}

<style>
	.v-empty {
		margin-top: 8px;
	}
	.day-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0 32px;
		margin-top: 10px;
	}
	.day-side {
		margin-top: 22px;
	}
	.lap-image {
		display: none;
	}
	@media (min-width: 1024px) {
		.day-grid {
			grid-template-columns: minmax(0, 62ch) minmax(0, 1fr);
			align-items: start;
		}
		.day-side {
			position: sticky;
			top: calc(var(--topbar-h) + 16px);
			margin-top: 0;
		}
		.phone-only {
			display: none;
		}
		.lap-image {
			display: flex;
			flex-direction: column;
			gap: 6px;
			width: 100%;
			padding: 0;
			border: 0;
			background: none;
			text-align: left;
			cursor: zoom-in;
		}
		.lap-image img {
			display: block;
			width: 100%;
			height: auto;
			border: 1px solid var(--color-border);
			border-radius: 10px;
			background: #f4ecd6;
		}
		.lap-image .hint {
			font-size: 15px;
			color: var(--color-ink-muted);
		}
	}
	.img-missing {
		margin: 0;
		padding: 14px;
		border: 1px dashed var(--color-ink-muted);
		border-radius: 10px;
		color: var(--color-ink-muted);
		font-size: 16px;
		text-align: center;
	}

	.share-status {
		margin: 6px 0 0;
		font-size: 16px;
		font-weight: 600;
		color: var(--color-evergreen-dark);
	}
	.share-status:empty {
		display: none;
	}
	.share-manual {
		display: grid;
		gap: 6px;
		margin-top: 10px;
		font-size: 16px;
		font-weight: 600;
	}
	.share-manual textarea {
		width: 100%;
		font: inherit;
		font-weight: 400;
		padding: 10px;
		border: 1px solid var(--color-ink-muted);
		border-radius: 10px;
		background: var(--color-paper);
		color: var(--color-ink);
	}

	.prevnext {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: 10px;
		margin: 22px 0 0;
	}
	.prevnext a,
	.prevnext .none {
		display: flex;
		flex-direction: column;
		justify-content: center;
		min-height: 60px;
		padding: 6px 12px;
		border-radius: 10px;
		border: 1px solid var(--color-border);
		background: var(--color-paper);
		text-decoration: none;
		color: var(--color-ink);
	}
	.prevnext a:hover {
		border-color: var(--color-ink-muted);
	}
	.prevnext .none {
		background: transparent;
		border-style: dashed;
		color: var(--color-ink-muted);
	}
	.prevnext .next {
		text-align: right;
	}
	.prevnext small {
		font-size: 15px;
		color: var(--color-ink-muted);
		font-weight: 600;
	}
	.prevnext b {
		font-size: 17px;
	}
	.skip-note {
		font-size: 15px;
		color: var(--color-ink-muted);
		margin: 6px 0 0;
		text-align: center;
	}
	.other-years {
		margin-top: 26px;
		padding-top: 14px;
		border-top: 1px solid var(--color-border);
	}
	.other-years h2 {
		margin: 0;
		font-size: 18px;
		color: var(--color-ink);
	}
	.see-all {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		margin-top: 6px;
		font-weight: 700;
		color: var(--color-evergreen);
	}
</style>

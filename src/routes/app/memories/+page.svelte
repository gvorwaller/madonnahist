<script lang="ts">
	import { withFrom } from '$lib/viewer/nav';
	import { memoryDateLabel, memoryPageHref } from '$lib/viewer/memories';

	const { data } = $props();
	const here = '/app/memories';

	/** First couple of lines, for the list. */
	function preview(body: string): string {
		const flat = body.replace(/\s+/g, ' ').trim();
		return flat.length > 180 ? flat.slice(0, 177).trimEnd() + '…' : flat;
	}
</script>

<svelte:head>
	<title>My memories — Vorwaller Family History</title>
</svelte:head>

<div class="v-page">
	<h1 class="v-title">My memories</h1>
	<p class="v-sub">
		Memories you add show on the day, month or year they're about. A draft stays private until you
		share it.
	</p>

	{#if data.deleted}
		<p class="v-note" role="status">Memory deleted.</p>
	{/if}

	<div class="v-actions">
		<a class="v-btn primary" href={withFrom('/app/memories/new', here)}>+ Add a memory</a>
	</div>

	{#if data.memories.length === 0}
		<div class="v-empty list-empty">
			<div class="icon" aria-hidden="true">✍️</div>
			<h2>No memories yet</h2>
			<p>
				Add one here, or open any day, month or year and tap "Add your memory".
			</p>
		</div>
	{:else}
		<ul class="list">
			{#each data.memories as m (m.id)}
				<li class:draft={!m.shared}>
					<div class="head">
						<b class="when">{memoryDateLabel(m.date, m.precision)}</b>
						{#if m.shared}
							<span class="v-badge shared">✓ Shared with family</span>
						{:else}
							<span class="v-badge draft">🔒 Draft — only you</span>
						{/if}
					</div>
					<p class="pv">{preview(m.body)}</p>
					<div class="links">
						<a href={withFrom(`/app/memories/${m.id}`, here)}
							>Edit<span class="v-sr"> the memory of {memoryDateLabel(m.date, m.precision)}</span></a
						>
						<a href={withFrom(memoryPageHref(m.date, m.precision), here) + `#m-${m.id}`}
							>View on page<span class="v-sr">
								for {memoryDateLabel(m.date, m.precision)}</span
							></a
						>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.list-empty {
		margin-top: 18px;
	}
	.list {
		list-style: none;
		margin: 18px 0 0;
		padding: 0;
		display: grid;
		gap: 10px;
	}
	.list li {
		padding: 12px 14px;
		border: 1px solid var(--color-border);
		border-radius: 12px;
		background: var(--color-paper);
	}
	.list li.draft {
		border: 2px dashed var(--color-ink-muted);
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 6px 10px;
	}
	.when {
		font-size: 18px;
	}
	.pv {
		margin: 6px 0 0;
		font-family: var(--font-serif);
		font-size: 17px;
		line-height: 1.5;
		overflow-wrap: anywhere;
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 0 20px;
		margin-top: 4px;
	}
	.links a {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		font-weight: 700;
		color: var(--color-evergreen);
	}
</style>

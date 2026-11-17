<script lang="ts">
	import { withFrom } from '$lib/viewer/nav';
	import type { MemoryView } from '$lib/viewer/memories';

	/**
	 * Memories on a Day, Month or Year page (plan:
	 * docs/2026-11-16-writers-and-memories-plan.md §4). Shared memories show
	 * to everyone; a draft shows only to the person who typed it, with a
	 * dashed border, a "Draft — only you" badge and an Edit link (AGY2 #7).
	 */
	const {
		memories,
		of,
		here
	}: {
		memories: MemoryView[];
		/** "this day", "this month" or "this year", for the aria-label. */
		of: string;
		/** This page's path, so Back returns here from the editor. */
		here: string;
	} = $props();
</script>

{#each memories as m (m.id)}
	<aside
		class="v-memory"
		class:draft={!m.shared}
		id="m-{m.id}"
		aria-label="{m.writerName}'s memory of {of}"
	>
		<p class="who">🗨 {m.writerName} remembers</p>
		<p class="text">{m.body}</p>
		{#if m.mine}
			<p class="mine">
				{#if m.shared}
					<span class="v-badge shared">✓ Shared with family</span>
				{:else}
					<span class="v-badge draft">🔒 Draft — only you</span>
				{/if}
				<a class="edit" href={withFrom(`/app/memories/${m.id}`, here)}
					>{m.shared ? 'Edit' : 'Edit draft'}<span class="v-sr"> your memory</span></a
				>
			</p>
		{/if}
	</aside>
{/each}

<style>
	.mine {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 12px;
		margin: 10px 0 0;
	}
	.edit {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		font-weight: 700;
		color: var(--color-evergreen);
	}
</style>

<script lang="ts">
	const { data } = $props();

	const MONTH_NAMES = [
		'', 'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'
	];

	const monthDayLabel = $derived(`${MONTH_NAMES[data.month]} ${data.day}`);
</script>

<svelte:head>
	<title>On this day — madonnahist</title>
</svelte:head>

<div class="home">
	<h1>On {monthDayLabel} in our history</h1>

	{#if data.entries.length === 0}
		<div class="empty-state">
			<p>
				No transcribed entries for {monthDayLabel} yet — {data.coverage.accepted} of
				{data.coverage.total} days transcribed so far.
			</p>
		</div>
	{:else}
		<ul class="cards">
			{#each data.entries as entry (entry.entryDate)}
				<li>
					<a class="card" href="/app/day/{entry.entryDate}">
						<img
							class="thumb"
							src="/app/day/{entry.entryDate}/image"
							alt="Calendar entry for {entry.entryDate}"
							loading="lazy"
						/>
						<div class="card-body">
							<div class="card-year">{entry.year}</div>
							<hr />
							{#if entry.preview}
								<p class="preview">{entry.preview}</p>
							{/if}
						</div>
					</a>
				</li>
			{/each}
		</ul>
	{/if}

	<p class="coverage-line">
		{data.coverage.accepted} of {data.coverage.total} days transcribed so far ({data.coverage.percent}%).
	</p>
</div>

<style>
	.home {
		padding: 1rem 1rem 0.5rem;
	}
	h1 {
		font-family: var(--font-sans);
		font-size: 1.15rem;
		font-weight: 700;
		margin: 0.5rem 0 1rem;
		color: var(--color-ink);
	}
	.empty-state {
		background: var(--color-paper);
		border: 1px solid var(--color-border);
		border-radius: 8px;
		padding: 1.25rem;
	}
	.empty-state p {
		margin: 0;
		font-family: var(--font-serif);
		font-size: 1.05rem;
		line-height: 1.6;
		color: var(--color-ink-muted);
	}
	.cards {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.card {
		display: block;
		background: var(--color-paper);
		border: 1px solid var(--color-border);
		border-radius: 10px;
		overflow: hidden;
		text-decoration: none;
		color: inherit;
	}
	.card:focus-visible {
		outline: 2px solid var(--color-evergreen-dark);
		outline-offset: 2px;
	}
	.thumb {
		display: block;
		width: 100%;
		height: auto;
		max-height: 220px;
		object-fit: cover;
		background: var(--color-cream);
	}
	.card-body {
		padding: 0.85rem 1rem 1rem;
	}
	.card-year {
		font-family: var(--font-sans);
		font-weight: 700;
		font-size: 1.05rem;
		color: var(--color-evergreen-dark);
	}
	.card-body hr {
		border: none;
		border-top: 1px solid var(--color-border);
		margin: 0.5rem 0 0.6rem;
	}
	.preview {
		font-family: var(--font-serif);
		font-size: 1.05rem;
		line-height: 1.55;
		color: var(--color-ink);
		margin: 0;
	}
	.coverage-line {
		margin: 1.5rem 0 0;
		font-family: var(--font-sans);
		font-size: 0.8rem;
		color: var(--color-ink-muted);
		text-align: center;
	}
</style>

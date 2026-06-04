<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
	let running = $state(false);
</script>

<div class="page">
	<h1>Substitutions</h1>
	<p class="desc">
		Apply deterministic text replacements to uncorrected LLM drafts.
		Rules are loaded from <strong>notation_key</strong> and high-frequency
		<strong>correction_lexicon</strong> entries (frequency &ge; 3).
		Days with accepted corrections are never modified.
	</p>

	<div class="stats">
		<div class="stat">
			<span class="label">Uncorrected days with drafts</span>
			<span class="value">{data.uncorrectedCount}</span>
		</div>
		<div class="stat">
			<span class="label">Total days with drafts</span>
			<span class="value">{data.totalDays}</span>
		</div>
		<div class="stat">
			<span class="label">Active rules</span>
			<span class="value">{data.rules.length}</span>
		</div>
		{#if data.lastRun}
			<div class="stat">
				<span class="label">Last run</span>
				<span class="value">{data.lastRun.created_at} ({data.lastRun.cnt} days)</span>
			</div>
		{/if}
	</div>

	<section class="rules-section">
		<h2>Active Rules</h2>
		{#if data.rules.length === 0}
			<p class="empty">No substitution rules loaded. Add entries to notation_key or build up correction_lexicon frequency.</p>
		{:else}
			<table class="rules-table">
				<thead>
					<tr>
						<th>Pattern</th>
						<th>Replacement</th>
						<th>Source</th>
					</tr>
				</thead>
				<tbody>
					{#each data.rules as rule}
						<tr>
							<td class="mono">{rule.pattern}</td>
							<td>{rule.replacement}</td>
							<td class="source">{rule.source}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>

	<section class="action-section">
		<form method="POST" action="?/run" use:enhance={() => {
			running = true;
			return async ({ update }) => {
				running = false;
				await update();
			};
		}}>
			<button type="submit" class="run-btn" disabled={running || data.rules.length === 0 || data.uncorrectedCount === 0}>
				{running ? 'Running...' : 'Run Substitutions'}
			</button>
		</form>

		{#if data.rules.length === 0}
			<p class="note">No rules to apply.</p>
		{:else if data.uncorrectedCount === 0}
			<p class="note">No uncorrected days with drafts to process.</p>
		{/if}
	</section>

	{#if form?.summary}
		<section class="results">
			<h2>Results</h2>
			<div class="stats">
				<div class="stat">
					<span class="label">Processed</span>
					<span class="value">{form.summary.processed}</span>
				</div>
				<div class="stat">
					<span class="label">Modified</span>
					<span class="value">{form.summary.modified}</span>
				</div>
				<div class="stat">
					<span class="label">Unchanged</span>
					<span class="value">{form.summary.skipped}</span>
				</div>
			</div>

			{#if form.summary.results.length > 0}
				<div class="diff-list">
					{#each form.summary.results as result}
						<div class="diff-card">
							<h3>{result.entryDate}</h3>
							<div class="rules-applied">
								{#each result.rulesApplied as rule}
									<span class="rule-tag">{rule}</span>
								{/each}
							</div>
							<div class="diff-panes">
								<div class="pane">
									<span class="pane-label">Before</span>
									<pre>{result.originalText}</pre>
								</div>
								<div class="pane">
									<span class="pane-label">After</span>
									<pre>{result.newText}</pre>
								</div>
							</div>
						</div>
					{/each}
				</div>
			{:else}
				<p class="empty">No substitutions matched any uncorrected drafts.</p>
			{/if}
		</section>
	{/if}
</div>

<style>
	.page {
		max-width: 900px;
		margin: 0 auto;
		padding: 1.5rem 1rem;
	}
	h1 {
		font-size: 1.4rem;
		margin: 0 0 0.5rem;
	}
	h2 {
		font-size: 1.1rem;
		margin: 1.5rem 0 0.75rem;
	}
	.desc {
		font-size: 0.85rem;
		color: #555;
		line-height: 1.5;
		margin: 0 0 1.25rem;
	}
	.stats {
		display: flex;
		gap: 1.5rem;
		flex-wrap: wrap;
		margin-bottom: 1rem;
	}
	.stat {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.stat .label {
		font-size: 0.75rem;
		color: #888;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}
	.stat .value {
		font-size: 1.3rem;
		font-weight: 600;
	}
	.rules-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
	}
	.rules-table th {
		text-align: left;
		padding: 0.4rem 0.6rem;
		border-bottom: 2px solid #ddd;
		font-size: 0.75rem;
		text-transform: uppercase;
		color: #888;
	}
	.rules-table td {
		padding: 0.4rem 0.6rem;
		border-bottom: 1px solid #eee;
	}
	.mono {
		font-family: monospace;
		background: #f5f5f5;
		padding: 0.1rem 0.3rem;
		border-radius: 3px;
	}
	.source {
		font-size: 0.75rem;
		color: #888;
	}
	.action-section {
		margin-top: 1.5rem;
		padding-top: 1rem;
		border-top: 1px solid #eee;
	}
	.run-btn {
		padding: 0.6rem 1.5rem;
		font-size: 0.9rem;
		background: #2563eb;
		color: #fff;
		border: none;
		border-radius: 6px;
		cursor: pointer;
	}
	.run-btn:hover:not(:disabled) {
		background: #1d4ed8;
	}
	.run-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.note {
		font-size: 0.82rem;
		color: #888;
		margin-top: 0.5rem;
	}
	.empty {
		font-size: 0.85rem;
		color: #888;
	}
	.results {
		margin-top: 2rem;
		padding-top: 1rem;
		border-top: 2px solid #2563eb;
	}
	.diff-list {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.diff-card {
		border: 1px solid #ddd;
		border-radius: 8px;
		padding: 1rem;
	}
	.diff-card h3 {
		margin: 0 0 0.5rem;
		font-size: 0.95rem;
	}
	.rules-applied {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
		margin-bottom: 0.75rem;
	}
	.rule-tag {
		font-size: 0.7rem;
		background: #e0e7ff;
		color: #3730a3;
		padding: 0.15rem 0.4rem;
		border-radius: 4px;
	}
	.diff-panes {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
	}
	.pane {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.pane-label {
		font-size: 0.7rem;
		text-transform: uppercase;
		color: #888;
		font-weight: 600;
	}
	.pane pre {
		margin: 0;
		padding: 0.5rem;
		background: #f9f9f9;
		border: 1px solid #eee;
		border-radius: 4px;
		font-size: 0.8rem;
		white-space: pre-wrap;
		line-height: 1.5;
	}
</style>

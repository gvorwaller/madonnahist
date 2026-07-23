<script lang="ts">
	const { data } = $props();

	// Mirrors src/hooks.server.ts's roleAllowed(): admin reaches all three
	// surfaces, corrector reaches Corrections + Family Viewer, viewer reaches
	// Family Viewer only. Showing a card the user's role can't actually open
	// just leads to a Forbidden click, so this page only renders what
	// roleAllowed() would actually let through. hooks.server.ts's own
	// handle() already requires a session before '/' resolves at all (see
	// PUBLIC_PATHS there), so data.user is always set here in practice — the
	// `role === ...` checks below still fail closed (show nothing) rather
	// than guess if that ever weren't true.
	const role = $derived(data.user?.role);
	const showCorrections = $derived(role === 'admin' || role === 'corrector');
	const showAdmin = $derived(role === 'admin');
	const showFamilyViewer = $derived(role === 'admin' || role === 'corrector' || role === 'viewer');
</script>

<div class="landing">
	<h1>madonnahist</h1>
	<p class="tagline">Sixty years of handwritten family history, digitized and searchable.</p>

	<div class="cards">
		{#if showCorrections}
			<a href="/correct" class="card">
				<h2>Corrections</h2>
				<p class="role">Madonna</p>
				<p class="desc">Transcribe and correct calendar entries from OCR drafts.</p>
				<span class="status active">Active</span>
			</a>
		{/if}

		{#if showAdmin}
			<a href="/admin" class="card">
				<h2>Admin</h2>
				<p class="role">Gaylon</p>
				<p class="desc">Capture intake, grid alignment, OCR review, vocabulary management.</p>
				<span class="status active">Active</span>
			</a>
		{/if}

		{#if showFamilyViewer}
			<a href="/app" class="card">
				<h2>Family Viewer</h2>
				<p class="role">Everyone</p>
				<p class="desc">"On this day in family history," day detail, and full-text search.</p>
				<span class="status active">Active</span>
			</a>
		{/if}
	</div>
</div>

<style>
	.landing {
		max-width: 800px;
		margin: 0 auto;
		padding: 3rem 1rem;
		text-align: center;
	}
	h1 {
		font-size: 2rem;
		margin: 0 0 0.5rem;
		color: #1a1a1a;
	}
	.tagline {
		color: #555;
		font-size: 1rem;
		margin: 0 0 2.5rem;
	}
	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 1.25rem;
		text-align: left;
	}
	.card {
		display: block;
		padding: 1.25rem;
		border: 1px solid #ddd;
		border-radius: 8px;
		background: #fff;
		text-decoration: none;
		color: inherit;
		transition: border-color 0.15s;
	}
	.card:hover {
		border-color: #888;
	}
	.card h2 {
		margin: 0 0 0.2rem;
		font-size: 1.15rem;
	}
	.role {
		margin: 0 0 0.5rem;
		font-size: 0.8rem;
		color: #888;
		font-style: italic;
	}
	.desc {
		margin: 0 0 0.75rem;
		font-size: 0.85rem;
		color: #444;
		line-height: 1.5;
	}
	.status {
		display: inline-block;
		padding: 0.15rem 0.5rem;
		border-radius: 3px;
		font-size: 0.7rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.status.active {
		background: #e6f4e6;
		color: #1a7a1a;
	}
</style>

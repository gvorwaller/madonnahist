<div class="landing">
	<h1>madonnahist</h1>
	<p class="tagline">Sixty years of handwritten family history, digitized and searchable.</p>

	<div class="cards">
		<a href="/correct" class="card">
			<h2>Corrections</h2>
			<p class="role">Madonna</p>
			<p class="desc">Transcribe and correct calendar entries from OCR drafts.</p>
			<span class="status active">Active</span>
		</a>

		<a href="/admin" class="card">
			<h2>Admin</h2>
			<p class="role">Gaylon</p>
			<p class="desc">Capture intake, grid alignment, OCR review, vocabulary management.</p>
			<span class="status active">Active</span>
		</a>

		<div class="card disabled">
			<h2>Family Viewer</h2>
			<p class="role">Everyone</p>
			<p class="desc">"On this day in family history," day detail, search, timeline, book view.</p>
			<span class="status coming">Coming Soon</span>
		</div>
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
	.card:hover:not(.disabled) {
		border-color: #888;
	}
	.card.disabled {
		opacity: 0.55;
		cursor: default;
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
	.status.coming {
		background: #f0f0f0;
		color: #888;
	}
</style>

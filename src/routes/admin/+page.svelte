<div class="dashboard">
	<h1>Admin</h1>

	<div class="tools">
		<a href="/admin/capture" class="tool">
			<h2>Capture Intake</h2>
			<p>Upload and classify new calendar page photos. Duplicate detection, batch ingest.</p>
		</a>

		<a href="/admin/ocr-review" class="tool">
			<h2>OCR Review</h2>
			<p>Review OCR results per page. Confidence scores, flagged cells, re-run options.</p>
		</a>

		<a href="/admin/vocabulary" class="tool">
			<h2>Vocabulary &amp; Lexicon</h2>
			<p>Manage OCR vocabulary hints and curate auto-learned correction pairs.</p>
		</a>

		<a href="/admin/grid-align" class="tool">
			<h2>Grid Alignment</h2>
			<p>Adjust grid lines on calendar pages. Select a page to align.</p>
		</a>

		<a href="/admin/substitutions" class="tool">
			<h2>Substitutions</h2>
			<p>Apply notation and lexicon replacements to uncorrected LLM drafts in bulk.</p>
		</a>

		<a href="/admin/system-health" class="tool">
			<h2>System Health</h2>
			<p>Memory usage, job queue status, worker health, and ingestion stats.</p>
		</a>
	</div>
</div>

<style>
	.dashboard {
		max-width: 800px;
		margin: 0 auto;
		padding: 1.5rem 1rem;
	}
	h1 {
		font-size: 1.4rem;
		margin: 0 0 1.25rem;
	}
	.tools {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 1rem;
	}
	.tool {
		display: block;
		padding: 1rem;
		border: 1px solid #ddd;
		border-radius: 8px;
		background: #fff;
		text-decoration: none;
		color: inherit;
		transition: border-color 0.15s;
	}
	.tool:hover {
		border-color: #888;
	}
	.tool h2 {
		margin: 0 0 0.4rem;
		font-size: 1rem;
	}
	.tool p {
		margin: 0;
		font-size: 0.82rem;
		color: #555;
		line-height: 1.5;
	}
</style>

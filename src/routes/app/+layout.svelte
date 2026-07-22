<script lang="ts">
	import { page } from '$app/state';

	let { children } = $props();

	const activeTab = $derived.by(() => {
		const p = page.url.pathname;
		if (p.startsWith('/app/search')) return 'search';
		if (p.startsWith('/app/browse') || p.startsWith('/app/year')) return 'browse';
		return 'home';
	});

	// Immersive mode: the Phase F book reader (/app/book/*) suppresses the
	// bottom nav — it has its own fixed exit control and progress bar, and the
	// nav would just be visual noise (and eat vertical space) during a long
	// continuous read. Segment-boundary match, same rule as
	// src/hooks.server.ts's matchesPrefix(), so a hypothetical future
	// /app/bookmarks route would never be wrongly swept in.
	const immersive = $derived(page.url.pathname.startsWith('/app/book'));
</script>

<div class="app-shell">
	<div class="app-content" class:immersive>
		{@render children()}
	</div>

	{#if !immersive}
	<nav class="bottom-nav" aria-label="Family viewer navigation">
		<a
			href="/app"
			class="nav-item"
			class:active={activeTab === 'home'}
			aria-current={activeTab === 'home' ? 'page' : undefined}
		>
			<span class="nav-icon" aria-hidden="true">🏠</span>
			<span class="nav-label">On this day</span>
		</a>
		<a
			href="/app/browse"
			class="nav-item"
			class:active={activeTab === 'browse'}
			aria-current={activeTab === 'browse' ? 'page' : undefined}
		>
			<span class="nav-icon" aria-hidden="true">📅</span>
			<span class="nav-label">Browse</span>
		</a>
		<a
			href="/app/search"
			class="nav-item"
			class:active={activeTab === 'search'}
			aria-current={activeTab === 'search' ? 'page' : undefined}
		>
			<span class="nav-icon" aria-hidden="true">🔍</span>
			<span class="nav-label">Search</span>
		</a>
	</nav>
	{/if}
</div>

<style>
	.app-shell {
		--font-serif: Georgia, 'Iowan Old Style', 'Palatino Linotype', serif;
		--font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;

		/* Warm domestic palette. Pairs below are verified >= 7:1 (WCAG AAA)
		   against the surface they're intended for — see docs/ui-mockups-V2.md
		   §Cross-Surface Notes and the plan's Phase B accessibility floor. */
		--color-cream: #faf6ec;
		--color-paper: #fffdf8;
		--color-ink: #2b2620;
		--color-ink-muted: #4a4536;
		--color-evergreen: #204d3a;
		--color-evergreen-dark: #163627;
		--color-amber: #6b4700;
		--color-border: #ded4bd;
		--color-chip-bg: #e7ddc4;
		--color-highlight-bg: #f5dfa0;

		display: flex;
		flex-direction: column;
		min-height: calc(100vh - 2.5rem);
		background: var(--color-cream);
		color: var(--color-ink);
		font-family: var(--font-sans);
		overflow-x: hidden; /* belt-and-suspenders: no horizontal scroll at phone widths */
	}

	.app-content {
		flex: 1;
		padding-bottom: 5.5rem; /* clears the fixed bottom nav */
		max-width: 640px;
		width: 100%;
		margin: 0 auto;
		box-sizing: border-box;
	}
	.app-content.immersive {
		padding-bottom: 0; /* no bottom nav to clear in immersive book view */
		max-width: none; /* book reader manages its own measure/max-width */
	}

	.bottom-nav {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 20;
		display: flex;
		background: var(--color-paper);
		border-top: 1px solid var(--color-border);
		box-shadow: 0 -2px 8px rgba(43, 38, 32, 0.08);
	}

	.nav-item {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.2rem;
		min-height: 56px;
		padding: 0.5rem 0 0.6rem;
		text-decoration: none;
		font-family: var(--font-sans);
		color: var(--color-ink-muted);
		font-size: 0.72rem;
		font-weight: 500;
	}

	.nav-icon {
		font-size: 1.4rem;
		line-height: 1;
	}

	.nav-item.active {
		color: var(--color-evergreen-dark);
		font-weight: 700;
	}

	.nav-item:focus-visible {
		outline: 2px solid var(--color-evergreen-dark);
		outline-offset: -2px;
	}
</style>

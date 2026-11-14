<script lang="ts">
	import '$lib/viewer/viewer.css';
	import { page } from '$app/state';
	import { enhance } from '$app/forms';
	import { afterNavigate } from '$app/navigation';
	import NavProgress from '$lib/components/viewer/NavProgress.svelte';

	let { children, data } = $props();

	type TabKey = 'today' | 'timeline' | 'people' | 'stories' | 'search';
	const tabs: { key: TabKey; label: string; href: string }[] = [
		{ key: 'today', label: 'Today', href: '/app' },
		{ key: 'timeline', label: 'Timeline', href: '/app/timeline' },
		{ key: 'people', label: 'People', href: '/app/people' },
		{ key: 'stories', label: 'Stories', href: '/app/stories' },
		{ key: 'search', label: 'Search', href: '/app/search' }
	];

	// Segment-boundary prefix match, same rule as src/hooks.server.ts.
	function under(path: string, prefix: string): boolean {
		return path === prefix || path.startsWith(prefix + '/');
	}

	const activeTab = $derived.by((): TabKey => {
		const p = page.url.pathname;
		if (under(p, '/app/search')) return 'search';
		if (['/app/browse', '/app/timeline', '/app/year', '/app/month'].some((x) => under(p, x)))
			return 'timeline';
		if (['/app/people', '/app/places', '/app/person', '/app/place'].some((x) => under(p, x)))
			return 'people';
		if (under(p, '/app/stories')) return 'stories';
		return 'today';
	});

	// Immersive mode: the book reader (/app/book/*) has its own fixed exit
	// control and progress bar, so the shell's bars stay out of the way.
	const immersive = $derived(under(page.url.pathname, '/app/book'));

	const who = $derived(data.user?.display_name || data.user?.username || '');

	// Menu drawer: a native modal <dialog> gives focus trapping, an inert
	// background and Escape-to-close in Safari and Chrome without custom code.
	let drawer: HTMLDialogElement | undefined = $state();

	function openMenu() {
		drawer?.showModal();
	}
	function closeMenu() {
		if (drawer?.open) drawer.close();
	}
	function onDrawerClick(e: MouseEvent) {
		// A click on the backdrop lands on the <dialog> element itself.
		if (e.target === drawer) closeMenu();
	}
	afterNavigate(() => closeMenu());
</script>

<div class="app-shell" class:immersive>
	<NavProgress />
	{#if !immersive}
		<header class="topbar">
			<a class="brand" href="/app">
				<span class="mark" aria-hidden="true">V</span>
				<span class="short">Family History</span>
				<span class="full">Vorwaller Family History</span>
			</a>
			<nav class="top-links" aria-label="Main">
				{#each tabs as t (t.key)}
					<a href={t.href} aria-current={activeTab === t.key ? 'page' : undefined}>{t.label}</a>
				{/each}
			</nav>
			<span class="spacer"></span>
			<button
				type="button"
				class="icon-btn"
				aria-label="Menu"
				aria-haspopup="dialog"
				onclick={openMenu}
			>
				<svg
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg
				>
			</button>
		</header>
	{/if}

	<div class="app-content" class:immersive>
		{@render children()}
	</div>

	{#if !immersive}
		<nav class="tabbar" aria-label="Main">
			{#each tabs as t (t.key)}
				<a href={t.href} aria-current={activeTab === t.key ? 'page' : undefined}>
					{#if t.key === 'today'}
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							aria-hidden="true"
							><circle cx="12" cy="12" r="4" /><path
								d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
							/></svg
						>
					{:else if t.key === 'timeline'}
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							aria-hidden="true"><path d="M4 20V10M9 20V4M14 20v-7M19 20V8" /></svg
						>
					{:else if t.key === 'people'}
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							aria-hidden="true"
							><circle cx="9" cy="8" r="3.5" /><path
								d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"
							/><circle cx="17" cy="9" r="2.5" /><path d="M17 14c2.3 0 4 1.4 4.5 4" /></svg
						>
					{:else if t.key === 'stories'}
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							aria-hidden="true"
							><path d="M3 5c3-1 6-1 9 1 3-2 6-2 9-1v14c-3-1-6-1-9 1-3-2-6-2-9-1z" /><path
								d="M12 6v14"
							/></svg
						>
					{:else}
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg
						>
					{/if}
					<span>{t.label}</span>
				</a>
			{/each}
		</nav>

		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
		<dialog class="drawer" aria-label="Menu" bind:this={drawer} onclick={onDrawerClick}>
			<div class="drawer-inner">
				<div class="drawer-head">
					<div class="who">
						<b>Signed in as {who}</b>
					</div>
					<button type="button" class="icon-btn" aria-label="Close menu" onclick={closeMenu}>
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg
						>
					</button>
				</div>
				<nav aria-label="More">
					<a href="/app/stories">📚 Books &amp; downloads</a>
					<a href="/app/about">ℹ️ About this archive</a>
					{#if data.user && data.user.id !== '0'}
						<a href="/app/account">👤 Your name &amp; home screen</a>
					{/if}
					{#if data.canCorrect || data.canAdmin}
						<div class="grp">Your other tools</div>
						{#if data.canCorrect}
							<a href="/correct">✍️ Corrections</a>
						{/if}
						{#if data.canAdmin}
							<a href="/admin">⚙️ Admin</a>
						{/if}
					{/if}
					<form method="POST" action="/login?/logout" use:enhance>
						<button type="submit" class="signout">Sign out</button>
					</form>
				</nav>
			</div>
		</dialog>
	{/if}
</div>

<style>
	.app-shell {
		display: flex;
		flex-direction: column;
		min-height: 100vh;
		min-height: 100dvh;
		background: var(--color-cream);
		color: var(--color-ink);
		font-family: var(--font-sans);
		overflow-x: clip; /* no horizontal scroll at phone widths */
	}

	/* ── Top bar ── */
	.topbar {
		position: sticky;
		top: 0;
		z-index: 30;
		display: flex;
		align-items: center;
		gap: 4px;
		height: calc(var(--topbar-h) + env(safe-area-inset-top));
		padding: env(safe-area-inset-top) max(6px, env(safe-area-inset-right)) 0
			max(14px, env(safe-area-inset-left));
		background: rgba(255, 253, 248, 0.92);
		-webkit-backdrop-filter: blur(12px);
		backdrop-filter: blur(12px);
		border-bottom: 1px solid var(--color-border);
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		min-height: 48px;
		font-family: var(--font-serif);
		font-weight: 700;
		font-size: 18px;
		color: var(--color-ink);
		text-decoration: none;
		white-space: nowrap;
	}
	.brand .mark {
		flex: 0 0 auto;
		width: 30px;
		height: 30px;
		border-radius: 8px;
		display: grid;
		place-items: center;
		background: var(--color-evergreen);
		color: #fff;
		font-size: 16px;
	}
	.brand .full {
		display: none;
	}
	.brand .short {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.top-links {
		display: none;
	}
	.spacer {
		flex: 1;
	}
	.icon-btn {
		width: 48px;
		height: 48px;
		flex: 0 0 auto;
		border: 0;
		border-radius: 10px;
		background: transparent;
		display: inline-grid;
		place-items: center;
		color: var(--color-ink);
		cursor: pointer;
	}
	.icon-btn:hover {
		background: var(--color-evergreen-soft);
	}
	.icon-btn svg {
		width: 24px;
		height: 24px;
	}

	/* ── Content ── */
	.app-content {
		flex: 1;
		width: 100%;
		/* clears the fixed bottom tab bar on phones */
		padding-bottom: calc(var(--tabbar-h) + env(safe-area-inset-bottom) + 8px);
	}
	.app-content.immersive {
		padding-bottom: 0;
	}
	/* Pages not yet rebuilt for V3 keep the old single-column measure; new
	   pages wrap themselves in .v-page and set their own width. Fixed
	   overlays (role=dialog) must never be width-capped. */
	.app-content:not(.immersive) > :global(:not(.v-page):not([role='dialog'])) {
		max-width: 680px;
		margin-inline: auto;
	}

	/* ── Bottom tabs (phones) ── */
	.tabbar {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 30;
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		height: calc(var(--tabbar-h) + env(safe-area-inset-bottom));
		padding: 0 env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
		background: rgba(255, 253, 248, 0.96);
		-webkit-backdrop-filter: blur(12px);
		backdrop-filter: blur(12px);
		border-top: 1px solid var(--color-border);
	}
	.tabbar a {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		min-width: 0;
		min-height: 48px;
		padding: 0 1px;
		text-decoration: none;
		color: var(--color-ink-muted);
		font-size: 15px;
		font-weight: 600;
		letter-spacing: -0.01em;
		white-space: nowrap;
	}
	.tabbar svg {
		width: 24px;
		height: 24px;
	}
	.tabbar a[aria-current='page'] {
		color: var(--color-evergreen-dark);
		font-weight: 700;
	}
	.tabbar a[aria-current='page'] svg {
		width: 40px;
		padding: 0 8px;
		border-radius: 999px;
		background: var(--color-evergreen-soft);
	}

	@media (min-width: 640px) {
		.tabbar {
			display: none;
		}
		.app-content {
			padding-bottom: 24px;
		}
		.top-links {
			display: flex;
			gap: 2px;
			margin-left: 18px;
		}
		.top-links a {
			min-height: 44px;
			padding: 0 14px;
			display: inline-flex;
			align-items: center;
			border-radius: 8px;
			text-decoration: none;
			color: var(--color-ink-muted);
			font-weight: 600;
			font-size: 16px;
		}
		.top-links a:hover {
			color: var(--color-ink);
			background: var(--color-cream);
		}
		.top-links a[aria-current='page'] {
			background: var(--color-evergreen-soft);
			color: var(--color-evergreen-dark);
		}
		.brand .full {
			display: inline;
		}
		.brand .short {
			display: none;
		}
	}

	/* ── Drawer ── */
	.drawer {
		position: fixed;
		inset: 0 0 0 auto;
		margin: 0;
		width: min(320px, 86vw);
		max-width: none;
		height: 100%;
		max-height: none;
		padding: 0;
		border: 0;
		background: var(--color-paper);
		color: var(--color-ink);
		box-shadow: -8px 0 24px rgba(0, 0, 0, 0.2);
	}
	.drawer::backdrop {
		background: rgba(0, 0, 0, 0.4);
	}
	.drawer-inner {
		padding: calc(8px + env(safe-area-inset-top)) 0 calc(12px + env(safe-area-inset-bottom));
	}
	.drawer-head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 0 6px 10px 18px;
		border-bottom: 1px solid var(--color-border);
	}
	.drawer-head .who {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.drawer nav a,
	.drawer nav button {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		min-height: 52px;
		padding: 0 18px;
		border: 0;
		background: none;
		text-align: left;
		text-decoration: none;
		color: var(--color-ink);
		font-size: 18px;
		font-weight: 600;
		cursor: pointer;
	}
	.drawer nav a:hover,
	.drawer nav button:hover {
		background: var(--color-cream);
	}
	.drawer .grp {
		padding: 14px 18px 4px;
		font-size: 15px;
		font-weight: 700;
		color: var(--color-ink-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.drawer .signout {
		color: var(--color-danger);
		border-top: 1px solid var(--color-border);
		margin-top: 10px;
	}
</style>

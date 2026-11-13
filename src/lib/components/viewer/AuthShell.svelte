<script lang="ts">
	/**
	 * Branded frame for the pages a family member sees before they're signed
	 * in: /login and /invite/<token> (V3 Slice 1b). Uses the viewer's tokens
	 * (.app-shell) so it matches the family viewer, without its tabs.
	 */
	import '$lib/viewer/viewer.css';
	import type { Snippet } from 'svelte';

	const { children }: { children: Snippet } = $props();
</script>

<div class="app-shell auth">
	<div class="brand">
		<span class="mark" aria-hidden="true">V</span>
		<span>Vorwaller Family History</span>
	</div>
	<div class="card">
		{@render children()}
	</div>
</div>

<style>
	.auth {
		min-height: 100vh;
		min-height: 100dvh;
		padding: max(24px, env(safe-area-inset-top)) 16px max(32px, env(safe-area-inset-bottom));
		background: var(--color-cream);
		color: var(--color-ink);
		font-family: var(--font-sans);
	}
	.brand {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		margin: 8px auto 20px;
		font-family: var(--font-serif);
		font-size: 22px;
		font-weight: 700;
		color: var(--color-evergreen-dark);
		text-align: center;
	}
	.mark {
		flex: 0 0 auto;
		width: 36px;
		height: 36px;
		border-radius: 9px;
		display: grid;
		place-items: center;
		background: var(--color-evergreen);
		color: #fff;
		font-size: 19px;
	}
	.card {
		max-width: 460px;
		margin: 0 auto;
		padding: 24px 20px;
		background: var(--color-paper);
		border: 1px solid var(--color-border);
		border-radius: var(--radius);
	}
	:where(.card) :global(h1) {
		margin: 0 0 6px;
		font-family: var(--font-serif);
		font-size: 28px;
		line-height: 1.2;
	}
	:where(.card) :global(p) {
		margin: 0 0 16px;
	}
</style>

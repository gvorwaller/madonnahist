<script lang="ts">
	import { page } from '$app/state';
	import { enhance } from '$app/forms';

	let { children, data } = $props();

	const section = $derived.by(() => {
		const p = page.url.pathname;
		if (p.startsWith('/admin')) return 'Admin';
		if (p.startsWith('/correct')) return 'Corrections';
		if (p.startsWith('/app')) return 'Family';
		return null;
	});
</script>

<nav class="topbar">
	<a href="/" class="home">madonnahist</a>
	{#if section}
		<span class="sep">/</span>
		<span class="section">{section}</span>
	{/if}
	<span class="spacer"></span>
	{#if data.user}
		<span class="username">{data.user.display_name}</span>
		<form method="POST" action="/login?/logout" use:enhance class="logout-form">
			<button type="submit" class="logout">Sign out</button>
		</form>
	{/if}
</nav>

<main>
	{@render children()}
</main>

<style>
	:global(body) {
		margin: 0;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
		color: #1a1a1a;
		background: #fafaf8;
	}
	.topbar {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.5rem 1rem;
		background: #2c2c2c;
		color: #e0e0e0;
		font-size: 0.85rem;
	}
	.home {
		color: #fff;
		text-decoration: none;
		font-weight: 600;
	}
	.home:hover {
		text-decoration: underline;
	}
	.sep {
		color: #666;
	}
	.section {
		color: #bbb;
	}
	.spacer {
		flex: 1;
	}
	.username {
		color: #aaa;
		font-size: 0.8rem;
	}
	.logout-form {
		display: inline;
	}
	.logout {
		background: none;
		border: none;
		color: #888;
		font-size: 0.75rem;
		cursor: pointer;
		padding: 0.15rem 0.4rem;
		border-radius: 3px;
	}
	.logout:hover {
		color: #fff;
		background: #555;
	}
	main {
		min-height: calc(100vh - 2.5rem);
	}
</style>

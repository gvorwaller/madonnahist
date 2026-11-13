<script lang="ts">
	import { enhance } from '$app/forms';
	import AuthShell from '$lib/components/viewer/AuthShell.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let submitting = $state(false);

	const returnTo = $derived(form?.returnTo ?? data.returnTo ?? '');
</script>

<svelte:head>
	<title>Sign in — Vorwaller Family History</title>
</svelte:head>

<AuthShell>
	<h1>Sign in</h1>
	<p class="sub">Welcome back.</p>

	<form
		method="POST"
		action="/login?/login"
		use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				await update();
				submitting = false;
			};
		}}
		novalidate
	>
		<input type="hidden" name="returnTo" value={returnTo} />
		<label class="v-field">
			<span>Username</span>
			<input
				type="text"
				name="username"
				autocomplete="username"
				autocapitalize="none"
				autocorrect="off"
				spellcheck="false"
				required
				defaultValue={form?.username ?? ''}
			/>
		</label>

		<label class="v-field">
			<span>Password</span>
			<input type="password" name="password" autocomplete="current-password" required />
		</label>

		{#if form?.error}
			<p class="v-alert" role="alert">{form.error}</p>
		{/if}

		<button type="submit" class="v-btn primary block" disabled={submitting}>
			{submitting ? 'Signing in…' : 'Sign in'}
		</button>
	</form>

	<p class="help">
		Forgot your password, or don't have one yet? Ask the admin (Gaylon / Dad / Papa) for a new link.
	</p>
</AuthShell>

<style>
	.sub {
		color: var(--color-ink-muted);
	}
	.help {
		margin: 20px 0 0;
		font-size: 16px;
		color: var(--color-ink-muted);
	}
</style>

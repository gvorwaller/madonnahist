<script lang="ts">
	import { enhance } from '$app/forms';
	import HomeScreenSteps from '$lib/components/viewer/HomeScreenSteps.svelte';

	const { data, form } = $props();
	let saving = $state(false);

	const value = $derived(
		(form && 'displayName' in form ? form.displayName : null) ?? data.displayName
	);
</script>

<svelte:head>
	<title>Your name — Vorwaller Family History</title>
</svelte:head>

<div class="v-page">
	<h1 class="v-title">Your name</h1>

	<form
		method="POST"
		action="/app/account?/rename"
		use:enhance={() => {
			saving = true;
			return async ({ update }) => {
				await update({ reset: false });
				saving = false;
			};
		}}
		novalidate
	>
		<label class="v-field">
			<span>Your name</span>
			<input
				type="text"
				name="displayName"
				defaultValue={value}
				autocomplete="name"
				maxlength="60"
				required
			/>
			<small>How your name shows in the family history.</small>
		</label>

		{#if form && 'error' in form && form.error}
			<p class="v-alert" role="alert">{form.error}</p>
		{:else if form && 'saved' in form && form.saved}
			<p class="v-note" role="status">Saved.</p>
		{/if}

		<button type="submit" class="v-btn primary" disabled={saving}>
			{saving ? 'Saving…' : 'Save my name'}
		</button>
	</form>

	<div class="v-field signin">
		<span>Your username</span>
		<p class="username">{data.username}</p>
		<small>You sign in with this. It can't be changed.</small>
	</div>

	<HomeScreenSteps platform={data.platform} />
</div>

<style>
	form {
		margin-top: 12px;
	}
	.signin {
		margin-top: 28px;
	}
	.username {
		margin: 0;
		padding: 10px 14px;
		border-radius: 10px;
		background: var(--color-evergreen-soft);
		color: var(--color-evergreen-dark);
		font-size: 22px;
		font-weight: 700;
		overflow-wrap: anywhere;
	}
</style>

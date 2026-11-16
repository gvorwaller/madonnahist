<script lang="ts">
	import { enhance } from '$app/forms';
	import HomeScreenSteps from '$lib/components/viewer/HomeScreenSteps.svelte';

	const { data, form } = $props();
	let saving = $state(false);
	let changing = $state(false);

	const value = $derived(
		(form && 'displayName' in form ? form.displayName : null) ?? data.displayName
	);
	const pwError = $derived(form && 'pwError' in form ? form.pwError : null);
	const pwSaved = $derived(!!(form && 'pwSaved' in form && form.pwSaved));
</script>

<svelte:head>
	<title>Your account — Vorwaller Family History</title>
</svelte:head>

<div class="v-page">
	<h1 class="v-title">Your account</h1>

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

	<section class="pw" aria-labelledby="pw-h">
		<h2 id="pw-h">Change your password</h2>
		<form
			method="POST"
			action="/app/account?/password"
			use:enhance={() => {
				changing = true;
				return async ({ result, update }) => {
					// Clear the boxes after a change; keep them after a mistake.
					await update({ reset: result.type === 'success' });
					changing = false;
				};
			}}
			novalidate
		>
			<!-- Tells Safari and password managers which saved login to update. -->
			<input type="text" autocomplete="username" value={data.username} hidden readonly />

			<label class="v-field">
				<span>Current password</span>
				<input type="password" name="currentPassword" autocomplete="current-password" required />
			</label>

			<label class="v-field">
				<span>New password</span>
				<input
					type="password"
					name="newPassword"
					autocomplete="new-password"
					minlength="8"
					required
				/>
				<small>At least 8 characters.</small>
			</label>

			<label class="v-field">
				<span>Type the new password again</span>
				<input type="password" name="confirmPassword" autocomplete="new-password" required />
			</label>

			{#if pwError}
				<p class="v-alert" role="alert">{pwError}</p>
			{:else if pwSaved}
				<p class="v-note" role="status">
					Password changed. Any other phones or computers will need to sign in again.
				</p>
			{/if}

			<button type="submit" class="v-btn primary" disabled={changing}>
				{changing ? 'Saving…' : 'Change my password'}
			</button>
		</form>
		<p class="fine">
			Forgot your password? Ask the admin (Gaylon / Dad / Papa) for a new link.
		</p>
	</section>

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
	.pw {
		margin: 32px 0 12px;
	}
	.pw h2 {
		margin: 0 0 4px;
		font-size: 20px;
	}
	.fine {
		margin: 12px 0 0;
	}
</style>

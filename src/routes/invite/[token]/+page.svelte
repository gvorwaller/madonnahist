<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import AuthShell from '$lib/components/viewer/AuthShell.svelte';
	import HomeScreenSteps from '$lib/components/viewer/HomeScreenSteps.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let submitting = $state(false);

	// A failed POST can report that the link stopped working meanwhile.
	const problem = $derived(
		form && 'problem' in form && form.problem
			? form.problem
			: data.state !== 'valid'
				? data.state
				: null
	);
	const success = $derived(form && 'success' in form && form.success ? form : null);
	const error = $derived(form && 'error' in form ? form.error : null);
	const nameValue = $derived(
		(form && 'displayName' in form ? form.displayName : null) ??
			('displayName' in data ? data.displayName : '')
	);

	const expires = $derived(
		'expiresAt' in data && data.expiresAt
			? new Date(data.expiresAt).toLocaleDateString('en-US', {
					month: 'long',
					day: 'numeric',
					year: 'numeric'
				})
			: ''
	);

	const PROBLEM_COPY: Record<string, { h: string; p: string }> = {
		expired: { h: 'This link has expired', p: 'Invite links last 30 days.' },
		used: {
			h: 'This link has already been used',
			p: 'If you already set your password, you can sign in.'
		},
		revoked: {
			h: 'This link was replaced',
			p: 'A newer link was sent, or this one was cancelled.'
		},
		invalid: {
			h: "This link doesn't work",
			p: 'It may have been copied only partly. Check that you have the whole link.'
		},
		busy: { h: 'Please try again shortly', p: 'Lots of people are opening links right now.' }
	};
</script>

<svelte:head>
	<title>Welcome — Vorwaller Family History</title>
	<meta name="referrer" content="no-referrer" />
	<meta name="robots" content="noindex" />
</svelte:head>

<AuthShell>
	{#if success}
		<h1>You're all set, {success.displayName}</h1>
		<p>This phone or computer is now signed in.</p>
		<div class="v-field">
			<span>Your username</span>
			<p class="username">{success.username}</p>
			<small>
				If it ever asks you to sign in, use this username and the password you just made.
			</small>
		</div>

		<HomeScreenSteps platform={data.platform} />

		<a class="v-btn primary block go" href="/app" data-sveltekit-reload>
			Open the family history ▸
		</a>
	{:else if problem}
		<h1>{PROBLEM_COPY[problem]?.h ?? "This link doesn't work"}</h1>
		<p>{PROBLEM_COPY[problem]?.p ?? ''}</p>
		<p class="v-note">Ask the admin (Gaylon / Dad / Papa) for a new link.</p>
		{#if problem === 'used'}
			<a class="v-btn secondary block" href="/login">Sign in</a>
		{/if}
	{:else if data.state === 'valid'}
		<h1>Welcome, {data.displayName}</h1>
		<p>
			You've been invited to the Vorwaller Family History: Madonna's calendars, day by day. Choose a
			password to finish.
		</p>

		{#if data.signedInAs}
			<p class="v-note">
				This browser is signed in as <b>{data.signedInAs}</b>. Finishing will sign it in as
				<b>{data.displayName}</b> instead.
			</p>
		{/if}

		<form
			method="POST"
			action="/invite/{page.params.token}?/redeem"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					// No invalidateAll: the page's data is the link check, and the
					// result (success or a problem) comes back as form data.
					await update({ invalidateAll: false, reset: false });
					submitting = false;
				};
			}}
			novalidate
		>
			<label class="v-field">
				<span>Your username</span>
				<input
					class="big"
					type="text"
					name="username"
					value={data.username}
					readonly
					autocomplete="username"
				/>
				<small>You'll use this to sign in. It can't be changed.</small>
			</label>

			<label class="v-field">
				<span>Your name</span>
				<input
					type="text"
					name="displayName"
					defaultValue={nameValue}
					autocomplete="name"
					maxlength="60"
					required
				/>
				<small>How your name shows in the family history. You can change it later.</small>
			</label>

			<label class="v-field">
				<span>Choose a password</span>
				<input type="password" name="password" autocomplete="new-password" minlength="8" required />
				<small>At least 8 characters.</small>
			</label>

			<label class="v-field">
				<span>Type it again</span>
				<input type="password" name="confirm" autocomplete="new-password" required />
			</label>

			{#if error}
				<p class="v-alert" role="alert">{error}</p>
			{/if}

			<button type="submit" class="v-btn primary block" disabled={submitting}>
				{submitting ? 'Saving…' : 'Save my password'}
			</button>
		</form>
		{#if expires}
			<p class="fine">This link works once, until {expires}.</p>
		{/if}
	{/if}
</AuthShell>

<style>
	.username {
		margin: 0;
		padding: 10px 14px;
		border-radius: 10px;
		background: var(--color-evergreen-soft);
		color: var(--color-evergreen-dark);
		font-size: 24px;
		font-weight: 700;
		overflow-wrap: anywhere;
	}
	.v-field input.big {
		font-size: 24px;
	}
	.go {
		margin-top: 20px;
	}
	.fine {
		margin: 16px 0 0;
		font-size: 15px;
		color: var(--color-ink-muted);
	}
</style>

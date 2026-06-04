<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
	let submitting = $state(false);
</script>

<svelte:head>
	<title>Sign in — madonnahist</title>
</svelte:head>

<div class="login">
	<div class="card">
		<h1>madonnahist</h1>
		<p class="subtitle">Sign in to continue.</p>

		<form
			method="POST"
			action="?/login"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}
			novalidate
		>
			<label>
				<span>Username</span>
				<input
					type="text"
					name="username"
					autocomplete="username"
					autocapitalize="none"
					autocorrect="off"
					spellcheck="false"
					required
					value={form?.username ?? ''}
				/>
			</label>

			<label>
				<span>Password</span>
				<input type="password" name="password" autocomplete="current-password" required />
			</label>

			{#if form?.error}
				<p class="error" role="alert">{form.error}</p>
			{/if}

			<button type="submit" disabled={submitting}>
				{submitting ? 'Signing in…' : 'Sign in'}
			</button>
		</form>
	</div>
</div>

<style>
	.login {
		max-width: 400px;
		margin: 0 auto;
		min-height: calc(100vh - 2.5rem);
		display: grid;
		place-items: center;
		padding: 1.5rem 1rem;
	}
	.card {
		width: 100%;
		background: #fff;
		border: 1px solid #ddd;
		border-radius: 8px;
		padding: 2rem 1.5rem;
	}
	h1 {
		font-size: 1.5rem;
		margin: 0 0 0.25rem;
	}
	.subtitle {
		color: #666;
		font-size: 0.9rem;
		margin: 0 0 1.5rem;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	label span {
		font-size: 0.8rem;
		font-weight: 600;
		color: #555;
	}
	input {
		min-height: 44px;
		padding: 0.5rem 0.75rem;
		font-size: 1rem;
		background: #fafaf8;
		border: 1px solid #ccc;
		border-radius: 4px;
		color: #1a1a1a;
	}
	input:focus {
		outline: 2px solid #2c2c2c;
		outline-offset: 1px;
		background: #fff;
	}
	.error {
		color: #c33;
		font-size: 0.85rem;
		margin: -0.25rem 0 0;
	}
	button {
		margin-top: 0.5rem;
		min-height: 44px;
		background: #2c2c2c;
		color: #fff;
		border: none;
		border-radius: 4px;
		font-size: 0.95rem;
		font-weight: 600;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	button:hover:not(:disabled) {
		background: #444;
	}
</style>

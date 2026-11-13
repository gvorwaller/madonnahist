<script lang="ts">
	import { enhance } from '$app/forms';

	const { data, form } = $props();

	// Start from the saved text, or the default when nothing is saved yet,
	// so editing begins from what the family sees today.
	// svelte-ignore state_referenced_locally
	let text = $state(data.text || data.defaultText || '');
	let saving = $state(false);
</script>

<svelte:head>
	<title>About text — Admin</title>
</svelte:head>

<div class="page">
	<header>
		<h1>"About this archive"</h1>
		<p class="subtitle">
			The text family members see from the menu in the family viewer. Plain text; leave a blank line
			between paragraphs.
			{#if data.defaultText}
				Nothing is saved yet, so the family sees the default text below.
			{/if}
		</p>
	</header>

	<form
		method="POST"
		action="/admin/about?/save"
		use:enhance={() => {
			saving = true;
			return async ({ update }) => {
				await update({ reset: false });
				saving = false;
			};
		}}
	>
		<label for="about-text" class="label">Text</label>
		<textarea id="about-text" name="text" bind:value={text} rows="16" maxlength="6000"></textarea>
		<p class="hint">{text.length} / 6000 characters. Save it empty to go back to the default.</p>

		{#if form?.error}
			<p class="error" role="alert">{form.error}</p>
		{:else if form?.saved}
			<p class="ok" role="status">Saved. The family sees this now.</p>
		{/if}

		<div class="actions">
			<button type="submit" class="btn btn-primary" disabled={saving}>
				{saving ? 'Saving…' : 'Save'}
			</button>
			<a class="btn btn-secondary" href="/app/about">Preview in the family viewer</a>
		</div>
	</form>
</div>

<style>
	.page {
		max-width: 760px;
		margin: 0 auto;
		padding: 1rem;
	}
	h1 {
		margin: 0;
		font-size: 1.4rem;
	}
	.subtitle {
		color: #444;
		font-size: 0.9rem;
		margin: 0.3rem 0 1rem;
	}
	.label {
		display: block;
		font-weight: 600;
		font-size: 0.85rem;
		margin-bottom: 0.3rem;
	}
	textarea {
		width: 100%;
		box-sizing: border-box;
		padding: 0.6rem;
		border: 1px solid #999;
		border-radius: 4px;
		font: inherit;
		font-size: 1rem;
		line-height: 1.5;
	}
	.hint {
		margin: 0.3rem 0 0.8rem;
		font-size: 0.8rem;
		color: #444;
	}
	.error {
		color: #7a1414;
		font-weight: 600;
	}
	.ok {
		color: #14431a;
		font-weight: 600;
	}
	.actions {
		display: flex;
		gap: 0.6rem;
		align-items: center;
	}
	.btn {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0 1rem;
		border-radius: 4px;
		font-size: 0.9rem;
		font-weight: 600;
		text-decoration: none;
		cursor: pointer;
	}
	.btn-primary {
		background: #1a5a1a;
		color: #fff;
		border: none;
	}
	.btn-secondary {
		background: #fff;
		color: #1a1a1a;
		border: 1px solid #999;
	}
	.btn:disabled {
		opacity: 0.5;
	}
</style>

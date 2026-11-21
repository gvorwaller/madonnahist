<script lang="ts">
	import { afterNavigate } from '$app/navigation';
	import { hideSignedOut, signedOut } from '$lib/signed-out.svelte';

	/**
	 * "You've been signed out" (td-46337c). Pinned to the bottom of the
	 * screen so it shows wherever on the page the form was; role=alert so a
	 * screen reader says it at once. Any navigation clears it (signing in
	 * is one). The sign-in link is the one the save was made from
	 * (src/lib/forms.ts), never just "wherever the reader is now".
	 */
	afterNavigate(() => hideSignedOut());
</script>

{#if signedOut.shown}
	<div class="signed-out" role="alert">
		<p>
			<b>You've been signed out</b>, so that wasn't saved. Sign in again, then do it once more.
		</p>
		<div class="acts">
			<a class="go" href={signedOut.signInHref}>Sign in again</a>
			<button type="button" class="close" onclick={hideSignedOut}>Close</button>
		</div>
	</div>
{/if}

<style>
	.signed-out {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 1000;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: 8px 16px;
		padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
		background: #1a1a1a;
		color: #fff;
		font-size: 17px;
		line-height: 1.4;
		box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.25);
	}
	p {
		margin: 0;
		max-width: 40em;
	}
	.acts {
		display: flex;
		gap: 10px;
	}
	.go,
	.close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 44px;
		min-width: 44px;
		padding: 0 16px;
		border-radius: 10px;
		font: inherit;
		font-weight: 700;
	}
	.go {
		background: #fff;
		color: #1a1a1a;
		text-decoration: none;
	}
	.close {
		background: transparent;
		color: #fff;
		border: 2px solid #fff;
		cursor: pointer;
	}
	.go:focus-visible,
	.close:focus-visible {
		outline: 3px solid #ffd54a;
		outline-offset: 2px;
	}
</style>

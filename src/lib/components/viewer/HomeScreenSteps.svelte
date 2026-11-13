<script lang="ts">
	/**
	 * "Add to your home screen" steps for iPhone and Android (V3 Slice 1b).
	 * The set matching the reader's phone shows first and open; the other
	 * stays one tap away (the server guesses from the user agent, and a
	 * guess can be wrong). On a computer both start folded.
	 */
	const { platform }: { platform: 'ios' | 'android' | 'other' } = $props();

	const order = $derived(platform === 'android' ? ['android', 'ios'] : ['ios', 'android']);
</script>

<section class="hs" aria-labelledby="hs-h">
	<h2 id="hs-h">Put it on your home screen</h2>
	<p>Then it opens like an app, with the green “V” icon.</p>
	{#each order as kind (kind)}
		<details class="v-fold" open={kind === platform}>
			<summary>{kind === 'ios' ? 'iPhone or iPad (Safari)' : 'Android (Chrome)'}</summary>
			<div class="v-fold-body">
				{#if kind === 'ios'}
					<ol>
						<li>
							Tap the <b>Share</b> button: a square with an arrow pointing up. (On newer iPhones,
							tap <b>•••</b> first, then <b>Share</b>.)
						</li>
						<li>Scroll down and tap <b>Add to Home Screen</b>.</li>
						<li>Tap <b>Add</b>.</li>
					</ol>
				{:else}
					<ol>
						<li>Tap the <b>⋮</b> menu at the top right.</li>
						<li>Tap <b>Add to Home screen</b> (it may say <b>Install app</b>).</li>
						<li>Tap <b>Add</b> or <b>Install</b>.</li>
					</ol>
				{/if}
			</div>
		</details>
	{/each}
</section>

<style>
	.hs {
		margin: 20px 0 0;
	}
	h2 {
		margin: 0 0 4px;
		font-size: 20px;
	}
	ol {
		margin: 0;
		padding-left: 22px;
	}
	li + li {
		margin-top: 8px;
	}
</style>

<script lang="ts">
	const { data } = $props();
</script>

<svelte:head>
	<title>About this archive — Vorwaller Family History</title>
</svelte:head>

<div class="v-page">
	<h1 class="v-title">About this archive</h1>
	<div class="about">
		{#each data.paragraphs as p, i (i)}
			<p>{p}</p>
		{/each}
	</div>
</div>

<style>
	.about {
		margin-top: 12px;
		font-family: var(--font-serif);
		font-size: 19px;
		line-height: 1.65;
	}
	.about p {
		margin: 0 0 16px;
		white-space: pre-line;
		overflow-wrap: anywhere;
	}
</style>

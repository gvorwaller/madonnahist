<script lang="ts">
	import EntityIndex from '$lib/components/viewer/EntityIndex.svelte';

	const { data } = $props();
</script>

<svelte:head>
	<title>People — Vorwaller Family History</title>
</svelte:head>

<EntityIndex kind="person" entries={data.entries} />

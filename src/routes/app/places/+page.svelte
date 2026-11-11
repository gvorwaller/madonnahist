<script lang="ts">
	import EntityIndex from '$lib/components/viewer/EntityIndex.svelte';

	const { data } = $props();
</script>

<svelte:head>
	<title>Places — Vorwaller Family History</title>
</svelte:head>

<EntityIndex kind="place" entries={data.entries} />

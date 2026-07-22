<script lang="ts">
	import EntityProfile from '$lib/components/EntityProfile.svelte';

	const { data } = $props();
</script>

<svelte:head>
	<title>{data.profile ? data.profile.displayName : 'Not found'} — madonnahist</title>
</svelte:head>

<EntityProfile profile={data.profile} />

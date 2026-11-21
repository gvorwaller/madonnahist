<script lang="ts">
	import { page } from '$app/state';
	import MemoryForm from '$lib/components/viewer/MemoryForm.svelte';
	import { backLabel, backTarget } from '$lib/viewer/nav';

	const { data, form } = $props();

	const from = $derived(backTarget(page.url.searchParams.get('from'), ''));
	const backHref = $derived(from || '/app/memories');
	const backText = $derived(backLabel(backHref));
</script>

<svelte:head>
	<title>Add a memory — Vorwaller Family History</title>
</svelte:head>

<div class="v-page">
	<a class="v-back" href={backHref}>◂ {backText}</a>
	<h1 class="v-title">Add a memory</h1>
	<p class="v-sub">It will show as "{data.writerName} remembers".</p>

	<MemoryForm
		action="/app/memories/new?/save"
		initial={form?.values ?? data.initial}
		mode="new"
		{from}
		maxYear={data.maxYear}
		error={form?.error ?? null}
		canonical={data.initial}
	/>
</div>

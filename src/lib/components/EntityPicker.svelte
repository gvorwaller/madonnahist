<script lang="ts">
	interface Option {
		id: number;
		display_name: string;
	}

	let {
		options,
		selectedId = $bindable(null),
		placeholder = 'Type a name…',
		inputLabel = 'Search entities'
	}: {
		options: Option[];
		selectedId?: number | null;
		placeholder?: string;
		inputLabel?: string;
	} = $props();

	// Initialize the text from an existing selection (e.g. editing an alias
	// that is already set). $state initializers run once.
	let queryText = $state(options.find((o) => o.id === selectedId)?.display_name ?? '');
	let open = $state(false);
	let wrapper: HTMLElement | undefined = $state(undefined);

	const filtered = $derived.by(() => {
		const q = queryText.trim().toLowerCase();
		if (q === '') return options.slice(0, 12);
		return options.filter((o) => o.display_name.toLowerCase().includes(q)).slice(0, 12);
	});

	function choose(o: Option) {
		selectedId = o.id;
		queryText = o.display_name;
		open = false;
	}

	function handleInput() {
		// Any typing invalidates the previous selection until a new choice.
		open = true;
		selectedId = null;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			// Choose the top match instead of submitting the surrounding form.
			e.preventDefault();
			if (open && filtered.length > 0) choose(filtered[0]);
		} else if (e.key === 'Escape' && open) {
			// Close the list without also closing a surrounding modal.
			e.stopPropagation();
			open = false;
		}
	}

	function handleFocusOut(e: FocusEvent) {
		if (wrapper && e.relatedTarget instanceof Node && wrapper.contains(e.relatedTarget)) return;
		open = false;
		const sel = options.find((o) => o.id === selectedId);
		if (sel) queryText = sel.display_name;
	}
</script>

<div class="picker" bind:this={wrapper} onfocusout={handleFocusOut}>
	<input
		type="text"
		class="picker-input"
		bind:value={queryText}
		oninput={handleInput}
		onfocus={() => (open = true)}
		onkeydown={handleKeydown}
		{placeholder}
		aria-label={inputLabel}
		role="combobox"
		aria-expanded={open}
		aria-autocomplete="list"
		autocomplete="off"
	/>
	{#if open}
		<ul class="picker-list" role="listbox">
			{#each filtered as o (o.id)}
				<li>
					<button
						type="button"
						class="picker-option"
						onclick={() => choose(o)}
						role="option"
						aria-selected={o.id === selectedId}
					>
						{o.display_name}
					</button>
				</li>
			{:else}
				<li class="picker-empty">No matches</li>
			{/each}
			{#if queryText.trim() === '' && options.length > 12}
				<li class="picker-empty">Type to search {options.length} entries…</li>
			{/if}
		</ul>
	{/if}
</div>

<style>
	.picker {
		position: relative;
		width: 100%;
	}
	.picker-input {
		width: 100%;
		padding: 0.5rem 0.6rem;
		font: inherit;
		border: 1px solid #999;
		border-radius: 4px;
		box-sizing: border-box;
	}
	.picker-input:focus-visible {
		outline: 2px solid #1a4731;
		outline-offset: 1px;
	}
	.picker-list {
		position: absolute;
		z-index: 30;
		top: calc(100% + 2px);
		left: 0;
		right: 0;
		margin: 0;
		padding: 0.25rem;
		list-style: none;
		background: #fff;
		border: 1px solid #999;
		border-radius: 4px;
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.15);
		max-height: 16rem;
		overflow-y: auto;
	}
	.picker-option {
		display: block;
		width: 100%;
		min-height: 44px;
		padding: 0.5rem 0.6rem;
		background: none;
		border: none;
		font: inherit;
		color: #222;
		text-align: left;
		cursor: pointer;
		border-radius: 3px;
	}
	.picker-option:hover,
	.picker-option:focus-visible {
		background: #e8efe9;
		outline: none;
	}
	.picker-option[aria-selected='true'] {
		font-weight: 600;
	}
	.picker-empty {
		padding: 0.5rem 0.6rem;
		font-size: 0.85rem;
		font-style: italic;
		color: #555;
	}
</style>

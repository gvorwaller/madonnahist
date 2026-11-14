<script lang="ts">
	/**
	 * Search box with typeahead (V3 Slice 4). As the reader types, people,
	 * places and tags that match come from /app/search/suggest; picking one
	 * adds it as a filter (via `filterHref`). The last option, or Enter with
	 * nothing highlighted, searches the diary text as typed.
	 *
	 * ARIA combobox pattern: the input owns a listbox and points at the
	 * highlighted option with aria-activedescendant, so focus never leaves
	 * the input. Options call preventDefault on pointerdown so Safari, which
	 * doesn't focus what you click, never blurs the input mid-tap.
	 */
	import { goto } from '$app/navigation';

	type Kind = 'person' | 'place' | 'tag';
	interface Item {
		slug: string;
		label: string;
		days: number;
	}
	interface Option {
		id: string;
		kind: Kind | 'text';
		label: string;
		meta: string;
		href: string | null;
	}

	let {
		value = '',
		filterHref
	}: {
		value?: string;
		filterHref: (kind: Kind, slug: string) => string;
	} = $props();

	let term = $state('');
	$effect.pre(() => {
		term = value;
	});
	let groups = $state<{ title: string; options: Option[] }[]>([]);
	let open = $state(false);
	let active = $state(-1);
	let input: HTMLInputElement | undefined = $state();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let ctrl: AbortController | undefined;

	const flat = $derived(groups.flatMap((g) => g.options));
	const activeId = $derived(active >= 0 && flat[active] ? flat[active].id : undefined);
	const count = $derived(flat.filter((o) => o.kind !== 'text').length);

	const ICON: Record<Kind, string> = { person: '👤', place: '📍', tag: '🏷' };
	const days = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'day' : 'days'}`;

	function build(t: string, data: { people: Item[]; places: Item[]; tags: Item[] } | null) {
		const out: { title: string; options: Option[] }[] = [];
		const add = (title: string, kind: Kind, items: Item[]) => {
			if (items.length === 0) return;
			out.push({
				title,
				options: items.map((it) => ({
					id: `sug-${kind}-${it.slug}`,
					kind,
					label: `${ICON[kind]} ${it.label}`,
					meta: days(it.days),
					href: filterHref(kind, it.slug)
				}))
			});
		};
		if (data) {
			add('People', 'person', data.people);
			add('Places', 'place', data.places);
			add('Tags', 'tag', data.tags);
		}
		out.push({
			title: 'Words',
			options: [
				{ id: 'sug-text', kind: 'text', label: `🔍 Search for “${t}”`, meta: 'in the diary text', href: null }
			]
		});
		return out;
	}

	function onInput() {
		clearTimeout(timer);
		const t = term.trim();
		if (t.length < 2) {
			ctrl?.abort();
			groups = [];
			open = false;
			active = -1;
			return;
		}
		timer = setTimeout(async () => {
			ctrl?.abort();
			ctrl = new AbortController();
			try {
				const res = await fetch(`/app/search/suggest?q=${encodeURIComponent(t)}`, {
					signal: ctrl.signal,
					headers: { Accept: 'application/json' }
				});
				const data = res.ok ? await res.json() : null;
				if (term.trim() !== t) return;
				groups = build(t, data);
				active = -1;
				open = true;
			} catch (e) {
				if (e instanceof DOMException && e.name === 'AbortError') return;
				groups = build(t, null);
				open = true;
			}
		}, 150);
	}

	function choose(o: Option) {
		open = false;
		if (o.href) {
			goto(o.href);
		} else {
			input?.form?.requestSubmit();
		}
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' && flat.length > 0) {
			e.preventDefault();
			open = true;
			active = (active + 1) % flat.length;
		} else if (e.key === 'ArrowUp' && flat.length > 0) {
			e.preventDefault();
			open = true;
			active = active <= 0 ? flat.length - 1 : active - 1;
		} else if (e.key === 'Escape' && open) {
			e.preventDefault();
			open = false;
			active = -1;
		} else if (e.key === 'Enter' && open && active >= 0 && flat[active]) {
			e.preventDefault();
			choose(flat[active]);
		}
	}
</script>

<div class="wrap">
	<label class="v-searchbox">
		<span aria-hidden="true">🔍</span>
		<span class="v-sr">Search the calendars</span>
		<input
			bind:this={input}
			bind:value={term}
			type="search"
			name="q"
			maxlength="200"
			autocomplete="off"
			autocapitalize="off"
			spellcheck="false"
			placeholder="A name, place or words"
			role="combobox"
			aria-autocomplete="list"
			aria-expanded={open}
			aria-controls="search-suggest"
			aria-activedescendant={open ? activeId : undefined}
			oninput={onInput}
			onkeydown={onKeydown}
			onfocus={() => {
				if (groups.length > 0 && term.trim().length >= 2) open = true;
			}}
			onblur={() => {
				open = false;
				active = -1;
			}}
		/>
	</label>

	<ul class="list" id="search-suggest" role="listbox" aria-label="Suggestions" hidden={!open}>
		{#each groups as g (g.title)}
			<li role="presentation" class="group">{g.title}</li>
			{#each g.options as o (o.id)}
				{@const i = flat.indexOf(o)}
				<!-- Keyboard choice happens on the input (combobox pattern), so options take no focus. -->
				<!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
				<li
					id={o.id}
					role="option"
					aria-selected={i === active}
					class:hl={i === active}
					onpointerdown={(e) => e.preventDefault()}
					onclick={() => choose(o)}
				>
					<span class="label">{o.label}</span>
					<span class="meta">{o.meta}</span>
				</li>
			{/each}
		{/each}
	</ul>
	<p class="v-sr" role="status">
		{open ? `${count} ${count === 1 ? 'suggestion' : 'suggestions'}. Use up and down arrows to choose.` : ''}
	</p>
</div>

<style>
	.wrap {
		position: relative;
	}
	.list {
		position: absolute;
		z-index: 30;
		left: 0;
		right: 0;
		top: calc(100% + 4px);
		max-height: min(60vh, 420px);
		overflow-y: auto;
		margin: 0;
		padding: 4px 0;
		list-style: none;
		background: var(--color-paper);
		border: 1px solid var(--color-ink-muted);
		border-radius: 12px;
		box-shadow: 0 8px 24px rgba(43, 38, 32, 0.18);
	}
	.list[hidden] {
		display: none;
	}
	.group {
		padding: 8px 14px 2px;
		font-size: 15px;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--color-amber);
	}
	[role='option'] {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 48px;
		padding: 4px 14px;
		cursor: pointer;
	}
	[role='option']:hover,
	[role='option'].hl {
		background: var(--color-highlight-bg);
	}
	[role='option'].hl {
		box-shadow: inset 4px 0 0 var(--color-evergreen);
	}
	.label {
		flex: 1;
		min-width: 0;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.meta {
		flex: none;
		font-size: 15px;
		color: var(--color-ink-muted);
	}
</style>

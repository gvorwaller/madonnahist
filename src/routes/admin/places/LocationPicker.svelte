<script lang="ts">
	/**
	 * Set a place's location by hand (td-085e19): search like the Google Maps
	 * app and pick a result, tap a business on the map, or drop a pin and drag
	 * it. Modelled on trips' MapPicker. Lookups go through the server
	 * (/admin/places/locate); "Save this location" posts ?/pin.
	 */
	import { onMount, untrack } from 'svelte';
	import { page } from '$app/state';
	import { enhance } from '$lib/forms';
	import { isSignedOutResult, signInHref } from '$lib/viewer/session';
	import { loadGoogleMaps, onMapsAuthFailure } from '$lib/google-maps';
	import type { SubmitFunction } from '@sveltejs/kit';

	interface Spot {
		name: string;
		address: string;
		lat: number;
		lon: number;
		placeId: string | null;
	}

	interface Props {
		place: {
			entityId: number;
			name: string;
			region: 'utah' | 'florida' | null;
			lat: number | null;
			lon: number | null;
			placeId: string | null;
			matchedName: string | null;
			address: string | null;
			query: string | null;
			candidates: Spot[];
		};
		maps: { key: string; mapId: string };
		centre: { lat: number; lon: number };
		onclose: () => void;
		onsaved: (message: string) => void;
	}

	const { place, maps, centre, onclose, onsaved }: Props = $props();

	// The dialog works from the place as it was when opened; saving closes it.
	const start = untrack(() => place);
	const current: Spot | null =
		start.lat !== null && start.lon !== null
			? { name: start.matchedName ?? start.name, address: start.address ?? '', lat: start.lat, lon: start.lon, placeId: start.placeId }
			: null;

	let dialog: HTMLDialogElement;
	let mapEl: HTMLDivElement;
	let q = $state(start.query && start.query !== start.name ? start.query : start.name);
	let results = $state<Spot[]>(start.candidates.map((c) => ({ ...c })));
	let selected = $state<Spot | null>(current);
	let searching = $state(false);
	let looking = $state(false);
	let saving = $state(false);
	let note = $state('');
	let error = $state('');
	/** Signed out before Save (td-46337c): the modal makes the app-wide bar unreachable, so say it here. */
	let signInTo = $state<string | null>(null);
	let mapError = $state('');

	/* eslint-disable @typescript-eslint/no-explicit-any */
	let map: any = null;
	let gmaps: any = null;
	let markerLib: any = null;
	let resultMarkers: any[] = [];
	let pin: any = null;
	/* eslint-enable @typescript-eslint/no-explicit-any */

	const sameSpot = (a: Spot | null, b: Spot) => !!a && a.lat === b.lat && a.lon === b.lon;

	async function locate(body: Record<string, unknown>): Promise<{ results?: Spot[]; spot?: Spot | null; error?: string }> {
		try {
			const res = await fetch('/admin/places/locate', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) return { error: data.error ?? 'That lookup didn’t work.' };
			return data;
		} catch {
			return { error: 'Could not reach the server.' };
		}
	}

	function numberEl(n: number, chosen: boolean): HTMLElement {
		const el = document.createElement('div');
		el.className = chosen ? 'lp-num lp-num-chosen' : 'lp-num';
		el.textContent = String(n);
		el.setAttribute('aria-hidden', 'true');
		return el;
	}

	function pinEl(): HTMLElement {
		const el = document.createElement('div');
		el.className = 'lp-pin';
		el.setAttribute('aria-hidden', 'true');
		return el;
	}

	function drawResults() {
		if (!map) return;
		resultMarkers.forEach((m) => (m.map = null));
		resultMarkers = results.map((r, i) => {
			const m = new markerLib.AdvancedMarkerElement({
				map,
				position: { lat: r.lat, lng: r.lon },
				content: numberEl(i + 1, sameSpot(selected, r)),
				title: `${i + 1}. ${r.name}`,
				gmpClickable: true
			});
			m.addListener('click', () => choose(r));
			return m;
		});
	}

	function drawPin() {
		if (!map) return;
		if (!selected) {
			if (pin) pin.map = null;
			return;
		}
		const position = { lat: selected.lat, lng: selected.lon };
		if (!pin) {
			pin = new markerLib.AdvancedMarkerElement({ map, position, content: pinEl(), gmpDraggable: true, zIndex: 1000 });
			pin.addListener('dragend', () => {
				const p = pin.position;
				const lat = typeof p.lat === 'function' ? p.lat() : p.lat;
				const lng = typeof p.lng === 'function' ? p.lng() : p.lng;
				void dropAt(lat, lng);
			});
		} else {
			pin.position = position;
			pin.map = map;
		}
	}

	function redraw() {
		drawResults();
		drawPin();
	}

	/** Show the results (after a search), or everything known when the dialog opens. */
	function fitAll(resultsOnly = false) {
		if (!map) return;
		const pts = resultsOnly && results.length > 0 ? results : [...results, ...(selected ? [selected] : [])];
		if (pts.length === 0) {
			map.setCenter({ lat: centre.lat, lng: centre.lon });
			map.setZoom(10);
		} else if (pts.length === 1) {
			map.setCenter({ lat: pts[0].lat, lng: pts[0].lon });
			map.setZoom(15);
		} else {
			const b = new gmaps.LatLngBounds();
			pts.forEach((p) => b.extend({ lat: p.lat, lng: p.lon }));
			map.fitBounds(b, 48);
		}
	}

	function choose(s: Spot) {
		selected = { ...s };
		error = '';
		note = '';
		redraw();
		map?.panTo({ lat: s.lat, lng: s.lon });
	}

	async function search(e: SubmitEvent) {
		e.preventDefault();
		const text = q.trim();
		if (!text) return;
		searching = true;
		error = '';
		note = '';
		const r = await locate({ entity_id: place.entityId, q: text });
		searching = false;
		if (r.error) {
			error = r.error;
			return;
		}
		results = r.results ?? [];
		note = results.length === 0 ? `Nothing found for “${text}”. Try other words, or tap the map.` : '';
		redraw();
		fitAll(true);
	}

	// A dropped or dragged pin keeps its exact point; the nearest address only labels it.
	async function dropAt(lat: number, lon: number) {
		selected = { name: 'Dropped pin', address: '', lat, lon, placeId: null };
		redraw();
		looking = true;
		const r = await locate({ lat, lon });
		looking = false;
		if (!selected || selected.lat !== lat || selected.lon !== lon) return; // moved again meanwhile
		if (r.spot) selected = { name: r.spot.name, address: r.spot.address, lat, lon, placeId: null };
	}

	async function tapPlace(placeId: string, lat: number, lon: number) {
		selected = { name: 'Looking up…', address: '', lat, lon, placeId: null };
		redraw();
		looking = true;
		const r = await locate({ place_id: placeId });
		looking = false;
		if (r.spot) choose(r.spot);
		else if (r.error) error = r.error;
	}

	onMount(() => {
		dialog.showModal();
		const offAuth = onMapsAuthFailure(() => {
			mapError =
				'Google refused the map key for this website. In Google Cloud → Credentials, add madonnahist.gaylon.photos/* to the browser key’s allowed websites.';
		});
		(async () => {
			try {
				const libs = await loadGoogleMaps(maps.key, ['maps', 'marker']);
				gmaps = (window as unknown as { google: { maps: unknown } }).google.maps;
				markerLib = libs.marker;
				const { Map } = libs.maps as { Map: new (el: HTMLElement, opts: unknown) => unknown };
				map = new Map(mapEl, {
					center: { lat: centre.lat, lng: centre.lon },
					zoom: 10,
					mapId: maps.mapId || 'DEMO_MAP_ID',
					gestureHandling: 'greedy',
					clickableIcons: true,
					zoomControl: true,
					streetViewControl: false,
					mapTypeControl: true,
					fullscreenControl: false
				});
				map.addListener('click', (ev: { latLng: { lat(): number; lng(): number }; placeId?: string; stop?: () => void }) => {
					const lat = ev.latLng.lat();
					const lon = ev.latLng.lng();
					if (ev.placeId) {
						ev.stop?.(); // no Google info window: the tap picks the place
						void tapPlace(ev.placeId, lat, lon);
					} else {
						void dropAt(lat, lon);
					}
				});
				redraw();
				fitAll();
			} catch (err) {
				mapError = err instanceof Error ? err.message : 'Could not load the map.';
			}
		})();
		return offAuth;
	});

	const save: SubmitFunction = () => {
		saving = true;
		error = '';
		signInTo = null;
		const back = signInHref(page.url);
		return async ({ result, update }) => {
			saving = false;
			if (isSignedOutResult(result)) {
				signInTo = back;
			} else if (result.type === 'success') {
				await update({ reset: false });
				onsaved(String(result.data?.message ?? 'Location saved'));
				dialog.close();
			} else if (result.type === 'failure') {
				error = String(result.data?.error ?? 'That didn’t save.');
			} else {
				error = 'Something went wrong. Try again.';
			}
		};
	};
</script>

<dialog bind:this={dialog} class="picker" aria-labelledby="lp-title" onclose={onclose}>
	<div class="top">
		<h2 id="lp-title">Where is {place.name}?</h2>
		<button type="button" class="close" onclick={() => dialog.close()}>Close</button>
	</div>
	<p class="hint">Search and pick a result, tap a business on the map, or tap anywhere to drop a pin. Drag the pin to adjust.</p>

	<form class="search" onsubmit={search}>
		<label class="grow">
			<span class="sr">Search for {place.name}</span>
			<input type="search" bind:value={q} maxlength="200" placeholder="e.g. {place.name}, Jacksonville FL" />
		</label>
		<button type="submit" class="btn primary" disabled={searching}>{searching ? 'Searching…' : 'Search'}</button>
	</form>
	{#if note}<p class="note" role="status">{note}</p>{/if}

	<div class="body">
		<div class="map-wrap">
			<!-- Google owns everything inside .map (it replaces it with its own error box), so the note sits beside it. -->
			<div class="map" bind:this={mapEl}></div>
			{#if mapError}<p class="map-error" role="alert">{mapError}</p>{/if}
		</div>
		{#if results.length > 0}
			<ol class="results" aria-label="Search results">
				{#each results as r, i (i)}
					<li>
						<button type="button" class="result" aria-pressed={sameSpot(selected, r)} onclick={() => choose(r)}>
							<span class="n" aria-hidden="true">{i + 1}</span>
							<span><b>{r.name}</b>{#if r.address}<br /><span class="addr">{r.address}</span>{/if}</span>
						</button>
					</li>
				{/each}
			</ol>
		{/if}
	</div>

	<div class="footer">
		<p class="chosen" aria-live="polite">
			{#if selected}
				<b>{current && sameSpot(selected, current) ? 'Current location' : 'Selected'}:</b>
				{selected.name}{selected.address && selected.address !== selected.name ? `, ${selected.address}` : ''}
				{#if looking}<span class="addr"> (finding the address…)</span>{/if}
			{:else}
				Nothing selected yet.
			{/if}
		</p>
		{#if error}<p class="err" role="alert">{error}</p>{/if}
		{#if signInTo}
			<p class="err" role="alert">
				You've been signed out, so the location wasn't saved.
				<a class="signin" href={signInTo}>Sign in again</a>, then pick it once more.
			</p>
		{/if}
		<form method="POST" action="/admin/places?/pin" data-signed-out-inline use:enhance={save}>
			<input type="hidden" name="entity_id" value={place.entityId} />
			<input type="hidden" name="lat" value={selected?.lat ?? ''} />
			<input type="hidden" name="lon" value={selected?.lon ?? ''} />
			<input type="hidden" name="place_id" value={selected?.placeId ?? ''} />
			<input type="hidden" name="name" value={selected?.name === 'Dropped pin' || selected?.name === 'Looking up…' ? '' : (selected?.name ?? '')} />
			<input type="hidden" name="address" value={selected?.address ?? ''} />
			<div class="buttons">
				<button type="button" class="btn" onclick={() => dialog.close()}>Cancel</button>
				<button type="submit" class="btn primary" disabled={!selected || saving || looking}>
					{saving ? 'Saving…' : 'Save this location'}
				</button>
			</div>
		</form>
	</div>
</dialog>

<style>
	.picker {
		width: min(1000px, calc(100vw - 2rem));
		max-height: calc(100dvh - 2rem);
		padding: 1rem;
		border: 1px solid #888;
		border-radius: 10px;
		background: #fff;
		color: #222;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.picker:not([open]) {
		display: none;
	}
	.picker::backdrop {
		background: rgb(0 0 0 / 0.45);
	}
	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}
	h2 {
		margin: 0;
		font-size: 1.15rem;
	}
	.hint,
	.note {
		margin: 0;
		font-size: 0.88rem;
		color: #4a4a4a;
	}
	.search {
		display: flex;
		gap: 0.4rem;
	}
	.grow {
		flex: 1;
	}
	.search input {
		width: 100%;
		min-height: 44px;
		padding: 0 0.6rem;
		border: 1px solid #888;
		border-radius: 6px;
		font-size: 1rem;
		box-sizing: border-box;
	}
	.body {
		display: grid;
		grid-template-columns: 1fr;
		gap: 0.5rem;
		min-height: 0;
	}
	.map-wrap {
		position: relative;
		min-width: 0;
	}
	.map {
		height: 52dvh;
		min-height: 260px;
		border: 1px solid #ccc;
		border-radius: 8px;
		overflow: hidden;
		background: #e8ecef;
	}
	.map-error {
		position: absolute;
		inset: auto 0.5rem 0.5rem;
		margin: 0;
		padding: 0.6rem 0.75rem;
		background: #fff;
		border: 2px solid #7a1f1f;
		border-radius: 6px;
		color: #7a1f1f;
		font-weight: 600;
		font-size: 0.9rem;
		z-index: 2;
	}
	.results {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		align-content: start;
		gap: 0.3rem;
		max-height: 30dvh;
		overflow-y: auto;
	}
	.result {
		width: 100%;
		min-height: 44px;
		display: flex;
		gap: 0.6rem;
		align-items: flex-start;
		text-align: left;
		padding: 0.45rem 0.6rem;
		border: 1px solid #ccc;
		border-radius: 6px;
		background: #fff;
		color: #222;
		font: inherit;
		font-size: 0.9rem;
		cursor: pointer;
	}
	.result[aria-pressed='true'] {
		border: 2px solid #2a5f4c;
		background: #eef6f2;
	}
	.n {
		flex: none;
		width: 1.6rem;
		height: 1.6rem;
		border-radius: 50%;
		background: #1f3b57;
		color: #fff;
		font-weight: 700;
		display: grid;
		place-items: center;
		font-size: 0.85rem;
	}
	.addr {
		color: #4a4a4a;
		font-size: 0.85rem;
	}
	.footer {
		border-top: 1px solid #ddd;
		padding-top: 0.5rem;
	}
	.chosen {
		margin: 0 0 0.4rem;
		font-size: 0.92rem;
		line-height: 1.45;
	}
	.signin {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: inherit;
	}
	.err {
		margin: 0 0 0.4rem;
		color: #7a1f1f;
		font-weight: 600;
	}
	.buttons {
		display: flex;
		justify-content: flex-end;
		gap: 0.4rem;
	}
	.btn,
	.close {
		min-height: 44px;
		padding: 0 0.9rem;
		border: 1px solid #888;
		border-radius: 6px;
		background: #fff;
		color: #222;
		font: inherit;
		font-size: 0.9rem;
		cursor: pointer;
	}
	.btn.primary {
		background: #2a5f4c;
		border-color: #2a5f4c;
		color: #fff;
		font-weight: 700;
	}
	.btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
	/* Markers are created by the Maps API outside Svelte's scope. */
	:global(.lp-num) {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: #1f3b57;
		color: #fff;
		border: 2px solid #fff;
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.5);
		font: 700 14px/24px system-ui, sans-serif;
		text-align: center;
		cursor: pointer;
	}
	:global(.lp-num-chosen) {
		background: #2a5f4c;
	}
	:global(.lp-pin) {
		width: 26px;
		height: 26px;
		border-radius: 50% 50% 50% 0;
		background: #b3261e;
		border: 3px solid #fff;
		box-shadow: 0 1px 4px rgb(0 0 0 / 0.55);
		transform: rotate(-45deg) translate(4px, -4px);
		cursor: grab;
	}
	@media (min-width: 900px) {
		.body {
			grid-template-columns: 1fr 300px;
		}
		.results {
			max-height: 52dvh;
		}
	}
	@media (max-width: 600px) {
		.picker {
			width: 100vw;
			max-width: 100vw;
			height: 100dvh;
			max-height: 100dvh;
			margin: 0;
			border-radius: 0;
			border: 0;
			box-sizing: border-box;
		}
		.map {
			height: 42dvh;
		}
		.results {
			max-height: 22dvh;
		}
	}
</style>

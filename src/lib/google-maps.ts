/**
 * Browser-side Google Maps JS API loader (td-085e19), ported from trips
 * (trips/src/lib/google-maps.ts, itself from birds/gaylon.photos). Loads the
 * script once, then imports libraries on demand. The key is the shared
 * browser key, passed in by the page that needs a map (admin only today).
 */

const CALLBACK = '__madonnahistGoogleMapsLoaded__';

interface GMapsWindow {
	google?: { maps?: { importLibrary?: (name: string) => Promise<unknown> } };
	gm_authFailure?: () => void;
	[CALLBACK]?: () => void;
}

let scriptLoadPromise: Promise<void> | null = null;
const libraryPromises = new Map<string, Promise<unknown>>();
const authFailureListeners = new Set<() => void>();

function loadScript(apiKey: string): Promise<void> {
	if (typeof window === 'undefined') return Promise.reject(new Error('Google Maps can only be loaded in the browser'));
	const w = window as unknown as GMapsWindow;
	if (w.google?.maps?.importLibrary) return Promise.resolve();
	if (scriptLoadPromise) return scriptLoadPromise;

	// Google calls this when it refuses the key (e.g. this website isn't on
	// the key's allowed list). The map then shows Google's own error box.
	w.gm_authFailure = () => authFailureListeners.forEach((fn) => fn());

	scriptLoadPromise = new Promise<void>((resolve, reject) => {
		w[CALLBACK] = () => resolve();
		const params = new URLSearchParams({ key: apiKey, v: 'weekly', loading: 'async', callback: CALLBACK });
		const script = document.createElement('script');
		script.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
		script.async = true;
		script.onerror = () => {
			scriptLoadPromise = null;
			reject(new Error('Could not load Google Maps.'));
		};
		document.head.appendChild(script);
	});
	return scriptLoadPromise;
}

/** Load the script and the requested libraries; returns them by name. */
export async function loadGoogleMaps(apiKey: string, libraries: string[] = ['maps', 'marker']): Promise<Record<string, unknown>> {
	if (!apiKey) throw new Error('Google Maps key is required');
	await loadScript(apiKey);
	const w = window as unknown as GMapsWindow;
	const importLibrary = w.google?.maps?.importLibrary;
	if (!importLibrary) throw new Error('Google Maps not loaded');
	const loaded: Record<string, unknown> = {};
	for (const name of libraries) {
		if (!libraryPromises.has(name)) libraryPromises.set(name, importLibrary(name));
		loaded[name] = await libraryPromises.get(name);
	}
	return loaded;
}

/** Be told when Google refuses the key. Returns an unsubscribe function. */
export function onMapsAuthFailure(fn: () => void): () => void {
	authFailureListeners.add(fn);
	return () => authFailureListeners.delete(fn);
}

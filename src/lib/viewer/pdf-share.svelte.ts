/**
 * Opening a PDF from the installed family app (iPhone/iPad home-screen PWA).
 *
 * Since Viewer V3 (98ea9e8) the app is installable with display:standalone
 * and scope "/". In an installed iOS web app a same-site link ignores
 * target="_blank": the PDF replaces the app's only window, which has no
 * back button and no share/print, so the only way out was to kill the app.
 * td-863a4a's new-tab fix only works in a Safari tab.
 *
 * So in standalone mode a PDF tap never navigates. The PDF is fetched in the
 * page and handed to the iOS share sheet (Print, Save to Files, Books,
 * Mail, ...). Where the device can't share files, a message says to use
 * Safari instead. In a browser tab the link is left alone (new tab).
 *
 * iOS only lets navigator.share() run during a tap. Right after a fetch it
 * often still counts as the same tap; when it doesn't, `state` becomes
 * 'ready' and the page shows a "Share or print" button for a second tap.
 *
 * Nothing is cached between taps (the download URLs always serve the latest
 * edition), and the page calls reset() when it shows a different year or
 * story: a download still in flight, or a file waiting for its second tap,
 * then belongs to nothing and is dropped.
 */

type PdfShareState = 'idle' | 'loading' | 'ready' | 'error';

function isStandalone(): boolean {
	return (
		window.matchMedia?.('(display-mode: standalone)').matches === true ||
		(navigator as Navigator & { standalone?: boolean }).standalone === true
	);
}

const NO_SHARE =
	"This device can't share a PDF from the app. Open the family history in Safari to download it.";

export class PdfShare {
	state = $state<PdfShareState>('idle');
	message = $state('');
	/** Set when the session has expired: where to sign in again. */
	signInHref = $state<string | null>(null);
	/** What the pending PDF is called, for the "Share or print" button. */
	label = $state('');
	#file: File | null = null;
	/** Bumped by reset() and each new tap; stale downloads compare against it. */
	#generation = 0;

	/** Forget any pending PDF (the page now shows a different year/story). */
	reset(): void {
		this.#generation++;
		this.#file = null;
		this.state = 'idle';
		this.message = '';
		this.signInHref = null;
	}

	/** Click handler for a PDF link. Does nothing outside the installed app. */
	async open(event: MouseEvent, href: string, filename: string, label: string): Promise<void> {
		if (!isStandalone()) return;
		// From here on the link must never navigate: in the installed app
		// that is the trap this exists to avoid.
		event.preventDefault();
		if (this.state === 'loading') return;
		this.reset();
		const generation = this.#generation;
		this.label = label;

		if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') {
			this.#fail(NO_SHARE);
			return;
		}

		this.state = 'loading';
		let file: File;
		try {
			// 'manual': an expired session redirects to the sign-in page, and
			// following it would hand that HTML page on as the "PDF".
			const res = await fetch(href, { credentials: 'same-origin', redirect: 'manual' });
			if (generation !== this.#generation) return;
			if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
				this.#fail("You've been signed out. Sign in again, then try the PDF.");
				this.signInHref = `/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`;
				return;
			}
			if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('application/pdf')) {
				throw new Error(`unexpected response ${res.status} ${res.headers.get('content-type')}`);
			}
			const blob = await res.blob();
			if (generation !== this.#generation) return;
			file = new File([blob], filename, { type: 'application/pdf' });
		} catch {
			if (generation !== this.#generation) return;
			this.#fail("Couldn't get the PDF. Check the connection and try again.");
			return;
		}
		if (!navigator.canShare({ files: [file] })) {
			this.#fail(NO_SHARE);
			return;
		}
		this.#file = file;
		this.state = 'ready';
		await this.share();
	}

	/** Open the share sheet for the fetched PDF. Call from a tap. */
	async share(): Promise<void> {
		const file = this.#file;
		const generation = this.#generation;
		if (!file || this.state !== 'ready') return;
		try {
			await navigator.share({ files: [file], title: this.label });
			if (generation === this.#generation) this.reset();
		} catch (err) {
			if (generation !== this.#generation) return;
			const name = err instanceof DOMException ? err.name : '';
			if (name === 'AbortError') {
				// Share sheet closed without choosing anything.
				this.reset();
			} else if (name === 'NotAllowedError') {
				// The tap "expired" during the download: ask for one more.
				this.state = 'ready';
			} else {
				this.#fail("Couldn't open the share sheet. Try again.");
			}
		}
	}

	#fail(message: string): void {
		this.#file = null;
		this.state = 'error';
		this.message = message;
	}
}

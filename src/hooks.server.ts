import type { Handle } from '@sveltejs/kit';

// Real session resolution lands in td-510a34 (argon2id + cookie sessions).
// Until then this is a pass-through so route guards can read event.locals.user
// without crashing — they'll just see undefined.
export const handle: Handle = async ({ event, resolve }) => {
	return resolve(event);
};

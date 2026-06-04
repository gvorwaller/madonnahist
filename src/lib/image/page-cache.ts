import { getObject } from '$lib/ingest/spaces-upload';
import sharp from 'sharp';

interface CacheEntry {
	buffer: Buffer;
	timer: ReturnType<typeof setTimeout>;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<Buffer>>();
const CACHE_TTL = 60_000;
const MAX_ENTRIES = 2;

function evict(key: string) {
	const entry = cache.get(key);
	if (entry) {
		clearTimeout(entry.timer);
		cache.delete(key);
	}
}

function evictOldest() {
	const oldest = cache.keys().next().value;
	if (oldest !== undefined) evict(oldest);
}

export async function getPageBuffer(key: string, rotate = false): Promise<Buffer> {
	const cacheKey = rotate ? `${key}:rotated` : key;

	const cached = cache.get(cacheKey);
	if (cached) {
		cached.timer.refresh();
		return cached.buffer;
	}

	const existing = inflight.get(cacheKey);
	if (existing) return existing;

	const promise = (async () => {
		const raw = await getObject(key);
		const buffer = rotate
			? await sharp(raw).rotate().toBuffer()
			: raw;

		if (cache.size >= MAX_ENTRIES) evictOldest();

		const timer = setTimeout(() => evict(cacheKey), CACHE_TTL);
		timer.unref();
		cache.set(cacheKey, { buffer, timer });
		inflight.delete(cacheKey);

		return buffer;
	})();

	inflight.set(cacheKey, promise);
	promise.catch(() => { inflight.delete(cacheKey); });

	return promise;
}

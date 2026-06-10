/**
 * DigitalOcean Spaces (S3-compatible) upload for ingested page images.
 *
 * Keys are deterministic (derived from year/month/content-hash) so that an
 * interrupted ingest can be retried without creating duplicate objects: the
 * orchestrator computes the key BEFORE uploading, and upload is HEAD-then-skip.
 *
 * Credentials live in private_data.api_credentials (service 'do_spaces'),
 * never in .env — see cs.md § API Keys & Secrets.
 */
import { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { credentialService } from '$lib/credentials';
import { env } from '$env/dynamic/private';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

interface SpacesConfig {
	client: S3Client;
	bucket: string;
}

let cached: SpacesConfig | undefined;

function useLocalObjectStore(): boolean {
	return env.MADONNAHIST_OBJECT_STORE === 'local';
}

function localStoreRoot(): string {
	return resolve(process.cwd(), env.MADONNAHIST_LOCAL_OBJECT_STORE_DIR ?? '.local/object-store-test');
}

function localObjectPath(key: string): string {
	const root = localStoreRoot();
	const path = resolve(root, key);
	if (path !== root && !path.startsWith(root + sep)) {
		throw new Error(`Object key escapes local object store root: ${key}`);
	}
	return path;
}

async function getSpaces(): Promise<SpacesConfig> {
	if (cached) return cached;

	const [key, secret, bucket, region, endpoint] = await Promise.all([
		credentialService.getCredential('do_spaces', 'SPACES_KEY'),
		credentialService.getCredential('do_spaces', 'SPACES_SECRET'),
		credentialService.getCredential('do_spaces', 'SPACES_BUCKET'),
		credentialService.getCredential('do_spaces', 'SPACES_REGION'),
		credentialService.getCredential('do_spaces', 'SPACES_ENDPOINT')
	]);

	if (!key || !secret || !bucket || !region || !endpoint) {
		throw new Error('DO Spaces credentials are not fully configured in private_data.api_credentials');
	}

	const client = new S3Client({
		region,
		endpoint,
		credentials: { accessKeyId: key, secretAccessKey: secret },
		forcePathStyle: false
	});

	cached = { client, bucket };
	return cached;
}

/** Deterministic object key for a page image. `hash8` = first 8 chars of SHA-256. */
export function pageObjectKey(year: number, month: number, hash8: string): string {
	const mm = String(month).padStart(2, '0');
	return `pages/${year}/${mm}/page-${year}-${mm}-${hash8}.jpg`;
}

interface HeadResult {
	exists: boolean;
	size: number | null;
}

async function headObject(key: string): Promise<HeadResult> {
	if (useLocalObjectStore()) {
		try {
			const info = await stat(localObjectPath(key));
			return { exists: info.isFile(), size: info.isFile() ? info.size : null };
		} catch (err: unknown) {
			if ((err as { code?: string }).code === 'ENOENT') return { exists: false, size: null };
			throw err;
		}
	}

	const { client, bucket } = await getSpaces();
	try {
		const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
		return { exists: true, size: r.ContentLength ?? null };
	} catch (err: unknown) {
		// HeadObject throws on a missing key; treat 404/NotFound as "absent".
		const meta = (err as { $metadata?: { httpStatusCode?: number }; name?: string });
		if (meta?.$metadata?.httpStatusCode === 404 || meta?.name === 'NotFound' || meta?.name === 'NoSuchKey') {
			return { exists: false, size: null };
		}
		throw err;
	}
}

export interface UploadResult {
	key: string;
	uploaded: boolean; // false = object already present, upload skipped
}

/**
 * Upload `body` to `key` unless an object of the same byte length already
 * exists there (idempotent retry). Returns whether a PUT actually happened.
 */
export async function uploadIfAbsent(
	key: string,
	body: Buffer,
	contentType = 'image/jpeg'
): Promise<UploadResult> {
	const head = await headObject(key);
	if (head.exists && head.size === body.length) {
		return { key, uploaded: false };
	}

	if (useLocalObjectStore()) {
		const path = localObjectPath(key);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, body);
		return { key, uploaded: true };
	}

	const { client, bucket } = await getSpaces();
	await client.send(
		new PutObjectCommand({
			Bucket: bucket,
			Key: key,
			Body: body,
			ContentType: contentType,
			ACL: 'private'
		})
	);
	return { key, uploaded: true };
}

/** Download an object from Spaces. */
export async function getObject(key: string): Promise<Buffer> {
	if (useLocalObjectStore()) {
		return readFile(localObjectPath(key));
	}

	const { client, bucket } = await getSpaces();
	const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
	const stream = res.Body;
	if (!stream) throw new Error(`Empty response body for ${key}`);
	const chunks: Buffer[] = [];
	for await (const chunk of stream as AsyncIterable<Buffer>) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

/** Best-effort delete of a Spaces object. Returns true if deleted or already absent. */
export async function deleteObject(key: string): Promise<boolean> {
	try {
		if (useLocalObjectStore()) {
			await rm(localObjectPath(key), { force: true });
			return true;
		}

		const { client, bucket } = await getSpaces();
		await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
		return true;
	} catch {
		return false;
	}
}

/** Test hook: drop the memoized client (e.g. after credential rotation). */
export function resetSpacesClient(): void {
	cached = undefined;
}

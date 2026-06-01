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
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { credentialService } from '$lib/credentials';

interface SpacesConfig {
	client: S3Client;
	bucket: string;
}

let cached: SpacesConfig | undefined;

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

/** Test hook: drop the memoized client (e.g. after credential rotation). */
export function resetSpacesClient(): void {
	cached = undefined;
}

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { query } from './db.js';

interface SpacesConfig {
	client: S3Client;
	bucket: string;
}

let cached: SpacesConfig | undefined;

async function getCredential(service: string, key: string): Promise<string> {
	const r = await query<{ credential_value: string }>(
		`SELECT credential_value
		   FROM private_data.api_credentials
		  WHERE service_name = $1
		    AND credential_key = $2
		    AND is_active = true
		  ORDER BY created_at DESC
		  LIMIT 1`,
		[service, key]
	);
	if (!r.rows[0]) throw new Error(`Missing credential: ${service}/${key}`);
	return r.rows[0].credential_value;
}

export async function getApiKey(service: string, key: string, envFallback?: string): Promise<string> {
	try {
		return await getCredential(service, key);
	} catch {
		if (envFallback && process.env[envFallback]) return process.env[envFallback]!;
		throw new Error(`Credential ${service}/${key} not in DB and ${envFallback ?? 'no env fallback'} not set`);
	}
}

async function getSpaces(): Promise<SpacesConfig> {
	if (cached) return cached;

	const [accessKey, secret, bucket, region, endpoint] = await Promise.all([
		getCredential('do_spaces', 'SPACES_KEY'),
		getCredential('do_spaces', 'SPACES_SECRET'),
		getCredential('do_spaces', 'SPACES_BUCKET'),
		getCredential('do_spaces', 'SPACES_REGION'),
		getCredential('do_spaces', 'SPACES_ENDPOINT')
	]);

	const client = new S3Client({
		region,
		endpoint,
		credentials: { accessKeyId: accessKey, secretAccessKey: secret },
		forcePathStyle: false
	});

	cached = { client, bucket };
	return cached;
}

export async function getObject(key: string): Promise<Buffer> {
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

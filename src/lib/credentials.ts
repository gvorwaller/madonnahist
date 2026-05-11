import { query } from './db';

type CacheKey = `${string}::${string}`;
const cache = new Map<CacheKey, string | null>();

export const credentialService = {
	async getCredential(service: string, key: string): Promise<string | null> {
		const cacheKey: CacheKey = `${service}::${key}`;
		if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;

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
		const value = r.rows[0]?.credential_value ?? null;
		cache.set(cacheKey, value);
		return value;
	},

	clearCache(): void {
		cache.clear();
	}
};

export type SpacesHealth = 'ok' | 'not_configured' | 'error';

export async function spacesHealthCheck(): Promise<SpacesHealth> {
	try {
		const required = ['SPACES_KEY', 'SPACES_SECRET', 'SPACES_BUCKET', 'SPACES_REGION', 'SPACES_ENDPOINT'];
		const values = await Promise.all(required.map((k) => credentialService.getCredential('do_spaces', k)));
		const presentCount = values.filter((v) => v && v.length > 0).length;
		if (presentCount === 0) return 'not_configured';
		if (presentCount < required.length) return 'error';
		// TODO (td-ccb503): once @aws-sdk/client-s3 is added for the upload script,
		// upgrade this from "all five creds present" to a real HEAD bucket request.
		return 'ok';
	} catch {
		return 'error';
	}
}

import type { TranscribeInput, TranscribeOptions, TranscribeResult, VendorAdapter } from '../types.js';

export interface TranskribusConfig {
	email: string;
	password: string;
	htrModelId?: number;
	pollIntervalMs?: number;
	timeoutMs?: number;
}

const AUTH_URL =
	'https://account.readcoop.eu/auth/realms/readcoop/protocol/openid-connect/token';
const API_BASE = 'https://transkribus.eu/processing/v1';
const CLIENT_ID = 'processing-api-client';
const DEFAULT_HTR_MODEL = 356425; // Text Titan I ter (latest Super Model)

interface TokenState {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
}

async function authenticate(email: string, password: string): Promise<TokenState> {
	const res = await fetch(AUTH_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'password',
			username: email,
			password: password,
			client_id: CLIENT_ID
		})
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Transkribus auth failed (${res.status}): ${body}`);
	}

	const data = (await res.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
	};

	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAt: Date.now() + (data.expires_in - 30) * 1000
	};
}

async function refreshAuth(refreshToken: string): Promise<TokenState> {
	const res = await fetch(AUTH_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			client_id: CLIENT_ID
		})
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Transkribus token refresh failed (${res.status}): ${body}`);
	}

	const data = (await res.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
	};

	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAt: Date.now() + (data.expires_in - 30) * 1000
	};
}

function extractTextFromPageXml(xml: string): { text: string; lineCount: number } {
	const lines: string[] = [];
	const regex = /<Unicode>([^<]*)<\/Unicode>/g;
	let match;
	while ((match = regex.exec(xml)) !== null) {
		const text = match[1].trim();
		if (text) lines.push(text);
	}
	return { text: lines.join('\n'), lineCount: lines.length };
}

export function createTranskribusAdapter(config: TranskribusConfig): VendorAdapter {
	const htrModelId = config.htrModelId ?? DEFAULT_HTR_MODEL;
	const pollInterval = config.pollIntervalMs ?? 2000;
	const timeoutMs = config.timeoutMs ?? 120_000;
	let tokenState: TokenState | null = null;

	async function getToken(): Promise<string> {
		if (tokenState && Date.now() < tokenState.expiresAt) {
			return tokenState.accessToken;
		}
		if (tokenState) {
			try {
				tokenState = await refreshAuth(tokenState.refreshToken);
				return tokenState.accessToken;
			} catch {
				// refresh failed, re-authenticate
			}
		}
		tokenState = await authenticate(config.email, config.password);
		return tokenState.accessToken;
	}

	return {
		vendorName: `transkribus/${htrModelId}`,

		async transcribe(
			input: TranscribeInput,
			_options?: TranscribeOptions
		): Promise<TranscribeResult> {
			const token = await getToken();
			const imageB64 = input.image.toString('base64');
			const start = performance.now();

			const submitRes = await fetch(`${API_BASE}/processes`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${token}`
				},
				body: JSON.stringify({
					config: {
						textRecognition: { htrId: htrModelId }
					},
					image: { base64: imageB64 },
					content: {}
				})
			});

			if (!submitRes.ok) {
				const body = await submitRes.text();
				throw new Error(`Transkribus submit failed (${submitRes.status}): ${body}`);
			}

			const { processId } = (await submitRes.json()) as { processId: number };
			const deadline = Date.now() + timeoutMs;

			while (Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, pollInterval));

				const statusRes = await fetch(`${API_BASE}/processes/${processId}`, {
					headers: { Authorization: `Bearer ${token}` }
				});

				if (!statusRes.ok) {
					const body = await statusRes.text();
					throw new Error(`Transkribus status check failed (${statusRes.status}): ${body}`);
				}

				const { status } = (await statusRes.json()) as { status: string };

				if (status === 'FINISHED') {
					const pageRes = await fetch(`${API_BASE}/processes/${processId}/page`, {
						headers: { Authorization: `Bearer ${token}` }
					});

					if (!pageRes.ok) {
						const body = await pageRes.text();
						throw new Error(`Transkribus result fetch failed (${pageRes.status}): ${body}`);
					}

					const pageXml = await pageRes.text();
					const latencyMs = Math.round(performance.now() - start);
					const { text, lineCount } = extractTextFromPageXml(pageXml);

					return {
						text,
						confidence: null,
						latencyMs,
						vendorMeta: {
							processId,
							htrModelId,
							lineCount,
							sourceImagePath: input.sourceImagePath
						}
					};
				}

				if (status === 'FAILED') {
					throw new Error(`Transkribus processing failed (processId: ${processId})`);
				}
			}

			throw new Error(
				`Transkribus timed out after ${timeoutMs}ms (processId: ${processId})`
			);
		}
	};
}

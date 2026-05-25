import { CELL_PROMPT } from '../prompts.js';
import type { TranscribeInput, TranscribeOptions, TranscribeResult, VendorAdapter } from '../types.js';

export interface OllamaConfig {
	baseUrl?: string;
	model: string;
	timeoutMs?: number;
}

export function createOllamaAdapter(config: OllamaConfig): VendorAdapter {
	const baseUrl = (config.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
	const timeoutMs = config.timeoutMs ?? 120_000;

	return {
		vendorName: `ollama/${config.model}`,

		async transcribe(
			input: TranscribeInput,
			options?: TranscribeOptions
		): Promise<TranscribeResult> {
			const prompt = options?.prompt ?? CELL_PROMPT;
			const imageB64 = input.image.toString('base64');

			const start = performance.now();
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);

			try {
				const res = await fetch(`${baseUrl}/api/chat`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					signal: controller.signal,
					body: JSON.stringify({
						model: config.model,
						stream: false,
						messages: [
							{
								role: 'user',
								content: prompt,
								images: [imageB64]
							}
						]
					})
				});

				if (!res.ok) {
					const body = await res.text();
					throw new Error(`Ollama ${res.status}: ${body}`);
				}

				const data = await res.json();
				const latencyMs = Math.round(performance.now() - start);

				return {
					text: data.message?.content?.trim() ?? '',
					confidence: null,
					latencyMs,
					vendorMeta: {
						model: data.model ?? config.model,
						totalDuration: data.total_duration,
						evalCount: data.eval_count,
						evalDuration: data.eval_duration,
						promptEvalCount: data.prompt_eval_count,
						sourceImagePath: input.sourceImagePath
					}
				};
			} finally {
				clearTimeout(timer);
			}
		}
	};
}

export async function checkOllamaModel(
	model: string,
	baseUrl = 'http://127.0.0.1:11434'
): Promise<boolean> {
	try {
		const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/show`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: model })
		});
		return res.ok;
	} catch {
		return false;
	}
}

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
						stream: true,
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

				const chunks: string[] = [];
				let data: Record<string, unknown> = {};
				const reader = res.body!.getReader();
				const decoder = new TextDecoder();
				let buf = '';

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });
					const lines = buf.split('\n');
					buf = lines.pop()!;
					for (const line of lines) {
						if (!line.trim()) continue;
						const obj = JSON.parse(line);
						if (obj.message?.content) chunks.push(obj.message.content);
						if (obj.done) data = obj;
					}
				}

				const latencyMs = Math.round(performance.now() - start);

				return {
					text: chunks.join('').trim(),
					confidence: null,
					latencyMs,
					vendorMeta: {
						model: (data.model as string) ?? config.model,
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

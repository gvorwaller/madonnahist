import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { CELL_PROMPT } from '../prompts.js';
import type { TranscribeInput, TranscribeOptions, TranscribeResult, VendorAdapter } from '../types.js';

export interface ClaudeVisionConfig {
	apiKey: string;
	model?: string;
	maxTokens?: number;
}

const MAX_LONG_EDGE = 1568;

async function constrainImage(buf: Buffer): Promise<Buffer> {
	const meta = await sharp(buf).metadata();
	const w = meta.width!;
	const h = meta.height!;

	if (w <= MAX_LONG_EDGE && h <= MAX_LONG_EDGE) {
		return sharp(buf).jpeg({ quality: 95 }).toBuffer();
	}

	const opts = w >= h ? { width: MAX_LONG_EDGE } : { height: MAX_LONG_EDGE };
	return sharp(buf).resize(opts).jpeg({ quality: 95 }).toBuffer();
}

export function createClaudeVisionAdapter(config: ClaudeVisionConfig): VendorAdapter {
	const model = config.model ?? 'claude-sonnet-4-20250514';
	const maxTokens = config.maxTokens ?? 4096;
	const client = new Anthropic({ apiKey: config.apiKey });

	return {
		vendorName: `claude/${model}`,

		async transcribe(
			input: TranscribeInput,
			options?: TranscribeOptions
		): Promise<TranscribeResult> {
			const prompt = options?.prompt ?? CELL_PROMPT;
			const resized = await constrainImage(input.image);
			const imageB64 = resized.toString('base64');

			const start = performance.now();

			const response = await client.messages.create({
				model,
				max_tokens: maxTokens,
				messages: [
					{
						role: 'user',
						content: [
							{
								type: 'image',
								source: {
									type: 'base64',
									media_type: 'image/jpeg',
									data: imageB64
								}
							},
							{
								type: 'text',
								text: prompt
							}
						]
					}
				]
			});

			const latencyMs = Math.round(performance.now() - start);
			const text = response.content
				.filter((b): b is Anthropic.TextBlock => b.type === 'text')
				.map((b) => b.text)
				.join('\n')
				.trim();

			return {
				text,
				confidence: null,
				latencyMs,
				vendorMeta: {
					model: response.model,
					inputTokens: response.usage.input_tokens,
					outputTokens: response.usage.output_tokens,
					stopReason: response.stop_reason,
					sourceImagePath: input.sourceImagePath
				}
			};
		}
	};
}

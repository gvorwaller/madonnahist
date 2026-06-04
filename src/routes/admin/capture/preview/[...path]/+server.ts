/**
 * Image preview for /admin/capture. The requested path is validated against a
 * registered capture_intake row (never served from an arbitrary path) and the
 * resolved file must live under TETHER_DIR — see the path-security note in
 * docs/2026-05-29-capture-intake-pipeline.md.
 */
import { error } from '@sveltejs/kit';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, basename, extname, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, mkdir, rm, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { query } from '$lib/db';
import type { RequestHandler } from './$types';

const execFileAsync = promisify(execFile);

const TETHER_DIR = join(process.env.TETHER_DIR ?? join(process.env.HOME ?? '', 'Lumix Tether'));
const CACHE_DIR = join(process.env.HOME ?? '/root', '.cache', 'madonnahist-previews');

async function rw2ToJpeg(srcPath: string, destPath: string, maxDim: number): Promise<void> {
	const tmpDir = join(CACHE_DIR, 'ql-tmp');
	await mkdir(tmpDir, { recursive: true });
	const qlOut = join(tmpDir, basename(srcPath) + '.png');
	try {
		await execFileAsync('qlmanage', ['-t', '-s', String(maxDim), '-o', tmpDir, srcPath]);
		await execFileAsync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '90', qlOut, '--out', destPath]);
	} finally {
		if (existsSync(qlOut)) await rm(qlOut);
	}
}

export const GET: RequestHandler = async ({ params, url }) => {
	const relativePath = params.path;
	const requested = join(TETHER_DIR, relativePath);

	// Only serve files registered in capture_intake (source_path is relative to TETHER_DIR).
	const registered = await query<{ id: number }>(
		`SELECT id FROM capture_intake WHERE source_path = $1 LIMIT 1`,
		[relativePath]
	);
	if (registered.rows.length === 0) {
		error(404, 'Not a registered capture image');
	}

	// Containment: resolved path must live under TETHER_DIR (rejects symlink escapes).
	let real: string;
	let realTether: string;
	try {
		real = await realpath(requested);
		realTether = await realpath(TETHER_DIR);
	} catch {
		error(404, 'File not found');
	}
	if (real !== realTether && !real.startsWith(realTether + sep)) {
		error(403, 'Path outside tether directory');
	}

	const maxDim = Math.min(4000, Math.max(100, parseInt(url.searchParams.get('w') ?? '400', 10) || 400));
	const ext = extname(real).toLowerCase();

	if (ext === '.jpg' || ext === '.jpeg') {
		const sharp = (await import('sharp')).default;
		const buf = await readFile(real);
		const resized = await sharp(buf).rotate().resize({ width: maxDim, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
		return new Response(resized as unknown as BodyInit, {
			headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=60' }
		});
	}

	const hash = createHash('md5').update(`${real}:${maxDim}`).digest('hex');
	const cachePath = join(CACHE_DIR, `${hash}.jpg`);

	if (!existsSync(cachePath)) {
		await mkdir(CACHE_DIR, { recursive: true });
		await rw2ToJpeg(real, cachePath, maxDim);
	}

	const buf = await readFile(cachePath);
	return new Response(buf, {
		headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=60' }
	});
};

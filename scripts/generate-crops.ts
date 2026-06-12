/**
 * Bulk-generate pre-computed day-cell crop images for all pages that have
 * finalized grid_lines but are missing day_image_path entries.
 *
 * Usage: npx tsx --env-file=.env scripts/generate-crops.ts [--page-id=N] [--dry-run]
 *
 * Uses the app DB role (PGUSER from .env) since it needs UPDATE on calendar_days.
 */
import pg from 'pg';
import sharp from 'sharp';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

const { Pool } = pg;

const PAGE_ID_FLAG = process.argv.find(a => a.startsWith('--page-id='));
const TARGET_PAGE_ID = PAGE_ID_FLAG ? Number(PAGE_ID_FLAG.split('=')[1]) : null;
const DRY_RUN = process.argv.includes('--dry-run');

const pool = new Pool({
	host: process.env.PGHOST ?? '127.0.0.1',
	port: Number(process.env.PGPORT ?? 5435),
	database: process.env.PGDATABASE ?? 'madonnahist',
	user: process.env.PGUSER ?? 'madonnahist_app',
	password: process.env.PGPASSWORD,
	max: 2
});

function useLocal(): boolean {
	return process.env.MADONNAHIST_OBJECT_STORE === 'local';
}

function localRoot(): string {
	return resolve(process.cwd(), process.env.MADONNAHIST_LOCAL_OBJECT_STORE_DIR ?? '.local/object-store-test');
}

function localPath(key: string): string {
	const root = localRoot();
	const p = resolve(root, key);
	if (!p.startsWith(root + sep) && p !== root) throw new Error(`Key escapes root: ${key}`);
	return p;
}

let s3: { client: S3Client; bucket: string } | null = null;
async function getS3() {
	if (s3) return s3;
	const creds = await pool.query<{ credential_key: string; credential_value: string }>(
		`SELECT credential_key, credential_value FROM private_data.api_credentials
		  WHERE service_name = 'do_spaces' AND is_active = true`
	);
	const map = Object.fromEntries(creds.rows.map(r => [r.credential_key, r.credential_value]));
	s3 = {
		client: new S3Client({
			region: map.SPACES_REGION,
			endpoint: map.SPACES_ENDPOINT,
			credentials: { accessKeyId: map.SPACES_KEY, secretAccessKey: map.SPACES_SECRET },
			forcePathStyle: false
		}),
		bucket: map.SPACES_BUCKET
	};
	return s3;
}

async function download(key: string): Promise<Buffer> {
	if (useLocal()) return readFile(localPath(key));
	const { client, bucket } = await getS3();
	const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
	const chunks: Buffer[] = [];
	for await (const chunk of res.Body as AsyncIterable<Buffer>) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

async function upload(key: string, body: Buffer): Promise<void> {
	if (useLocal()) {
		const p = localPath(key);
		await mkdir(dirname(p), { recursive: true });
		await writeFile(p, body);
		return;
	}
	const { client, bucket } = await getS3();
	await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'image/jpeg', ACL: 'private' }));
}

async function deleteObj(key: string): Promise<void> {
	try {
		if (useLocal()) { await rm(localPath(key), { force: true }); return; }
		const { client, bucket } = await getS3();
		await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
	} catch { /* best-effort */ }
}

function cropKey(entryDate: string, gridVersion: number): string {
	const [year, mm] = entryDate.split('-');
	return `crops/${year}/${mm}/${entryDate}-v${gridVersion}.jpg`;
}

async function main() {
	const pages = TARGET_PAGE_ID
		? await pool.query<{
			id: number; year: number; month: number;
			page_image_path: string; warped_image_path: string | null; grid_version: number;
		}>(`SELECT cp.id, cp.year, cp.month, cp.page_image_path, cp.warped_image_path, cp.grid_version
		      FROM calendar_pages cp WHERE cp.id = $1 ORDER BY cp.year, cp.month`, [TARGET_PAGE_ID])
		: await pool.query<{
			id: number; year: number; month: number;
			page_image_path: string; warped_image_path: string | null; grid_version: number;
		}>(`SELECT cp.id, cp.year, cp.month, cp.page_image_path, cp.warped_image_path, cp.grid_version
		      FROM calendar_pages cp WHERE cp.grid_lines IS NOT NULL ORDER BY cp.year, cp.month`);

	console.log(`Found ${pages.rows.length} page(s) to process${DRY_RUN ? ' (dry run)' : ''}`);

	let totalGenerated = 0;
	let totalSkipped = 0;
	let totalErrors = 0;

	for (const page of pages.rows) {
		const days = await pool.query<{
			id: number; entry_date: string;
			crop_bounds: { x: number; y: number; width: number; height: number } | null;
			day_image_path: string | null;
		}>(`SELECT id, entry_date::text AS entry_date, crop_bounds, day_image_path
		      FROM calendar_days WHERE page_id = $1 AND crop_bounds IS NOT NULL ORDER BY entry_date`,
			[page.id]);

		const needsCrops = days.rows.filter(d => {
			const expected = cropKey(d.entry_date, page.grid_version);
			return d.day_image_path !== expected;
		});

		if (needsCrops.length === 0) {
			console.log(`  ${page.year}-${String(page.month).padStart(2, '0')}: all ${days.rows.length} crops current, skipping`);
			totalSkipped += days.rows.length;
			continue;
		}

		console.log(`  ${page.year}-${String(page.month).padStart(2, '0')}: ${needsCrops.length}/${days.rows.length} crops to generate`);

		if (DRY_RUN) {
			totalSkipped += days.rows.length - needsCrops.length;
			totalGenerated += needsCrops.length;
			continue;
		}

		const imageKey = page.warped_image_path ?? page.page_image_path;
		const raw = await download(imageKey);
		const normalized = await sharp(raw).rotate().toBuffer();

		for (const day of needsCrops) {
			const bounds = day.crop_bounds!;
			const key = cropKey(day.entry_date, page.grid_version);
			try {
				const cropBuffer = await sharp(normalized)
					.extract({ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height })
					.jpeg({ quality: 95 })
					.toBuffer();

				await upload(key, cropBuffer);
				await pool.query(`UPDATE calendar_days SET day_image_path = $2 WHERE id = $1`, [day.id, key]);

				if (day.day_image_path && day.day_image_path !== key) {
					await deleteObj(day.day_image_path);
				}

				totalGenerated++;
			} catch (err) {
				console.error(`    ERROR ${day.entry_date}: ${err instanceof Error ? err.message : err}`);
				totalErrors++;
			}
		}

		totalSkipped += days.rows.length - needsCrops.length;
	}

	console.log(`\nDone. Generated: ${totalGenerated}, Skipped: ${totalSkipped}, Errors: ${totalErrors}`);
	await pool.end();
}

main().catch(err => {
	console.error('Fatal:', err);
	process.exit(1);
});

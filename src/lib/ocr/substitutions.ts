import { query } from '$lib/db';

interface SubstitutionRule {
	pattern: string;
	replacement: string;
	source: 'notation_key' | 'correction_lexicon' | 'ocr_vocabulary';
}

export interface SubstitutionResult {
	dayId: number;
	entryDate: string;
	originalText: string;
	newText: string;
	rulesApplied: string[];
}

export interface SubstitutionSummary {
	processed: number;
	modified: number;
	skipped: number;
	results: SubstitutionResult[];
}

export async function loadSubstitutionRules(): Promise<SubstitutionRule[]> {
	const rules: SubstitutionRule[] = [];

	const notation = await query<{ input_shorthand: string; meaning: string }>(
		`SELECT input_shorthand, meaning FROM notation_key ORDER BY length(input_shorthand) DESC`
	);
	for (const row of notation.rows) {
		rules.push({
			pattern: row.input_shorthand,
			replacement: row.meaning,
			source: 'notation_key'
		});
	}

	const lexicon = await query<{ ocr_token: string; corrected_token: string; frequency: number }>(
		`SELECT ocr_token, corrected_token, frequency FROM correction_lexicon WHERE frequency >= 3 ORDER BY length(ocr_token) DESC`
	);
	for (const row of lexicon.rows) {
		rules.push({
			pattern: row.ocr_token,
			replacement: row.corrected_token,
			source: 'correction_lexicon'
		});
	}

	return rules;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAlphanumeric(s: string): boolean {
	return /^\w+$/.test(s);
}

export function applyRules(text: string, rules: SubstitutionRule[]): { text: string; applied: string[] } {
	const applied: string[] = [];
	let result = text;

	for (const rule of rules) {
		const escaped = escapeRegExp(rule.pattern);
		const needsBoundary = isAlphanumeric(rule.pattern);
		const pattern = needsBoundary ? `\\b${escaped}\\b` : escaped;
		const regex = new RegExp(pattern, 'gi');
		if (regex.test(result)) {
			applied.push(`${rule.pattern} → ${rule.replacement} (${rule.source})`);
			result = result.replace(regex, rule.replacement);
		}
	}

	return { text: result, applied };
}

export async function runSubstitutionPass(): Promise<SubstitutionSummary> {
	const rules = await loadSubstitutionRules();
	if (rules.length === 0) {
		return { processed: 0, modified: 0, skipped: 0, results: [] };
	}

	// Uncorrected days that have at least one LLM draft
	const days = await query<{
		day_id: number;
		entry_date: string;
		draft_id: number;
		draft_text: string;
	}>(
		`SELECT cd.id AS day_id, cd.entry_date::text AS entry_date,
		        ldr.id AS draft_id, ldr.draft_text
		   FROM calendar_days cd
		   JOIN llm_draft_runs ldr ON ldr.id = cd.latest_llm_draft_run_id
		  WHERE cd.correction_status IS DISTINCT FROM 'accepted'
		    AND cd.latest_llm_draft_run_id IS NOT NULL
		  ORDER BY cd.entry_date`
	);

	let modified = 0;
	const results: SubstitutionResult[] = [];

	for (const day of days.rows) {
		const { text: newText, applied } = applyRules(day.draft_text, rules);

		if (applied.length === 0 || newText === day.draft_text) continue;

		await query(
			`INSERT INTO llm_draft_runs (day_id, based_on_ocr_run_id, model_name, prompt_version, draft_text, confidence_note)
			 SELECT $1, based_on_ocr_run_id, 'substitution-pass', 'rules-v1', $2, $3
			   FROM llm_draft_runs WHERE id = $4`,
			[day.day_id, newText, `${applied.length} substitution(s) applied`, day.draft_id]
		);

		modified++;
		results.push({
			dayId: day.day_id,
			entryDate: day.entry_date,
			originalText: day.draft_text,
			newText,
			rulesApplied: applied
		});
	}

	return {
		processed: days.rows.length,
		modified,
		skipped: days.rows.length - modified,
		results
	};
}

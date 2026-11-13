import { aboutParagraphs, getAboutText } from '$server/about';
import type { PageServerLoad } from './$types';

/** "About this archive" (V3 Slice 1b): admin-edited text, or the default. */
export const load: PageServerLoad = async () => {
	const about = await getAboutText();
	return { paragraphs: aboutParagraphs(about.text) };
};

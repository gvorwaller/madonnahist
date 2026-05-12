// See https://svelte.dev/docs/kit/types#app
declare global {
	namespace App {
		interface Locals {
			user?: {
				id: string;
				username: string;
				role: 'admin' | 'corrector' | 'viewer';
				display_name: string | null;
			};
		}
	}
}

export {};

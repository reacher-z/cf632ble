import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
// vitest's defineConfig extends vite's with the `test` field.
import { defineConfig } from 'vitest/config';

// GitHub Pages project sites are served from https://<user>.github.io/<repo>/, so the app must be
// built with that sub-path as its base. The deploy workflow sets BASE_PATH (e.g. "/cf632ble-web").
// For a user/org page (https://<user>.github.io/) leave BASE_PATH unset/empty.
const base = (process.env.BASE_PATH ?? '') as '' | `/${string}`;

export default defineConfig(({ command }) => ({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// Static adapter: prerender the whole app to plain files for GitHub Pages.
			// fallback: '404.html' makes GH Pages serve the SPA shell for unknown paths.
			adapter: adapter({ fallback: '404.html' }),
			paths: { base }
		}),
		// Self-signed HTTPS for `vite dev`/`vite preview` — Web Bluetooth needs a secure context,
		// and `localhost` already counts as one, but testing from another device (e.g. a phone) over
		// the LAN hits it by IP, which only Chrome accepts as secure with real TLS. Only loaded for
		// those two commands: `vite build` uses command 'build', and vitest also resolves its config
		// with command 'serve' (same as dev), so it's excluded via VITEST too — otherwise the plugin's
		// `configResolved` hook would generate/read a cert on every build and test run for nothing.
		...(command === 'serve' && !process.env.VITEST ? [basicSsl()] : [])
	],
	// Under vitest only, resolve Svelte's browser build so component render tests can mount
	// components (happy-dom). This never affects `npm run build` (VITEST is unset there).
	resolve: process.env.VITEST ? { conditions: ['browser'] } : {},
	test: {
		// Pure-logic tests run in node; files that need a DOM opt in with
		// `// @vitest-environment happy-dom` at the top (e.g. component render tests).
		include: ['src/**/*.{test,spec}.{js,ts}'],
		environment: 'node'
	}
}));

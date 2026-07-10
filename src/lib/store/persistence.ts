/**
 * Tiny typed localStorage layer + a persisted Svelte store helper.
 *
 * Only profile + measurements are persisted here (small, bounded — a weigh-in is a few hundred
 * bytes, well within the ~5MB localStorage quota). BLE traffic is deliberately NOT persisted (see
 * traffic-log.ts). All access is browser-guarded so prerender/SSR never touches localStorage.
 */

import { writable, type Writable } from 'svelte/store';
import { browser } from '$app/environment';

/** Bump when the persisted shape changes incompatibly (add a migration in `loadJson` then). */
export const SCHEMA_VERSION = 1;

const PREFIX = 'cf632.';

export function loadJson<T>(key: string, fallback: T): T {
	if (!browser) return fallback;
	try {
		const raw = localStorage.getItem(PREFIX + key);
		if (raw === null) return fallback;
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

export function saveJson<T>(key: string, value: T): void {
	if (!browser) return;
	try {
		localStorage.setItem(PREFIX + key, JSON.stringify(value));
	} catch {
		/* quota/serialization error — non-fatal */
	}
}

export function removeKey(key: string): void {
	if (!browser) return;
	try {
		localStorage.removeItem(PREFIX + key);
	} catch {
		/* ignore */
	}
}

/** Wipes every key this app has written to localStorage (profile, measurements, theme, …). */
export function clearAllData(): void {
	if (!browser) return;
	const keys: string[] = [];
	for (let i = 0; i < localStorage.length; i++) {
		const k = localStorage.key(i);
		if (k?.startsWith(PREFIX)) keys.push(k);
	}
	keys.forEach((k) => removeKey(k.slice(PREFIX.length)));
}

/**
 * A writable store that hydrates from localStorage on creation and re-persists on every change.
 * `merge` lets a store reconcile a stored value with defaults (e.g. new fields added to Profile).
 */
export function persistedStore<T>(
	key: string,
	initial: T,
	merge: (stored: T, initial: T) => T = (stored) => stored
): Writable<T> {
	const start = browser ? merge(loadJson<T>(key, initial), initial) : initial;
	const store = writable<T>(start);
	if (browser) {
		store.subscribe((value) => saveJson(key, value));
	}
	return store;
}

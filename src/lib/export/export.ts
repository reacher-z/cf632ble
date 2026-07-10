/** Data export: all persisted data → JSON file, plus a shared browser download helper. */

import { get } from 'svelte/store';
import { SCHEMA_VERSION } from '$lib/store/persistence';
import { profile } from '$lib/store/profile';
import { measurements } from '$lib/store/measurements';

/** Trigger a browser download of `text` as `filename`. */
export function downloadBlob(filename: string, mime: string, text: string): void {
	const blob = new Blob([text], { type: mime });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	// Revoke on the next tick so the click has a chance to start the download.
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

function timestampSlug(): string {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Serialize profile + all measurements to a single pretty-JSON string. */
export function serializeAllData(): string {
	return JSON.stringify(
		{
			kind: 'cf632ble-data',
			schemaVersion: SCHEMA_VERSION,
			exportedAt: new Date().toISOString(),
			profile: get(profile),
			measurements: get(measurements)
		},
		null,
		2
	);
}

/** Export everything (profile + measurements) as a downloaded JSON file. */
export function exportAllData(): void {
	downloadBlob(
		`cf632-data-${timestampSlug()}.json`,
		'application/json',
		serializeAllData()
	);
}

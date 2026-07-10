/**
 * In-memory, session-only BLE traffic log. Holds every GATT write / notification / lifecycle event
 * for the *current* connection so it can be viewed live in the debug panel and exported to a file.
 *
 * By design this is NEVER persisted to localStorage — it's reset on each connect and lives only in
 * memory (a capped ring buffer). Exporting writes it to a downloaded file on demand.
 */

import { writable } from 'svelte/store';
import { bytesToHex } from './protocol';

export type TrafficDir = 'tx' | 'rx' | 'event';
export type TrafficChar = 'FFF1' | 'FFF2' | 'FFF3' | 'battery' | 'devinfo' | '-';

export interface TrafficEntry {
	/** milliseconds since the current session/connect started */
	tMs: number;
	dir: TrafficDir;
	char: TrafficChar;
	/** space-separated hex of the payload ('' for pure lifecycle events) */
	hex: string;
	/** optional decoded meaning, e.g. "time-sync" or "0x01 weight=71.65kg complete" */
	note?: string;
}

const MAX_ENTRIES = 10_000;

export const trafficLog = writable<TrafficEntry[]>([]);

let sessionStart = 0;
let buffer: TrafficEntry[] = [];

/** Start a fresh session: clear the log and reset the relative-time origin. */
export function resetTraffic(): void {
	sessionStart = performance.now();
	buffer = [];
	trafficLog.set(buffer);
}

/** Append an entry. `data` may be raw bytes (hex is computed) or omitted for lifecycle events. */
export function logTraffic(
	dir: TrafficDir,
	char: TrafficChar,
	data?: Uint8Array | null,
	note?: string
): void {
	if (sessionStart === 0) sessionStart = performance.now();
	const entry: TrafficEntry = {
		tMs: Math.round(performance.now() - sessionStart),
		dir,
		char,
		hex: data && data.length ? bytesToHex(data) : '',
		note
	};
	// Ring-buffer: drop the oldest if over cap. Reassign a new array so the store update is seen.
	buffer = buffer.length >= MAX_ENTRIES ? [...buffer.slice(1), entry] : [...buffer, entry];
	trafficLog.set(buffer);
}

/** Current entries (non-reactive snapshot), for export. */
export function snapshotTraffic(): TrafficEntry[] {
	return buffer;
}

/** Serialize the current session's traffic as pretty JSON. */
export function exportTrafficJson(): string {
	return JSON.stringify(
		{
			kind: 'cf632ble-ble-traffic',
			exportedAt: new Date().toISOString(),
			entryCount: buffer.length,
			entries: buffer
		},
		null,
		2
	);
}

/** Serialize as a human-readable text log (one line per entry). */
export function exportTrafficText(): string {
	const dirLabel: Record<TrafficDir, string> = { tx: 'TX  ', rx: 'RX  ', event: 'EVT ' };
	return buffer
		.map((e) => {
			const t = `t=+${(e.tMs / 1000).toFixed(3)}s`.padEnd(12);
			const line = `${t} ${dirLabel[e.dir]} ${e.char.padEnd(8)} ${e.hex}`;
			return e.note ? `${line.trimEnd()}  # ${e.note}` : line.trimEnd();
		})
		.join('\n');
}

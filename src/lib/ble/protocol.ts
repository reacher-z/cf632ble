/**
 * CF632BLE ("Borre" family) BLE protocol — UUIDs, command builders, and F3 frame parser.
 *
 * Direct TypeScript port of `poc/cf632ble/protocol.py` (live-validated against real hardware,
 * see RE-NOTES §12.9). Byte layouts here are the "plain Borre" (`deviceCalcuteType == Direct`)
 * path used by CF632BLE specifically. See RE-NOTES §12–§13 for the full write-up and the Ghidra
 * function references each function is based on.
 *
 * All values are plain `Uint8Array`s. Where the Python builds an ASCII-hex string then converts to
 * bytes, we build the bytes directly.
 */

/** Expand a 16-bit short UUID to the full Bluetooth SIG base UUID string (lower-case). */
export function uuid16(short: number): string {
	return `0000${short.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
}

// --- GATT topology (RE-NOTES §12.2) ------------------------------------------------------------
export const SERVICE_FFF0 = uuid16(0xfff0); // vendor service (contains F1/F2/F3)
export const CHAR_FFF1 = uuid16(0xfff1); // control/config write + command-response notify
export const CHAR_FFF2 = uuid16(0xfff2); // bulk data write (user profile / history) + notify
export const CHAR_FFF3 = uuid16(0xfff3); // real-time measurement notify (weight + impedance)

export const SERVICE_BATTERY = uuid16(0x180f);
export const CHAR_BATTERY_LEVEL = uuid16(0x2a19);
export const SERVICE_DEVICE_INFO = uuid16(0x180a);

/**
 * Device.json lists deviceName "CF632BLE" plus aliases CF632/LEFU-CF632/CF6321/etc. (RE-NOTES §3).
 * The FFF0 service UUID is NOT advertised (only visible after connecting), so scanning matches on
 * the advertised name prefix. The physical unit advertises as "CF632BLE".
 */
export const ADVERTISED_NAME_PREFIX = 'CF632';

// --- Byte / hex helpers ------------------------------------------------------------------------

/** Uint8Array → space-separated lower-case hex string (for logging). */
export function bytesToHex(data: Uint8Array, sep = ' '): string {
	return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join(sep);
}

/** Parse a hex string (with or without separators) into a Uint8Array. */
export function hexToBytes(hex: string): Uint8Array {
	const clean = hex.replace(/[^0-9a-fA-F]/g, '');
	const out = new Uint8Array(clean.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

/** Little-endian uint16 from two bytes. */
function le16(lo: number, hi: number): number {
	return (lo | (hi << 8)) & 0xffff;
}

/** Two-byte little-endian encoding of a uint16 value. */
function u16le(value: number): [number, number] {
	return [value & 0xff, (value >> 8) & 0xff];
}

/**
 * Port of `ByteUtil.decimal2Hex` (classes5 0x5029773c): plain hex digits of `value`, left-padded
 * with a single '0' if the result has an odd number of hex digits (so it maps to a whole number of
 * bytes). NOT the same as zero-padding to a fixed width. Returns the resulting bytes.
 */
export function decimal2hexBytes(value: number): Uint8Array {
	let h = value.toString(16);
	if (h.length % 2) h = '0' + h;
	return hexToBytes(h);
}

// --- Command builders (RE-NOTES §12.4) ---------------------------------------------------------

/**
 * Opcode 0xF1 — set device time (`PPBleSender.sendSyncTimeCommand`, classes3 0x501e4b54).
 * No explicit length byte: 'F1' + hex(year)+hex(month)+hex(day)+hex(hour)+hex(min)+hex(sec).
 * Year is 3–4 hex digits (e.g. 2026 -> '07EA'), so this is normally 8 bytes: F1 YY YY MM DD HH mm SS.
 * Written on FFF1.
 */
export function buildTimeSyncCommand(when: Date = new Date()): Uint8Array {
	const parts = [
		when.getFullYear(),
		when.getMonth() + 1, // JS months are 0-based
		when.getDate(),
		when.getHours(),
		when.getMinutes(),
		when.getSeconds()
	];
	const chunks: Uint8Array[] = [Uint8Array.of(0xf1)];
	for (const v of parts) chunks.push(decimal2hexBytes(v));
	return concatBytes(chunks);
}

/**
 * Opcode 0x2C — impedance measurement on/off (`kx8.controlImpedance2`, `H`).
 * '2C020101' = on, '2C020100' = off. Written on FFF1.
 */
export function buildImpedanceControlCommand(enable: boolean): Uint8Array {
	return Uint8Array.of(0x2c, 0x02, 0x01, enable ? 0x01 : 0x00);
}

/**
 * Opcode 0x45 — get/set RGB/LED display mode (`s50.getRGBMode`). Written on FFF1.
 * Exact meaning of `mode` byte values not decoded; 0x00 mirrors the observed '450100'. (Optional.)
 */
export function buildRgbModeCommand(mode = 0x00): Uint8Array {
	return Uint8Array.of(0x45, 0x01, mode & 0xff);
}

/**
 * Opcode 0x05 — announce an upcoming user-profile push (`kx8.sendCurrentUserForMeasurement_l1`,
 * classes5 0x5025916c). '05 03 06' + LE16(payloadLen); observed as '0503068000' (len=128, the
 * userIdHeader length used by `j70.z`). Written on FFF2, before the chunked profile push.
 * The scale ACKs with '05 02 06 00' on FFF2 (RE-NOTES §12.9).
 */
export function buildUserAnnounceCommand(payloadLen = 128): Uint8Array {
	return Uint8Array.of(0x05, 0x03, 0x06, ...u16le(payloadLen));
}

/**
 * Opcode 0x24 — "startMeasure" (`kx8.C2`, classes5 0x5025aa20). Sends bare '2400' on FFF1.
 * REQUIRED to trigger a fresh BIA cycle — without it you may only ever see a stale/cached reading
 * (RE-NOTES §18). Ack: FFF1 '24 <resultcode>'.
 */
export function buildStartMeasurementCommand(): Uint8Array {
	return Uint8Array.of(0x24, 0x00);
}

/**
 * Opcode 0x0A — trigger weight-trend/history upload (`syncUser14DayWeightStart`, `s50.w3`).
 * Two observed variants; which one plain Borre/CF632 uses is unconfirmed (RE-NOTES §12.8).
 * Exposed for experimentation; not used by default. (Optional.)
 */
export function buildHistoryTriggerCommand(variant: 'A' | 'B' = 'A'): Uint8Array {
	return variant === 'A' ? hexToBytes('0A0301EB00') : hexToBytes('0A0301F700');
}

// --- User profile (RE-NOTES §13.2) -------------------------------------------------------------

export enum Sex {
	FEMALE = 0,
	MALE = 1
}

export interface UserProfileInput {
	ageYears: number;
	sex: Sex;
	heightCm: number;
	/** on-scale member slot ("P-index"), 1..N */
	pIndex?: number;
	athlete?: boolean;
	/** seed / last-known weight (kg) */
	weightKg?: number;
}

/**
 * `j70.buildUserProfile_plainBorre_z` (classes5 0x50129a14): 128B userIdHeader + age(1) + sex(1) +
 * height LE16(2) + userIndexByte(1) + weight LE16 kg*100(2) = 135 bytes.
 *
 * Only the anonymous case (empty user_id/member_id -> 128 zero bytes) is implemented; RE-NOTES
 * §13.2 confirms that's fine for a standalone client — the scale keys the member off `pIndex`, not
 * the header. Weight uses a Java `(int)` cast, which TRUNCATES (`Math.trunc`), not rounds.
 */
export function buildUserProfilePayload(p: UserProfileInput): Uint8Array {
	const pIndex = p.pIndex ?? 1;
	const athlete = p.athlete ?? false;
	const weightKg = p.weightKg ?? 70.0;

	const payload = new Uint8Array(135);
	// bytes 0..127 are the zero userIdHeader (already zero-filled).
	payload[128] = p.ageYears & 0xff;
	payload[129] = p.sex & 0xff; // 0x01 = Male, 0x00 = Female
	const [hLo, hHi] = u16le(p.heightCm & 0xffff);
	payload[130] = hLo;
	payload[131] = hHi;
	payload[132] = ((pIndex & 0x7f) << 1) | (athlete ? 1 : 0);
	const weightCentiKg = Math.trunc((weightKg + 0.005) * 100.0);
	const [wLo, wHi] = u16le(weightCentiKg & 0xffff);
	payload[133] = wLo;
	payload[134] = wHi;
	return payload;
}

/**
 * `chunkPayloadForMtu_00seq`: split a bulk (F2) payload into `[0x00][seqIndex][data...]` chunks.
 * `chunkSize` is the data-only portion per chunk; default 18 assumes the default (unnegotiated) ATT
 * MTU of 23 bytes (20 usable − 2 header bytes). Web Bluetooth has no MTU API, so keep 18.
 */
export function chunkPayload(payload: Uint8Array, chunkSize = 18): Uint8Array[] {
	const chunks: Uint8Array[] = [];
	for (let i = 0; i < payload.length; i += chunkSize) {
		const seq = Math.floor(i / chunkSize);
		const slice = payload.subarray(i, i + chunkSize);
		const chunk = new Uint8Array(2 + slice.length);
		chunk[0] = 0x00;
		chunk[1] = seq & 0xff;
		chunk.set(slice, 2);
		chunks.push(chunk);
	}
	return chunks;
}

// --- F3 measurement-frame parsing (RE-NOTES §12.5.1) -------------------------------------------

export interface MeasurementFrame {
	subCommand: number;
	raw: Uint8Array;
	status1: number | null;
	status2: number | null;
	weightKg: number | null;
	/** plaintext impedance from the 0x01 frame — dead code for CF632, kept for completeness. */
	impedanceOhm: number | null;
	impedance2Ohm: number | null;
	/** decoded 50kHz impedance from a 0x02 frame (the real BIA input). */
	z50khzOhm: number | null;
	/** decoded 100kHz impedance from a 0x02 frame (byte3==2 dual-frequency case only). */
	z100khzOhm: number | null;
	measurementComplete: boolean;
	stable: boolean;
	leaveScale: boolean;
	overweight: boolean;
	note: string | null;
}

const BH13_NO_READING = 0xffff;

/**
 * Port of the native `Bh13DecodeImpedance` (`libbh3BodyComposition.so` 0x1266b0, RE-NOTES §16.3) —
 * decodes an F3 `0x02` frame's per-channel 32-bit "encoded" field into real ohms. A reversible
 * byte-scramble, not real cryptography (verified byte-for-byte against a live-captured frame).
 * Uses C truncating integer division (`Math.trunc`), NOT floor.
 */
export function decodeImpedanceBh13(encoded: number): number {
	if (encoded === 0xffffff) return BH13_NO_READING;
	const b0 = encoded & 0xff;
	const b1Lo = encoded & 0xf00;
	const b1Hi = (encoded & 0xf000) >> 12;
	const b2 = (encoded >> 16) & 0xff;
	return Math.trunc((b1Lo + b2 - b1Hi - 4 * b0) / 2);
}

/** Little-endian uint32 from 4 bytes at `offset`. */
function u32le(data: Uint8Array, offset: number): number {
	return (
		(data[offset] |
			(data[offset + 1] << 8) |
			(data[offset + 2] << 16) |
			(data[offset + 3] << 24)) >>>
		0
	);
}

function emptyFrame(sub: number, raw: Uint8Array): MeasurementFrame {
	return {
		subCommand: sub,
		raw,
		status1: null,
		status2: null,
		weightKg: null,
		impedanceOhm: null,
		impedance2Ohm: null,
		z50khzOhm: null,
		z100khzOhm: null,
		measurementComplete: false,
		stable: false,
		leaveScale: false,
		overweight: false,
		note: null
	};
}

/**
 * Decode an FFF3 notification per `jk6::V` (dispatch) / `jk6::K` (weight+status+impedance parser),
 * for the plain-Borre 'Direct'-calc-type path used by CF632BLE.
 *
 * Sub-commands 0x0D / 0x01 / 0x11 carry weight+status+(plaintext) impedance and are fully decoded.
 * 0x02 carries the real dual-frequency encoded impedance (the BIA input). Others (0x16 error, 0x03
 * status, 0x04 gsensor, 0x05 history-available, 0x06 user-selection) are flagged via `note` only.
 */
export function parseF3Frame(data: Uint8Array): MeasurementFrame {
	if (data.length === 0) throw new Error('empty F3 frame');

	const sub = data[0];
	const frame = emptyFrame(sub, data.slice());

	if (sub === 0x0d || sub === 0x01 || sub === 0x11) {
		if (data.length < 6) {
			frame.note = `frame too short for weight/status (${data.length} bytes)`;
			return frame;
		}
		const status1 = data[2];
		const status2 = data[3];
		const weightRaw = le16(data[4], data[5]); // hundredths of kg

		frame.status1 = status1;
		frame.status2 = status2;
		frame.weightKg = weightRaw / 100.0;
		// Priority-encoded 2-bit weight-state (RE-NOTES §12.5.1): leave-scale needs BOTH bit2+bit3
		// set (& 0x0C == 0x0C), not "either bit". A bit2-only frame is "stable/locked", not leave.
		frame.leaveScale = (status1 & 0x0c) === 0x0c;
		frame.overweight = !frame.leaveScale && (status1 & 0x08) !== 0;
		frame.stable = !frame.leaveScale && !frame.overweight && (status1 & 0x04) !== 0;
		frame.measurementComplete = (status2 & 0x80) !== 0;

		if (data.length >= 12) {
			frame.impedanceOhm = le16(data[10], data[11]) / 10.0;
		}
		if (data.length >= 14) {
			frame.impedance2Ohm = le16(data[12], data[13]) / 10.0;
		}
	} else if (sub === 0x16) {
		frame.note = 'impedance measurement failure frame (electrode error bitmask undecoded here)';
	} else if (sub === 0x02) {
		// RE-NOTES §16.3/§18: byte3 selects the branch. byte3==1/2 is the 4-electrode case CF632BLE
		// uses: encoded 50kHz Z is bytes 4-7, encoded 100kHz Z (dual-frequency only) is bytes 8-11.
		// BYTE ORDER = LITTLE-ENDIAN (the app's `py8_c` reverses before hex->int); reading it
		// big-endian was an earlier bug that produced garbage (RE-NOTES §18).
		const freqKind = data.length > 3 ? data[3] : null;
		if (data.length >= 8) {
			frame.z50khzOhm = decodeImpedanceBh13(u32le(data, 4));
		}
		if (freqKind === 2 && data.length >= 12) {
			frame.z100khzOhm = decodeImpedanceBh13(u32le(data, 8));
		}
		if (freqKind === 2) {
			frame.note = 'dual-frequency 4-electrode encoded impedance (z50khzOhm + z100khzOhm)';
		} else if (freqKind === 1) {
			frame.note = 'single-frequency 4-electrode encoded impedance (z50khzOhm)';
		} else {
			frame.note = '8-electrode segmental encoded impedance frame (not decoded here)';
		}
	} else {
		frame.note = `sub-command 0x${sub.toString(16).padStart(2, '0')} not decoded by this parser`;
	}

	return frame;
}

// --- misc --------------------------------------------------------------------------------------

/** Concatenate a list of Uint8Arrays. */
export function concatBytes(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

/**
 * CF632BLE ("Borre" family) BLE protocol — UUIDs, command builders, and F3 frame parser.
 *
 * Direct TypeScript port of `poc/cf632ble/protocol.py` (live-validated against real hardware,
 * see BLE-PROTOCOL.md). Byte layouts here are the "plain Borre" (`deviceProtocolType == 5`) path
 * used by CF632BLE specifically — note its body-composition calc type is `Alternate4_1` (10), NOT
 * `Direct`; that is exactly why the real impedance arrives in a separate 0x02 frame rather than in
 * the 0x01 weight frame's plaintext field (§6). See BLE-PROTOCOL.md for the full write-up and the
 * Ghidra function references each function is based on.
 *
 * All values are plain `Uint8Array`s. Where the Python builds an ASCII-hex string then converts to
 * bytes, we build the bytes directly.
 */

/** Expand a 16-bit short UUID to the full Bluetooth SIG base UUID string (lower-case). */
export function uuid16(short: number): string {
	return `0000${short.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
}

// --- GATT topology (BLE-PROTOCOL.md) ------------------------------------------------------------
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

// --- Command builders (BLE-PROTOCOL.md) ---------------------------------------------------------

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
 * Opcode 0x2C — impedance measurement on/off (`kx8_controlImpedance_0x2C_H`).
 * '2C020101' = on, '2C020100' = off. Written on FFF1.
 *
 * **Dead SDK surface — use {@link buildBodyFatModuleCommand} (0x07) instead.** `0x2C` has no
 * callers anywhere in the vendor app, so it is not something the app ever sends; the scale accepts
 * it, but the real body-fat/BIA toggle is 0x07 (BLE-PROTOCOL.md §4). Nothing in this app calls
 * this — it is kept as a documented builder so the opcode stays reachable for an experiment, and
 * so the next person to find `2C020101` in an old capture can tell what it was.
 */
export function buildImpedanceControlCommand(enable: boolean): Uint8Array {
	return Uint8Array.of(0x2c, 0x02, 0x01, enable ? 0x01 : 0x00);
}

/**
 * Opcode 0x06 — **heart-rate measurement module on/off**, a persistent device setting
 * (`kx8::F` set / `kx8::l0` get; named from its caller `getMeasureHeartRateModuleSwitch`).
 * `GET 06020200`, `SET 06020100` (on) / `06020101` (off). Written on FFF1. BLE-PROTOCOL.md §4.
 *
 * Note the inverted value byte — same convention as the body-fat sibling below, where the
 * evidence is written up.
 */
export function buildHeartRateModuleCommand(enable?: boolean): Uint8Array {
	if (enable === undefined) return Uint8Array.of(0x06, 0x02, 0x02, 0x00);
	return Uint8Array.of(0x06, 0x02, 0x01, enable ? MODULE_ON_VALUE : MODULE_OFF_VALUE);
}

/**
 * The value byte meaning "enabled" in a module SET — **zero, not one.**
 *
 * The reply direction is proven inverted (see {@link parseModuleReply}); the request direction is
 * inferred from that plus one live observation: sending `07020101` was acked "accepted" and the
 * module then read back *off*, and the scale did a weight-only measurement with no impedance frame
 * at all. An earlier revision of this file had these the other way round, so its "turn on" button
 * silently turned the module off. BLE-PROTOCOL.md §4.1.
 */
const MODULE_ON_VALUE = 0x00;
const MODULE_OFF_VALUE = 0x01;

/**
 * Opcode 0x07 — **body-fat (impedance/BIA) measurement module on/off**, the sibling persistent
 * setting to heart rate (`kx8::G` set / `kx8::m0` get, from `getMeasureBodyFatModuleSwitch`).
 * `GET 07020200`, `SET 07020100` (on) / `07020101` (off). Written on FFF1.
 *
 * **This switch gates BIA entirely.** With it off the scale streams weight only — no `0x02`
 * impedance frame — so every reading degrades to weight-with-no-body-composition. Live-observed.
 *
 * The vendor app sends the GET during connection bring-up (BLE-PROTOCOL.md §2 step 4) — that, not
 * 0x2C. It never sends the SET for this device family, which is why the value polarity had to be
 * established from the reply encoding plus hardware.
 */
export function buildBodyFatModuleCommand(enable?: boolean): Uint8Array {
	if (enable === undefined) return Uint8Array.of(0x07, 0x02, 0x02, 0x00);
	return Uint8Array.of(0x07, 0x02, 0x01, enable ? MODULE_ON_VALUE : MODULE_OFF_VALUE);
}

/**
 * Opcode 0x1C — get/set the device-bound flag (`kx8_deviceBindStatus_0x1C_Q`). `GET 1C020200`,
 * `SET 1C020101` (bound) / `1C020100` (unbound). Written on FFF1. BLE-PROTOCOL.md §7.
 *
 * SET-unbound is **not** a factory reset: live-tested, it flips the flag and leaves the stored
 * member list completely intact.
 */
export function buildDeviceBindStatusCommand(bound?: boolean): Uint8Array {
	if (bound === undefined) return Uint8Array.of(0x1c, 0x02, 0x02, 0x00);
	return Uint8Array.of(0x1c, 0x02, 0x01, bound ? 0x01 : 0x00);
}

/**
 * Decoded reply to a measurement-module opcode — heart rate `0x06` or body fat `0x07`.
 * Frame: `<opcode> LL <marker> <value>`. BLE-PROTOCOL.md §4.
 *
 * **Two traps, both of which this app fell into before the reply handler was decompiled:**
 *
 * 1. `marker` (byte 2) says which question is being answered: `1` = "your SET was processed",
 *    `2` = "here is the current state". A SET ack's `value` is a *status*, not a state — reading
 *    it as one makes a successful "turn on" look like "off".
 * 2. **The polarity is inverted relative to the request.** You turn the module on by sending
 *    `…0101` (value byte 1), but the scale reports "on" as value byte **0**. Zero means
 *    success/on in the reply; non-zero means failure/off.
 *
 * Ground truth: `b16e_onBodyFatModuleReply_0x07_0x2C_c` (classes5 `0x501eb8c8`) and its heart-rate
 * sibling `0x501ebb30` — the vendor's own log strings print "is on" exactly when the byte is 0.
 */
export interface ModuleReply {
	opcode: 0x06 | 0x07;
	/** true when this answers a SET (marker 1); false when it reports state (marker 2). */
	isSetAck: boolean;
	/** For a SET ack: did it succeed. For a state report: is the module on. */
	ok: boolean;
	raw: number;
}

/** Parse an FFF1 notification as a 0x06/0x07 module reply; null if it isn't one. */
export function parseModuleReply(data: Uint8Array): ModuleReply | null {
	if (data.length < 4) return null;
	if (data[0] !== 0x06 && data[0] !== 0x07) return null;
	const marker = data[2];
	if (marker !== 1 && marker !== 2) return null;
	return {
		opcode: data[0] as 0x06 | 0x07,
		isSetAck: marker === 1,
		ok: data[3] === 0,
		raw: data[3]
	};
}

/** Decoded 0x1C response: `1C LL <echoedType> <boundRaw>`. */
export interface DeviceBindStatus {
	/** Echoes the *request's* type byte (01 = SET response, 02 = GET response). Carries no bind
	 * information — an earlier revision of the protocol doc read it as the state and got the SET
	 * case backwards. */
	echoedType: number;
	boundRaw: number;
	bound: boolean;
}

/** Parse an FFF1 notification as a 0x1C bind-status response; null if it isn't one. */
export function parseDeviceBindStatus(data: Uint8Array): DeviceBindStatus | null {
	if (data.length < 4 || data[0] !== 0x1c) return null;
	return { echoedType: data[2], boundRaw: data[3], bound: data[3] !== 0 };
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
 * The scale ACKs with '05 02 06 00' on FFF2 (BLE-PROTOCOL.md).
 */
export function buildUserAnnounceCommand(payloadLen = 128): Uint8Array {
	return Uint8Array.of(0x05, 0x03, 0x06, ...u16le(payloadLen));
}

/**
 * Opcode 0x05 subcmd 0x01 — **the real profile-registration announce** (`s50::c3`, classes5
 * 0x50127a10). `05 03 01` + LE16(135). The scale replies `05 02 01 00`, which gates sending the
 * 135-byte profile.
 *
 * Do not confuse with `buildUserAnnounceCommand` (subcmd 0x06), which declares 128 bytes and must
 * be followed by the identity header *alone* — it identifies who is on the scale right now and does
 * not create a persistent member. See BLE-PROTOCOL.md §5.1.1 vs §5.1.2.
 */
export function buildSyncUserInfoCommand(payloadLen = 135): Uint8Array {
	return Uint8Array.of(0x05, 0x03, 0x01, ...u16le(payloadLen));
}

/**
 * Opcode 0x05 subcmd 0x03 — announce a member deletion (`kx8_sendDeleteUser_0x05_03_O`).
 * `05 03 03` + LE16(128); `0503038000`. Written on FFF2. BLE-PROTOCOL.md §5.1.2a, live-verified.
 *
 * The declared length is the 128-byte identity header alone — a delete is keyed entirely on
 * `memberId`, never on pIndex.
 */
export function buildDeleteUserCommand(payloadLen = 128): Uint8Array {
	return Uint8Array.of(0x05, 0x03, 0x03, ...u16le(payloadLen));
}

/** Result subcmds to declare in `buildTransferCompleteCommand`, per operation. */
export const SUBCMD_RESULT_SYNC_USER_INFO = 0x02;
export const SUBCMD_RESULT_DELETE_USER = 0x04;
export const SUBCMD_RESULT_CURRENT_USER = 0x07;

/**
 * **`05 01 <resultSubcmd>` — the transfer-complete frame. MANDATORY after every chunked FFF2
 * upload.** BLE-PROTOCOL.md §5.1.7.
 *
 * Every chunked upload is `announce → confirm → chunks → complete → result`. Omit this frame and the
 * scale never learns the payload ended: it keeps waiting for more bytes and returns **no result at
 * all** — not even the `status=0xFF` length-mismatch error. That silent failure is what made
 * registration appear impossible for four investigation sessions.
 *
 * In the vendor app the frame is written by the send-completion callback handed *into*
 * `kx8_sendListOnF2Char_t1`, not by the response dispatcher — registration `s50$c` → `kx8..._u2`
 * (`050102`), delete `kx8$e` → `kx8..._N` (`050104`), confirmCurrentUser `kx8$k` → `kx8..._k1`
 * (`050107`). The 0x0A history push has its own variant, `0A0102`.
 */
export function buildTransferCompleteCommand(resultSubcmd: number): Uint8Array {
	return Uint8Array.of(0x05, 0x01, resultSubcmd & 0xff);
}

/** `0A0102` — transfer-complete for the 0x0A weight-history push (`kx8..._x2`). */
export function buildHistoryTransferCompleteCommand(): Uint8Array {
	return Uint8Array.of(0x0a, 0x01, 0x02);
}

/** `05020501` — client-side ACK of a completed member-list transfer (`kx8..._g3`). Optional: not
 * required for later operations to succeed, but it is what the app sends. BLE-PROTOCOL.md §5.2. */
export function buildMemberListAckCommand(): Uint8Array {
	return Uint8Array.of(0x05, 0x02, 0x05, 0x01);
}

/**
 * `05020500` on FFF2 — request the scale's stored member list (`kx8_readMemberList_L0`).
 * BLE-PROTOCOL.md §5.2, live-verified.
 *
 * The response arrives as plain `[0x00][seq][data]` chunks accumulating into one payload
 * ({@link parseMemberListPayload}), terminated by a `05 02 05 <status>` frame. Two things a caller
 * must not assume: the chunking restarts at each *record* boundary (a 207-byte payload arrived as
 * 59/59/18/59/12), and the terminator is not guaranteed — on an empty list the scale has been seen
 * streaming endless all-zero chunks instead. Stop at the declared total, `65 + count * 71`, which
 * is known as soon as the first 65 bytes are in.
 */
export function buildReadMemberListCommand(): Uint8Array {
	return Uint8Array.of(0x05, 0x02, 0x05, 0x00);
}

/** One entry from the scale's stored member list. */
export interface StoredMember {
	/** account id — a single header shared by every member in the response, not per-member. */
	userId: string;
	memberId: string;
	ageYears: number;
	sex: Sex;
	heightCm: number;
	/** on-scale slot, decoded from `userIndexByte >> 1` — real ground truth for what's occupied. */
	pIndex: number;
	/** low bit of `userIndexByte`; consistent with the vendor app's own athlete members but never
	 * independently confirmed (BLE-PROTOCOL.md §10). */
	athlete: boolean;
	weightKg: number;
	userIndexByte: number;
}

/**
 * Parse the fully-accumulated member-list payload (`yj6.B0`, BLE-PROTOCOL.md §5.2):
 *
 * ```
 * [0:64]   shared userId header
 * [64]     member count N
 * then N x 71-byte records:
 *   [0:64] memberId | [64] age | [65] sex | [66:68] heightCm LE16
 *   [68]   userIndexByte = (pIndex << 1) | athlete | [69:71] weight LE16 kg*100
 * ```
 *
 * A truncated trailing record is dropped rather than throwing, matching the real parser.
 */
export function parseMemberListPayload(data: Uint8Array): StoredMember[] {
	if (data.length < 65) return [];
	const asString = (bytes: Uint8Array) =>
		new TextDecoder().decode(bytes).replace(/\0+$/, '').trim();

	const userId = asString(data.subarray(0, 64));
	const count = data[64];
	const members: StoredMember[] = [];
	let offset = 65;
	for (let i = 0; i < count; i++) {
		if (offset + 71 > data.length) break;
		const record = data.subarray(offset, offset + 71);
		offset += 71;
		const userIndexByte = record[68];
		members.push({
			userId,
			memberId: asString(record.subarray(0, 64)),
			ageYears: record[64],
			sex: record[65] === 1 ? Sex.MALE : Sex.FEMALE,
			heightCm: le16(record[66], record[67]),
			pIndex: (userIndexByte >> 1) & 0x7f,
			athlete: (userIndexByte & 0x01) !== 0,
			weightKg: le16(record[69], record[70]) / 100.0,
			userIndexByte
		});
	}
	return members;
}

/** How many bytes a member-list payload with `count` members occupies. */
export function memberListPayloadLength(count: number): number {
	return 65 + count * 71;
}

/** `userIndexByte` packs pIndex into 7 bits, so this is the protocol maximum (§5.1.4). */
export const MAX_P_INDEX = 0x7f;

/**
 * Lowest slot in `[1, maxMembers]` that no stored member occupies, or null when all are taken.
 *
 * This is the BLE-only equivalent of the app's cloud-driven slot assignment — it computes
 * `freeSlots = [1..maxMemberCount] - usedSlots` from its cloud's per-device bookkeeping and hands
 * them out in order (§5.1.5); the scale's own member list is strictly better ground truth. Null
 * means registering would have to overwrite someone, which is a decision for the caller (the app
 * shows a "pick a slot to overwrite" screen at this point).
 *
 * `maxMembers` defaults to the protocol maximum, not the device's real capacity — CF632BLE's
 * member limit is unknown; the scale reports exhaustion at registration time instead
 * (result status 0x04, "storage full").
 */
export function pickFreePIndex(members: StoredMember[], maxMembers = MAX_P_INDEX): number | null {
	const used = new Set(members.map((m) => m.pIndex));
	for (let slot = 1; slot <= maxMembers; slot++) {
		if (!used.has(slot)) return slot;
	}
	return null;
}

/** A parsed FFF2 opcode-0x05 response frame: `05 02 <subcmd> <status>`. */
export interface UserSyncStatus {
	subcmd: number;
	status: number | null;
}

/**
 * Parse an FFF2 `0x05`-family response. Returns null if `data` is not one.
 * Subcmds: 0x01 start-confirm, 0x02 registration result, 0x03/0x04 delete confirm/result,
 * 0x05 member-list terminator, 0x06/0x07 current-user confirm/result. BLE-PROTOCOL.md §5.1.2.
 */
export function parseUserSyncStatus(data: Uint8Array): UserSyncStatus | null {
	if (data.length < 3 || data[0] !== 0x05) return null;
	return { subcmd: data[2], status: data.length >= 4 ? data[3] : null };
}

/** Human-readable meaning of a registration result status (subcmd 0x02). BLE-PROTOCOL.md §5.1.2. */
export function describeSyncUserResult(status: number | null): string {
	switch (status) {
		case 0x00:
			return 'registered';
		case 0x01:
			return 'failure';
		case 0x02:
			return 'device-side user selection in progress';
		case 0x03:
			return 'needs nickname glyph/font sync';
		case 0x04:
			return 'scale member storage full';
		case 0xff:
			return 'invalid length (declared vs received mismatch)';
		default:
			return `unknown status ${status}`;
	}
}

/**
 * Opcode 0x24 — "startMeasure" (`kx8.C2`, classes5 0x5025aa20). Sends bare '2400' on FFF1.
 * REQUIRED to trigger a fresh BIA cycle — without it you may only ever see a stale/cached reading
 * (BLE-PROTOCOL.md §6). Ack: FFF1 '24 <resultcode>'.
 */
export function buildStartMeasurementCommand(): Uint8Array {
	return Uint8Array.of(0x24, 0x00);
}

/**
 * Opcode 0x0A — announce the weight-history / computed-results **push to the scale**
 * (`BorreDelegate_syncUser14DayWeightStart_w3`, BLE-PROTOCOL.md §5.3). The trailing byte is a
 * fixed per-device-family selector, not something a client computes; **CF632BLE is plain Borre**,
 * so `0A0301C100` is the correct one. Live-confirmed ack: `0A020100`.
 *
 * An earlier revision of this file offered only the Borre_A/Borre_B variants and defaulted to
 * Borre_A — i.e. the wrong frame for this device. Exposed for experimentation; the push itself has
 * never been run end-to-end with its `0A0102` completion frame (§10).
 */
export function buildHistoryTriggerCommand(
	variant: 'PlainBorre' | 'Borre_A' | 'Borre_B' | 'Borre_C' = 'PlainBorre'
): Uint8Array {
	const variants = {
		PlainBorre: '0A0301C100', // CF632BLE
		Borre_A: '0A0301EB00',
		Borre_B: '0A0301F700',
		Borre_C: '0A0301B300'
	};
	return hexToBytes(variants[variant]);
}

// --- User profile (BLE-PROTOCOL.md §5.1.4) -------------------------------------------------------------

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
	/** wire-level account id (§5.1.3); the app always sends a real one. */
	userId?: string;
	/** wire-level member id — what a later delete targets. Must be stable and non-empty. */
	memberId?: string;
}

/** Per-field length of the identity header (`py8_c`). Each field is padded to this. */
export const USER_ID_FIELD_BYTES = 64;

/**
 * `py8.r` (BLE-PROTOCOL.md §5.1.3) — the 128-byte identity header prefixing the registration
 * payload, the delete payload and the current-user payload: `userId` and `memberId`, each UTF-8
 * and zero-padded on the right to 64 bytes.
 *
 * **A blank `memberId` is not "anonymous" — it means "every member under this `userId`"** (§5.1.5),
 * which is how the app expresses "delete all members". So an app that registers members with an
 * empty header can only remove them by wiping the lot. Always give each member a stable id.
 *
 * Throws if either field exceeds 64 UTF-8 bytes: silently truncating would send a
 * plausible-looking header addressing the wrong member.
 */
export function buildUserIdHeader(userId = '', memberId = ''): Uint8Array {
	const out = new Uint8Array(USER_ID_FIELD_BYTES * 2);
	const enc = new TextEncoder();
	for (const [i, value] of [userId, memberId].entries()) {
		if (!value) continue;
		const bytes = enc.encode(value);
		if (bytes.length > USER_ID_FIELD_BYTES) {
			throw new Error(
				`"${value}" is ${bytes.length} UTF-8 bytes, over the ${USER_ID_FIELD_BYTES}-byte field limit`
			);
		}
		out.set(bytes, i * USER_ID_FIELD_BYTES);
	}
	return out;
}

/**
 * The 128-byte identity header sent (chunked) after a `buildDeleteUserCommand` announce, naming
 * which member to remove. BLE-PROTOCOL.md §5.1.2a. Requires a non-empty `memberId` — see
 * {@link buildUserIdHeader} for why passing an empty one is a wipe, not a no-op.
 */
export function buildDeleteUserPayload(userId: string, memberId: string): Uint8Array {
	if (!memberId) {
		throw new Error(
			'refusing to build a delete payload with a blank memberId — that deletes EVERY member ' +
				'under this userId (BLE-PROTOCOL.md §5.1.5)'
		);
	}
	return buildUserIdHeader(userId, memberId);
}

/**
 * The 128-byte header for `sendCurrentUserForMeasurement` (§5.1.1) — tells the scale which
 * already-registered member is standing on it, so the weigh-in is attributed to them. This app
 * computes body composition on-device, so it never needs this to take a reading; it only affects
 * the scale's own bookkeeping.
 */
export function buildCurrentUserPayload(userId: string, memberId: string): Uint8Array {
	return buildUserIdHeader(userId, memberId);
}

/**
 * `j70.buildUserProfile_plainBorre_z` (classes5 0x50129a14): 128B userIdHeader + age(1) + sex(1) +
 * height LE16(2) + userIndexByte(1) + weight LE16 kg*100(2) = 135 bytes.
 *
 * Weight is `(int)((weightKg + 0.005) * 100.0)`: the cast truncates, but the `+0.005` makes the
 * composite round half-up to the nearest 0.01 kg (BLE-PROTOCOL.md §5.1.4). `Math.trunc` is the
 * faithful port.
 */
export function buildUserProfilePayload(p: UserProfileInput): Uint8Array {
	const pIndex = p.pIndex ?? 1;
	const athlete = p.athlete ?? false;
	const weightKg = p.weightKg ?? 70.0;

	const payload = new Uint8Array(135);
	payload.set(buildUserIdHeader(p.userId, p.memberId), 0);
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

// --- Device-MTU handshake: opcode 0x02 on FFF1 -------------------------------------------------
// This is what the FFF2 chunk size comes from. It is NOT the ATT MTU (Web Bluetooth deliberately
// exposes no ATT MTU API, and it wouldn't be the right number anyway).

/**
 * The vendor app's initial `PPDeviceModel.mtu` (`py8_b` = 0xF4 = 244, set in both PPDeviceModel
 * constructors, classes3 0x50410a08 / 0x50410a94) — the same constant it passes to Android's
 * `requestMtu()`. This value, minus 2, is how many data bytes go in each FFF2 chunk, and it stands
 * unless the scale answers the `0x02` query below.
 */
export const DEFAULT_DEVICE_MTU = 0xf4; // 244

/** What the app falls back to when the ATT-level requestMtu() *fails*, and what the 0x02 handler
 * substitutes if the scale reports 0. */
export const FALLBACK_DEVICE_MTU = 0x14; // 20

/**
 * Opcode 0x02 — **query the scale's bulk-transfer ("device") MTU**. Bare '0200' on **FFF1**.
 * `kx8.u0`, classes5 0x50257ae0.
 *
 * A mandatory bring-up step that earlier revisions of this client missed entirely. The vendor app
 * sends it as soon as its ATT `requestMtu(244)` succeeds, and its `onMtuSuccess` continuation — so
 * the whole rest of the session — only runs once the scale's reply has been applied via
 * `setMtu()`. The reply's value is the sole input to `ByteUtil.subAccordToMTU`, i.e. it sets the
 * fragment size for every chunked FFF2 payload.
 *
 * Never asking is why every multi-chunk FFF2 mutation was silently dropped by the scale while
 * every single-frame write worked. See BLE-PROTOCOL.md §2.1.
 */
export function buildDeviceMtuQueryCommand(): Uint8Array {
	return Uint8Array.of(0x02, 0x00);
}

/**
 * Parse the scale's FFF1 reply: `02 02 <mtu_lo> <mtu_hi>` (length byte must be 0x02; MTU is LE16).
 * Returns the reported MTU, or null if `data` isn't such a frame.
 *
 * Handler: classes5 0x50214b56, inside `jk6_parseF1ResponseFrame_dispatch_T` (packed-switch case
 * for `"02".hashCode() == 0x602`); logs "requestMtu result device mtu = %d", then
 * `setMtu(mtu > 0 ? mtu : 20)`.
 */
export function parseDeviceMtuReport(data: Uint8Array): number | null {
	if (data.length < 4 || data[0] !== 0x02 || data[1] !== 0x02) return null;
	return data[2] | (data[3] << 8);
}

/**
 * FFF2 data bytes per chunk for a given device MTU: `deviceMtu - 2`, so a complete wire frame
 * including its 2-byte `[0x00][seq]` header is exactly `deviceMtu` bytes.
 *
 * A frame larger than the link's `ATT_MTU - 3` is expected and fine: the browser/OS GATT stack
 * turns it into an ATT long write (Prepare Write × N + Execute Write), exactly as Android does for
 * the vendor app. Do **not** clamp this to a guessed ATT MTU — that reintroduces the very
 * fragmentation mismatch this handshake exists to prevent.
 */
export function chunkSizeForDeviceMtu(deviceMtu: number): number {
	return deviceMtu - 2;
}

/**
 * `ByteUtil.subAccordToMTU` (classes5 0x50297c7c): split a bulk (FFF2) payload into
 * `[0x00][seqIndex][data...]` frames. `chunkSize` is the data-only portion per frame, i.e.
 * `chunkSizeForDeviceMtu(deviceMtu)`.
 *
 * **`chunkSize` must come from the scale**, via the `0x02` handshake above — it is not a constant.
 * The default here is `DEFAULT_DEVICE_MTU - 2` = 242, matching what the vendor app uses when the
 * query goes unanswered; at that size the whole 135-byte registration profile is a single frame.
 * An earlier revision defaulted to 18 on the mistaken belief that the app pinned its chunking MTU
 * to 20.
 */
export function chunkPayload(
	payload: Uint8Array,
	chunkSize = DEFAULT_DEVICE_MTU - 2
): Uint8Array[] {
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

// --- F3 measurement-frame parsing (BLE-PROTOCOL.md §6) -------------------------------------------

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
 * Port of the native `Bh13DecodeImpedance` (`libbh3BodyComposition.so` 0x1266b0, BLE-PROTOCOL.md §6.3) —
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
 * for the CF632BLE / plain-Borre device specifically (BLE-PROTOCOL.md §6).
 *
 * **CF632BLE emits sub-command `0x01`** for weight/status frames — confirmed live. Byte 1 of such a
 * frame is a fixed/reserved marker (observed `0x0D`), not a length or a second sub-command; an
 * earlier revision of this parser also accepted `0x0D`/`0x11` at byte 0, which came from generic
 * (non-Borre) decompiled code and does not match what this device sends.
 *
 * `0x02` carries the real dual-frequency encoded impedance (the BIA input). `0x03` is confirmed
 * dead code in the vendor app itself; `0x16` is an impedance-measurement failure. Anything else is
 * flagged via `note` only.
 */
export function parseF3Frame(data: Uint8Array): MeasurementFrame {
	if (data.length === 0) throw new Error('empty F3 frame');

	const sub = data[0];
	const frame = emptyFrame(sub, data.slice());

	if (sub === 0x01) {
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
		// Priority-encoded 2-bit weight-state (BLE-PROTOCOL.md §6): leave-scale needs BOTH bit2+bit3
		// set (& 0x0C == 0x0C), not "either bit". A bit2-only frame is "stable/locked", not leave.
		frame.leaveScale = (status1 & 0x0c) === 0x0c;
		frame.overweight = !frame.leaveScale && (status1 & 0x08) !== 0;
		frame.stable = !frame.leaveScale && !frame.overweight && (status1 & 0x04) !== 0;
		frame.measurementComplete = (status2 & 0x80) !== 0;

		if (data.length >= 12) {
			// Plaintext impedance — dead code for CF632 (gated on deviceCalcuteType == Direct, which
			// this device is not); the real values come from the 0x02 frame below.
			frame.impedanceOhm = le16(data[10], data[11]) / 10.0;
		}
		if (data.length >= 14) {
			frame.impedance2Ohm = le16(data[12], data[13]) / 10.0;
		}
	} else if (sub === 0x16) {
		frame.note = 'impedance measurement failure frame (electrode error bitmask undecoded here)';
	} else if (sub === 0x03) {
		frame.note = 'per-frequency status ping — confirmed dead code in the vendor app itself';
	} else if (sub === 0x02) {
		// BLE-PROTOCOL.md §6: byte3 == 2 is the "4-electrode dual-frequency" case, the only one
		// confirmed for CF632BLE: encoded 50kHz Z in bytes 4-7, encoded 100kHz Z in bytes 8-11.
		// BYTE ORDER = LITTLE-ENDIAN (the app's `py8_c` reverses before hex->int); reading it
		// big-endian was an earlier bug that made a clean ~448Ω reading look like noise.
		const freqKind = data.length > 3 ? data[3] : null;
		if (freqKind === 2 && data.length >= 12) {
			frame.z50khzOhm = decodeImpedanceBh13(u32le(data, 4));
			frame.z100khzOhm = decodeImpedanceBh13(u32le(data, 8));
			frame.note = 'dual-frequency 4-electrode encoded impedance (z50khzOhm + z100khzOhm)';
		} else {
			// Other byte3 values are left undecoded rather than guessed at — only the dual-frequency
			// case is confirmed for this device, and a wrong decode here feeds the BIA math silently.
			frame.note = `0x02 frame with byte3=${freqKind} not decoded (only byte3==2 is confirmed for CF632BLE)`;
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

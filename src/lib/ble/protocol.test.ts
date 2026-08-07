import { describe, it, expect } from 'vitest';
import {
	Sex,
	uuid16,
	bytesToHex,
	hexToBytes,
	buildTimeSyncCommand,
	buildImpedanceControlCommand,
	buildUserAnnounceCommand,
	buildStartMeasurementCommand,
	buildUserProfilePayload,
	chunkPayload,
	buildDeviceMtuQueryCommand,
	buildSyncUserInfoCommand,
	buildTransferCompleteCommand,
	buildHistoryTransferCompleteCommand,
	buildMemberListAckCommand,
	parseUserSyncStatus,
	SUBCMD_RESULT_SYNC_USER_INFO,
	SUBCMD_RESULT_DELETE_USER,
	SUBCMD_RESULT_CURRENT_USER,
	parseDeviceMtuReport,
	chunkSizeForDeviceMtu,
	DEFAULT_DEVICE_MTU,
	FALLBACK_DEVICE_MTU,
	decodeImpedanceBh13,
	parseF3Frame,
	buildUserIdHeader,
	buildDeleteUserCommand,
	buildDeleteUserPayload,
	buildCurrentUserPayload,
	buildReadMemberListCommand,
	parseMemberListPayload,
	memberListPayloadLength,
	pickFreePIndex,
	buildHeartRateModuleCommand,
	buildBodyFatModuleCommand,
	buildDeviceBindStatusCommand,
	parseDeviceBindStatus,
	parseModuleReply,
	buildHistoryTriggerCommand,
	USER_ID_FIELD_BYTES
} from './protocol';

describe('uuid16', () => {
	it('expands short codes to the SIG base UUID', () => {
		expect(uuid16(0xfff0)).toBe('0000fff0-0000-1000-8000-00805f9b34fb');
		expect(uuid16(0x2a19)).toBe('00002a19-0000-1000-8000-00805f9b34fb');
	});
});

describe('command builders', () => {
	it('time-sync 0xF1 encodes y/m/d/h/m/s (BLE-PROTOCOL.md)', () => {
		// 2026-07-07 12:30:45 -> F1 07EA 07 07 0C 1E 2D (year 2026=0x07EA, 8 bytes total)
		const cmd = buildTimeSyncCommand(new Date(2026, 6, 7, 12, 30, 45));
		expect(bytesToHex(cmd, '')).toBe('f107ea07070c1e2d');
	});

	it('impedance on/off 0x2C', () => {
		expect(bytesToHex(buildImpedanceControlCommand(true), '')).toBe('2c020101');
		expect(bytesToHex(buildImpedanceControlCommand(false), '')).toBe('2c020100');
	});

	it('user announce 0x05 (0503068000 for the 128-byte header)', () => {
		expect(bytesToHex(buildUserAnnounceCommand(128), '')).toBe('0503068000');
	});

	it('start-measure 0x24 (2400)', () => {
		expect(bytesToHex(buildStartMeasurementCommand(), '')).toBe('2400');
	});
});

describe('user profile payload (BLE-PROTOCOL.md §5.1.4 worked example)', () => {
	it('male/30y/175cm/slot1/non-athlete/72.50kg ends with 1E 01 AF00 02 521C', () => {
		const payload = buildUserProfilePayload({
			ageYears: 30,
			sex: Sex.MALE,
			heightCm: 175,
			pIndex: 1,
			athlete: false,
			weightKg: 72.5
		});
		expect(payload.length).toBe(135);
		// first 128 bytes are the zero userIdHeader
		expect(payload.subarray(0, 128).every((b) => b === 0)).toBe(true);
		expect(bytesToHex(payload.subarray(128), ' ')).toBe('1e 01 af 00 02 52 1c');
	});

	it('weight is round-half-up to 0.01 kg via the +0.005 idiom', () => {
		// The builder computes (int)((w + 0.005) * 100.0) -- BLE-PROTOCOL.md §5.1.4.
		// 80.0kg -> (80.0 + 0.005)*100 = 8000.5 -> trunc 8000 = 0x1F40 -> LE 40 1f.
		const payload = buildUserProfilePayload({
			ageYears: 30,
			sex: Sex.MALE,
			heightCm: 175,
			weightKg: 80.0
		});
		expect(bytesToHex(payload.subarray(133), ' ')).toBe('40 1f');
	});
});

describe('chunkPayload', () => {
	it('prefixes each 18-byte chunk with [00][seq]', () => {
		const payload = new Uint8Array(40).map((_, i) => i);
		const chunks = chunkPayload(payload, 18);
		expect(chunks.length).toBe(3); // 18 + 18 + 4
		expect(chunks[0][0]).toBe(0x00);
		expect(chunks[0][1]).toBe(0); // seq 0
		expect(chunks[1][1]).toBe(1); // seq 1
		expect(chunks[2][1]).toBe(2); // seq 2
		expect(chunks[2].length).toBe(2 + 4);
	});

	it('defaults to the vendor app’s 244-byte device MTU, i.e. one frame for a 135-byte profile', () => {
		// BLE-PROTOCOL.md §2.1: PPDeviceModel.mtu starts at 244, so chunk data size is 242 and
		// the whole registration profile goes out as a single [00][00]+135 = 137-byte frame.
		const chunks = chunkPayload(new Uint8Array(135));
		expect(chunks.length).toBe(1);
		expect(chunks[0].length).toBe(137);
		expect(chunks[0][0]).toBe(0x00);
		expect(chunks[0][1]).toBe(0x00);
	});
});

describe('device-MTU handshake (BLE-PROTOCOL.md §2.1)', () => {
	it('builds the bare 0200 query', () => {
		expect(bytesToHex(buildDeviceMtuQueryCommand(), '')).toBe('0200');
	});

	it('parses 02 02 <LE16> replies', () => {
		expect(parseDeviceMtuReport(hexToBytes('0202f400'))).toBe(244);
		expect(parseDeviceMtuReport(hexToBytes('02021400'))).toBe(20);
		expect(parseDeviceMtuReport(hexToBytes('02024000'))).toBe(64);
		expect(parseDeviceMtuReport(hexToBytes('02020000'))).toBe(0); // caller substitutes the fallback
	});

	it('rejects frames that are not an 0x02/len-0x02 reply', () => {
		expect(parseDeviceMtuReport(hexToBytes('1c020201'))).toBeNull(); // 0x1C bind status
		expect(parseDeviceMtuReport(hexToBytes('02011400'))).toBeNull(); // wrong length byte
		expect(parseDeviceMtuReport(hexToBytes('0202f4'))).toBeNull(); // truncated
	});

	it('derives the chunk size as deviceMtu - 2', () => {
		expect(chunkSizeForDeviceMtu(DEFAULT_DEVICE_MTU)).toBe(242);
		expect(chunkSizeForDeviceMtu(FALLBACK_DEVICE_MTU)).toBe(18);
		expect(chunkSizeForDeviceMtu(64)).toBe(62);
	});
});

describe('parseF3Frame — 0x01 weight/status (BLE-PROTOCOL.md captured frame)', () => {
	// 01 0d 25 00 fd 1b 00 00 00 32 bf 11 64 86 10 -> weight 71.65 kg
	const f = parseF3Frame(hexToBytes('010d2500fd1b00000032bf11648610'));

	it('weight 71.65 kg, stable, not complete', () => {
		expect(f.subCommand).toBe(0x01);
		expect(f.weightKg).toBeCloseTo(71.65, 5);
		expect(f.status1).toBe(0x25);
		expect(f.status2).toBe(0x00);
		expect(f.stable).toBe(true);
		expect(f.leaveScale).toBe(false);
		expect(f.measurementComplete).toBe(false);
	});

	it('also surfaces the plaintext + 2nd-freq impedance fields', () => {
		expect(f.impedanceOhm).toBeCloseTo(454.3, 3); // 0x11bf/10
		expect(f.impedance2Ohm).toBeCloseTo(3440.4, 3); // 0x8664/10
	});
});

describe('decodeImpedanceBh13 / 0x02 frame (BLE-PROTOCOL.md §6.3)', () => {
	it('decodes the captured dual-frequency 0x02 frame little-endian', () => {
		// 02 0a 18 02 00 03 8c 00 dc 56 c3 00 : z50 = bytes4-7, z100 = bytes8-11 (little-endian)
		const frame = parseF3Frame(hexToBytes('020a180200038c00dc56c300'));
		expect(frame.subCommand).toBe(0x02);
		expect(frame.z50khzOhm).toBe(454);
		expect(frame.z100khzOhm).toBe(423);
	});

	it('0xFFFFFF sentinel means no reading', () => {
		expect(decodeImpedanceBh13(0xffffff)).toBe(0xffff);
	});
});

describe('chunked-upload handshake (BLE-PROTOCOL.md §5.1.2 / §5.1.7)', () => {
	it('builds the registration announce with the 135-byte length', () => {
		expect(bytesToHex(buildSyncUserInfoCommand(135), '')).toBe('0503018700');
	});

	it('builds the transfer-complete frame per operation', () => {
		// The frame that made registration work: 05 01 <expected result subcmd>.
		expect(bytesToHex(buildTransferCompleteCommand(SUBCMD_RESULT_SYNC_USER_INFO), '')).toBe('050102');
		expect(bytesToHex(buildTransferCompleteCommand(SUBCMD_RESULT_DELETE_USER), '')).toBe('050104');
		expect(bytesToHex(buildTransferCompleteCommand(SUBCMD_RESULT_CURRENT_USER), '')).toBe('050107');
		expect(bytesToHex(buildHistoryTransferCompleteCommand(), '')).toBe('0a0102');
		expect(bytesToHex(buildMemberListAckCommand(), '')).toBe('05020501');
	});

	it('parses the 0x05 handshake responses seen live', () => {
		expect(parseUserSyncStatus(hexToBytes('05020100'))).toEqual({ subcmd: 0x01, status: 0x00 });
		expect(parseUserSyncStatus(hexToBytes('05020200'))).toEqual({ subcmd: 0x02, status: 0x00 });
		expect(parseUserSyncStatus(hexToBytes('05020400'))).toEqual({ subcmd: 0x04, status: 0x00 });
		expect(parseUserSyncStatus(hexToBytes('05020501'))).toEqual({ subcmd: 0x05, status: 0x01 });
		expect(parseUserSyncStatus(hexToBytes('020200'))).toBeNull();
	});

	it('fragments the 135-byte profile the way the scale asks (device MTU 61 -> 59)', () => {
		// Live-observed: CF632BLE reports 61, so 3 frames of 59/59/17 data bytes.
		const chunks = chunkPayload(new Uint8Array(135), chunkSizeForDeviceMtu(61));
		expect(chunks.map((c) => c.length)).toEqual([61, 61, 19]);
		expect(chunks.map((c) => c[1])).toEqual([0, 1, 2]);
	});
});

describe('identity header (BLE-PROTOCOL.md §5.1.3)', () => {
	it('zero-pads each field to 64 bytes, userId then memberId', () => {
		const header = buildUserIdHeader('acct', 'member');
		expect(header.length).toBe(128);
		expect(new TextDecoder().decode(header.subarray(0, 4))).toBe('acct');
		expect(header.subarray(4, 64).every((b) => b === 0)).toBe(true);
		expect(new TextDecoder().decode(header.subarray(64, 70))).toBe('member');
		expect(header.subarray(70).every((b) => b === 0)).toBe(true);
	});

	it('is all zeros when both fields are empty (guest mode)', () => {
		expect(buildUserIdHeader().every((b) => b === 0)).toBe(true);
	});

	it('throws rather than truncating an over-long id', () => {
		expect(() => buildUserIdHeader('x'.repeat(USER_ID_FIELD_BYTES + 1))).toThrow(/field limit/);
	});

	it('carries the ids into the 135-byte registration payload', () => {
		const payload = buildUserProfilePayload({
			ageYears: 30,
			sex: Sex.MALE,
			heightCm: 175,
			pIndex: 3,
			weightKg: 70.0,
			userId: 'acct',
			memberId: 'member'
		});
		expect(payload.length).toBe(135);
		expect(new TextDecoder().decode(payload.subarray(64, 70))).toBe('member');
		// Live-verified tail: age 30, male, 175cm, pIndex 3 (0x06), 70.00kg (7000 = 0x1B58).
		expect(bytesToHex(payload.subarray(128), ' ')).toBe('1e 01 af 00 06 58 1b');
	});
});

describe('delete member (BLE-PROTOCOL.md §5.1.2a)', () => {
	it('announces 0503038000 — the 128-byte header alone identifies the member', () => {
		expect(bytesToHex(buildDeleteUserCommand(128), '')).toBe('0503038000');
		expect(buildDeleteUserPayload('acct', 'member').length).toBe(128);
	});

	it('refuses a blank memberId, which the scale reads as "delete ALL members" (§5.1.5)', () => {
		expect(() => buildDeleteUserPayload('acct', '')).toThrow(/blank memberId/);
	});

	it('current-user payload is the same 128-byte header', () => {
		expect(buildCurrentUserPayload('acct', 'member')).toEqual(buildUserIdHeader('acct', 'member'));
	});
});

describe('member list (BLE-PROTOCOL.md §5.2)', () => {
	const ACCOUNT = 'f9b23f7c-c95c-4e48-8e95-0cccc8efb8da';
	const MEMBER = '537bd85d-73c2-445a-831e-a3d0c165b2ec';

	/** Build a payload the way the scale does: 64B userId + count + N x 71B records. */
	function makePayload(records: { memberId: string; userIndexByte: number }[]): Uint8Array {
		const enc = new TextEncoder();
		const out = new Uint8Array(memberListPayloadLength(records.length));
		out.set(enc.encode(ACCOUNT), 0);
		out[64] = records.length;
		records.forEach((r, i) => {
			const at = 65 + i * 71;
			out.set(enc.encode(r.memberId), at);
			out[at + 64] = 37; // age
			out[at + 65] = 1; // male
			out[at + 66] = 173 & 0xff; // height LE16
			out[at + 67] = 173 >> 8;
			out[at + 68] = r.userIndexByte;
			out[at + 69] = 7220 & 0xff; // 72.20 kg LE16
			out[at + 70] = 7220 >> 8;
		});
		return out;
	}

	it('requests with 05020500', () => {
		expect(bytesToHex(buildReadMemberListCommand(), '')).toBe('05020500');
	});

	it('decodes pIndex and the athlete flag out of userIndexByte (live-verified pair)', () => {
		// 0x03 -> PIndex 1 + athlete; 0x04 -> PIndex 2, not athlete.
		const members = parseMemberListPayload(
			makePayload([
				{ memberId: MEMBER, userIndexByte: 0x03 },
				{ memberId: '5b0f8565-84a9-40a2-be59-7e4c767060d4', userIndexByte: 0x04 }
			])
		);
		expect(members.length).toBe(2);
		expect(members[0]).toMatchObject({
			userId: ACCOUNT,
			memberId: MEMBER,
			ageYears: 37,
			sex: Sex.MALE,
			heightCm: 173,
			pIndex: 1,
			athlete: true,
			userIndexByte: 0x03
		});
		expect(members[0].weightKg).toBeCloseTo(72.2, 5);
		expect(members[1]).toMatchObject({ pIndex: 2, athlete: false });
	});

	it('round-trips the userIndexByte the write path builds', () => {
		const payload = buildUserProfilePayload({
			ageYears: 37,
			sex: Sex.MALE,
			heightCm: 173,
			pIndex: 1,
			athlete: true,
			memberId: MEMBER
		});
		expect(payload[132]).toBe(0x03);
	});

	it('drops a truncated trailing record instead of throwing', () => {
		const full = makePayload([{ memberId: MEMBER, userIndexByte: 0x03 }]);
		expect(parseMemberListPayload(full.subarray(0, full.length - 5))).toEqual([]);
		expect(parseMemberListPayload(new Uint8Array(10))).toEqual([]);
	});

	it('picks the lowest free slot, or null when everything is taken', () => {
		const members = parseMemberListPayload(
			makePayload([
				{ memberId: 'a', userIndexByte: 0x02 }, // slot 1
				{ memberId: 'b', userIndexByte: 0x04 } // slot 2
			])
		);
		expect(pickFreePIndex(members)).toBe(3);
		expect(pickFreePIndex([])).toBe(1);
		expect(pickFreePIndex(members, 2)).toBeNull();
	});
});

describe('device settings (BLE-PROTOCOL.md §4 / §7)', () => {
	it('heart-rate 0x06 and body-fat 0x07 are separate module toggles', () => {
		// The value byte is INVERTED: 0 = on. Getting this wrong silently disables BIA on the
		// scale — an earlier revision did exactly that. BLE-PROTOCOL.md §4.1.
		expect(bytesToHex(buildHeartRateModuleCommand(), '')).toBe('06020200');
		expect(bytesToHex(buildHeartRateModuleCommand(true), '')).toBe('06020100');
		expect(bytesToHex(buildHeartRateModuleCommand(false), '')).toBe('06020101');
		expect(bytesToHex(buildBodyFatModuleCommand(), '')).toBe('07020200');
		expect(bytesToHex(buildBodyFatModuleCommand(true), '')).toBe('07020100');
		expect(bytesToHex(buildBodyFatModuleCommand(false), '')).toBe('07020101');
	});

	it('decodes a module reply — SET ack vs state report, and the inverted polarity', () => {
		// BLE-PROTOCOL.md §4: byte2 1 = answer to a SET, 2 = state report; byte3 0 = success/ON.
		// Getting either of these backwards makes a working toggle look stuck off — which is
		// exactly what happened live before the reply handler was decompiled.
		expect(parseModuleReply(hexToBytes('07020100'))).toEqual({
			opcode: 0x07,
			isSetAck: true,
			ok: true, // the SET succeeded — NOT "the module is off"
			raw: 0x00
		});
		expect(parseModuleReply(hexToBytes('07020200'))).toMatchObject({ isSetAck: false, ok: true }); // ON
		expect(parseModuleReply(hexToBytes('07020201'))).toMatchObject({ isSetAck: false, ok: false }); // off
		expect(parseModuleReply(hexToBytes('06020100'))).toMatchObject({ opcode: 0x06, isSetAck: true, ok: true });
		// Not a module reply: wrong opcode, unknown marker, or truncated.
		expect(parseModuleReply(hexToBytes('1c020201'))).toBeNull();
		expect(parseModuleReply(hexToBytes('07020300'))).toBeNull();
		expect(parseModuleReply(hexToBytes('070202'))).toBeNull();
	});

	it('bind status 0x1C get/set', () => {
		expect(bytesToHex(buildDeviceBindStatusCommand(), '')).toBe('1c020200');
		expect(bytesToHex(buildDeviceBindStatusCommand(true), '')).toBe('1c020101');
	});

	it('reads bind state from byte 3, not the echoed type byte', () => {
		// Live captures: GET-after-bind 1c020201 (bound), SET-unbound 1c020100 (unbound).
		expect(parseDeviceBindStatus(hexToBytes('1c020201'))).toEqual({
			echoedType: 0x02,
			boundRaw: 0x01,
			bound: true
		});
		expect(parseDeviceBindStatus(hexToBytes('1c020100'))).toEqual({
			echoedType: 0x01,
			boundRaw: 0x00,
			bound: false
		});
		expect(parseDeviceBindStatus(hexToBytes('0202f400'))).toBeNull();
	});

	it('defaults the 0x0A history trigger to the plain-Borre variant CF632BLE uses', () => {
		expect(bytesToHex(buildHistoryTriggerCommand(), '')).toBe('0a0301c100');
		expect(bytesToHex(buildHistoryTriggerCommand('Borre_A'), '')).toBe('0a0301eb00');
	});
});

describe('parseF3Frame — sub-commands this device does not send', () => {
	it('does not treat 0x0d / 0x11 as weight frames (generic non-Borre decompiled code)', () => {
		for (const hex of ['0d0d2500fd1b0000', '110d2500fd1b0000']) {
			const f = parseF3Frame(hexToBytes(hex));
			expect(f.weightKg).toBeNull();
			expect(f.note).toMatch(/not decoded/);
		}
	});

	it('leaves a 0x02 frame undecoded unless byte3 == 2 (the only confirmed case)', () => {
		const f = parseF3Frame(hexToBytes('020a180100038c00dc56c300'));
		expect(f.z50khzOhm).toBeNull();
		expect(f.z100khzOhm).toBeNull();
		expect(f.note).toMatch(/byte3=1 not decoded/);
	});

	it('flags 0x03 as the vendor app’s own dead code', () => {
		expect(parseF3Frame(hexToBytes('0300')).note).toMatch(/dead code/);
	});
});

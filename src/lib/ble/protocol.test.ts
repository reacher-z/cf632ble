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
	decodeImpedanceBh13,
	parseF3Frame
} from './protocol';

describe('uuid16', () => {
	it('expands short codes to the SIG base UUID', () => {
		expect(uuid16(0xfff0)).toBe('0000fff0-0000-1000-8000-00805f9b34fb');
		expect(uuid16(0x2a19)).toBe('00002a19-0000-1000-8000-00805f9b34fb');
	});
});

describe('command builders', () => {
	it('time-sync 0xF1 encodes y/m/d/h/m/s (RE-NOTES §12.4)', () => {
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

describe('user profile payload (RE-NOTES §13.3 worked example)', () => {
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

	it('weight uses truncation, not rounding (Java (int) cast)', () => {
		// 80.0kg -> (80.0 + 0.005)*100 = 8000.5 -> trunc 8000 = 0x1F40 -> LE 40 1f.
		// (Rounding would give 8001 = 0x1F41 -> 41 1f; the native code truncates.)
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
});

describe('parseF3Frame — 0x01 weight/status (RE-NOTES §12.9 captured frame)', () => {
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

describe('decodeImpedanceBh13 / 0x02 frame (RE-NOTES §16.3)', () => {
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

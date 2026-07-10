import { describe, it, expect } from 'vitest';
import { measurementFromReading } from './measurements';
import type { Profile } from '$lib/types';
import type { RawReading } from '$lib/ble/client';

const maleProfile: Profile = {
	ageYears: 37,
	sex: 'male',
	heightCm: 173,
	athlete: false,
	pIndex: 1,
	units: 'kg'
};

describe('measurementFromReading — BLE reading -> stored Measurement', () => {
	it('computes full body composition from weight + impedance (hardware-confirmed 21.4%)', () => {
		const reading: RawReading = {
			at: new Date('2026-07-07T08:00:00Z'),
			weightKg: 72.2,
			z50khzOhm: 448,
			z100khzOhm: 418
		};
		const m = measurementFromReading(reading, maleProfile);

		expect(m.weightKg).toBe(72.2);
		expect(m.z50khzOhm).toBe(448);
		expect(m.timestamp).toBe('2026-07-07T08:00:00.000Z');
		// snapshotted inputs stay with the reading
		expect(m.inputs).toEqual({ ageYears: 37, sex: 'male', heightCm: 173, athlete: false });
		expect(m.body).not.toBeNull();
		expect(m.body!.bodyFatRatePercent).toBeCloseTo(21.4, 6);
		expect(m.id).toBeTruthy();
	});

	it('stores a weight-only reading (body=null) when impedance is missing', () => {
		const reading: RawReading = {
			at: new Date(),
			weightKg: 70.0,
			z50khzOhm: null,
			z100khzOhm: null
		};
		const m = measurementFromReading(reading, maleProfile);
		expect(m.weightKg).toBe(70.0);
		expect(m.body).toBeNull();
	});

	it('stores a weight-only reading when impedance is out of the valid range', () => {
		const reading: RawReading = {
			at: new Date(),
			weightKg: 70.0,
			z50khzOhm: 50, // below 200Ω → native lib would reject
			z100khzOhm: 418
		};
		const m = measurementFromReading(reading, maleProfile);
		expect(m.body).toBeNull();
	});
});

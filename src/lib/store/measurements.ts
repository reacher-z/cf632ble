/** Measurement history store (persisted to localStorage), newest last. */

import { get } from 'svelte/store';
import { persistedStore } from './persistence';
import type { Measurement, MeasurementInputs, Profile } from '$lib/types';
import type { RawReading } from '$lib/ble/client';
import { calcFullBodyComposition } from '$lib/bia/vendor-bia';
import { sexToEnum } from './profile';

export const measurements = persistedStore<Measurement[]>('measurements', []);

export const DAY_MS = 86_400_000;

function newId(): string {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
	return `m_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Turn a raw scale reading + the current profile into a stored Measurement: snapshots the profile
 * inputs and computes the full body composition (null if impedance was absent or out of range).
 */
export function measurementFromReading(reading: RawReading, profile: Profile): Measurement {
	const inputs: MeasurementInputs = {
		ageYears: profile.ageYears,
		sex: profile.sex,
		heightCm: profile.heightCm,
		athlete: profile.athlete
	};

	let body: Measurement['body'] = null;
	if (reading.z50khzOhm !== null && reading.z100khzOhm !== null) {
		const res = calcFullBodyComposition({
			weightKg: reading.weightKg,
			heightCm: inputs.heightCm,
			age: inputs.ageYears,
			sex: sexToEnum(inputs.sex),
			z50khzOhm: reading.z50khzOhm,
			z100khzOhm: reading.z100khzOhm,
			athlete: inputs.athlete
		});
		if (res.ok) body = res.body;
	}

	return {
		id: newId(),
		timestamp: reading.at.toISOString(),
		weightKg: reading.weightKg,
		z50khzOhm: reading.z50khzOhm,
		z100khzOhm: reading.z100khzOhm,
		inputs,
		body
	};
}

export function addMeasurement(m: Measurement): void {
	measurements.update((list) => [...list, m]);
}

export function removeMeasurement(id: string): void {
	measurements.update((list) => list.filter((m) => m.id !== id));
}

export function clearMeasurements(): void {
	measurements.set([]);
}

/** Most recent measurement, or undefined. */
export function latestMeasurement(): Measurement | undefined {
	const list = get(measurements);
	return list.length ? list[list.length - 1] : undefined;
}

/**
 * Dev-only: appends `days` synthetic daily readings (weight trending down with noise, impedance
 * within the vendor's valid range) to the existing history, run through the same
 * `measurementFromReading` path a real BLE reading takes — so every field (body composition,
 * levels) renders exactly like it would from hardware. For exercising Trends/History without a scale.
 */
export function loadSampleMeasurements(profile: Profile, days = 120): void {
	const now = Date.now();
	const startWeightKg = (profile.lastKnownWeightKg ?? 82) + 6;
	const totalDropKg = 6 + Math.random() * 4;
	const generated: Measurement[] = [];
	for (let i = 0; i < days; i++) {
		const progress = days > 1 ? i / (days - 1) : 1;
		const daysAgo = days - 1 - i;
		const reading: RawReading = {
			at: new Date(now - daysAgo * DAY_MS),
			weightKg: Number((startWeightKg - progress * totalDropKg + (Math.random() - 0.5) * 0.6).toFixed(1)),
			z50khzOhm: Math.round(430 + progress * 30 + (Math.random() - 0.5) * 15),
			z100khzOhm: Math.round(400 + progress * 25 + (Math.random() - 0.5) * 15)
		};
		generated.push(measurementFromReading(reading, profile));
	}
	measurements.update((list) =>
		[...list, ...generated].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
	);
}

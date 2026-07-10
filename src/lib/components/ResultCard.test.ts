// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import ResultCard from './ResultCard.svelte';
import { calcFullBodyComposition } from '$lib/bia/vendor-bia';
import { Sex } from '$lib/ble/protocol';
import type { Measurement } from '$lib/types';

afterEach(cleanup);

function makeMeasurement(): Measurement {
	const res = calcFullBodyComposition({
		weightKg: 72.2,
		heightCm: 173,
		age: 37,
		sex: Sex.MALE,
		z50khzOhm: 448,
		z100khzOhm: 418
	});
	if (!res.ok) throw new Error('expected a body');
	return {
		id: 'test',
		timestamp: '2026-07-07T08:00:00.000Z',
		weightKg: 72.2,
		z50khzOhm: 448,
		z100khzOhm: 418,
		inputs: { ageYears: 37, sex: 'male', heightCm: 173, athlete: false },
		body: res.body
	};
}

describe('ResultCard renders populated state', () => {
	it('shows the weight, key metrics, and level badges without error', () => {
		const { getByText, container } = render(ResultCard, {
			props: { measurement: makeMeasurement(), units: 'kg' }
		});
		const text = container.textContent ?? '';
		expect(text).toContain('72.2 kg'); // headline weight
		expect(text).toContain('Body fat');
		expect(text).toContain('21.4'); // hardware-confirmed fat %
		expect(text).toContain('Standard+'); // a level badge
		expect(getByText('BMR')).toBeTruthy();
		expect(getByText('Visceral fat')).toBeTruthy();
	});

	it('shows the empty state when there is no measurement', () => {
		const { container } = render(ResultCard, { props: { measurement: null, units: 'kg' } });
		expect(container.textContent ?? '').toContain('no reading yet');
	});

	it('shows a weight-only note when body composition is unavailable', () => {
		const m = makeMeasurement();
		m.body = null;
		const { container } = render(ResultCard, { props: { measurement: m, units: 'kg' } });
		expect(container.textContent ?? '').toContain('Weight only');
	});
});

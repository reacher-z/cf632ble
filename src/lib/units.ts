/** Weight unit conversion. Canonical storage/compute is always kg; this is display-only. */

import type { Units } from '$lib/types';

const LB_PER_KG = 2.2046226218;

export function kgToDisplay(kg: number, units: Units): number {
	return units === 'lb' ? kg * LB_PER_KG : kg;
}

export function displayToKg(value: number, units: Units): number {
	return units === 'lb' ? value / LB_PER_KG : value;
}

export function unitLabel(units: Units): string {
	return units;
}

/** Format a kg weight in the chosen units with a unit suffix (e.g. "71.6 kg" / "157.9 lb"). */
export function formatWeight(kg: number, units: Units, digits = 1): string {
	return `${kgToDisplay(kg, units).toFixed(digits)} ${units}`;
}

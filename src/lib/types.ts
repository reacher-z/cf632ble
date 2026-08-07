/** Shared app data model (persisted to localStorage; see WEB-APP-PLAN §6). */

import type { FullBodyComposition } from '$lib/bia/vendor-bia';

export type SexStr = 'male' | 'female';
export type Units = 'kg' | 'lb';

/** The single-user profile. */
export interface Profile {
	ageYears: number;
	sex: SexStr;
	heightCm: number;
	athlete: boolean;
	/** on-scale member slot ("P-index"); default 1 for a single-user app */
	pIndex: number;
	/** display units only — storage/compute is always kg */
	units: Units;
	/** seed for the profile-push packet (field 6); usually the most recent weight */
	lastKnownWeightKg?: number;
	/**
	 * Wire identity used when this profile is registered as a member on the scale
	 * (BLE-PROTOCOL.md §5.1.3). `memberId` is what a later delete targets, so it must stay stable
	 * once a member has been registered with it — and it must never be blank, since a blank
	 * memberId means "every member under this account" (§5.1.5).
	 *
	 * Generated on demand (`ensureScaleIdentity`) rather than at profile creation: a user who never
	 * touches the Device tab never registers anything on the scale, and never needs one. Purely
	 * local — nothing leaves the browser.
	 */
	userId?: string;
	memberId?: string;
}

/** The profile inputs actually used for a given reading, snapshotted so results stay reproducible. */
export interface MeasurementInputs {
	ageYears: number;
	sex: SexStr;
	heightCm: number;
	athlete: boolean;
}

export interface Measurement {
	id: string;
	/** ISO 8601 */
	timestamp: string;
	weightKg: number;
	z50khzOhm: number | null;
	z100khzOhm: number | null;
	inputs: MeasurementInputs;
	/** full computed body composition; null if impedance was unavailable (weight-only reading) */
	body: FullBodyComposition | null;
}

export const DEFAULT_PROFILE: Profile = {
	ageYears: 30,
	sex: 'male',
	heightCm: 170,
	athlete: false,
	pIndex: 1,
	units: 'kg'
};

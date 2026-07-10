/** The single-user profile store (persisted to localStorage). */

import { persistedStore } from './persistence';
import { DEFAULT_PROFILE, type Profile, type SexStr } from '$lib/types';
import { Sex, type UserProfileInput } from '$lib/ble/protocol';

export const profile = persistedStore<Profile>('profile', DEFAULT_PROFILE, (stored, initial) => ({
	// Merge so profiles saved before a field existed still get sane defaults.
	...initial,
	...stored
}));

/** UI-flow state, not part of the domain profile — kept separate so it doesn't end up in data exports. */
export const onboarded = persistedStore<boolean>('onboarded', false);

export function sexToEnum(sex: SexStr): Sex {
	return sex === 'male' ? Sex.MALE : Sex.FEMALE;
}

/** Build the protocol-layer profile-push input from the app profile. */
export function toUserProfileInput(p: Profile, weightKg?: number): UserProfileInput {
	return {
		ageYears: p.ageYears,
		sex: sexToEnum(p.sex),
		heightCm: Math.round(p.heightCm),
		pIndex: p.pIndex,
		athlete: p.athlete,
		weightKg: weightKg ?? p.lastKnownWeightKg ?? 70.0
	};
}

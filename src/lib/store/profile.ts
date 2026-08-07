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
		weightKg: weightKg ?? p.lastKnownWeightKg ?? 70.0,
		userId: p.userId,
		memberId: p.memberId
	};
}

/**
 * Random UUID. `crypto.randomUUID` needs a secure context — which Web Bluetooth also requires, so
 * it is always there when it matters — but fall back to random bytes so a plain-HTTP dev server
 * doesn't throw. Exported because every generated wire id must come from here: calling
 * `crypto.randomUUID()` directly reintroduces the crash this guards against.
 */
export function randomId(): string {
	if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Make sure this profile has the stable wire identity a scale registration needs, and persist it.
 * Returns the profile with both ids populated.
 *
 * `scaleAccountId` is the account id the scale reports in its member-list header, and it is
 * **adopted whenever it is non-empty** — including over an id this app minted earlier.
 *
 * That asymmetry is deliberate. The scale models exactly one account: the member-list response
 * (BLE-PROTOCOL.md §5.2) carries a *single* `userId` at `[0:64]` shared by every record, and
 * "delete all members" (§5.1.5) is scoped by it. A second account id is not representable, so
 * registering under a self-minted one onto a scale that already holds vendor-app members would put
 * the header out of step with what the scale stores. Only mint when the scale has no account of its
 * own to adopt.
 *
 * `memberId`, by contrast, is minted once and never replaced: it is what a delete targets, so
 * changing it would orphan an already-registered member (§5.1.3). Deletion is unaffected by any of
 * this either way — it uses the `userId` carried on the member record itself.
 */
export function ensureScaleIdentity(scaleAccountId?: string): Profile {
	let resolved!: Profile;
	profile.update((p) => {
		resolved = {
			...p,
			userId: scaleAccountId || p.userId || randomId(),
			memberId: p.memberId || randomId()
		};
		return resolved;
	});
	return resolved;
}

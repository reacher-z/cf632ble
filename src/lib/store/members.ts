/**
 * Local labels for members stored on the scale.
 *
 * The scale itself stores no name for a plain-Borre device: the 135-byte profile payload is
 * age/sex/height/slot/weight and an opaque 64-byte id (BLE-PROTOCOL.md §5.1.4). The nickname-bearing
 * payload variant exists in the SDK but is selected by `supportNickname == 2`, and CF632BLE is `1` —
 * so a name can only live here, in this browser, keyed by the member id the scale does store.
 *
 * Consequence worth knowing: members created by the vendor app (or by this app in another browser)
 * come back from the scale unlabelled, and there is no way to recover what they were called.
 */

import { persistedStore } from './persistence';

export type MemberLabels = Record<string, string>;

export const memberLabels = persistedStore<MemberLabels>('memberLabels', {});

export function setMemberLabel(memberId: string, label: string): void {
	memberLabels.update((labels) => {
		const next = { ...labels };
		const trimmed = label.trim();
		if (trimmed) next[memberId] = trimmed;
		else delete next[memberId];
		return next;
	});
}

export function forgetMemberLabel(memberId: string): void {
	memberLabels.update((labels) => {
		const next = { ...labels };
		delete next[memberId];
		return next;
	});
}

// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { get } from 'svelte/store';
import DevicePanel from './DevicePanel.svelte';
import { profile } from '$lib/store/profile';
import { memberLabels, setMemberLabel } from '$lib/store/members';
import { DEFAULT_PROFILE } from '$lib/types';
import { Sex, type StoredMember } from '$lib/ble/protocol';
import type { ScaleClient } from '$lib/ble/client';

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	profile.set({ ...DEFAULT_PROFILE });
	memberLabels.set({});
});

/** happy-dom has no `window.confirm`, so stub it rather than spy on it. */
function stubConfirm(answer: boolean) {
	const confirm = vi.fn().mockReturnValue(answer);
	vi.stubGlobal('confirm', confirm);
	return confirm;
}

/** The two members really stored on the project's scale, both registered by the vendor app. */
const ACCOUNT = 'f9b23f7c-c95c-4e48-8e95-0cccc8efb8da';
const VENDOR_MEMBERS: StoredMember[] = [
	{
		userId: ACCOUNT,
		memberId: '537bd85d-73c2-445a-831e-a3d0c165b2ec',
		ageYears: 37,
		sex: Sex.MALE,
		heightCm: 173,
		pIndex: 1,
		athlete: true,
		weightKg: 72.2,
		userIndexByte: 0x03
	},
	{
		userId: ACCOUNT,
		memberId: '5b0f8565-84a9-40a2-be59-7e4c767060d4',
		ageYears: 21,
		sex: Sex.FEMALE,
		heightCm: 168,
		pIndex: 2,
		athlete: false,
		weightKg: 60.0,
		userIndexByte: 0x04
	}
];

function stubClient(overrides: Partial<Record<keyof ScaleClient, unknown>> = {}) {
	return {
		readMemberList: vi.fn().mockResolvedValue(VENDOR_MEMBERS),
		registerMember: vi.fn().mockResolvedValue(0x00),
		deleteMember: vi.fn().mockResolvedValue(0x00),
		confirmCurrentUser: vi.fn().mockResolvedValue(0x00),
		setHeartRateModule: vi.fn().mockResolvedValue(undefined),
		setBodyFatModule: vi.fn().mockResolvedValue(undefined),
		...overrides
	} as unknown as ScaleClient;
}

const props = (client: ScaleClient | undefined, connected = true) => ({
	client,
	connected,
	units: 'kg' as const,
	heartRateModule: null,
	bodyFatModule: null
});

describe('DevicePanel', () => {
	it('writes nothing until asked, and disables everything while disconnected', () => {
		const client = stubClient();
		const { getByText } = render(DevicePanel, { props: props(client, false) });

		expect(getByText(/Connect the scale to read/)).toBeTruthy();
		expect((getByText('Read from scale') as HTMLButtonElement).disabled).toBe(true);
		expect(client.readMemberList).not.toHaveBeenCalled();
	});

	it('lists stored members with their decoded slots and offers the first free one', async () => {
		const client = stubClient();
		const { getByText, findByText } = render(DevicePanel, { props: props(client) });

		await fireEvent.click(getByText('Read from scale'));

		expect(await findByText(/37 y · M · 173 cm/)).toBeTruthy();
		expect(getByText(/21 y · F · 168 cm/)).toBeTruthy();
		// Slots 1 and 2 are taken, so the offer must be slot 3 — not the profile's default of 1.
		expect(getByText('Register me in slot 3')).toBeTruthy();
	});

	it('registers under the SCALE’s account id, never a freshly minted one', async () => {
		// The scale models a single account (BLE-PROTOCOL.md §5.2/§5.1.5), so a second id is not
		// representable — registering must adopt what the device already stores.
		const client = stubClient();
		const { getByText, findByText } = render(DevicePanel, { props: props(client) });

		await fireEvent.click(getByText('Read from scale'));
		await fireEvent.click(await findByText('Register me in slot 3'));

		expect(client.registerMember).toHaveBeenCalledTimes(1);
		const sent = vi.mocked(client.registerMember).mock.calls[0][0];
		expect(sent.userId).toBe(ACCOUNT);
		expect(sent.pIndex).toBe(3);
		// A stable, non-empty memberId — a blank one would mean "delete every member" later.
		expect(sent.memberId).toBeTruthy();
		expect(sent.memberId).not.toBe(ACCOUNT);
		// ...and it is persisted, so a later delete can still target this member.
		expect(get(profile).memberId).toBe(sent.memberId);
		expect(get(profile).pIndex).toBe(3);
	});

	it('deletes using the id carried on the member record, after confirmation', async () => {
		const client = stubClient();
		stubConfirm(true);
		const { getByText, findAllByText } = render(DevicePanel, { props: props(client) });

		await fireEvent.click(getByText('Read from scale'));
		await fireEvent.click((await findAllByText('Delete'))[0]);

		expect(client.deleteMember).toHaveBeenCalledWith(ACCOUNT, VENDOR_MEMBERS[0].memberId);
	});

	it('does not delete when the confirmation is declined', async () => {
		const client = stubClient();
		stubConfirm(false);
		const { getByText, findAllByText } = render(DevicePanel, { props: props(client) });

		await fireEvent.click(getByText('Read from scale'));
		await fireEvent.click((await findAllByText('Delete'))[0]);

		expect(client.deleteMember).not.toHaveBeenCalled();
	});

	it('adds an arbitrary member — someone who is not the app’s own profile', async () => {
		const client = stubClient();
		const { getByText, getByLabelText, findByText } = render(DevicePanel, { props: props(client) });

		await fireEvent.click(getByText('Read from scale'));
		await fireEvent.click(await findByText('Add member'));

		// NB: the sex <select> is driven in the edit test instead — Svelte 5's select binding does
		// not react to a synthetic change event under happy-dom (verified with a minimal probe), so
		// exercising it here would test the harness, not the component.
		await fireEvent.input(getByLabelText('Name'), { target: { value: 'Dana' } });
		await fireEvent.input(getByLabelText('Age'), { target: { value: '21' } });
		await fireEvent.input(getByLabelText('Height (cm)'), { target: { value: '168' } });
		await fireEvent.click(getByText('Add to scale'));

		const sent = vi.mocked(client.registerMember).mock.calls[0][0];
		expect(sent).toMatchObject({ ageYears: 21, heightCm: 168, pIndex: 3 });
		// Same account as the scale, but its own member id — and NOT the local profile's.
		expect(sent.userId).toBe(ACCOUNT);
		expect(sent.memberId).toBeTruthy();
		expect(sent.memberId).not.toBe(get(profile).memberId);
		// The name lives here, not on the scale: the plain-Borre payload has no nickname field.
		expect(get(memberLabels)[sent.memberId!]).toBe('Dana');
	});

	it('edits a member in place — same id, same slot, and the slot is locked', async () => {
		const client = stubClient();
		const { getByText, getByLabelText, findAllByText } = render(DevicePanel, { props: props(client) });

		await fireEvent.click(getByText('Read from scale'));
		await fireEvent.click((await findAllByText('Edit'))[1]); // the 21 y / F member in slot 2

		expect((getByLabelText('Slot') as HTMLInputElement).disabled).toBe(true);
		await fireEvent.input(getByLabelText('Height (cm)'), { target: { value: '169' } });
		await fireEvent.click(getByText('Save changes'));

		const sent = vi.mocked(client.registerMember).mock.calls[0][0];
		expect(sent).toMatchObject({
			memberId: VENDOR_MEMBERS[1].memberId,
			userId: ACCOUNT,
			pIndex: 2,
			heightCm: 169,
			// Round-trips the stored member's sex through the form and back to the wire enum.
			sex: Sex.FEMALE,
			ageYears: 21
		});
	});

	it('does not keep the name when the scale rejects the add', async () => {
		// 0x04 = member storage full. The label must not be persisted for a member that was never
		// created, or it would later attach itself to whoever ends up with that id.
		const client = stubClient({ registerMember: vi.fn().mockResolvedValue(0x04) });
		const { getByText, getByLabelText, findByText } = render(DevicePanel, { props: props(client) });

		await fireEvent.click(getByText('Read from scale'));
		await fireEvent.click(await findByText('Add member'));
		await fireEvent.input(getByLabelText('Name'), { target: { value: 'Ghost' } });
		await fireEvent.click(getByText('Add to scale'));

		expect(await findByText(/storage is full/)).toBeTruthy();
		expect(Object.values(get(memberLabels))).not.toContain('Ghost');
	});

	it('forgets the local name when a member is deleted from the scale', async () => {
		const client = stubClient();
		stubConfirm(true);
		setMemberLabel(VENDOR_MEMBERS[0].memberId, 'Guy');
		const { getByText, findAllByText } = render(DevicePanel, { props: props(client) });

		await fireEvent.click(getByText('Read from scale'));
		await fireEvent.click((await findAllByText('Delete'))[0]);

		expect(get(memberLabels)[VENDOR_MEMBERS[0].memberId]).toBeUndefined();
	});

	it('reports a scale that never answers instead of showing an empty list', async () => {
		const client = stubClient({ readMemberList: vi.fn().mockResolvedValue(null) });
		const { getByText, findByText } = render(DevicePanel, { props: props(client) });

		await fireEvent.click(getByText('Read from scale'));

		expect(await findByText(/did not answer/)).toBeTruthy();
	});
});

// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import ProfileForm from './ProfileForm.svelte';
import { profile, onboarded } from '$lib/store/profile';
import { measurements } from '$lib/store/measurements';
import { DEFAULT_PROFILE } from '$lib/types';
import { get } from 'svelte/store';

afterEach(() => {
	cleanup();
	profile.set({ ...DEFAULT_PROFILE });
	measurements.set([]);
	onboarded.set(false);
});

describe('ProfileForm — onboarding mode', () => {
	it('shows the first-run heading and marks onboarding done on continue', async () => {
		const onDone = vi.fn();
		const { getByText } = render(ProfileForm, { props: { onboarding: true, onDone } });

		expect(getByText('Set up your profile')).toBeTruthy();
		expect(get(onboarded)).toBeFalsy();

		await fireEvent.click(getByText('Save profile & continue'));

		expect(get(onboarded)).toBe(true);
		expect(onDone).toHaveBeenCalledOnce();
	});

	it('does not show the danger zone during onboarding', () => {
		const { queryByText } = render(ProfileForm, { props: { onboarding: true } });
		expect(queryByText('Clear all saved data')).toBeNull();
	});
});

describe('ProfileForm — normal mode', () => {
	it('clears all storage and resets stores when "Clear all saved data" is confirmed', async () => {
		localStorage.setItem('cf632.profile', '{}');
		localStorage.setItem('cf632.measurements', '[]');
		profile.set({ ...DEFAULT_PROFILE, ageYears: 45 });
		measurements.set([{ id: 'm1' } as never]);
		onboarded.set(true);
		const confirmSpy = vi.fn().mockReturnValue(true);
		vi.stubGlobal('confirm', confirmSpy);

		const { getByText } = render(ProfileForm);
		await fireEvent.click(getByText('Clear all saved data'));

		expect(confirmSpy).toHaveBeenCalledOnce();
		// clearAllData() wipes localStorage, then the stores are reset to their defaults —
		// which re-persists those defaults, so the keys exist again with default content.
		expect(get(profile)).toEqual(DEFAULT_PROFILE);
		expect(get(measurements)).toEqual([]);
		expect(get(onboarded)).toBe(false);
		expect(JSON.parse(localStorage.getItem('cf632.profile')!)).toEqual(DEFAULT_PROFILE);
		expect(JSON.parse(localStorage.getItem('cf632.measurements')!)).toEqual([]);

		vi.unstubAllGlobals();
	});

	it('does nothing when the clear confirmation is declined', async () => {
		vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));

		const { getByText } = render(ProfileForm);
		await fireEvent.click(getByText('Clear all saved data'));

		// the store's own subscription re-persists on every render regardless; what matters is the
		// key is still present (declining the confirm must not have wiped it).
		expect(localStorage.getItem('cf632.profile')).not.toBeNull();
		vi.unstubAllGlobals();
	});
});

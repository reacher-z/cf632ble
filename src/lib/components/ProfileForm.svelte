<script lang="ts">
	import { profile, onboarded } from '$lib/store/profile';
	import { measurements } from '$lib/store/measurements';
	import { DEFAULT_PROFILE, type Profile } from '$lib/types';
	import { kgToDisplay, displayToKg, unitLabel } from '$lib/units';
	import { clearAllData } from '$lib/store/persistence';

	let { onboarding = false, onDone }: { onboarding?: boolean; onDone?: () => void } = $props();

	// Local editable snapshot; persisted back to the store on change.
	let p = $state<Profile>({ ...$profile });

	$effect(() => {
		// Persist whenever any field changes (reads all props so the effect tracks them all).
		// userId/memberId are carried through untouched: they are not editable here, and dropping
		// them would orphan a member already registered on the scale under that memberId (it is
		// what a delete targets — BLE-PROTOCOL.md §5.1.3).
		profile.set({
			ageYears: p.ageYears,
			sex: p.sex,
			heightCm: p.heightCm,
			athlete: p.athlete,
			pIndex: p.pIndex,
			units: p.units,
			lastKnownWeightKg: p.lastKnownWeightKg,
			userId: p.userId,
			memberId: p.memberId
		});
	});

	function finishOnboarding() {
		onboarded.set(true);
		onDone?.();
	}

	function clearAll() {
		if (!confirm('Delete everything saved by this app — profile, all measurements, and settings? This cannot be undone.'))
			return;
		clearAllData();
		profile.set(DEFAULT_PROFILE);
		measurements.set([]);
		onboarded.set(false);
	}

	// Seed weight is edited in the chosen display unit but stored as kg.
	let seedWeightDisplay = $state(
		$profile.lastKnownWeightKg != null
			? Number(kgToDisplay($profile.lastKnownWeightKg, $profile.units).toFixed(1))
			: undefined
	);
	$effect(() => {
		p.lastKnownWeightKg =
			seedWeightDisplay != null && seedWeightDisplay > 0
				? displayToKg(seedWeightDisplay, p.units)
				: undefined;
	});
</script>

<section class="panel form">
	<span class="eyebrow">profile</span>
	{#if onboarding}
		<h2 class="title">Set up your profile</h2>
		<p class="lead">
			Before your first weigh-in, tell the app about yourself. Age, sex and height are what the
			on-device body-composition math needs — the scale itself only ever sends weight and
			impedance. Everything stays on this device; nothing is uploaded anywhere.
		</p>
	{:else}
		<p class="lead">
			Used for the on-device body-composition math — the scale only sends weight and impedance.
			Stays on this device.
		</p>
	{/if}

	<div class="grid">
		<div class="field">
			<label for="age">Age</label>
			<input id="age" type="number" min="6" max="99" bind:value={p.ageYears} />
		</div>

		<div class="field">
			<label for="sex">Sex</label>
			<select id="sex" bind:value={p.sex}>
				<option value="male">Male</option>
				<option value="female">Female</option>
			</select>
		</div>

		<div class="field">
			<label for="height">Height (cm)</label>
			<input id="height" type="number" min="90" max="220" bind:value={p.heightCm} />
		</div>

		<div class="field">
			<label for="units">Units</label>
			<select id="units" bind:value={p.units}>
				<option value="kg">kg</option>
				<option value="lb">lb</option>
			</select>
		</div>

		<div class="field">
			<label for="seed">Last weight ({unitLabel(p.units)})</label>
			<input id="seed" type="number" min="0" step="0.1" bind:value={seedWeightDisplay} placeholder="optional" />
		</div>

		<div class="field">
			<label for="pindex">Scale member slot</label>
			<input id="pindex" type="number" min="1" max="127" bind:value={p.pIndex} />
		</div>
	</div>

	<p class="lead slot-note">
		The member slot only matters if you register this profile onto the scale from the
		<strong>Device</strong> tab — measurements never need it. Pick a free slot there rather than
		guessing here; registering overwrites whoever already occupies the slot.
	</p>

	<label class="check">
		<input type="checkbox" bind:checked={p.athlete} />
		<span>Athlete mode <em>— adjusts body-fat / muscle for trained bodies</em></span>
	</label>

	{#if onboarding}
		<button class="btn primary continue" onclick={finishOnboarding}>Save profile &amp; continue</button>
	{/if}
</section>

{#if !onboarding}
	<section class="panel danger-zone">
		<span class="eyebrow">danger zone</span>
		<div class="row">
			<p class="lead">
				Permanently deletes your profile, all saved measurements, and app settings from this
				browser.
			</p>
			<button class="btn ghost danger" onclick={clearAll}>Clear all saved data</button>
		</div>
	</section>
{/if}

<style>
	.form {
		padding: 18px 20px 20px;
	}
	.title {
		margin: 10px 0 0;
		font-size: 19px;
	}
	.lead {
		margin: 8px 0 16px;
		color: var(--muted);
		font-size: 13.5px;
		max-width: 60ch;
	}
	.slot-note {
		margin: 14px 0 0;
	}
	.continue {
		margin-top: 20px;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
		gap: 13px;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 9px;
		margin-top: 16px;
		font-size: 14px;
		color: var(--ink);
		cursor: pointer;
	}
	.check input {
		width: auto;
	}
	.check em {
		color: var(--muted);
		font-style: normal;
		font-size: 12.5px;
	}

	.danger-zone {
		margin-top: 16px;
		padding: 18px 20px 20px;
		border-color: color-mix(in srgb, var(--lv-danger) 35%, var(--line));
	}
	.danger-zone .row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
	}
	.danger-zone .lead {
		margin: 8px 0 0;
	}
	.danger {
		flex-shrink: 0;
		border-color: color-mix(in srgb, var(--lv-danger) 45%, var(--line-strong));
		color: var(--lv-danger);
	}
</style>

<script lang="ts">
	/**
	 * Device tab — manages what lives on the *scale*, as opposed to what lives in this browser.
	 *
	 * The scale stores its own member list: age/sex/height/weight per slot ("PIndex"), which is what
	 * its own display and its own history attribute readings to. This app does not need any of that
	 * to work — body composition is computed here, on-device — so everything on this screen is
	 * optional, and every write is behind an explicit click.
	 *
	 * Deliberately absent: "delete all members" and the device factory reset. Both are documented in
	 * BLE-PROTOCOL.md §10 as decompilation-only (never tested against real hardware), and both are
	 * unrecoverable — a wiped member list can only be restored with the vendor app. The Python POC
	 * in `poc/` has them behind a typed confirmation for anyone who wants to test them.
	 */
	import type { ScaleClient } from '$lib/ble/client';
	import { pickFreePIndex, Sex, type StoredMember } from '$lib/ble/protocol';
	import { profile, ensureScaleIdentity, toUserProfileInput, randomId } from '$lib/store/profile';
	import { memberLabels, setMemberLabel, forgetMemberLabel } from '$lib/store/members';
	import { kgToDisplay, displayToKg, unitLabel } from '$lib/units';
	import type { Units } from '$lib/types';

	let {
		client,
		connected,
		units,
		heartRateModule,
		bodyFatModule
	}: {
		client: ScaleClient | undefined;
		connected: boolean;
		units: Units;
		heartRateModule: boolean | null;
		bodyFatModule: boolean | null;
	} = $props();

	let members = $state<StoredMember[] | null>(null);
	let busy = $state<string | null>(null);
	let note = $state<string | null>(null);
	let error = $state<string | null>(null);

	const freeSlot = $derived(members ? pickFreePIndex(members) : null);
	const mine = $derived(
		members && $profile.memberId ? members.find((m) => m.memberId === $profile.memberId) : undefined
	);
	/**
	 * The account id the scale already stores (one per device, shared by every member — §5.2).
	 * Registering must reuse it rather than inventing a second account the scale cannot represent;
	 * see `ensureScaleIdentity`. Empty when the scale holds no members yet.
	 */
	const scaleAccountId = $derived(members?.find((m) => m.userId)?.userId ?? '');

	async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
		if (!client || busy) return;
		busy = label;
		error = null;
		note = null;
		try {
			return await fn();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = null;
		}
	}

	function refresh() {
		return run('Reading member list…', async () => {
			const list = await client!.readMemberList();
			if (list === null) {
				error = 'The scale did not answer the member-list request. Step on it to wake it and try again.';
				return;
			}
			members = list;
			note = list.length ? null : 'The scale has no members stored.';
		});
	}

	/** Register your own profile — the one that owns this app's measurement history. */
	function registerMe(slot: number) {
		// Adopt the scale's own account id (see `scaleAccountId`) — never register under a competing
		// one. `members` is always populated here: the button only renders after a read.
		const identity = ensureScaleIdentity(scaleAccountId);
		return submit(toUserProfileInput({ ...identity, pIndex: slot }), `slot ${slot}`, () =>
			profile.update((p) => ({ ...p, pIndex: slot }))
		);
	}

	/**
	 * Register any member, mine or someone else's. Same wire operation either way (§5.1.2) — the
	 * scale stores a member per slot and neither knows nor cares which of them is "you".
	 */
	function submit(
		input: Parameters<ScaleClient['registerMember']>[0],
		where: string,
		onSuccess?: () => void
	) {
		return run('Saving…', async () => {
			const status = await client!.registerMember(input);
			if (status === 0x00) {
				onSuccess?.();
				note = `Saved to ${where}.`;
				closeForm();
				await refreshQuietly();
			} else if (status === null) {
				error = 'No result from the scale — nothing was saved.';
			} else if (status === 0x04) {
				error = 'The scale reports its member storage is full. Delete a member first.';
			} else {
				error = `The scale rejected it (status 0x${status.toString(16).padStart(2, '0')}).`;
			}
		});
	}

	function remove(member: StoredMember) {
		const who =
			member.memberId === $profile.memberId
				? 'your profile'
				: nameOf(member) || `the member in slot ${member.pIndex}`;
		if (
			!confirm(
				`Delete ${who} from the scale? This removes it from the scale only — your measurements in this app are untouched.`
			)
		)
			return;
		return run('Deleting…', async () => {
			const status = await client!.deleteMember(member.userId, member.memberId);
			if (status === 0x00) {
				forgetMemberLabel(member.memberId);
				note = `Deleted the member in slot ${member.pIndex}.`;
				if (editingMember?.memberId === member.memberId) closeForm();
				await refreshQuietly();
			} else if (status === null) {
				error = 'No result from the scale — the deletion did not complete.';
			} else {
				error = `The scale refused the deletion (status 0x${status.toString(16).padStart(2, '0')}).`;
			}
		});
	}

	function announceMe(member: StoredMember) {
		return run('Announcing…', async () => {
			const status = await client!.confirmCurrentUser(member.userId, member.memberId);
			note =
				status === 0x00
					? `The scale will attribute the next weigh-in to slot ${member.pIndex}.`
					: `The scale answered status ${status === null ? '(none)' : '0x' + status.toString(16)}.`;
		});
	}

	/** Re-read after a mutation without clobbering the note/error the mutation just set. */
	async function refreshQuietly() {
		const list = await client!.readMemberList();
		if (list !== null) members = list;
	}

	// --- Add / edit an arbitrary member ---------------------------------------------------------
	// Registration is one operation: "add" and "edit" differ only in whether the member id is new
	// and whether the slot is fixed. Re-registering an existing id into its existing slot updates it
	// in place, which is what the vendor app's "renew" control does too (§5.1.2).

	/** The member being edited, or 'new'; null when the form is closed. */
	let editing = $state<StoredMember | 'new' | null>(null);
	let form = $state({ label: '', ageYears: 30, sex: 'male' as 'male' | 'female', heightCm: 170, athlete: false, weightDisplay: 70, slot: 1 });

	const editingMember = $derived(editing && editing !== 'new' ? editing : null);
	const nameOf = (m: StoredMember) => $memberLabels[m.memberId] ?? '';

	function openAdd() {
		if (freeSlot === null) {
			error = 'Every slot on the scale is occupied — delete a member first.';
			return;
		}
		error = null;
		note = null;
		editing = 'new';
		form = {
			label: '',
			ageYears: 30,
			sex: 'male',
			heightCm: 170,
			athlete: false,
			weightDisplay: Number(kgToDisplay(70, units).toFixed(1)),
			slot: freeSlot
		};
	}

	function openEdit(m: StoredMember) {
		error = null;
		note = null;
		editing = m;
		form = {
			label: nameOf(m),
			ageYears: m.ageYears,
			sex: m.sex === Sex.MALE ? 'male' : 'female',
			heightCm: m.heightCm,
			athlete: m.athlete,
			weightDisplay: Number(kgToDisplay(m.weightKg, units).toFixed(1)),
			slot: m.pIndex
		};
	}

	function closeForm() {
		editing = null;
	}

	function saveForm() {
		if (!editing) return;
		// A new member needs an id that will still identify it on a later delete, and it must be
		// non-empty — a blank one is the scale's "every member" wildcard (§5.1.5).
		const memberId = editingMember?.memberId ?? randomId();
		// One account id for the whole device (§5.2): whatever the scale already stores, else the one
		// this app minted for its own profile, so every member we add stays in the same account.
		const userId = editingMember?.userId || scaleAccountId || ensureScaleIdentity(scaleAccountId).userId!;

		const label = form.label;
		return submit(
			{
				ageYears: form.ageYears,
				sex: form.sex === 'male' ? Sex.MALE : Sex.FEMALE,
				heightCm: Math.round(form.heightCm),
				pIndex: form.slot,
				athlete: form.athlete,
				weightKg: displayToKg(form.weightDisplay, units),
				userId,
				memberId
			},
			`slot ${form.slot}`,
			// Only after the scale confirms — otherwise a failed add leaves a label naming a member
			// that does not exist, and it would attach to whoever later lands on that id.
			() => setMemberLabel(memberId, label)
		);
	}

	function toggleModule(which: 'heart' | 'fat', on: boolean) {
		return run('Updating…', async () => {
			if (which === 'heart') await client!.setHeartRateModule(on);
			else await client!.setBodyFatModule(on);
		});
	}

	const describe = (m: StoredMember) =>
		`${m.ageYears} y · ${m.sex === Sex.MALE ? 'M' : 'F'} · ${m.heightCm} cm · ${kgToDisplay(m.weightKg, units).toFixed(1)} ${unitLabel(units)}`;
</script>

<section class="panel block">
	<div class="head">
		<div>
			<span class="eyebrow">members on the scale</span>
			<p class="lead">
				The scale keeps its own profiles, one per slot — this is what its display and its own
				stored history use. This app doesn't need them: it computes body composition here, from
				weight and impedance. Manage them only if you also use the scale standalone or with the
				vendor app.
			</p>
		</div>
		<button class="btn" onclick={refresh} disabled={!connected || !!busy}>
			{members === null ? 'Read from scale' : 'Refresh'}
		</button>
	</div>

	{#if !connected}
		<p class="state">Connect the scale to read or change its member list.</p>
	{:else if busy}
		<p class="state">{busy}</p>
	{:else if members === null}
		<p class="state">Not read yet.</p>
	{:else if members.length === 0}
		<p class="state">No members stored on the scale.</p>
	{:else}
		<ul class="members">
			{#each members as m (m.memberId + m.pIndex)}
				<li class:me={m.memberId === $profile.memberId}>
					<span class="slot num">{m.pIndex}</span>
					<div class="who">
						<span class="line">
							{#if nameOf(m)}<strong>{nameOf(m)}</strong>{/if}
							{describe(m)}
							{#if m.athlete}<span class="chip">athlete</span>{/if}
							{#if m.memberId === $profile.memberId}<span class="chip you">you</span>{/if}
						</span>
						<span class="id num" title={m.memberId}>{m.memberId || '(no id)'}</span>
					</div>
					<div class="actions">
						<button class="btn ghost" onclick={() => openEdit(m)}>Edit</button>
						<button
							class="btn ghost"
							onclick={() => announceMe(m)}
							title="Tell the scale this member is the one weighing in next"
						>
							Set as current
						</button>
						<button class="btn ghost danger" onclick={() => remove(m)}>Delete</button>
					</div>
				</li>
			{/each}
		</ul>
	{/if}

	{#if connected && members !== null && !busy && !editing}
		<div class="register">
			<div class="reg-text">
				{#if mine}
					<p class="state">
						Your own profile is in slot {mine.pIndex}. Updating rewrites it from the Profile tab's
						current age, sex and height.
					</p>
				{:else if freeSlot !== null}
					<p class="state">
						Add anyone who uses this scale. Your own profile — the one this app's measurements belong
						to — can be registered in one click.
					</p>
				{:else}
					<p class="state">Every slot is occupied. Delete a member to free one.</p>
				{/if}
			</div>
			<div class="actions">
				{#if mine}
					<button class="btn" onclick={() => registerMe(mine.pIndex)}>Update my slot</button>
				{:else if freeSlot !== null}
					<button class="btn" onclick={() => registerMe(freeSlot)}>
						Register me in slot {freeSlot}
					</button>
				{/if}
				<button class="btn primary" onclick={openAdd} disabled={freeSlot === null}>Add member</button>
			</div>
		</div>
	{/if}

	{#if editing}
		<div class="editor">
			<h3>{editingMember ? `Edit slot ${editingMember.pIndex}` : `New member in slot ${form.slot}`}</h3>

			<div class="grid">
				<div class="field">
					<label for="m-label">Name</label>
					<input id="m-label" bind:value={form.label} placeholder="optional" />
				</div>
				<div class="field">
					<label for="m-age">Age</label>
					<input id="m-age" type="number" min="6" max="99" bind:value={form.ageYears} />
				</div>
				<div class="field">
					<label for="m-sex">Sex</label>
					<select id="m-sex" bind:value={form.sex}>
						<option value="male">Male</option>
						<option value="female">Female</option>
					</select>
				</div>
				<div class="field">
					<label for="m-height">Height (cm)</label>
					<input id="m-height" type="number" min="90" max="220" bind:value={form.heightCm} />
				</div>
				<div class="field">
					<label for="m-weight">Starting weight ({unitLabel(units)})</label>
					<input id="m-weight" type="number" min="0" step="0.1" bind:value={form.weightDisplay} />
				</div>
				<div class="field">
					<label for="m-slot">Slot</label>
					<input
						id="m-slot"
						type="number"
						min="1"
						max="127"
						bind:value={form.slot}
						disabled={!!editingMember}
					/>
				</div>
			</div>

			<label class="check">
				<input type="checkbox" bind:checked={form.athlete} />
				<span>Athlete mode</span>
			</label>

			<p class="footnote">
				{#if editingMember}
					The slot is fixed while editing — the scale keys a member to its slot, so moving one means
					deleting it and adding it again.
				{:else}
					Registering into an occupied slot overwrites whoever is in it.
				{/if}
				The name is stored in this browser only: the scale has no field for it, so members added
				elsewhere show up here unnamed.
			</p>

			<div class="actions">
				<button class="btn primary" type="button" onclick={saveForm}>
					{editingMember ? 'Save changes' : 'Add to scale'}
				</button>
				<button class="btn ghost" type="button" onclick={closeForm}>Cancel</button>
			</div>
		</div>
	{/if}

	{#if error}<p class="msg bad">{error}</p>{/if}
	{#if note}<p class="msg ok">{note}</p>{/if}
</section>

<section class="panel block">
	<span class="eyebrow">measurement modules</span>
	<p class="lead">
		Persistent settings stored in the scale, not in this app. With the body-fat module off the
		scale sends weight only, and readings here lose every body-composition metric.
	</p>

	<div class="toggles">
		<div class="toggle">
			<div>
				<strong>Body fat / bioimpedance</strong>
				<span class="state">{bodyFatModule === null ? 'state unknown' : bodyFatModule ? 'on' : 'off'}</span>
			</div>
			<div class="actions">
				<button class="btn ghost" disabled={!connected || !!busy} onclick={() => toggleModule('fat', true)}>On</button>
				<button class="btn ghost" disabled={!connected || !!busy} onclick={() => toggleModule('fat', false)}>Off</button>
			</div>
		</div>

		<div class="toggle">
			<div>
				<strong>Heart rate</strong>
				<span class="state">{heartRateModule === null ? 'state unknown' : heartRateModule ? 'on' : 'off'}</span>
			</div>
			<div class="actions">
				<button class="btn ghost" disabled={!connected || !!busy} onclick={() => toggleModule('heart', true)}>On</button>
				<button class="btn ghost" disabled={!connected || !!busy} onclick={() => toggleModule('heart', false)}>Off</button>
			</div>
		</div>
	</div>

	<p class="footnote">
		Each switch is written and then read back, so what you see is what the scale reports, not
		what was requested. "State unknown" means it hasn't answered yet. This app never reads heart
		rate itself — that toggle only affects what the scale does on its own.
	</p>
</section>

<style>
	.block {
		padding: 18px 20px 20px;
	}
	.block + .block {
		margin-top: 16px;
	}
	.head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
	}
	.lead {
		margin: 8px 0 14px;
		color: var(--muted);
		font-size: 13.5px;
		max-width: 62ch;
	}
	.state {
		font-size: 13px;
		color: var(--muted);
		margin: 0;
	}

	.members {
		list-style: none;
		margin: 6px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.members li {
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 10px 4px;
		border-top: 1px solid var(--line);
		flex-wrap: wrap;
	}
	.members li.me {
		background: var(--signal-weak);
		border-radius: var(--radius-sm);
		padding-inline: 10px;
	}
	.slot {
		min-width: 30px;
		height: 30px;
		display: grid;
		place-items: center;
		border: 1px solid var(--line-strong);
		border-radius: 8px;
		font-size: 13px;
	}
	.who {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex: 1;
		min-width: 200px;
	}
	.line {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		font-size: 14px;
	}
	.id {
		font-size: 11px;
		color: var(--faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 42ch;
	}
	.chip.you {
		color: var(--signal);
		border-color: var(--signal);
	}
	.actions {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
	}

	.register {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		flex-wrap: wrap;
		margin-top: 16px;
		padding-top: 14px;
		border-top: 1px solid var(--line);
	}
	.reg-text {
		flex: 1;
		min-width: 240px;
	}

	.editor {
		margin-top: 16px;
		padding: 16px;
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-sm);
		background: var(--bg);
	}
	.editor h3 {
		margin: 0 0 14px;
		font-size: 15px;
		font-weight: 600;
	}
	.editor .actions {
		margin-top: 16px;
	}
	.editor input:disabled {
		opacity: 0.55;
		cursor: not-allowed;
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
	/* app.css stretches inputs to width:100% for the text fields; a checkbox must opt out. */
	.check input {
		width: auto;
	}

	.toggles {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.toggle {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		padding: 11px 4px;
		border-top: 1px solid var(--line);
		flex-wrap: wrap;
	}
	.toggle strong {
		display: block;
		font-size: 14px;
		font-weight: 550;
	}

	.msg {
		margin: 14px 0 0;
		font-size: 13px;
	}
	.msg.bad {
		color: var(--lv-alert);
	}
	.msg.ok {
		color: var(--signal);
	}
	.footnote {
		margin: 14px 0 0;
		font-size: 12px;
		color: var(--faint);
		max-width: 62ch;
		line-height: 1.5;
	}
</style>

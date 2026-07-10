<script lang="ts">
	import { onMount } from 'svelte';
	import {
		ScaleClient,
		type ConnectionState,
		type LiveReading,
		type DeviceInfo,
		type RawReading
	} from '$lib/ble/client';
	import { profile, onboarded, toUserProfileInput } from '$lib/store/profile';
	import {
		measurements,
		measurementFromReading,
		addMeasurement,
		removeMeasurement,
		clearMeasurements
	} from '$lib/store/measurements';
	import { exportAllData } from '$lib/export/export';

	import ConnectPanel from '$lib/components/ConnectPanel.svelte';
	import LiveReadingView from '$lib/components/LiveReading.svelte';
	import ResultCard from '$lib/components/ResultCard.svelte';
	import TrendsView from '$lib/components/TrendsView.svelte';
	import HistoryTable from '$lib/components/HistoryTable.svelte';
	import ProfileForm from '$lib/components/ProfileForm.svelte';
	import DebugPanel from '$lib/components/DebugPanel.svelte';

	let client: ScaleClient | undefined = $state();
	let supported = $state(false);
	let connState = $state<ConnectionState>('idle');
	let live = $state<LiveReading | null>(null);
	let battery = $state<number | null>(null);
	let deviceInfo = $state<DeviceInfo | null>(null);
	let errorMsg = $state<string | null>(null);

	type Tab = 'measure' | 'trends' | 'history' | 'profile' | 'debug';
	let tab = $state<Tab>('measure');
	const tabs: { key: Tab; label: string }[] = [
		{ key: 'measure', label: 'Measure' },
		{ key: 'trends', label: 'Trends' },
		{ key: 'history', label: 'History' },
		{ key: 'profile', label: 'Profile' },
		{ key: 'debug', label: 'Debug' }
	];

	const connected = $derived(connState === 'connected');
	const busy = $derived(connState === 'connecting');
	const latest = $derived($measurements.length ? $measurements[$measurements.length - 1] : null);
	const needsOnboarding = $derived(!$onboarded);

	onMount(() => {
		const c = new ScaleClient();
		client = c;
		supported = ScaleClient.isSupported();
		connState = c.getState();

		const offs = [
			c.on('statechange', (s) => (connState = s)),
			c.on('live', (l) => (live = l)),
			c.on('battery', (b) => (battery = b)),
			c.on('deviceinfo', (d) => (deviceInfo = d)),
			c.on('error', (e) => (errorMsg = e.message)),
			c.on('reading', handleReading)
		];
		return () => offs.forEach((off) => off());
	});

	function handleReading(reading: RawReading) {
		const m = measurementFromReading(reading, $profile);
		addMeasurement(m);
		profile.update((p) => ({ ...p, lastKnownWeightKg: reading.weightKg }));
	}

	async function connect() {
		errorMsg = null;
		try {
			await client?.connect({ profile: toUserProfileInput($profile) });
		} catch (e) {
			// requestDevice throws NotFoundError if the user cancels the chooser — not worth showing.
			const msg = e instanceof Error ? e.message : String(e);
			if (!/cancell?ed|user cancelled|chooser|no devices/i.test(msg)) errorMsg = msg;
		}
	}

	function disconnect() {
		client?.disconnect();
	}

	async function measureAgain() {
		errorMsg = null;
		try {
			await client?.startMeasurement();
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : String(e);
		}
	}
</script>

{#if needsOnboarding}
	<main>
		<ProfileForm onboarding onDone={() => (tab = 'measure')} />
	</main>
{:else}
	<ConnectPanel
		state={connState}
		{supported}
		{battery}
		{deviceInfo}
		{busy}
		onConnect={connect}
		onDisconnect={disconnect}
	/>

	{#if errorMsg}
		<div class="toast" role="alert">
			<span>{errorMsg}</span>
			<button class="btn ghost" onclick={() => (errorMsg = null)} aria-label="Dismiss">×</button>
		</div>
	{/if}

	<nav class="tabs">
		{#each tabs as t (t.key)}
			<button class="tab" class:on={tab === t.key} onclick={() => (tab = t.key)}>{t.label}</button>
		{/each}
		<span class="spacer"></span>
		<button class="btn ghost export" onclick={exportAllData} title="Download all data as JSON">
			Export data
		</button>
	</nav>

	<main>
		{#if tab === 'measure'}
			<div class="stack">
				<LiveReadingView {live} units={$profile.units} {connected} />
				{#if connected}
					<div class="toolbar">
						<button class="btn" onclick={measureAgain}>Measure again</button>
						<span class="hint">Step on with bare feet; a completed reading saves automatically.</span>
					</div>
				{/if}
				<ResultCard measurement={latest} units={$profile.units} />
			</div>
		{:else if tab === 'trends'}
			<TrendsView measurements={$measurements} units={$profile.units} />
		{:else if tab === 'history'}
			<HistoryTable
				measurements={$measurements}
				units={$profile.units}
				onRemove={removeMeasurement}
				onClear={clearMeasurements}
			/>
		{:else if tab === 'profile'}
			<ProfileForm />
		{:else if tab === 'debug'}
			<DebugPanel />
		{/if}
	</main>
{/if}

<style>
	.toast {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-top: 12px;
		padding: 10px 14px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--lv-alert);
		background: color-mix(in srgb, var(--lv-alert) 12%, transparent);
		color: var(--ink);
		font-size: 13.5px;
	}

	.tabs {
		display: flex;
		align-items: center;
		gap: 4px;
		margin: 18px 0 16px;
		border-bottom: 1px solid var(--line);
		overflow-x: auto;
	}
	.tab {
		border: none;
		background: transparent;
		color: var(--muted);
		font-size: 14px;
		font-weight: 550;
		padding: 9px 12px;
		cursor: pointer;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		white-space: nowrap;
	}
	.tab:hover {
		color: var(--ink);
	}
	.tab.on {
		color: var(--ink);
		border-bottom-color: var(--signal);
	}
	.spacer {
		flex: 1;
	}
	.export {
		font-size: 13px;
	}

	.stack {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	.toolbar {
		display: flex;
		align-items: center;
		gap: 14px;
		flex-wrap: wrap;
	}
	.hint {
		font-size: 13px;
		color: var(--muted);
	}
</style>

<script lang="ts">
	import {
		trafficLog,
		resetTraffic,
		exportTrafficJson,
		exportTrafficText,
		snapshotTraffic
	} from '$lib/ble/traffic-log';
	import { downloadBlob } from '$lib/export/export';
	import { profile } from '$lib/store/profile';
	import { loadSampleMeasurements } from '$lib/store/measurements';

	function slug() {
		return new Date().toISOString().replace(/[:.]/g, '-');
	}
	function dumpJson() {
		downloadBlob(`cf632-ble-traffic-${slug()}.json`, 'application/json', exportTrafficJson());
	}
	function dumpText() {
		downloadBlob(`cf632-ble-traffic-${slug()}.log`, 'text/plain', exportTrafficText());
	}

	const count = $derived($trafficLog.length);
	const hasData = $derived(count > 0);

	// Show newest entries at the bottom; cap what we render for performance.
	const shown = $derived($trafficLog.slice(-400));
</script>

<section class="debug">
	<div class="head">
		<span class="eyebrow">ble traffic · session only</span>
		<div class="actions">
			<button class="btn ghost" onclick={dumpJson} disabled={!hasData}>Dump JSON</button>
			<button class="btn ghost" onclick={dumpText} disabled={!hasData}>Dump log</button>
			<button class="btn ghost" onclick={() => resetTraffic()} disabled={!hasData}>Clear</button>
		</div>
	</div>

	<p class="lead">
		Every GATT write, notification, and lifecycle event for the current connection. Held in memory
		only — it's never saved, and resets when you reconnect. Export it here for debugging.
	</p>

	<div class="log panel">
		{#if !hasData}
			<div class="empty">No traffic yet. Connect the scale to see live frames.</div>
		{:else}
			{#each shown as e, i (i)}
				<div class="line" data-dir={e.dir}>
					<span class="t num">+{(e.tMs / 1000).toFixed(3)}s</span>
					<span class="dir">{e.dir}</span>
					<span class="ch">{e.char}</span>
					<span class="hex num">{e.hex}</span>
					{#if e.note}<span class="note"># {e.note}</span>{/if}
				</div>
			{/each}
		{/if}
	</div>
	{#if count > shown.length}
		<div class="more">showing last {shown.length} of {count} — export for the full log</div>
	{/if}
</section>

{#if import.meta.env.DEV}
	<section class="panel devtools">
		<span class="eyebrow">dev only · sample data</span>
		<p class="lead">
			Generates ~120 days of synthetic daily readings (weight trending down, valid impedance) run
			through the real body-composition math, appended to your history — for exercising Trends and
			History without a scale. Not shown in production builds.
		</p>
		<button class="btn ghost" onclick={() => loadSampleMeasurements($profile)}>
			Load sample data
		</button>
	</section>
{/if}

<style>
	.debug {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		flex-wrap: wrap;
	}
	.actions {
		display: inline-flex;
		gap: 6px;
	}
	.lead {
		margin: 0;
		color: var(--muted);
		font-size: 13px;
		max-width: 66ch;
	}
	.log {
		padding: 10px 12px;
		max-height: 380px;
		overflow: auto;
		font-family: var(--font-mono);
		font-size: 12px;
		line-height: 1.7;
	}
	.empty {
		color: var(--muted);
		text-align: center;
		padding: 22px 0;
	}
	.line {
		display: flex;
		gap: 9px;
		white-space: nowrap;
		border-bottom: 1px solid var(--line);
		padding: 1px 0;
	}
	.line:last-child {
		border-bottom: none;
	}
	.t {
		color: var(--faint);
		flex-shrink: 0;
		width: 74px;
	}
	.dir {
		flex-shrink: 0;
		width: 34px;
		text-transform: uppercase;
		font-size: 10.5px;
		align-self: center;
	}
	.line[data-dir='tx'] .dir {
		color: var(--readout);
	}
	.line[data-dir='rx'] .dir {
		color: var(--signal);
	}
	.line[data-dir='event'] .dir {
		color: var(--faint);
	}
	.ch {
		flex-shrink: 0;
		width: 52px;
		color: var(--muted);
	}
	.hex {
		color: var(--ink);
	}
	.note {
		color: var(--muted);
	}
	.more {
		font-size: 11.5px;
		color: var(--faint);
		text-align: center;
		font-family: var(--font-mono);
	}

	.devtools {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 14px 16px 16px;
	}
</style>

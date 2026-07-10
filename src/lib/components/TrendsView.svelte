<script lang="ts">
	import type { Measurement, Units } from '$lib/types';
	import { kgToDisplay } from '$lib/units';
	import { DAY_MS } from '$lib/store/measurements';
	import TrendChart, { type Point } from './TrendChart.svelte';

	let { measurements, units }: { measurements: Measurement[]; units: Units } = $props();

	const ranges = [
		{ key: '30d', label: '30d', days: 30 },
		{ key: '90d', label: '90d', days: 90 },
		{ key: '1y', label: '1y', days: 365 },
		{ key: 'all', label: 'All', days: Infinity }
	] as const;

	let range = $state<(typeof ranges)[number]['key']>('90d');

	const cutoff = $derived.by(() => {
		const days = ranges.find((r) => r.key === range)!.days;
		return days === Infinity ? 0 : Date.now() - days * DAY_MS;
	});

	const inRange = $derived(
		measurements.filter((m) => new Date(m.timestamp).getTime() >= cutoff)
	);

	const weightPoints = $derived<Point[]>(
		inRange.map((m) => ({ t: new Date(m.timestamp).getTime(), v: kgToDisplay(m.weightKg, units) }))
	);
	const fatPoints = $derived<Point[]>(
		inRange
			.filter((m) => m.body)
			.map((m) => ({ t: new Date(m.timestamp).getTime(), v: kgToDisplay(m.body!.bodyFatKg, units) }))
	);
</script>

<div class="trends">
	<div class="rangebar">
		<span class="eyebrow">trends</span>
		<div class="ranges">
			{#each ranges as r (r.key)}
				<button class="rbtn" class:on={range === r.key} onclick={() => (range = r.key)}>{r.label}</button>
			{/each}
		</div>
	</div>

	<TrendChart points={weightPoints} label="Weight ({units})" unit=" {units}" color="var(--readout)" />
	<TrendChart points={fatPoints} label="Fat mass ({units})" unit=" {units}" color="var(--signal)" />
</div>

<style>
	.trends {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.rangebar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.ranges {
		display: inline-flex;
		gap: 4px;
		padding: 3px;
		border: 1px solid var(--line);
		border-radius: 999px;
	}
	.rbtn {
		border: none;
		background: transparent;
		color: var(--muted);
		font-family: var(--font-mono);
		font-size: 12px;
		padding: 4px 12px;
		border-radius: 999px;
		cursor: pointer;
	}
	.rbtn.on {
		background: var(--signal);
		color: #04211d;
	}
</style>

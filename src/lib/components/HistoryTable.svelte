<script lang="ts">
	import type { Measurement, Units } from '$lib/types';
	import { formatWeight } from '$lib/units';

	let {
		measurements,
		units,
		onRemove,
		onClear
	}: {
		measurements: Measurement[];
		units: Units;
		onRemove: (id: string) => void;
		onClear: () => void;
	} = $props();

	// Newest first.
	const rows = $derived([...measurements].reverse());

	function fmtDate(iso: string) {
		return new Date(iso).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}
</script>

<section class="history">
	<div class="head">
		<span class="eyebrow">history · {measurements.length} readings</span>
		{#if measurements.length > 0}
			<button
				class="btn ghost danger"
				onclick={() => {
					if (confirm('Delete all saved measurements? This cannot be undone.')) onClear();
				}}>Clear all</button
			>
		{/if}
	</div>

	{#if rows.length === 0}
		<div class="empty panel">No measurements saved yet.</div>
	{:else}
		<div class="panel table">
			<div class="tr th">
				<span>Date</span>
				<span class="r">Weight</span>
				<span class="r">Fat</span>
				<span class="r">Muscle</span>
				<span class="r">Score</span>
				<span></span>
			</div>
			{#each rows as m (m.id)}
				<div class="tr">
					<span class="num date">{fmtDate(m.timestamp)}</span>
					<span class="r num">{formatWeight(m.weightKg, units)}</span>
					<span class="r num">{m.body ? `${m.body.bodyFatRatePercent.toFixed(1)}%` : '—'}</span>
					<span class="r num">{m.body ? `${m.body.muscleRatePercent.toFixed(1)}%` : '—'}</span>
					<span class="r num">{m.body ? m.body.bodyScore : '—'}</span>
					<span class="r">
						<button class="del" title="Delete reading" aria-label="Delete reading" onclick={() => onRemove(m.id)}>×</button>
					</span>
				</div>
			{/each}
		</div>
	{/if}
</section>

<style>
	.history {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.empty {
		padding: 22px;
		text-align: center;
		color: var(--muted);
	}
	.table {
		overflow: hidden;
	}
	.tr {
		display: grid;
		grid-template-columns: 1.4fr 0.9fr 0.7fr 0.8fr 0.6fr 32px;
		align-items: center;
		gap: 8px;
		padding: 10px 14px;
		border-bottom: 1px solid var(--line);
		font-size: 13.5px;
	}
	.tr:last-child {
		border-bottom: none;
	}
	.th {
		font-family: var(--font-mono);
		font-size: 10.5px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
		background: var(--bg-2);
	}
	.r {
		text-align: right;
	}
	.date {
		color: var(--muted);
		font-size: 12.5px;
	}
	.del {
		border: none;
		background: transparent;
		color: var(--faint);
		font-size: 18px;
		line-height: 1;
		cursor: pointer;
		padding: 2px 6px;
		border-radius: 6px;
	}
	.del:hover {
		color: var(--lv-danger);
		background: color-mix(in srgb, var(--lv-danger) 12%, transparent);
	}

	@media (max-width: 560px) {
		.tr {
			grid-template-columns: 1.3fr 0.9fr 0.7fr 32px;
		}
		.tr :nth-child(4),
		.tr :nth-child(5) {
			display: none;
		}
	}
</style>

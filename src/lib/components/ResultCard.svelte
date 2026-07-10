<script lang="ts">
	import type { Measurement, Units } from '$lib/types';
	import type { MetricLevel } from '$lib/bia/vendor-bia';
	import { levelColorVar } from '$lib/levels';
	import { kgToDisplay, formatWeight } from '$lib/units';

	let { measurement, units }: { measurement: Measurement | null; units: Units } = $props();

	interface Tile {
		label: string;
		value: string;
		unit?: string;
		sub?: string;
		level?: MetricLevel;
	}

	function kg(v: number) {
		return kgToDisplay(v, units).toFixed(1);
	}

	const groups = $derived.by((): { title: string; tiles: Tile[] }[] => {
		const m = measurement;
		if (!m || !m.body) return [];
		const b = m.body;
		return [
			{
				title: 'composition',
				tiles: [
					{ label: 'Body fat', value: b.bodyFatRatePercent.toFixed(1), unit: '%', sub: `${kg(b.bodyFatKg)} ${units}`, level: b.bodyFatRateLevel },
					{ label: 'Muscle', value: b.muscleRatePercent.toFixed(1), unit: '%', sub: `${kg(b.muscleKg)} ${units}`, level: b.muscleLevel },
					{ label: 'Skeletal muscle', value: kg(b.skeletalMuscleKg), unit: units, level: b.skeletalMuscleLevel },
					{ label: 'Fat-free mass', value: kg(b.fatFreeMassKg), unit: units },
					{ label: 'Bone mass', value: kg(b.boneKg), unit: units, level: b.boneLevel }
				]
			},
			{
				title: 'fluids & protein',
				tiles: [
					{ label: 'Body water', value: b.waterRatePercent.toFixed(1), unit: '%', level: b.waterLevel },
					{ label: 'Protein', value: b.proteinRatePercent.toFixed(1), unit: '%', level: b.proteinLevel },
					{ label: 'Subcutaneous fat', value: b.subcutaneousFatRatePercent.toFixed(1), unit: '%', sub: `${kg(b.subcutaneousFatKg)} ${units}`, level: b.subcutaneousFatLevel }
				]
			},
			{
				title: 'metabolism',
				tiles: [
					{ label: 'BMR', value: String(b.bmrKcal), unit: 'kcal', level: b.bmrLevel },
					{ label: 'Visceral fat', value: String(b.vfal), sub: 'level', level: b.vfalLevel }
				]
			},
			{
				title: 'summary',
				tiles: [
					{ label: 'BMI', value: b.bmi.toFixed(1), level: b.bmiLevel },
					{ label: 'Body age', value: String(b.bodyAge), unit: 'yr' },
					{ label: 'Ideal weight', value: kg(b.idealWeightKg), unit: units },
					{ label: 'Body score', value: String(b.bodyScore), sub: '/ 100' },
					{ label: 'Body type', value: String(b.bodyType), sub: '/ 9' }
				]
			}
		];
	});

	const when = $derived(
		measurement ? new Date(measurement.timestamp).toLocaleString() : ''
	);
</script>

{#if !measurement}
	<div class="empty panel">
		<span class="eyebrow">no reading yet</span>
		<p>Connect the scale and step on. Your latest measurement and full body-composition breakdown will appear here.</p>
	</div>
{:else}
	<div class="result">
		<div class="headline panel">
			<div>
				<span class="eyebrow">latest reading</span>
				<div class="weight num">{formatWeight(measurement.weightKg, units)}</div>
				<div class="when num">{when}</div>
			</div>
			{#if measurement.body}
				<div class="score">
					<div class="score-num num">{measurement.body.bodyScore}</div>
					<div class="score-label">body score</div>
				</div>
			{/if}
		</div>

		{#if !measurement.body}
			<p class="note panel">
				Weight only — no impedance was captured for this reading (bare feet on the electrodes are
				needed, or the values were out of range), so body composition wasn't computed.
			</p>
		{:else}
			{#each groups as group (group.title)}
				<section class="group">
					<span class="eyebrow">{group.title}</span>
					<div class="tiles">
						{#each group.tiles as t (t.label)}
							<div class="tile panel">
								<div class="tile-label">{t.label}</div>
								<div class="tile-val num">
									{t.value}{#if t.unit}<span class="tile-unit">{t.unit}</span>{/if}
								</div>
								<div class="tile-foot">
									{#if t.level}
										<span class="badge" style="--c:{levelColorVar(t.level)}">{t.level.label}</span>
									{/if}
									{#if t.sub}<span class="tile-sub num">{t.sub}</span>{/if}
								</div>
							</div>
						{/each}
					</div>
				</section>
			{/each}
		{/if}
	</div>
{/if}

<style>
	.empty {
		padding: 26px;
		text-align: center;
	}
	.empty p {
		margin: 10px auto 0;
		max-width: 42ch;
		color: var(--muted);
	}

	.result {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.headline {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 16px 20px;
	}
	.weight {
		font-size: 34px;
		font-weight: 600;
		margin-top: 6px;
	}
	.when {
		font-size: 12px;
		color: var(--muted);
	}
	.score {
		text-align: center;
	}
	.score-num {
		font-size: 40px;
		font-weight: 650;
		color: var(--signal);
		line-height: 1;
	}
	.score-label {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--muted);
	}

	.note {
		padding: 14px 18px;
		color: var(--muted);
		font-size: 13.5px;
		line-height: 1.5;
	}

	.group {
		display: flex;
		flex-direction: column;
		gap: 9px;
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: 10px;
	}
	.tile {
		padding: 12px 13px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.tile-label {
		font-size: 12px;
		color: var(--muted);
	}
	.tile-val {
		font-size: 25px;
		font-weight: 600;
		line-height: 1.05;
	}
	.tile-unit {
		font-size: 13px;
		color: var(--muted);
		margin-left: 3px;
		font-weight: 500;
	}
	.tile-foot {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 2px;
		min-height: 18px;
	}
	.badge {
		font-family: var(--font-mono);
		font-size: 10.5px;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		padding: 2px 7px;
		border-radius: 999px;
		color: var(--c);
		border: 1px solid var(--c);
		background: color-mix(in srgb, var(--c) 12%, transparent);
	}
	.tile-sub {
		font-size: 11.5px;
		color: var(--faint);
	}

	@media (max-width: 560px) {
		.tiles {
			grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
		}
	}
</style>

<script lang="ts">
	import type { LiveReading } from '$lib/ble/client';
	import type { Units } from '$lib/types';
	import { kgToDisplay } from '$lib/units';

	let {
		live,
		units,
		connected
	}: { live: LiveReading | null; units: Units; connected: boolean } = $props();

	const weightDisplay = $derived(
		live && live.weightKg > 0 ? kgToDisplay(live.weightKg, units).toFixed(2) : '0.00'
	);

	const status = $derived.by(() => {
		if (!connected) return { text: 'standby', tone: 'idle' };
		if (!live || live.weightKg <= 0) return { text: 'step on', tone: 'idle' };
		if (live.measurementComplete) return { text: 'complete', tone: 'done' };
		if (live.leaveScale) return { text: 'step off to finish', tone: 'busy' };
		if (live.stable) return { text: 'stable · measuring', tone: 'busy' };
		return { text: 'measuring', tone: 'busy' };
	});

	const active = $derived(connected && !!live && live.weightKg > 0);
</script>

<div class="screen" class:on={connected} data-tone={status.tone}>
	<div class="scanlines" aria-hidden="true"></div>

	<div class="row">
		<span class="eyebrow screen-eyebrow">live weight</span>
		<span class="sig" class:lit={live?.hasImpedance}>
			<i></i><i></i><i></i> Z {live?.hasImpedance ? '50 / 100 kHz' : '——'}
		</span>
	</div>

	<div class="readout num" class:pulse={active && !live?.measurementComplete}>
		<span class="digits">{weightDisplay}</span>
		<span class="unit">{units}</span>
	</div>

	<div class="baseline" aria-hidden="true"></div>

	<div class="status" data-tone={status.tone}>
		<span class="tick"></span>
		{status.text}
	</div>
</div>

<style>
	.screen {
		position: relative;
		overflow: hidden;
		border-radius: var(--radius);
		padding: 18px 20px 20px;
		background:
			radial-gradient(120% 90% at 50% 0%, var(--screen-bg-2), var(--screen-bg));
		border: 1px solid var(--screen-line);
		box-shadow:
			inset 0 0 40px rgba(45, 212, 191, 0.06),
			var(--shadow);
		color: var(--screen-ink);
	}

	.scanlines {
		position: absolute;
		inset: 0;
		background: repeating-linear-gradient(
			to bottom,
			rgba(255, 255, 255, 0.03) 0 1px,
			transparent 1px 3px
		);
		pointer-events: none;
		opacity: 0.6;
	}

	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		position: relative;
	}
	.screen-eyebrow {
		color: var(--screen-muted);
	}
	.screen-eyebrow::before {
		background: var(--screen-signal);
		box-shadow: 0 0 6px var(--screen-signal);
	}

	.sig {
		font-family: var(--font-mono);
		font-size: 11px;
		letter-spacing: 0.1em;
		color: var(--screen-muted);
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
	.sig i {
		width: 3px;
		height: 9px;
		border-radius: 1px;
		background: var(--screen-muted);
		opacity: 0.4;
	}
	.sig.lit i {
		background: var(--screen-signal);
		opacity: 1;
		box-shadow: 0 0 6px var(--screen-signal);
	}
	.sig.lit i:nth-child(2) {
		animation: bounce 1.1s ease-in-out infinite 0.15s;
	}
	.sig.lit i:nth-child(3) {
		animation: bounce 1.1s ease-in-out infinite 0.3s;
	}

	.readout {
		position: relative;
		display: flex;
		align-items: baseline;
		gap: 12px;
		margin: 10px 0 4px;
		color: var(--readout);
		text-shadow: 0 0 18px var(--readout-dim);
	}
	.digits {
		font-size: clamp(52px, 15vw, 88px);
		font-weight: 600;
		line-height: 0.95;
		letter-spacing: 0.01em;
	}
	.unit {
		font-family: var(--font-mono);
		font-size: 20px;
		color: var(--readout);
		opacity: 0.7;
		text-transform: lowercase;
	}
	.readout.pulse {
		animation: glow 1.6s ease-in-out infinite;
	}

	.baseline {
		height: 2px;
		border-radius: 2px;
		background: linear-gradient(
			90deg,
			transparent,
			var(--screen-signal) 20%,
			var(--screen-signal) 80%,
			transparent
		);
		opacity: 0.35;
		margin: 8px 0 12px;
	}

	.status {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-family: var(--font-mono);
		font-size: 12.5px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--screen-muted);
	}
	.status .tick {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--screen-muted);
	}
	.status[data-tone='busy'] {
		color: var(--readout);
	}
	.status[data-tone='busy'] .tick {
		background: var(--readout);
		box-shadow: 0 0 8px var(--readout);
		animation: blink 1s steps(2) infinite;
	}
	.status[data-tone='done'] {
		color: var(--screen-signal);
	}
	.status[data-tone='done'] .tick {
		background: var(--screen-signal);
		box-shadow: 0 0 8px var(--screen-signal);
	}

	@keyframes glow {
		0%,
		100% {
			text-shadow: 0 0 14px var(--readout-dim);
		}
		50% {
			text-shadow: 0 0 26px var(--readout-dim);
		}
	}
	@keyframes blink {
		50% {
			opacity: 0.3;
		}
	}
	@keyframes bounce {
		0%,
		100% {
			transform: scaleY(1);
		}
		50% {
			transform: scaleY(1.8);
		}
	}
</style>

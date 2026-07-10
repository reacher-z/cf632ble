<script lang="ts">
	// Dependency-free SVG line chart with an optional trailing-moving-average trendline (WEB-APP-PLAN §4).
	export interface Point {
		t: number; // epoch ms (x)
		v: number; // value (y)
	}

	// Trendline is a trailing moving average over this time window — smooths day-to-day
	// fluctuation (water weight, meal timing, …) without needing regularly-spaced samples.
	const TREND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

	let {
		points,
		label,
		unit = '',
		digits = 1,
		color = 'var(--signal)',
		showTrend = true
	}: {
		points: Point[];
		label: string;
		unit?: string;
		digits?: number;
		color?: string;
		showTrend?: boolean;
	} = $props();

	// viewBox geometry
	const W = 640;
	const H = 220;
	const M = { top: 16, right: 16, bottom: 26, left: 44 };
	const iw = W - M.left - M.right;
	const ih = H - M.top - M.bottom;

	const sorted = $derived([...points].sort((a, b) => a.t - b.t));

	const geom = $derived.by(() => {
		const pts = sorted;
		if (pts.length === 0) return null;

		const xs = pts.map((p) => p.t);
		const ys = pts.map((p) => p.v);
		let xMin = Math.min(...xs);
		let xMax = Math.max(...xs);
		let yMin = Math.min(...ys);
		let yMax = Math.max(...ys);

		// Pad the value axis a little; guard against a flat/single series.
		if (yMin === yMax) {
			yMin -= 1;
			yMax += 1;
		} else {
			const pad = (yMax - yMin) * 0.12;
			yMin -= pad;
			yMax += pad;
		}
		if (xMin === xMax) {
			xMin -= 1;
			xMax += 1;
		}

		const sx = (t: number) => M.left + ((t - xMin) / (xMax - xMin)) * iw;
		const sy = (v: number) => M.top + ih - ((v - yMin) / (yMax - yMin)) * ih;

		const coords = pts.map((p) => ({ x: sx(p.t), y: sy(p.v), p }));
		const line = coords.map((c, i) => `${i ? 'L' : 'M'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
		const area = `${line} L${coords[coords.length - 1].x.toFixed(1)},${(M.top + ih).toFixed(1)} L${coords[0].x.toFixed(1)},${(M.top + ih).toFixed(1)} Z`;

		// Trailing moving average over (t, v) for the trendline: for each point, average every
		// sample within TREND_WINDOW_MS before it (inclusive). `pts` is already sorted by t, so a
		// sliding window keeps this O(n).
		let trend: string | null = null;
		if (showTrend && pts.length >= 2) {
			let windowStart = 0;
			let sum = 0;
			const avgPts: { x: number; y: number }[] = [];
			for (let i = 0; i < pts.length; i++) {
				sum += ys[i];
				while (xs[i] - xs[windowStart] > TREND_WINDOW_MS) {
					sum -= ys[windowStart];
					windowStart++;
				}
				const count = i - windowStart + 1;
				avgPts.push({ x: sx(xs[i]), y: sy(sum / count) });
			}
			trend = avgPts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
		}

		const yTicks = [yMax, (yMax + yMin) / 2, yMin].map((v) => ({ v, y: sy(v) }));
		const fmtDate = (t: number) =>
			new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

		return {
			coords,
			line,
			area,
			trend,
			yTicks,
			xFirst: { x: sx(xMin), label: fmtDate(xMin) },
			xLast: { x: sx(xMax), label: fmtDate(xMax) },
			last: coords[coords.length - 1]
		};
	});
</script>

<figure class="chart panel">
	<figcaption>
		<span class="eyebrow">{label}</span>
		{#if geom}
			<span class="last num" style="color:{color}">
				{geom.last.p.v.toFixed(digits)}{unit}
			</span>
		{/if}
	</figcaption>

	{#if !geom}
		<div class="empty">Not enough data yet — take a few measurements to see the trend.</div>
	{:else}
		<svg viewBox="0 0 {W} {H}" role="img" aria-label="{label} over time" preserveAspectRatio="none">
			<!-- gridlines + y labels -->
			{#each geom.yTicks as tick (tick.v)}
				<line class="grid" x1={M.left} x2={W - M.right} y1={tick.y} y2={tick.y} />
				<text class="axis" x={M.left - 8} y={tick.y + 3} text-anchor="end">{tick.v.toFixed(digits)}</text>
			{/each}

			<!-- area + line -->
			<path d={geom.area} fill={color} opacity="0.08" />
			<path d={geom.line} fill="none" stroke={color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />

			<!-- trendline (trailing moving average) -->
			{#if geom.trend}
				<path class="trend" d={geom.trend} fill="none" stroke={color} />
			{/if}

			<!-- points -->
			{#each geom.coords as c (c.p.t)}
				<circle cx={c.x} cy={c.y} r="2.6" fill="var(--panel)" stroke={color} stroke-width="1.6" />
			{/each}

			<!-- x labels -->
			<text class="axis" x={geom.xFirst.x} y={H - 8} text-anchor="start">{geom.xFirst.label}</text>
			<text class="axis" x={geom.xLast.x} y={H - 8} text-anchor="end">{geom.xLast.label}</text>
		</svg>
	{/if}
</figure>

<style>
	.chart {
		padding: 14px 16px 8px;
		margin: 0;
	}
	figcaption {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 6px;
	}
	.last {
		font-size: 18px;
		font-weight: 600;
	}
	svg {
		width: 100%;
		height: auto;
		display: block;
		overflow: visible;
	}
	.grid {
		stroke: var(--line);
		stroke-width: 1;
	}
	.axis {
		fill: var(--faint);
		font-family: var(--font-mono);
		font-size: 10px;
	}
	.trend {
		stroke-width: 1.4;
		stroke-dasharray: 5 5;
		opacity: 0.55;
	}
	.empty {
		padding: 26px 6px;
		text-align: center;
		color: var(--muted);
		font-size: 13.5px;
	}
</style>

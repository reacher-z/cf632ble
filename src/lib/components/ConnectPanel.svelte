<script lang="ts">
	import type { ConnectionState, DeviceInfo } from '$lib/ble/client';

	let {
		state,
		supported,
		battery,
		deviceInfo,
		busy,
		onConnect,
		onDisconnect
	}: {
		state: ConnectionState;
		supported: boolean;
		battery: number | null;
		deviceInfo: DeviceInfo | null;
		busy: boolean;
		onConnect: () => void;
		onDisconnect: () => void;
	} = $props();

	const statusText: Record<ConnectionState, string> = {
		unsupported: 'unsupported',
		idle: 'not connected',
		connecting: 'connecting…',
		connected: 'connected',
		disconnected: 'disconnected',
		error: 'connection failed'
	};

	const tone = $derived(
		state === 'connected'
			? 'ok'
			: state === 'connecting'
				? 'busy'
				: state === 'error'
					? 'bad'
					: 'idle'
	);
</script>

<section class="panel connect">
	<div class="left">
		<span class="chip status" data-tone={tone}>
			<span class="dot"></span>{statusText[state]}
		</span>
		{#if deviceInfo?.name}
			<span class="meta num">{deviceInfo.name}</span>
		{/if}
		{#if deviceInfo?.firmware}
			<span class="meta num">fw {deviceInfo.firmware}</span>
		{/if}
		{#if battery !== null}
			<span class="chip batt" title="battery">
				<span class="battglyph" style="--pct:{battery}%"></span>
				<span class="num">{battery}%</span>
			</span>
		{/if}
	</div>

	<div class="right">
		{#if !supported}
			<span class="unsupported">Needs a Chromium browser (Chrome / Edge)</span>
		{:else if state === 'connected'}
			<button class="btn" onclick={onDisconnect}>Disconnect</button>
		{:else}
			<button class="btn primary" onclick={onConnect} disabled={busy}>
				{state === 'connecting' ? 'Connecting…' : state === 'disconnected' ? 'Reconnect' : 'Connect scale'}
			</button>
		{/if}
	</div>
</section>

{#if !supported}
	<p class="hint">
		This app talks to the scale with <strong>Web Bluetooth</strong>, which today only works in
		Chromium-based browsers (Chrome, Edge, Opera; desktop or Android) over HTTPS. Open it there to
		connect. Your saved data and charts still work here.
	</p>
{/if}

<style>
	.connect {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		padding: 13px 16px;
		flex-wrap: wrap;
	}
	.left {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}
	.meta {
		font-size: 12px;
		color: var(--muted);
	}

	.status .dot {
		transition: background 0.2s ease;
	}
	.status[data-tone='ok'] .dot {
		background: var(--signal);
		box-shadow: 0 0 0 3px var(--signal-weak);
	}
	.status[data-tone='busy'] .dot {
		background: var(--readout);
		animation: blink 1s steps(2) infinite;
	}
	.status[data-tone='bad'] .dot {
		background: var(--lv-danger);
	}

	.batt {
		gap: 6px;
	}
	.battglyph {
		width: 22px;
		height: 11px;
		border: 1.5px solid var(--muted);
		border-radius: 3px;
		position: relative;
		display: inline-block;
	}
	.battglyph::after {
		content: '';
		position: absolute;
		right: -3px;
		top: 3px;
		width: 2px;
		height: 5px;
		background: var(--muted);
		border-radius: 0 1px 1px 0;
	}
	.battglyph::before {
		content: '';
		position: absolute;
		inset: 1.5px;
		width: var(--pct);
		max-width: calc(100% - 3px);
		background: var(--signal);
		border-radius: 1px;
	}

	.unsupported {
		font-size: 13px;
		color: var(--lv-alert);
	}
	.hint {
		margin: 10px 2px 0;
		font-size: 13px;
		color: var(--muted);
		line-height: 1.5;
	}

	@keyframes blink {
		50% {
			opacity: 0.35;
		}
	}
</style>

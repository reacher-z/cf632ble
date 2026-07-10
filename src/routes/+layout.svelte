<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { browser } from '$app/environment';

	let { children } = $props();

	// Theme: 'system' | 'light' | 'dark'. Persisted; applied to <html data-theme>.
	let theme = $state<'system' | 'light' | 'dark'>('system');

	if (browser) {
		theme = (localStorage.getItem('cf632.theme') as typeof theme) ?? 'system';
	}

	$effect(() => {
		if (!browser) return;
		const root = document.documentElement;
		if (theme === 'system') root.removeAttribute('data-theme');
		else root.setAttribute('data-theme', theme);
		localStorage.setItem('cf632.theme', theme);
	});

	function cycleTheme() {
		theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
	}

	const themeIcon = $derived(theme === 'system' ? '◐' : theme === 'light' ? '☀' : '☾');
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>CF632BLE · Body Scale</title>
</svelte:head>

<div class="shell">
	<header class="topbar">
		<div class="brand">
			<span class="mark" aria-hidden="true"></span>
			<div>
				<div class="brand-name">CF632<span>BLE</span></div>
				<div class="brand-sub">local body-composition scale</div>
			</div>
		</div>
		<button class="btn ghost theme" onclick={cycleTheme} title="Theme: {theme}">
			<span aria-hidden="true">{themeIcon}</span>
			<span class="theme-label">{theme}</span>
		</button>
	</header>

	{@render children()}

	<footer class="foot">
		<span class="num">FFF0 · FFF1/2/3</span>
		<span>·</span>
		<span>all data stays on this device — no account, no cloud</span>
	</footer>
</div>

<style>
	.shell {
		max-width: 940px;
		margin: 0 auto;
		padding: 22px 18px 64px;
	}

	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 18px;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.mark {
		width: 34px;
		height: 34px;
		border-radius: 9px;
		background:
			radial-gradient(circle at 50% 34%, var(--readout) 0 3px, transparent 4px),
			linear-gradient(160deg, var(--screen-bg-2), var(--screen-bg));
		border: 1px solid var(--screen-line);
		box-shadow: inset 0 0 12px rgba(45, 212, 191, 0.15);
	}
	.brand-name {
		font-weight: 700;
		font-size: 17px;
		letter-spacing: 0.04em;
	}
	.brand-name span {
		color: var(--signal);
	}
	.brand-sub {
		font-size: 12px;
		color: var(--muted);
	}

	.theme {
		display: inline-flex;
		gap: 8px;
		align-items: center;
		font-family: var(--font-mono);
		font-size: 12px;
	}
	.theme-label {
		text-transform: lowercase;
	}

	.foot {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		justify-content: center;
		align-items: center;
		margin-top: 34px;
		color: var(--faint);
		font-size: 12px;
	}
	.foot .num {
		color: var(--muted);
	}

	@media (max-width: 560px) {
		.theme-label {
			display: none;
		}
	}
</style>

/** Map a MetricLevel label to a CSS color token (the level ramp defined in app.css). */

import type { MetricLevel } from '$lib/bia/vendor-bia';

export function levelColorVar(level: MetricLevel): string {
	switch (level.label) {
		case 'Under':
		case 'Underweight':
		case 'Under Fat':
			return 'var(--lv-under)';
		case 'Standard':
		case 'Standard-':
		case 'Normal':
			return 'var(--lv-standard)';
		case 'Standard+':
		case 'Excellent':
			return 'var(--lv-excellent)';
		case 'Over':
		case 'Overweight':
		case 'Over Fat':
			return 'var(--lv-over)';
		case 'Alert':
			return 'var(--lv-alert)';
		case 'Obese':
		case 'Danger':
			return 'var(--lv-danger)';
		default:
			return 'var(--muted)';
	}
}

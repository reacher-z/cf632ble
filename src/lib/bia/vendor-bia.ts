/**
 * Vendor-exact body-composition reimplementation — a faithful TypeScript port of
 * `poc/cf632ble/vendor_bia.py`, which transcribes the proprietary regression the vendor app runs
 * on-phone for CF632BLE (`libbh3BodyComposition.so`'s `BhCalcBodyComposition_TwoLegs240_core`,
 * RE-NOTES §16.4 / §19 / §20 / §21).
 *
 * Every coefficient, the sex/athlete branch structure, the clamp ranges, and the reference-band
 * tables come directly from the decompiled ARM64, verified at the P-code level — do NOT "clean up"
 * or simplify the math; bug-for-bug parity with the vendor app is the goal.
 *
 * INTEGER SEMANTICS: the native code uses C integer casts (truncate toward zero) and, in the
 * positive domain these formulas operate in, Python's `//` (floor) coincides with truncation. We
 * use `Math.trunc` throughout to match the native cast exactly. Many intermediate values are
 * fixed-point integers: deci-kg (kg×10) and permille (rate×1000, i.e. percent×10).
 *
 * Two subtleties the RE already resolved and this port preserves (RE-NOTES §18/§21):
 *   1. Sex maps FEMALE=0 / MALE=1; the native input byte's bit6 is set for MALES.
 *   2. Water-rate LEVEL thresholds are sex-dependent (550/650 M, 450/600 F) and differ from the
 *      body-score's own internal fixed 530/670 water comparison.
 */

import { Sex } from '$lib/ble/protocol';

// Native lib's own input validation range (RE-NOTES §16.4). Violating these means the real .so sets
// errFlags and never runs the regression at all — so we return errors instead of a result.
const HEIGHT_RANGE_CM: [number, number] = [90, 220];
const AGE_RANGE: [number, number] = [6, 99];
const WEIGHT_RANGE_KG: [number, number] = [10.0, 200.0];
const IMPEDANCE_RANGE_OHM: [number, number] = [200, 1200];

// --- low-level helpers (Func13 / Kg2Rate3 / Bh3_Rate2Kg_permille) ------------------------------

/** `Func13(c,x)` (0x128598): round-half-up (native truncates `x*c + 0.5`; callers pass x >= 0). */
function func13(coeff: number, x: number): number {
	return Math.trunc(x * coeff + 0.5);
}

/** `Kg2Rate3(kg,wt)` (0x12862c): deci-kg -> permille rate, inverse of rate2kg. */
function kg2rate3(kgDeci: number, weightDg: number): number {
	if (weightDg === 0) return 0;
	return Math.trunc((kgDeci * 1000) / weightDg);
}

/** `Bh3_Rate2Kg_permille` (0x127970): permille rate -> deci-kg mass. */
function rate2kg(weightDg: number, ratePermille: number): number {
	return Math.trunc((weightDg * ratePermille) / 1000);
}

function heightM2(heightCm: number): number {
	return (heightCm / 100.0) ** 2;
}

/** `GetHeightMSquare3` (0x1285c8): BMI x10, truncated. */
function bmi3(heightCm: number, weightDg: number): number {
	return Math.trunc(weightDg / heightM2(heightCm));
}

/** Pre-constant fat-free-mass term shared by the fat-rate regression and bone-mass formula. */
function ffmRaw(heightCm: number, weightDg: number, age: number, avgZ: number): number {
	return (
		heightM2(heightCm) * 9.058 +
		12.226 +
		weightDg * 0.032 -
		avgZ * 0.0068 -
		age * 0.0542
	);
}

/**
 * Body-fat-rate regression (RE-NOTES §16.4/§19), returned as the raw clamped permille the core
 * writes to `bhBodyFatRate`. SEX: bit6 set for MALES; the `bit6==0` branch is FEMALE (RE-NOTES §18).
 */
function bodyFatRatePermille(
	heightCm: number,
	weightDg: number,
	age: number,
	avgZ: number,
	isMale: boolean,
	isAthlete: boolean
): number {
	let ffm = ffmRaw(heightCm, weightDg, age, avgZ);

	const constant = isMale ? 0.8 : age < 50 ? 9.25 : 7.25;
	ffm -= constant;

	if (isMale) {
		// bit6==1 branch; the 3-way sub-branch is dead for this app (single *0.98 when weight < 610).
		if (weightDg < 0x262) ffm *= 0.98;
	} else {
		// bit6==0 (female) branch: weight/height correction multipliers.
		if (weightDg < 500) ffm *= 1.02;
		if (weightDg > 600) ffm *= 0.96;
		if (heightCm > 0xa0) ffm *= 1.03; // height > 160cm (raw byte compare)
	}

	let fatMassKg = weightDg / 10.0 - ffm;
	if (isAthlete) {
		fatMassKg = isMale ? fatMassKg * 0.778 - 0.93 : fatMassKg * 0.992 - 1.5;
	}

	const permille = (fatMassKg * 10000.0) / weightDg;
	return Math.trunc(Math.max(50.0, Math.min(750.0, permille)));
}

// --- BMR (`Bh3CalcBMR_TwoLegs240`, 0x127ce0) ---------------------------------------------------

function bmrKcal(
	heightCm: number,
	weightDg: number,
	age: number,
	isMale: boolean,
	isAthlete: boolean
): number {
	// FEMALE (bit6==0): weight*1.0204 +865 - height*0.3934 - age*6.204
	// MALE   (bit6==1): weight*1.4916 +878 - height*0.726  - age*8.976
	let bmr = !isMale
		? func13(1.0204, weightDg) + 865 - func13(0.3934, heightCm) - func13(6.204, age)
		: func13(1.4916, weightDg) + 878 - func13(0.726, heightCm) - func13(8.976, age);
	if (isAthlete) bmr = Math.trunc(bmr * 1.16 - 149.0);
	return Math.max(500, bmr);
}

// --- VFAL (`Bh3CalcVFAL_TwoLegs240`, 0x127e4c) -------------------------------------------------

function vfal(
	heightCm: number,
	weightDg: number,
	age: number,
	isMale: boolean,
	isAthlete: boolean
): number {
	const heightSq = heightCm * heightCm;
	let v: number;
	if (!isMale) {
		if (heightCm * 5.0 - 130.0 < weightDg) {
			v = (weightDg * 50.0) / (heightSq * 0.1158 + heightCm * 1.45 - 120.0) - 6.0 + age * 0.07;
		} else {
			v = ((-0.0024 * heightCm + 0.691) * weightDg) / 10.0 - heightCm * 0.027 + age * 0.07 - 10.5;
		}
	} else {
		if (heightCm < weightDg * 0.16 + 63.0) {
			v = (weightDg * 30.5) / (heightSq * 0.0826 - heightCm * 0.4 + 48.0) - 2.9 + age * 0.15;
		} else {
			v = ((-0.0015 * heightCm + 0.765) * weightDg) / 10.0 - heightCm * 0.143 + age * 0.15 - 5.0;
		}
	}

	if (isAthlete) {
		if (v < 2.0) v = 1.0;
		else if (v < 10.0) v -= 2.0;
		else if (v < 20.0) v *= 0.8;
		else v *= 0.85;
	}

	if (v < 1.0) return 1;
	if (v <= 50.0) return Math.trunc(v);
	return 50;
}

// --- Body age (`Bh3CalcBodyAge_TwoLegs240`, 0x127adc) ------------------------------------------

function bodyAge(bmi10: number, age: number): number {
	// NOTE: the `bmi10 < 30` selector (BMI < 3.0) is unreachable for real humans; transcribed
	// exactly (bug-for-bug), so in practice only the else (0.4/0.6-weighted) branch runs.
	let est1 = Math.trunc(age + 28.428 - bmi10 * 0.1428);
	est1 = Math.max(age - 5, Math.min(age + 5, est1));
	let est2 = Math.trunc(age + bmi10 * 0.1724 - 34.931);
	est2 = Math.max(age - 8, Math.min(age + 8, est2));
	const blended =
		bmi10 < 30 ? Math.trunc(est1 * 0.6 + est2 * 0.4) : Math.trunc(est1 * 0.4 + est2 * 0.6);
	return Math.max(6, Math.min(99, blended));
}

// --- Water / protein / subcutaneous-fat rate ---------------------------------------------------

function waterRatePermille(fatRatePermille: number, isMale: boolean, isAthlete: boolean): number {
	const base = Math.trunc(((1000 - fatRatePermille) * 7) / 10);
	let water = base < 501 ? func13(1.02, base) : func13(0.98, base);
	if (isAthlete) water = (isMale ? func13(0.996, water) : func13(0.985, water)) + 4;
	return Math.max(350, water);
}

function proteinRatePermille(weightDg: number, waterRatePermilleV: number): number {
	const waterKgDeci = rate2kg(weightDg, waterRatePermilleV);
	const proteinKgDeci = Math.trunc(waterKgDeci * 0.275 + 0.5); // Func13(0.275, ...)
	const rate = kg2rate3(Math.trunc(proteinKgDeci - 1.36), weightDg);
	return Math.max(20, Math.min(300, rate));
}

function subcutFatRatePermille(
	avgZ: number,
	bmi10: number,
	age: number,
	fatKgDeci: number,
	weightDg: number,
	isAthlete: boolean
): number {
	let waistTerm = avgZ * 0.031 + bmi10 * 0.94 + age * 1.049 - 210.772;
	waistTerm = Math.max(10.0, Math.min(300.0, waistTerm));
	let subcutKgDeci = fatKgDeci - (waistTerm * 9.4) / 34.0;
	if (isAthlete) subcutKgDeci *= 0.85;
	const rate = Math.trunc((subcutKgDeci * 1000.0) / weightDg);
	return Math.max(10, Math.min(600, rate));
}

// --- Bone mass (inline in the core, 0x1268a0) --------------------------------------------------

function boneKgDeci(ffm: number, isMale: boolean, isAthlete: boolean): number {
	// round(FFM_raw*0.5158 - sexConst), then unconditional +/-1 deci-kg nudge, then athlete band.
	// Sex constant: FEMALE=2.4569 / MALE=1.802 (bit6==0 is FEMALE).
	const sexConst = isMale ? 1.802 : 2.4569;
	let bone = Math.trunc(ffm * 0.5158 - sexConst);
	bone += bone < 23 ? -1 : 1;
	if (isAthlete) {
		if (bone < 20) bone += 1;
		else if (bone < 30) bone += 2;
		else bone += 3;
	}
	return bone;
}

// --- Reference-band lookups needed for body score / body type ----------------------------------

function ageBandIndex(age: number): number {
	if (age < 19) return age - 6; // ages 6..18 -> 0..12
	if (age < 40) return 12;
	if (age < 60) return 13;
	return 14;
}

// Byte-for-byte dump of `libbh3BodyComposition.so:0x11734e` (RE-NOTES §20): 15 age-band rows x
// [male, female] x 4 fat-rate-permille boundaries (under / standard- / standard+ / over-fat/obese).
const MALE_FAT_BANDS_PERMILLE: readonly [number, number, number, number][] = [
	[70, 160, 250, 300], [70, 160, 250, 300], [70, 160, 260, 300], [70, 160, 260, 300],
	[70, 160, 260, 300], [70, 160, 260, 300], [70, 160, 250, 300], [70, 160, 250, 300],
	[70, 150, 250, 290], [80, 150, 240, 290], [80, 160, 240, 280], [90, 160, 230, 280],
	[110, 170, 220, 270], [120, 180, 230, 280], [140, 200, 250, 300]
];
const FEMALE_FAT_BANDS_PERMILLE: readonly [number, number, number, number][] = [
	[80, 160, 250, 290], [90, 170, 250, 300], [100, 180, 260, 310], [100, 190, 280, 320],
	[110, 200, 290, 330], [130, 220, 310, 350], [140, 230, 320, 360], [150, 250, 340, 380],
	[170, 260, 350, 390], [180, 270, 360, 400], [190, 280, 370, 410], [200, 280, 370, 410],
	[210, 280, 350, 400], [220, 290, 360, 410], [230, 300, 370, 420]
];

function fatRateBands(age: number, isMale: boolean): [number, number, number, number] {
	const table = isMale ? MALE_FAT_BANDS_PERMILLE : FEMALE_FAT_BANDS_PERMILLE;
	return [...table[ageBandIndex(age)]];
}

function muscleHeightBandDeci(heightCm: number, isMale: boolean): [number, number] {
	if (heightCm < 160) return isMale ? [385, 465] : [291, 347];
	if (heightCm < 170) return isMale ? [440, 524] : [329, 375];
	return isMale ? [495, 594] : [365, 425];
}

function boneWeightBandDeci(weightDg: number, isMale: boolean): [number, number] {
	let c: number;
	if (isMale) c = weightDg < 600 ? 25 : weightDg < 750 ? 29 : 32;
	else c = weightDg < 450 ? 18 : weightDg < 600 ? 22 : 25;
	return [c - 1, c + 1];
}

const WATER_BAND_PERMILLE: [number, number] = [530, 670];
const PROTEIN_BAND_PERMILLE: [number, number] = [160, 180];
const VFAL_BAND: [number, number] = [10, 15];

function bodyScoreAndType(
	bmi10: number,
	fatRatePermille: number,
	muscleKgDeci: number,
	waterRatePermilleV: number,
	proteinRatePermilleV: number,
	boneKgDeciV: number,
	vfalV: number,
	weightDg: number,
	heightCm: number,
	age: number,
	isMale: boolean
): [number, number] {
	// No explicit final clamp on the score in the native code — raw accumulator (RE-NOTES §20).
	let score: number;
	if (bmi10 < 185) score = 36;
	else if (bmi10 < 250) score = 40;
	else if (bmi10 < 300) score = 36;
	else score = 32;

	const [row0, row1, row2, row3] = fatRateBands(age, isMale);
	if (fatRatePermille < row0) score += 18;
	else if (fatRatePermille < row1) score += 20;
	else if (fatRatePermille < row2) score += 18;
	else if (fatRatePermille < row3) score += 16;
	else score += 14;

	const [mLo, mHi] = muscleHeightBandDeci(heightCm, isMale);
	if (muscleKgDeci < mLo) score += 4;
	else if (muscleKgDeci < mHi) score += 4;
	else score += 5;

	if (waterRatePermilleV < WATER_BAND_PERMILLE[0]) score += 8;
	else if (waterRatePermilleV < WATER_BAND_PERMILLE[1]) score += 9;
	else score += 10;

	if (proteinRatePermilleV < PROTEIN_BAND_PERMILLE[0]) score += 8;
	else if (proteinRatePermilleV < PROTEIN_BAND_PERMILLE[1]) score += 9;
	else score += 10;

	const [bLo, bHi] = boneWeightBandDeci(weightDg, isMale);
	if (boneKgDeciV < bLo) score += 4;
	else if (boneKgDeciV < bHi) score += 4;
	else score += 5;

	if (vfalV < VFAL_BAND[0]) score += 10;
	else if (vfalV < VFAL_BAND[1]) score += 9;
	else score += 8;

	// Body type (1-9): the binary groups LOW fat -> 1-3, HIGH fat -> 4-6, MIDDLE -> 7-9 (not the
	// intuitive increasing-fat ordering). Within each, muscle band picks the sub-index.
	let bodyType: number;
	if (fatRatePermille < row0) bodyType = muscleKgDeci < mLo ? 1 : muscleKgDeci < mHi ? 2 : 3;
	else if (fatRatePermille > row3) bodyType = muscleKgDeci < mLo ? 4 : muscleKgDeci < mHi ? 5 : 6;
	else bodyType = muscleKgDeci < mLo ? 7 : muscleKgDeci < mHi ? 8 : 9;

	return [score, bodyType];
}

// --- Per-metric "is this high/low/standard" Level classification (RE-NOTES §21) ----------------

export interface MetricLevel {
	index: number;
	label: string;
}

/** Classify `value` against ascending `boundaries`; index = # of boundaries it meets or exceeds. */
function classify(value: number, boundaries: readonly number[], labels: readonly string[]): MetricLevel {
	let idx = boundaries.length;
	for (let i = 0; i < boundaries.length; i++) {
		if (value < boundaries[i]) {
			idx = i;
			break;
		}
	}
	return { index: idx, label: labels[idx] };
}

const LEVEL_LABELS_BMI = ['Underweight', 'Normal', 'Overweight', 'Obese'];
const LEVEL_LABELS_FAT_RATE = ['Under Fat', 'Standard-', 'Standard+', 'Over Fat', 'Obese'];
const LEVEL_LABELS_USE = ['Under', 'Standard', 'Excellent']; // under/standard/excellent
const LEVEL_LABELS_USO = ['Under', 'Standard', 'Over']; // under/standard/over
const LEVEL_LABELS_VFAL = ['Standard', 'Alert', 'Danger'];
const LEVEL_LABELS_BMR = ['Under', 'Standard'];

const BMI_LEVEL_BANDS_PERMILLE = [185, 250, 300];
const PROTEIN_LEVEL_BAND_PERMILLE = [160, 180];
const VFAL_LEVEL_BAND = [10, 15];
const SKELETAL_MUSCLE_LEVEL_BAND_DECI = [200, 350];

// `bhWaterRateList*` (offsets 44/46): sex-dependent, DIFFERENT from the body score's fixed 530/670.
function waterLevelBandPermille(isMale: boolean): [number, number] {
	return isMale ? [550, 650] : [450, 600];
}

// `bhBodyFatSubCutRateList*` (offsets 30/32): sex-dependent permille.
function subcutFatLevelBandPermille(isMale: boolean): [number, number] {
	return isMale ? [86, 167] : [185, 267];
}

// `bhBMRListUnderOrStandard` (offset 20): age/sex-banded %-of-weight reference; the single
// comparison point for the binary bhBMRLevel (Under/Standard).
function bmrStandardKcal(age: number, weightDg: number, isMale: boolean): number {
	let pct: number;
	if (age < 13) pct = isMale ? 36 : 34;
	else if (age < 16) pct = isMale ? 30 : 29;
	else if (age < 18) pct = isMale ? 26 : 24;
	else if (age < 30) pct = isMale ? 23 : 22;
	else if (age < 50) pct = isMale ? 21 : 20;
	else pct = isMale ? 20 : 19;
	return Math.trunc((pct * weightDg) / 10);
}

// --- Public API --------------------------------------------------------------------------------

export interface FullBodyComposition {
	bmi: number;
	bodyFatRatePercent: number;
	bodyFatKg: number;
	fatFreeMassKg: number;
	boneKg: number;
	muscleKg: number;
	muscleRatePercent: number;
	skeletalMuscleKg: number;
	waterRatePercent: number;
	proteinRatePercent: number;
	subcutaneousFatRatePercent: number;
	subcutaneousFatKg: number;
	bmrKcal: number;
	vfal: number;
	idealWeightKg: number;
	bodyAge: number;
	bodyScore: number;
	bodyType: number;

	// Per-metric "is this high/low/standard" classifications (RE-NOTES §21).
	bmiLevel: MetricLevel;
	bodyFatRateLevel: MetricLevel;
	bmrLevel: MetricLevel;
	vfalLevel: MetricLevel;
	boneLevel: MetricLevel;
	muscleLevel: MetricLevel;
	waterLevel: MetricLevel;
	proteinLevel: MetricLevel;
	skeletalMuscleLevel: MetricLevel;
	subcutaneousFatLevel: MetricLevel;
}

export interface BiaInput {
	weightKg: number;
	heightCm: number;
	age: number;
	sex: Sex;
	z50khzOhm: number;
	z100khzOhm: number;
	athlete?: boolean;
}

export type BiaResult =
	| { ok: true; body: FullBodyComposition }
	| { ok: false; errors: string[] };

/**
 * Mirrors the JNI wrapper's own gate (`Bh3GetBodyComposition_TwoLegs240`, RE-NOTES §18.1): if any
 * of these fail the native lib sets errFlags and never runs the regression at all.
 */
export function rangeErrors(input: BiaInput): string[] {
	const errors: string[] = [];
	const { heightCm, weightKg, age, z50khzOhm, z100khzOhm } = input;
	if (heightCm < HEIGHT_RANGE_CM[0] || heightCm > HEIGHT_RANGE_CM[1])
		errors.push(`height ${heightCm}cm outside validated range ${HEIGHT_RANGE_CM.join('-')}`);
	if (age < AGE_RANGE[0] || age > AGE_RANGE[1])
		errors.push(`age ${age} outside validated range ${AGE_RANGE.join('-')}`);
	if (weightKg < WEIGHT_RANGE_KG[0] || weightKg > WEIGHT_RANGE_KG[1])
		errors.push(`weight ${weightKg}kg outside validated range ${WEIGHT_RANGE_KG.join('-')}`);
	for (const [label, z] of [
		['z50khz', z50khzOhm],
		['z100khz', z100khzOhm]
	] as const) {
		if (z < IMPEDANCE_RANGE_OHM[0] || z > IMPEDANCE_RANGE_OHM[1])
			errors.push(`${label}=${z}ohm outside validated range ${IMPEDANCE_RANGE_OHM.join('-')}`);
	}
	return errors;
}

/** Full vendor-exact metric set (RE-NOTES §19). Returns range-check errors if the input is rejected. */
export function calcFullBodyComposition(input: BiaInput): BiaResult {
	const errors = rangeErrors(input);
	if (errors.length) return { ok: false, errors };

	const athlete = input.athlete ?? false;
	const isMale = input.sex === Sex.MALE;
	const heightCmI = Math.round(input.heightCm);
	const weightDg = Math.round(input.weightKg * 10);
	const avgZ = (input.z50khzOhm + input.z100khzOhm) >> 1; // native: (int)(z50+z100) >> 1

	const bmi10 = bmi3(heightCmI, weightDg);
	const ffm = ffmRaw(heightCmI, weightDg, input.age, avgZ);

	const fatRatePermille = bodyFatRatePermille(heightCmI, weightDg, input.age, avgZ, isMale, athlete);
	const fatKgDeci = rate2kg(weightDg, fatRatePermille);
	const fatFreeMassDeci = weightDg - fatKgDeci;

	const boneDeci = boneKgDeci(ffm, isMale, athlete);
	const muscleDeci = fatFreeMassDeci - boneDeci;
	const muscleRatePermille = Math.trunc((muscleDeci * 1000.0) / weightDg);

	const waterRatePermilleV = waterRatePermille(fatRatePermille, isMale, athlete);
	const skeletalMuscleDeci = Math.trunc(rate2kg(weightDg, waterRatePermilleV) * 0.832 - 27.354);
	const proteinRatePermilleV = proteinRatePermille(weightDg, waterRatePermilleV);

	const subcutRatePermille = subcutFatRatePermille(
		avgZ,
		bmi10,
		input.age,
		fatKgDeci,
		weightDg,
		athlete
	);
	const subcutKgDeci = rate2kg(weightDg, subcutRatePermille);

	const bmr = bmrKcal(heightCmI, weightDg, input.age, isMale, athlete);
	const vfalV = vfal(heightCmI, weightDg, input.age, isMale, athlete);
	const idealWeightDeci = Math.trunc(heightCmI * heightCmI * 0.022);
	const bodyAgeV = bodyAge(bmi10, input.age);
	const [bodyScore, bodyType] = bodyScoreAndType(
		bmi10,
		fatRatePermille,
		muscleDeci,
		waterRatePermilleV,
		proteinRatePermilleV,
		boneDeci,
		vfalV,
		weightDg,
		heightCmI,
		input.age,
		isMale
	);

	const bmrStandard = bmrStandardKcal(input.age, weightDg, isMale);

	const body: FullBodyComposition = {
		bmi: bmi10 / 10.0,
		bodyFatRatePercent: fatRatePermille / 10.0,
		bodyFatKg: fatKgDeci / 10.0,
		fatFreeMassKg: fatFreeMassDeci / 10.0,
		boneKg: boneDeci / 10.0,
		muscleKg: muscleDeci / 10.0,
		muscleRatePercent: muscleRatePermille / 10.0,
		skeletalMuscleKg: skeletalMuscleDeci / 10.0,
		waterRatePercent: waterRatePermilleV / 10.0,
		proteinRatePercent: proteinRatePermilleV / 10.0,
		subcutaneousFatRatePercent: subcutRatePermille / 10.0,
		subcutaneousFatKg: subcutKgDeci / 10.0,
		bmrKcal: bmr,
		vfal: vfalV,
		idealWeightKg: idealWeightDeci / 10.0,
		bodyAge: bodyAgeV,
		bodyScore,
		bodyType,

		bmiLevel: classify(bmi10, BMI_LEVEL_BANDS_PERMILLE, LEVEL_LABELS_BMI),
		bodyFatRateLevel: classify(fatRatePermille, fatRateBands(input.age, isMale), LEVEL_LABELS_FAT_RATE),
		// native: bhBMRLevel = 1 ("Standard") iff bmr >= standard, i.e. level 0 iff bmr < standard.
		bmrLevel: classify(bmr, [bmrStandard], LEVEL_LABELS_BMR),
		vfalLevel: classify(vfalV, VFAL_LEVEL_BAND, LEVEL_LABELS_VFAL),
		boneLevel: classify(boneDeci, boneWeightBandDeci(weightDg, isMale), LEVEL_LABELS_USE),
		muscleLevel: classify(muscleDeci, muscleHeightBandDeci(heightCmI, isMale), LEVEL_LABELS_USE),
		waterLevel: classify(waterRatePermilleV, waterLevelBandPermille(isMale), LEVEL_LABELS_USE),
		proteinLevel: classify(proteinRatePermilleV, PROTEIN_LEVEL_BAND_PERMILLE, LEVEL_LABELS_USE),
		skeletalMuscleLevel: classify(skeletalMuscleDeci, SKELETAL_MUSCLE_LEVEL_BAND_DECI, LEVEL_LABELS_USE),
		subcutaneousFatLevel: classify(subcutRatePermille, subcutFatLevelBandPermille(isMale), LEVEL_LABELS_USO)
	};

	return { ok: true, body };
}

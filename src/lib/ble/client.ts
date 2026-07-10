/**
 * ScaleClient — the Web Bluetooth lifecycle wrapper for a CF632BLE scale.
 *
 * Implements the connection bring-up sequence (RE-NOTES §12.3), subscribes the three F-characteristics,
 * parses F3 measurement frames, and correlates a completed weigh-in (weight from a 0x01 frame + the
 * real dual-frequency impedance from a 0x02 frame) into a single `reading` event. See WEB-APP-PLAN.md
 * §3 and RE-NOTES §12–§13 for the protocol this drives.
 *
 * Web Bluetooth constraints honoured here (WEB-APP-PLAN §2): Chromium-only + secure context;
 * `connect()` MUST be called from a user gesture; FFF0 is not advertised so we scan by name prefix
 * and declare services in optionalServices; no MTU API (18-byte profile chunks); notifications via
 * `startNotifications()` (no manual CCCD write); all writes use write-with-response.
 */

import {
	SERVICE_FFF0,
	SERVICE_BATTERY,
	SERVICE_DEVICE_INFO,
	CHAR_FFF1,
	CHAR_FFF2,
	CHAR_FFF3,
	CHAR_BATTERY_LEVEL,
	ADVERTISED_NAME_PREFIX,
	buildTimeSyncCommand,
	buildImpedanceControlCommand,
	buildUserAnnounceCommand,
	buildStartMeasurementCommand,
	buildUserProfilePayload,
	chunkPayload,
	parseF3Frame,
	uuid16,
	type UserProfileInput,
	type MeasurementFrame
} from './protocol';
import { logTraffic, resetTraffic, type TrafficChar } from './traffic-log';

export type ConnectionState =
	| 'unsupported'
	| 'idle'
	| 'connecting'
	| 'connected'
	| 'disconnected'
	| 'error';

/** Streaming weight + status, emitted on every F3 weight frame (for the live UI). */
export interface LiveReading {
	weightKg: number;
	stable: boolean;
	measurementComplete: boolean;
	leaveScale: boolean;
	overweight: boolean;
	/** true once an impedance (0x02) frame has been seen this cycle */
	hasImpedance: boolean;
}

/** A finished weigh-in: weight + (optionally) the dual-frequency impedance for the BIA math. */
export interface RawReading {
	at: Date;
	weightKg: number;
	z50khzOhm: number | null;
	z100khzOhm: number | null;
}

export interface DeviceInfo {
	name?: string;
	manufacturer?: string;
	model?: string;
	firmware?: string;
}

export interface BringUpOptions {
	profile?: UserProfileInput;
	syncTime?: boolean;
	enableImpedance?: boolean;
	startMeasurement?: boolean;
}

interface ScaleEventMap {
	statechange: ConnectionState;
	live: LiveReading;
	reading: RawReading;
	battery: number;
	deviceinfo: DeviceInfo;
	error: Error;
}

type Listener<T> = (payload: T) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Standard Device Information Service characteristics.
const CHAR_MANUFACTURER = uuid16(0x2a29);
const CHAR_MODEL = uuid16(0x2a24);
const CHAR_FIRMWARE = uuid16(0x2a26);

// How long to wait after a measurement-complete weight frame for the impedance (0x02) frame that
// follows it (RE-NOTES §12.9), before finalizing a weight-only reading.
const IMPEDANCE_WAIT_MS = 1500;

export class ScaleClient {
	private device: BluetoothDevice | null = null;
	private server: BluetoothRemoteGATTServer | null = null;
	private fff1: BluetoothRemoteGATTCharacteristic | null = null;
	private fff2: BluetoothRemoteGATTCharacteristic | null = null;

	private state: ConnectionState = ScaleClient.isSupported() ? 'idle' : 'unsupported';

	private listeners: { [K in keyof ScaleEventMap]: Set<Listener<ScaleEventMap[K]>> } = {
		statechange: new Set(),
		live: new Set(),
		reading: new Set(),
		battery: new Set(),
		deviceinfo: new Set(),
		error: new Set()
	};

	// F3 correlation state.
	private latestZ: { z50: number; z100: number; at: number } | null = null;
	private pendingWeight: number | null = null;
	private lastReadingAt = 0;
	private impedanceTimer: ReturnType<typeof setTimeout> | null = null;

	static isSupported(): boolean {
		return typeof navigator !== 'undefined' && !!navigator.bluetooth;
	}

	getState(): ConnectionState {
		return this.state;
	}

	on<K extends keyof ScaleEventMap>(event: K, cb: Listener<ScaleEventMap[K]>): () => void {
		this.listeners[event].add(cb);
		return () => this.listeners[event].delete(cb);
	}

	private emit<K extends keyof ScaleEventMap>(event: K, payload: ScaleEventMap[K]): void {
		for (const cb of this.listeners[event]) cb(payload);
	}

	private setState(s: ConnectionState): void {
		this.state = s;
		this.emit('statechange', s);
	}

	/**
	 * Request a device (must be called from a user gesture), connect, discover, subscribe, and run
	 * the bring-up sequence. Reuses a previously chosen device if one is remembered.
	 */
	async connect(options: BringUpOptions = {}): Promise<void> {
		if (!ScaleClient.isSupported()) {
			this.setState('unsupported');
			throw new Error('Web Bluetooth is not available in this browser.');
		}
		try {
			this.setState('connecting');
			if (!this.device) {
				this.device = await navigator.bluetooth.requestDevice({
					filters: [{ namePrefix: ADVERTISED_NAME_PREFIX }],
					optionalServices: [SERVICE_FFF0, SERVICE_BATTERY, SERVICE_DEVICE_INFO]
				});
				this.device.addEventListener('gattserverdisconnected', () => this.onDisconnected());
			}
			resetTraffic();
			logTraffic('event', '-', null, `connecting to ${this.device.name ?? 'device'}`);

			this.server = await this.device.gatt!.connect();
			const service = await this.server.getPrimaryService(SERVICE_FFF0);

			this.fff1 = await service.getCharacteristic(CHAR_FFF1);
			this.fff2 = await service.getCharacteristic(CHAR_FFF2);
			const fff3 = await service.getCharacteristic(CHAR_FFF3);

			await this.subscribe(this.fff1, 'FFF1', (d) => this.onFff1Notify(d));
			await this.subscribe(this.fff2, 'FFF2', (d) => this.onFff2Notify(d));
			await this.subscribe(fff3, 'FFF3', (d) => this.onFff3Notify(d));

			this.setState('connected');
			logTraffic('event', '-', null, 'connected + subscribed FFF1/FFF2/FFF3');

			// Best-effort device info + battery (never block the connection on these).
			void this.readDeviceInfo();
			void this.readBattery();

			await this.runBringUp(options);
		} catch (err) {
			this.setState('error');
			const e = err instanceof Error ? err : new Error(String(err));
			logTraffic('event', '-', null, `connect error: ${e.message}`);
			this.emit('error', e);
			throw e;
		}
	}

	private async runBringUp(options: BringUpOptions): Promise<void> {
		const { profile, syncTime = true, enableImpedance = true, startMeasurement = true } = options;

		if (syncTime) {
			await sleep(300); // the vendor app waits ~300ms after connect (RE-NOTES §12.3)
			await this.syncTime();
		}
		if (profile) {
			await this.pushProfile(profile);
		}
		if (enableImpedance) {
			await this.setImpedance(true);
		}
		if (startMeasurement) {
			// Required to trigger a fresh BIA cycle, else only a stale reading appears (RE-NOTES §18).
			await this.startMeasurement();
		}
	}

	private async subscribe(
		char: BluetoothRemoteGATTCharacteristic,
		label: TrafficChar,
		handler: (data: Uint8Array) => void
	): Promise<void> {
		char.addEventListener('characteristicvaluechanged', (event) => {
			const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
			if (!value) return;
			const data = new Uint8Array(value.buffer);
			logTraffic('rx', label, data);
			handler(data);
		});
		await char.startNotifications();
	}

	// --- Commands ------------------------------------------------------------------------------

	async syncTime(when: Date = new Date()): Promise<void> {
		await this.write(this.fff1, 'FFF1', buildTimeSyncCommand(when), 'time-sync 0xF1');
	}

	async setImpedance(on: boolean): Promise<void> {
		await this.write(
			this.fff1,
			'FFF1',
			buildImpedanceControlCommand(on),
			`impedance ${on ? 'on' : 'off'} 0x2C`
		);
	}

	async startMeasurement(): Promise<void> {
		await this.write(this.fff1, 'FFF1', buildStartMeasurementCommand(), 'start-measure 0x24');
	}

	/** Announce (0x05) then push the chunked 135-byte profile on FFF2 (RE-NOTES §13). */
	async pushProfile(profile: UserProfileInput): Promise<void> {
		const payload = buildUserProfilePayload(profile);
		await this.write(this.fff2, 'FFF2', buildUserAnnounceCommand(128), 'user-announce 0x05');
		await sleep(50);
		const chunks = chunkPayload(payload, 18);
		for (let i = 0; i < chunks.length; i++) {
			await this.write(this.fff2, 'FFF2', chunks[i], `profile chunk ${i + 1}/${chunks.length}`);
		}
	}

	private async write(
		char: BluetoothRemoteGATTCharacteristic | null,
		label: TrafficChar,
		data: Uint8Array,
		note: string
	): Promise<void> {
		if (!char) throw new Error(`cannot write ${note}: characteristic ${label} not available`);
		logTraffic('tx', label, data, note);
		await char.writeValueWithResponse(data as BufferSource);
	}

	// --- Notification handlers -----------------------------------------------------------------

	private onFff1Notify(data: Uint8Array): void {
		// FFF1 carries command responses/acks (e.g. 24 <code>, 05 02 06 00). Logged already; the
		// app doesn't currently act on them beyond the traffic log.
		void data;
	}

	private onFff2Notify(data: Uint8Array): void {
		void data; // profile/history acks; logged.
	}

	private onFff3Notify(data: Uint8Array): void {
		let frame: MeasurementFrame;
		try {
			frame = parseF3Frame(data);
		} catch {
			return;
		}

		if (frame.weightKg !== null && (frame.subCommand === 0x01 || frame.subCommand === 0x0d || frame.subCommand === 0x11)) {
			this.emit('live', {
				weightKg: frame.weightKg,
				stable: frame.stable,
				measurementComplete: frame.measurementComplete,
				leaveScale: frame.leaveScale,
				overweight: frame.overweight,
				hasImpedance: this.latestZ !== null && this.latestZ.at > this.lastReadingAt
			});

			if (frame.measurementComplete) {
				this.pendingWeight = frame.weightKg;
				this.tryFinalizeReading();
			}
		} else if (frame.subCommand === 0x02 && frame.z50khzOhm !== null && frame.z100khzOhm !== null) {
			this.latestZ = { z50: frame.z50khzOhm, z100: frame.z100khzOhm, at: performance.now() };
			this.tryFinalizeReading();
		}
	}

	/**
	 * Combine a pending completed weight with the freshest dual-frequency impedance. If impedance for
	 * this cycle hasn't arrived yet, arm a short timer (the 0x02 frame follows the 0x01-complete frame,
	 * RE-NOTES §12.9); on timeout, emit a weight-only reading.
	 */
	private tryFinalizeReading(): void {
		if (this.pendingWeight === null) return;

		const zFresh = this.latestZ && this.latestZ.at > this.lastReadingAt ? this.latestZ : null;
		if (zFresh) {
			this.finalizeReading(this.pendingWeight, zFresh.z50, zFresh.z100);
			return;
		}
		if (this.impedanceTimer === null) {
			this.impedanceTimer = setTimeout(() => {
				this.impedanceTimer = null;
				if (this.pendingWeight !== null) {
					this.finalizeReading(this.pendingWeight, null, null);
				}
			}, IMPEDANCE_WAIT_MS);
		}
	}

	private finalizeReading(weightKg: number, z50: number | null, z100: number | null): void {
		if (this.impedanceTimer !== null) {
			clearTimeout(this.impedanceTimer);
			this.impedanceTimer = null;
		}
		this.lastReadingAt = performance.now();
		this.pendingWeight = null;
		const reading: RawReading = { at: new Date(), weightKg, z50khzOhm: z50, z100khzOhm: z100 };
		logTraffic(
			'event',
			'-',
			null,
			`reading: ${weightKg.toFixed(2)}kg` +
				(z50 !== null ? ` z50=${z50}Ω z100=${z100}Ω` : ' (weight only, no impedance)')
		);
		this.emit('reading', reading);
	}

	// --- Device info / battery -----------------------------------------------------------------

	private async readDeviceInfo(): Promise<void> {
		const info: DeviceInfo = { name: this.device?.name };
		try {
			const svc = await this.server!.getPrimaryService(SERVICE_DEVICE_INFO);
			const dec = new TextDecoder();
			for (const [uuid, key] of [
				[CHAR_MANUFACTURER, 'manufacturer'],
				[CHAR_MODEL, 'model'],
				[CHAR_FIRMWARE, 'firmware']
			] as const) {
				try {
					const c = await svc.getCharacteristic(uuid);
					const v = await c.readValue();
					info[key] = dec.decode(v).replace(/\0+$/, '').trim();
				} catch {
					/* characteristic absent — skip */
				}
			}
		} catch {
			/* no device-info service — just report the name */
		}
		this.emit('deviceinfo', info);
	}

	private async readBattery(): Promise<void> {
		try {
			const svc = await this.server!.getPrimaryService(SERVICE_BATTERY);
			const c = await svc.getCharacteristic(CHAR_BATTERY_LEVEL);
			const v = await c.readValue();
			const level = v.getUint8(0);
			logTraffic('rx', 'battery', new Uint8Array([level]), `battery ${level}%`);
			this.emit('battery', level);
		} catch {
			/* no battery service — ignore */
		}
	}

	// --- Disconnect ----------------------------------------------------------------------------

	private onDisconnected(): void {
		if (this.impedanceTimer !== null) {
			clearTimeout(this.impedanceTimer);
			this.impedanceTimer = null;
		}
		this.pendingWeight = null;
		this.fff1 = this.fff2 = null;
		this.server = null;
		logTraffic('event', '-', null, 'disconnected');
		this.setState('disconnected');
	}

	/** Explicit user-initiated disconnect. Keeps the device handle for a later reconnect. */
	disconnect(): void {
		try {
			this.server?.disconnect();
		} catch {
			/* ignore */
		}
	}

	/** Forget the remembered device (a fresh connect() will prompt the chooser again). */
	forget(): void {
		this.device = null;
	}
}

/**
 * ScaleClient — the Web Bluetooth lifecycle wrapper for a CF632BLE scale.
 *
 * Implements the connection bring-up sequence (BLE-PROTOCOL.md), subscribes the three F-characteristics,
 * parses F3 measurement frames, and correlates a completed weigh-in (weight from a 0x01 frame + the
 * real dual-frequency impedance from a 0x02 frame) into a single `reading` event. See WEB-APP-PLAN.md
 * §3 and BLE-PROTOCOL.md for the protocol this drives.
 *
 * Web Bluetooth constraints honoured here (WEB-APP-PLAN §2): Chromium-only + secure context;
 * `connect()` MUST be called from a user gesture; FFF0 is not advertised so we scan by name prefix
 * and declare services in optionalServices; notifications via `startNotifications()` (no manual CCCD
 * write); all writes use write-with-response. Web Bluetooth exposes no ATT MTU API, but that does not
 * matter: the FFF2 chunk size comes from the scale's own device-MTU reply (BLE-PROTOCOL.md §2.1),
 * not from the ATT MTU.
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
	buildBodyFatModuleCommand,
	buildHeartRateModuleCommand,
	buildDeviceBindStatusCommand,
	parseDeviceBindStatus,
	parseModuleReply,
	buildStartMeasurementCommand,
	buildUserProfilePayload,
	buildSyncUserInfoCommand,
	buildDeleteUserCommand,
	buildDeleteUserPayload,
	buildCurrentUserPayload,
	buildUserAnnounceCommand,
	buildReadMemberListCommand,
	buildMemberListAckCommand,
	parseMemberListPayload,
	memberListPayloadLength,
	buildTransferCompleteCommand,
	parseUserSyncStatus,
	describeSyncUserResult,
	SUBCMD_RESULT_SYNC_USER_INFO,
	SUBCMD_RESULT_DELETE_USER,
	SUBCMD_RESULT_CURRENT_USER,
	buildDeviceMtuQueryCommand,
	parseDeviceMtuReport,
	chunkSizeForDeviceMtu,
	DEFAULT_DEVICE_MTU,
	FALLBACK_DEVICE_MTU,
	chunkPayload,
	parseF3Frame,
	uuid16,
	type UserProfileInput,
	type StoredMember,
	type DeviceBindStatus,
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
	/**
	 * The local user's profile. Used for on-device BIA only — it is **not** written to the scale
	 * unless `registerProfile` is explicitly true.
	 */
	profile?: UserProfileInput;
	/**
	 * Write `profile` into a scale member slot during bring-up. **Defaults to false, deliberately.**
	 *
	 * Registration is a destructive, persistent mutation: it overwrites whatever member currently
	 * occupies `profile.pIndex` on the scale — including members created by the vendor app. Since the
	 * default `pIndex` is 1, auto-registering on every connect would silently clobber the first
	 * stored member. Measurement does not need it either: this app computes body composition
	 * on-device, so the scale never has to know who you are.
	 *
	 * Only set this from an explicit user action in a member-management flow, and only after reading
	 * the member list to choose a genuinely free slot (BLE-PROTOCOL.md §5.2).
	 */
	registerProfile?: boolean;
	syncTime?: boolean;
	/**
	 * What to do with the body-fat/BIA module (opcode 0x07) at bring-up. `'get'` — the default —
	 * is exactly what the vendor app sends here (BLE-PROTOCOL.md §2 step 4). `'on'`/`'off'` write
	 * the persistent device setting; `'skip'` sends nothing.
	 *
	 * The client used to send `0x2C` at this point, an opcode with no callers anywhere in the
	 * vendor app.
	 */
	bodyFatModule?: 'get' | 'on' | 'off' | 'skip';
	startMeasurement?: boolean;
}

/** State of a persistent measurement-module toggle (heart rate 0x06 / body fat 0x07). */
export interface ModuleState {
	opcode: 0x06 | 0x07;
	enabled: boolean;
}

interface ScaleEventMap {
	statechange: ConnectionState;
	live: LiveReading;
	reading: RawReading;
	battery: number;
	deviceinfo: DeviceInfo;
	/** heart-rate / body-fat module state reported by the scale (see {@link ModuleState}) */
	module: ModuleState;
	bindstatus: DeviceBindStatus;
	error: Error;
}

type Listener<T> = (payload: T) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex2 = (n: number) => n.toString(16).padStart(2, '0');

// Standard Device Information Service characteristics.
const CHAR_MANUFACTURER = uuid16(0x2a29);
const CHAR_MODEL = uuid16(0x2a24);
const CHAR_FIRMWARE = uuid16(0x2a26);

// How long to wait after a measurement-complete weight frame for the impedance (0x02) frame that
// follows it (BLE-PROTOCOL.md), before finalizing a weight-only reading.
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
		module: new Set(),
		bindstatus: new Set(),
		error: new Set()
	};

	// The scale's bulk-transfer MTU, learned from the FFF1 `0200` query (BLE-PROTOCOL.md §2.1).
	// Starts at the vendor app's own default — which is also what the app keeps using if the scale
	// never answers — and is what every chunked FFF2 payload is split by.
	private deviceMtu = DEFAULT_DEVICE_MTU;
	private deviceMtuResolved = false;

	// Opcode-0x05 handshake state, one slot per subcmd (BLE-PROTOCOL.md §5.1). Each chunked
	// operation is announce -> confirm -> chunks -> transfer-complete -> result, and both the
	// confirm and the result arrive as FFF2 notifications, so they are recorded here and awaited
	// by the method that started the operation.
	private syncStatus = new Map<number, number | null>();
	private syncSeen = new Set<number>();

	// Member-list accumulation (BLE-PROTOCOL.md §5.2).
	private memberListBuffer: number[] | null = null;
	private memberListDone = false;

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
			this.resetSessionState();
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

	/**
	 * Drop everything learned from the previous connection, before a new one starts.
	 *
	 * The load-bearing one is `deviceMtu`: it is per-device, and if the next scale never answers the
	 * `0200` query we must fall back to the documented default rather than silently keep the last
	 * device's value and fragment FFF2 at a size this one never agreed to. Getting that size wrong
	 * is invisible from the client side — the scale just stops reassembling — which is exactly the
	 * failure mode that took four sessions to find (BLE-PROTOCOL.md §2.1).
	 */
	private resetSessionState(): void {
		this.deviceMtu = DEFAULT_DEVICE_MTU;
		this.deviceMtuResolved = false;
		this.syncSeen.clear();
		this.syncStatus.clear();
		this.memberListBuffer = null;
		this.memberListDone = false;
		this.latestZ = null;
		this.pendingWeight = null;
		this.lastReadingAt = 0;
	}

	private async runBringUp(options: BringUpOptions): Promise<void> {
		const {
			profile,
			registerProfile = false,
			syncTime = true,
			bodyFatModule = 'get',
			startMeasurement = true
		} = options;

		// Device-MTU query FIRST — it decides how every later FFF2 payload is fragmented, and in the
		// vendor app nothing else in the session runs until its reply lands (BLE-PROTOCOL.md §2.1).
		await this.queryDeviceMtu();

		if (syncTime) {
			await sleep(300); // the vendor app waits ~300ms after connect (BLE-PROTOCOL.md)
			await this.syncTime();
		}
		// NOT by default -- see BringUpOptions.registerProfile. Registering writes a persistent member
		// into slot `profile.pIndex` and overwrites whatever was there.
		//
		// Never let it abort the connection: measurement does not depend on registration, so a
		// rejected or malformed profile should cost you the member sync, not the whole session.
		if (registerProfile && profile) {
			try {
				await this.registerMember(profile);
			} catch (err) {
				logTraffic('event', '-', null, `registration skipped: ${(err as Error).message}`);
			}
		}
		if (bodyFatModule !== 'skip') {
			await this.setBodyFatModule(bodyFatModule === 'get' ? undefined : bodyFatModule === 'on');
		}
		if (startMeasurement) {
			// Required to trigger a fresh BIA cycle, else only a stale reading appears (BLE-PROTOCOL.md §6).
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

	/**
	 * Ask the scale what MTU to chunk FFF2 payloads at (`0200` on FFF1) and wait briefly for the
	 * `02 02 <LE16>` reply. See BLE-PROTOCOL.md §2.1: this is load-bearing, not informational —
	 * getting the chunk size wrong makes the scale silently discard every bulk write.
	 *
	 * If no reply arrives we keep `DEFAULT_DEVICE_MTU` (244), which is exactly what the vendor app
	 * does in the same situation.
	 */
	async queryDeviceMtu(timeoutMs = 2000): Promise<number> {
		this.deviceMtuResolved = false;
		await this.write(this.fff1, 'FFF1', buildDeviceMtuQueryCommand(), 'device-mtu query 0x02');
		const deadline = Date.now() + timeoutMs;
		while (!this.deviceMtuResolved && Date.now() < deadline) {
			await sleep(50);
		}
		if (!this.deviceMtuResolved) {
			logTraffic(
				'event',
				'-',
				null,
				`no device-MTU (0x02) reply within ${timeoutMs}ms — using default ${this.deviceMtu} ` +
					`(FFF2 chunk data size ${chunkSizeForDeviceMtu(this.deviceMtu)})`
			);
		}
		return this.deviceMtu;
	}

	async syncTime(when: Date = new Date()): Promise<void> {
		await this.write(this.fff1, 'FFF1', buildTimeSyncCommand(when), 'time-sync 0xF1');
	}

	/**
	 * Get (no argument) or set the persistent **body-fat / BIA module** toggle, opcode 0x07.
	 * With the module off the scale produces no 0x02 impedance frame, so readings degrade to
	 * weight-only. The GET is what the vendor app sends at bring-up. BLE-PROTOCOL.md §4.
	 */
	async setBodyFatModule(on?: boolean): Promise<void> {
		await this.write(
			this.fff1,
			'FFF1',
			buildBodyFatModuleCommand(on),
			`body-fat module ${on === undefined ? 'get' : on ? 'on' : 'off'} 0x07`
		);
		if (on !== undefined) await this.readBackModule(buildBodyFatModuleCommand());
	}

	/** Get (no argument) or set the persistent **heart-rate module** toggle, opcode 0x06. §4. */
	async setHeartRateModule(on?: boolean): Promise<void> {
		await this.write(
			this.fff1,
			'FFF1',
			buildHeartRateModuleCommand(on),
			`heart-rate module ${on === undefined ? 'get' : on ? 'on' : 'off'} 0x06`
		);
		if (on !== undefined) await this.readBackModule(buildHeartRateModuleCommand());
	}

	/**
	 * After writing a module setting, ask the scale what the setting now *is*.
	 *
	 * A SET is acked with a status byte, not a state (BLE-PROTOCOL.md §4), so the only honest way
	 * to show a toggle's position is to re-read it. Without this the UI would either show nothing
	 * or — as an earlier revision did — misreport a successful "turn on" as "off".
	 */
	private async readBackModule(getCommand: Uint8Array): Promise<void> {
		await sleep(200); // let the SET ack land first, so the two replies don't interleave
		await this.write(this.fff1, 'FFF1', getCommand, 'read back module state');
	}

	/**
	 * Get (no argument) or set the account-binding flag, opcode 0x1C. Replies arrive as a
	 * `bindstatus` event. Note SET-unbound is not a factory reset — it leaves the member list
	 * intact (BLE-PROTOCOL.md §7).
	 */
	async setBindStatus(bound?: boolean): Promise<void> {
		await this.write(
			this.fff1,
			'FFF1',
			buildDeviceBindStatusCommand(bound),
			`bind status ${bound === undefined ? 'get' : bound ? 'bind' : 'unbind'} 0x1C`
		);
	}

	async startMeasurement(): Promise<void> {
		await this.write(this.fff1, 'FFF1', buildStartMeasurementCommand(), 'start-measure 0x24');
	}

	/**
	 * Register (or update) a member on the scale so it stores their profile — the account-mode
	 * "users saved on the scale" operation. Verified against real hardware; BLE-PROTOCOL.md §5.1.2.
	 *
	 * ```
	 * -> 0503018700     announce (135 declared bytes)
	 * <- 05020100       start-user-info confirm
	 * -> chunks         the 135-byte profile, [00][seq][data] at deviceMtu-2 bytes each
	 * -> 050102         transfer-complete   <-- MANDATORY (§5.1.7)
	 * <- 05020200       result: 0x00 = registered
	 * ```
	 *
	 * Resolves to the result status (`0x00` on success), or null if the scale never answered.
	 * `pIndex` must be a free slot: read the member list first and take
	 * `record[68] >> 1` for each stored member (§5.2).
	 */
	async registerMember(profile: UserProfileInput): Promise<number | null> {
		if (!profile.memberId) {
			// A blank memberId is not "anonymous" — it is the wildcard the delete path reads as
			// "every member under this account" (§5.1.5), so a member registered without one can
			// never be deleted individually.
			throw new Error('registerMember needs a stable, non-empty memberId (BLE-PROTOCOL.md §5.1.3)');
		}
		const payload = buildUserProfilePayload(profile);
		return this.runChunkedUpload({
			label: 'register member',
			announce: buildSyncUserInfoCommand(payload.length),
			announceNote: 'sync-user-info announce 0x05/01',
			confirmSubcmd: 0x01,
			payload,
			completeSubcmd: SUBCMD_RESULT_SYNC_USER_INFO,
			resultSubcmd: 0x02,
			describe: describeSyncUserResult
		});
	}

	/**
	 * Delete a stored member, identified purely by its `memberId` — pIndex plays no part.
	 * BLE-PROTOCOL.md §5.1.2a, live-verified:
	 *
	 * ```
	 * -> 0503038000  announce   <- 05020300  confirm
	 * -> chunks      the 128-byte identity header
	 * -> 050104      transfer-complete   <- 05020400  deleted
	 * ```
	 *
	 * Resolves to the result status (`0x00` = deleted), or null if the scale never answered.
	 * Throws on a blank `memberId` rather than silently wiping every member (§5.1.5).
	 */
	async deleteMember(userId: string, memberId: string): Promise<number | null> {
		const payload = buildDeleteUserPayload(userId, memberId);
		return this.runChunkedUpload({
			label: 'delete member',
			announce: buildDeleteUserCommand(payload.length),
			announceNote: 'delete-user announce 0x05/03',
			confirmSubcmd: 0x03,
			payload,
			completeSubcmd: SUBCMD_RESULT_DELETE_USER,
			resultSubcmd: 0x04,
			describe: (s) => (s === 0x00 ? 'deleted' : `failed (status ${s})`)
		});
	}

	/**
	 * Tell the scale which already-registered member is standing on it, so *its own* stored
	 * weigh-in is attributed to them (BLE-PROTOCOL.md §5.1.1). This app computes body composition
	 * on-device and does not need it to take a reading.
	 */
	async confirmCurrentUser(userId: string, memberId: string): Promise<number | null> {
		const payload = buildCurrentUserPayload(userId, memberId);
		return this.runChunkedUpload({
			label: 'confirm current user',
			announce: buildUserAnnounceCommand(payload.length),
			announceNote: 'current-user announce 0x05/06',
			confirmSubcmd: 0x06,
			payload,
			completeSubcmd: SUBCMD_RESULT_CURRENT_USER,
			resultSubcmd: 0x07,
			describe: (s) =>
				s === 0x00 ? 'accepted' : s === 0x01 ? 'parameter error' : `user not found (status ${s})`
		});
	}

	/**
	 * The one shape every chunked FFF2 upload has (BLE-PROTOCOL.md §5.1.7):
	 * `announce → confirm → chunks → transfer-complete → result`.
	 *
	 * The transfer-complete frame is the part that is easy to leave out and impossible to debug
	 * from the outside: without it the scale keeps waiting for bytes and sends **no** result at
	 * all — not even a length-mismatch error.
	 */
	private async runChunkedUpload(op: {
		label: string;
		announce: Uint8Array;
		announceNote: string;
		confirmSubcmd: number;
		payload: Uint8Array;
		completeSubcmd: number;
		resultSubcmd: number;
		describe: (status: number | null) => string;
	}): Promise<number | null> {
		this.syncSeen.delete(op.confirmSubcmd);
		this.syncSeen.delete(op.resultSubcmd);

		await this.write(this.fff2, 'FFF2', op.announce, op.announceNote);
		if (!(await this.waitFor(() => this.syncSeen.has(op.confirmSubcmd), 3000))) {
			logTraffic('event', '-', null, `${op.label}: no confirm (0x05/${hex2(op.confirmSubcmd)}) within 3s`);
			return null;
		}
		const confirmStatus = this.syncStatus.get(op.confirmSubcmd) ?? null;
		if (confirmStatus !== 0x00) {
			logTraffic('event', '-', null, `${op.label}: confirm refused (status ${confirmStatus})`);
			return null;
		}

		const chunks = chunkPayload(op.payload, chunkSizeForDeviceMtu(this.deviceMtu));
		for (let i = 0; i < chunks.length; i++) {
			await this.write(this.fff2, 'FFF2', chunks[i], `${op.label} chunk ${i + 1}/${chunks.length}`);
		}

		await this.write(
			this.fff2,
			'FFF2',
			buildTransferCompleteCommand(op.completeSubcmd),
			`${op.label} transfer-complete`
		);

		if (!(await this.waitFor(() => this.syncSeen.has(op.resultSubcmd), 5000))) {
			logTraffic('event', '-', null, `${op.label}: no result (0x05/${hex2(op.resultSubcmd)}) within 5s`);
			return null;
		}
		const status = this.syncStatus.get(op.resultSubcmd) ?? null;
		logTraffic('event', '-', null, `${op.label}: ${op.describe(status)}`);
		return status;
	}

	/**
	 * Read the scale's stored member list (BLE-PROTOCOL.md §5.2, live-verified). Each member's
	 * `pIndex` comes back decoded, which is what makes picking a genuinely free slot possible.
	 *
	 * Stops as soon as the declared total (`65 + count * 71`) has been accumulated rather than
	 * waiting for the `05 02 05` terminator: on an empty list the scale has been observed never
	 * sending one and instead streaming all-zero chunks indefinitely.
	 */
	async readMemberList(timeoutMs = 10000): Promise<StoredMember[] | null> {
		this.memberListBuffer = [];
		this.memberListDone = false;
		this.syncSeen.delete(0x05);

		await this.write(this.fff2, 'FFF2', buildReadMemberListCommand(), 'read member list 0x05/05');
		const ok = await this.waitFor(() => this.memberListDone || this.syncSeen.has(0x05), timeoutMs);

		const buffer = Uint8Array.from(this.memberListBuffer ?? []);
		this.memberListBuffer = null;
		if (!ok) {
			logTraffic('event', '-', null, `member list: no complete response within ${timeoutMs}ms`);
			return null;
		}

		const members = parseMemberListPayload(buffer);
		logTraffic(
			'event',
			'-',
			null,
			`member list: ${members.length} member(s) — slots ${members.map((m) => m.pIndex).join(', ') || '(none)'}`
		);

		// The scale sends this same frame as its terminator, so the read is a two-way handshake.
		// Optional (verified), but it matches the app.
		await this.write(this.fff2, 'FFF2', buildMemberListAckCommand(), 'member-list ACK 05020501');
		return members;
	}

	/** Poll `pred` until true or `timeoutMs` elapses. Web Bluetooth notifications arrive as events,
	 * so a small poll is simpler than threading a promise through every handler. */
	private async waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (!pred() && Date.now() < deadline) await sleep(25);
		return pred();
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
		// The one FFF1 response we must act on is the device-MTU reply (opcode 0x02), which sets the
		// FFF2 chunk size for the rest of the session — see BLE-PROTOCOL.md §2.1.
		const reportedMtu = parseDeviceMtuReport(data);
		if (reportedMtu !== null) {
			this.deviceMtu = reportedMtu > 0 ? reportedMtu : FALLBACK_DEVICE_MTU;
			this.deviceMtuResolved = true;
			logTraffic(
				'event',
				'-',
				null,
				`device MTU = ${this.deviceMtu} (reported ${reportedMtu}) => FFF2 chunk data size ${chunkSizeForDeviceMtu(this.deviceMtu)}`
			);
			return;
		}

		const bind = parseDeviceBindStatus(data);
		if (bind) {
			logTraffic('event', '-', null, `bind status: ${bind.bound ? 'bound' : 'unbound'}`);
			this.emit('bindstatus', bind);
			return;
		}

		// Heart-rate (0x06) / body-fat (0x07) module replies. A SET ack only tells us the write was
		// accepted, so it is logged but does NOT update the state — `setBodyFatModule` re-reads
		// instead. Only a GET reply (marker 2) carries the real state. BLE-PROTOCOL.md §4.
		const module = parseModuleReply(data);
		if (module) {
			const name = module.opcode === 0x06 ? 'heart-rate' : 'body-fat';
			if (module.isSetAck) {
				logTraffic('event', '-', null, `${name} module: set ${module.ok ? 'accepted' : `REFUSED (0x${module.raw.toString(16)})`}`);
			} else {
				logTraffic('event', '-', null, `${name} module is ${module.ok ? 'on' : 'off'}`);
				this.emit('module', { opcode: module.opcode, enabled: module.ok });
			}
			return;
		}
		// Other FFF1 acks (e.g. 24 <code>) are logged only.
	}

	private onFff2Notify(data: Uint8Array): void {
		// A bulk-read in progress: plain [0x00][seq][data] chunks accumulate into one payload.
		if (this.memberListBuffer !== null && !this.memberListDone && data.length >= 2 && data[0] === 0x00) {
			for (let i = 2; i < data.length; i++) this.memberListBuffer.push(data[i]);
			// As soon as the header + count are in we know the exact total, so we can stop there
			// instead of trusting a terminator that does not always come (BLE-PROTOCOL.md §5.2).
			if (this.memberListBuffer.length >= 65) {
				const expected = memberListPayloadLength(this.memberListBuffer[64]);
				if (this.memberListBuffer.length >= expected) this.memberListDone = true;
			}
			return;
		}

		// FFF2 opcode-0x05 handshake frames: the confirms that gate sending a payload, and the
		// results that follow the transfer-complete frame (BLE-PROTOCOL.md §5.1).
		const st = parseUserSyncStatus(data);
		if (!st) return;
		this.syncStatus.set(st.subcmd, st.status);
		this.syncSeen.add(st.subcmd);
		if (st.subcmd === 0x05) this.memberListDone = true; // member-list terminator
	}

	private onFff3Notify(data: Uint8Array): void {
		let frame: MeasurementFrame;
		try {
			frame = parseF3Frame(data);
		} catch {
			return;
		}

		if (frame.weightKg !== null && frame.subCommand === 0x01) {
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
	 * BLE-PROTOCOL.md); on timeout, emit a weight-only reading.
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

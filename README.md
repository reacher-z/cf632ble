# CF632BLE — Web Bluetooth body-composition scale app

[![Featured by Awesome REA](https://raw.githubusercontent.com/reacher-z/Awesome-REA/477658fa73f6860e86cd1fc526657c2efdc25194/assets/featured-by-awesome-rea-inline.svg)](https://awesomerea.org/resources/cf632ble-case/)

Client-side web app that talks to a **CF632BLE** smart scale over **Web Bluetooth**, computes
body composition locally, and stores data in the browser — no server, no vendor backend.
SvelteKit + `adapter-static`, deployed to GitHub Pages.

The BLE protocol and body-composition math were reverse-engineered from the vendor's Android
app ("Unique Health", package `com.lefu.xin`) and reimplemented here from scratch.

## Features

- First-run profile setup (age, sex, height, units) — required by the on-device BIA math
- Connect over Web Bluetooth, sync time, trigger a measurement
- Live weight + ~2 dozen body-composition metrics (fat %/kg, muscle, water, protein, bone,
  visceral fat, BMR, BMI, body age/score/type, …), each with a level badge
- Weight and fat-mass trends (dependency-free SVG charts with regression trendline)
- History, JSON export, debug panel dumping raw BLE traffic
- **Device tab** — full member management for the profiles stored *on the scale*: read its member
  list, add anyone who uses it (age/sex/height/athlete, into a free slot), edit or delete a member,
  register your own profile in one click, set who the next weigh-in belongs to, and toggle the
  scale's heart-rate and body-fat modules
- Single user, data in `localStorage`, "Clear all saved data" option in Profile tab

Measuring never writes anything persistent to the scale: body composition is computed here, from
the weight and dual-frequency impedance the scale streams. The Device tab exists for people who
also use the scale standalone or alongside the vendor app — every write there is behind an
explicit click.

Note on member names: the scale stores no name for a member — its profile record is
age/sex/height/slot/weight plus an opaque id. Names you type in the Device tab are kept in this
browser and matched back by id, so members added from another device or the vendor app appear
unnamed.

## Requirements

Web Bluetooth is Chromium-only (Chrome/Edge/Opera, desktop or Android) and needs a secure
context (HTTPS or `localhost`). Firefox and Safari/iOS are unsupported — the app detects this
and shows a notice; saved data and charts still work everywhere.

## Develop

```bash
npm install
npm run dev             # https://localhost:5173
npm run dev -- --host   # bind to LAN to test from a phone, e.g. https://<lan-ip>:5173
npm test                # vitest — protocol + BIA + integration + component render tests
npm run check           # svelte-check typecheck
npm run build           # static build into ./build
npm run preview         # preview the production build
```

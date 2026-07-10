# CF632BLE — Web Bluetooth body-composition scale app

Client-side web app that talks to a **CF632BLE** smart scale over **Web Bluetooth**, computes
body composition locally, and stores data in the browser — no server, no vendor backend.
SvelteKit + `adapter-static`, deployed to GitHub Pages.

The BLE protocol and body-composition math were reverse-engineered from the vendor's Android
app ("Unique Health", package `com.lefu.xin`) and reimplemented here from scratch.

## Features

- First-run profile setup (age, sex, height, units) — required by the on-device BIA math
- Connect over Web Bluetooth, sync time, push profile, trigger a measurement
- Live weight + ~2 dozen body-composition metrics (fat %/kg, muscle, water, protein, bone,
  visceral fat, BMR, BMI, body age/score/type, …), each with a level badge
- Weight and fat-mass trends (dependency-free SVG charts with regression trendline)
- History, JSON export, debug panel dumping raw BLE traffic
- Single user, data in `localStorage`, "Clear all saved data" option in Profile tab

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

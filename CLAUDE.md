# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A mobile-first loyalty points scanner web app. Staff scan a customer's QR code, then add drink points or redeem a free drink (costs 9 points). Deployed as a static site on Vercel.

## Architecture

- **Single-file app**: All HTML, CSS, and JS live in `public/index.html`. No build step, no framework, no bundler.
- **QR scanning**: Uses the [jsQR](https://github.com/nicolestandifer3/jsQR-qr-code) library (CDN) with the device camera via `getUserMedia`. The camera feed is drawn to a hidden `<canvas>` and decoded frame-by-frame in `tick()`.
- **Backend**: A Make.com (formerly Integromat) webhook at `WEBHOOK_URL` handles all server actions. The app POSTs JSON with an `action` field (`lookup_customer`, `add_points`, `redeem_points`) and the scanned `qr_data`.
- **Points logic**: After scanning, `lookupCustomerPoints()` first tries to extract points directly from the QR data string (via `extractPoints()`), falling back to a webhook lookup. The redeem button is shown/hidden based on `currentPoints >= 9` in `setPointsDisplay()`.
- **Deployment**: `vercel.json` sets `outputDirectory: "public"` with no build command. Push to deploy.

## Key Functions (public/index.html)

| Function | Purpose |
|---|---|
| `startScanner()` / `stopScanner()` | Camera lifecycle |
| `tick()` | rAF loop that feeds frames to jsQR |
| `handleScan(data)` | Processes a decoded QR, triggers point lookup |
| `lookupCustomerPoints(qrData)` | Extracts points locally or fetches from webhook |
| `extractPoints(data)` | Parses points from various response shapes (looks for keys: `points`, `current_points`, `loyalty_points`, `balance`, `point_balance`, `points_balance`) |
| `setPointsDisplay(points, message)` | Updates UI and controls redeem button visibility |
| `sendAddPoints()` / `sendRedeem()` | POST to webhook for mutations |

## Development

No build/lint/test commands exist. Edit `public/index.html` directly and open in a browser or deploy to Vercel. The app requires HTTPS for camera access (use Vercel preview deployments or a local HTTPS proxy for testing).

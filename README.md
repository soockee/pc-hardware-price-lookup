# RigCheck

RigCheck is a small browser utility for generating a paste-ready PC hardware report and checking component prices through its Cloudflare Worker backend.

## Why the browser boundary matters

Modern browsers do not expose arbitrary PCI/SMBIOS hardware to a web page. This prototype keeps the permission boundary explicit:

- the browser cannot inspect arbitrary PCI/SMBIOS hardware without a user-run local command;
- the provided scripts read component names and sizes and copy a plain-text report;
- the browser parses the pasted report and sends only the detected component names to the price API.

The page provides read-only scripts for Windows PowerShell, macOS Terminal and Linux Terminal. Each script prints CPU, GPU, RAM, storage, motherboard and OS information in a paste-ready format and copies the output to the local clipboard. Pasting updates the component list and automatically requests live offers from the backend.

## Backend

The `backend/` directory contains the Cloudflare Worker API. It validates requests, keeps the PricesAPI key in a Cloudflare secret, applies origin and size limits, times out upstream requests, caches short-lived results, and returns structured errors. It intentionally does not expose the key to the browser or invent prices.

From `backend/`:

```text
npm install
npm run typecheck
npm run deploy
npx wrangler secret put PRICES_API_KEY --env production
```

The production Worker is `https://rigcheck-prices.gamingsockee.workers.dev`. Without the secret, `/health` remains available and price checks return `provider_not_configured`.

## Run locally

Open `index.html` directly, or serve the folder with any static server. No package install is needed.

## GitHub Pages

The included workflow publishes the repository root to GitHub Pages whenever `main` changes. It can also be started manually from the Actions tab.

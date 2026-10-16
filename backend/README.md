# RigCheck price API

Small Cloudflare Worker backend for the GitHub Pages frontend. It accepts the locally generated component report, validates it, and queries the authenticated PricesAPI product search without exposing the provider key to the browser.

## Endpoints

- `GET /health` — configuration-safe health response.
- `POST /v1/price-check` — accepts `{ "components": [{ "type": "GPU", "name": "..." }] }` and returns normalized offers.

The API searches price-relevant component types (`CPU`, `GPU`, `RAM`, `STORAGE`, and `MOTHERBOARD`). OS data remains visible in the report but is intentionally excluded from pricing. Components with no relevant offers return `no_match` rather than fabricated pricing.

## Local setup

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
# Put the PricesAPI key in .dev.vars; do not commit it.
npm run dev
```

## Deploy

```powershell
npx wrangler secret put PRICES_API_KEY --env production
npm run deploy
```

The secret is entered interactively and is never stored in `wrangler.jsonc` or Git. The production market is configured as `de`; change `PRICES_API_MARKET` in `wrangler.jsonc` if the target market differs. The Worker intentionally returns a clear configuration error instead of using fake prices or scraping a consumer site.

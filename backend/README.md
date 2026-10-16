# RigCheck price API

Small Cloudflare Worker backend for the GitHub Pages frontend. It accepts the locally generated component report, validates it, and queries the authenticated Kelkoo Shopping API without exposing the provider token to the browser.

## Endpoints

- `GET /health` — configuration-safe health response.
- `POST /v1/price-check` — accepts `{ "components": [{ "type": "GPU", "name": "..." }] }` and returns normalized offers.

Supported price categories are `CPU`, `GPU`, `RAM`, and `STORAGE`. Motherboard and OS data are returned by the frontend but marked unsupported because shopping indexes do not price those system details.

## Local setup

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
# Put the Kelkoo publisher JWT in .dev.vars; do not commit it.
npm run dev
```

## Deploy

```powershell
npx wrangler secret put KELKOO_TOKEN --env production
npm run deploy
```

The secret is entered interactively and is never stored in `wrangler.jsonc` or Git. Kelkoo publisher credentials are required; the Worker intentionally returns a clear configuration error instead of using fake prices or scraping a consumer site.

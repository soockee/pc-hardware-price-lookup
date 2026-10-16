const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_UPSTREAM_BYTES = 256 * 1024;
const MAX_COMPONENTS = 16;
const REQUEST_TIMEOUT_MS = 8_000;
const CACHE_TTL_SECONDS = 600;

const ALL_TYPES = new Set(["CPU", "GPU", "RAM", "STORAGE", "MOTHERBOARD", "OS"]);

type ComponentType = "CPU" | "GPU" | "RAM" | "STORAGE" | "MOTHERBOARD" | "OS";
type Component = { type: ComponentType; name: string };
type Offer = { title: string; price: number | null; currency: string | null; merchant: string | null; available: boolean | null; url: string | null };
type PriceResult = { type: ComponentType; name: string; status: "ok" | "no_match" | "unsupported"; offers: Offer[] };
type ApiError = Error & { status?: number; code?: string };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cors = corsHeaders(request, env);
    const origin = request.headers.get("Origin");

    if (origin && !isAllowedOrigin(origin, env)) return json({ error: "origin_not_allowed" }, 403, cors);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "rigcheck-price-api", provider: "kelkoo", providerConfigured: Boolean(env.KELKOO_TOKEN), timestamp: new Date().toISOString() }, 200, cors, { "Cache-Control": "no-store" });
    }
    if (request.method === "POST" && url.pathname === "/v1/price-check") return handlePriceCheck(request, env, ctx, cors);
    if (request.method === "GET" && url.pathname === "/") return json({ service: "rigcheck-price-api", endpoints: ["GET /health", "POST /v1/price-check"] }, 200, cors);
    return json({ error: "not_found" }, 404, cors);
  },
} satisfies ExportedHandler<Env>;

async function handlePriceCheck(request: Request, env: Env, ctx: ExecutionContext, cors: Headers): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const components = normalizeComponents(await readJsonBody(request, MAX_REQUEST_BYTES));
    if (!env.KELKOO_TOKEN) return json({ error: "provider_not_configured", message: "KELKOO_TOKEN is not configured.", requestId }, 503, cors);

    const country = env.KELKOO_COUNTRY || "de";
    const cacheKey = new Request(`https://cache.rigcheck.invalid/v1/price-check?country=${country}&components=${encodeURIComponent(JSON.stringify(components))}`);
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      const cachedPayload = await readJsonResponse(cached, MAX_UPSTREAM_BYTES);
      return json(cachedPayload, 200, cors, { "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}` });
    }

    const results = await Promise.all(components.map((component) => lookupComponent(component, env)));
    const responsePayload = { provider: "kelkoo", country, generatedAt: new Date().toISOString(), results };
    const cachedResponse = json(responsePayload, 200, new Headers(), { "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}` });
    ctx.waitUntil(caches.default.put(cacheKey, cachedResponse));
    console.log(JSON.stringify({ event: "price_check", requestId, componentTypes: components.map(({ type }) => type), resultCount: results.length }));
    return json({ ...responsePayload, requestId }, 200, cors, { "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}` });
  } catch (error) {
    const apiError = error as ApiError;
    const status = apiError.status || 400;
    const code = apiError.code || "invalid_request";
    console.log(JSON.stringify({ event: "price_check_error", requestId, code, status }));
    return json({ error: code, message: apiError.message, requestId }, status, cors);
  }
}

async function lookupComponent(component: Component, env: Env): Promise<PriceResult> {
  const apiBase = env.KELKOO_API_BASE || "https://api.kelkoogroup.net/publisher/shopping/v2";
  const endpoint = new URL(`${apiBase.replace(/\/$/, "")}/search/offers`);
  endpoint.searchParams.set("country", env.KELKOO_COUNTRY || "de");
  endpoint.searchParams.set("query", component.name);
  endpoint.searchParams.set("queryMatchStrength", "all");
  endpoint.searchParams.set("fieldsAlias", "minimal");
  endpoint.searchParams.set("additionalFields", "offerId,lastUpdateDate,price,currency,merchantName,offerUrlLandingUrl,goUrl");
  endpoint.searchParams.set("sortBy", "price");
  endpoint.searchParams.set("sortDirection", "asc");
  endpoint.searchParams.set("pageSize", "5");

  const response = await fetchWithTimeout(endpoint, { headers: { Accept: "application/json", Authorization: `Bearer ${env.KELKOO_TOKEN}` } });
  if (!response.ok) {
    const error = apiError(`Kelkoo returned HTTP ${response.status}`, 502, "provider_unavailable");
    throw error;
  }

  const payload = await readJsonResponse(response, MAX_UPSTREAM_BYTES);
  const offers = isRecord(payload) && Array.isArray(payload.offers) ? payload.offers.map(normalizeOffer).filter((offer): offer is Offer => offer !== null) : [];
  offers.sort((a, b) => (a.price ?? Number.POSITIVE_INFINITY) - (b.price ?? Number.POSITIVE_INFINITY));
  return { ...component, status: offers.length ? "ok" : "no_match", offers: offers.slice(0, 5) };
}

function normalizeComponents(payload: unknown): Component[] {
  if (!isRecord(payload) || !Array.isArray(payload.components)) throw apiError("components must be an array", 400, "invalid_components");
  if (payload.components.length === 0 || payload.components.length > MAX_COMPONENTS) throw apiError(`components must contain between 1 and ${MAX_COMPONENTS} items`, 400, "invalid_component_count");
  const seen = new Set<string>();
  const components: Component[] = [];

  for (const item of payload.components) {
    if (!isRecord(item)) throw apiError("each component must be an object", 400, "invalid_component");
    const type = typeof item.type === "string" ? item.type.trim().toUpperCase() : "";
    const name = typeof item.name === "string" ? item.name.replace(/\s+/g, " ").trim() : "";
    if (!ALL_TYPES.has(type) || name.length < 2 || name.length > 160) throw apiError("each component needs a supported type and a name between 2 and 160 characters", 400, "invalid_component");
    const key = `${type}:${name.toLowerCase()}`;
    if (!seen.has(key)) { seen.add(key); components.push({ type: type as ComponentType, name }); }
  }
  return components;
}

function normalizeOffer(value: unknown): Offer | null {
  if (!isRecord(value)) return null;
  const title = stringValue(value.title) || "Untitled offer";
  const priceValue = value.price;
  const price = typeof priceValue === "number" ? priceValue : typeof priceValue === "string" ? Number(priceValue) : null;
  const merchant = stringValue(value.merchantName) || (isRecord(value.merchant) ? stringValue(value.merchant.name) : null);
  const url = safeUrl(stringValue(value.offerUrlLandingUrl) || stringValue(value.goUrl));
  return { title, price: price !== null && Number.isFinite(price) ? price : null, currency: stringValue(value.currency), merchant, available: null, url };
}

function safeUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch { return null; }
}

async function fetchWithTimeout(input: URL, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try { return await fetch(input, { ...init, signal: controller.signal }); }
  catch (error) { throw apiError(error instanceof Error && error.name === "AbortError" ? "Provider request timed out" : "Provider request failed", 502, "provider_unavailable"); }
  finally { clearTimeout(timeout); }
}

async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const text = await readLimitedStream(request.body, maxBytes);
  try { return JSON.parse(text); } catch { throw apiError("Request body must be valid JSON", 400, "invalid_json"); }
}

async function readJsonResponse(response: Response, maxBytes: number): Promise<unknown> {
  const text = await readLimitedStream(response.body, maxBytes);
  try { return JSON.parse(text); } catch { throw apiError("Provider returned invalid JSON", 502, "invalid_provider_response"); }
}

async function readLimitedStream(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel("body too large"); throw apiError("Request or provider response is too large", 413, "body_too_large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers({ "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400", Vary: "Origin" });
  const origin = request.headers.get("Origin");
  if (origin && isAllowedOrigin(origin, env)) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function isAllowedOrigin(origin: string, env: Env): boolean { return (env.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean).includes(origin); }

function json(value: unknown, status: number, cors: Headers, extra: Record<string, string> = {}): Response {
  const headers = new Headers(cors);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [key, item] of Object.entries(extra)) headers.set(key, item);
  return new Response(JSON.stringify(value), { status, headers });
}

function apiError(message: string, status: number, code: string): ApiError { const error = new Error(message) as ApiError; error.status = status; error.code = code; return error; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }

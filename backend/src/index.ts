const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_UPSTREAM_BYTES = 256 * 1024;
const MAX_COMPONENTS = 16;
const REQUEST_TIMEOUT_MS = 90_000;
const CACHE_TTL_SECONDS = 600;
const CACHE_SCHEMA_VERSION = "alternatives-v2";
const DEFAULT_PRICES_API_BASE = "https://api.pricesapi.io/api/v1";
const PRICEABLE_TYPES = new Set(["CPU", "GPU", "RAM", "STORAGE", "MOTHERBOARD"]);
const ALL_TYPES = new Set(["CPU", "GPU", "RAM", "STORAGE", "MOTHERBOARD", "OS"]);

type ComponentType = "CPU" | "GPU" | "RAM" | "STORAGE" | "MOTHERBOARD" | "OS";
type Component = { type: ComponentType; name: string };
type Offer = { title: string; price: number | null; currency: string | null; merchant: string | null; available: boolean | null; stock: string | null; delivery: string | null; url: string | null; matchType: "exact" | "similar"; matchLabel: string };
type PriceResult = { type: ComponentType; name: string; status: "ok" | "no_match" | "unsupported"; offers: Offer[] };
type SearchPlan = { query: string; exactModel: string | null; label: string };
type Match = { matchType: "exact" | "similar"; matchLabel: string };
type ApiError = Error & { status?: number; code?: string };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cors = corsHeaders(request, env);
    const origin = request.headers.get("Origin");

    if (origin && !isAllowedOrigin(origin, env)) return json({ error: "origin_not_allowed" }, 403, cors);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "rigcheck-price-api", provider: "pricesapi", providerConfigured: Boolean(env.PRICES_API_KEY), timestamp: new Date().toISOString() }, 200, cors, { "Cache-Control": "no-store" });
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
    if (!env.PRICES_API_KEY) return json({ error: "provider_not_configured", message: "PRICES_API_KEY is not configured.", requestId }, 503, cors);

    const market = env.PRICES_API_MARKET || "de";
    const cacheKey = new Request(`https://cache.rigcheck.invalid/${CACHE_SCHEMA_VERSION}/price-check?market=${market}&components=${encodeURIComponent(JSON.stringify(components))}`);
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      const cachedPayload = await readJsonResponse(cached, MAX_UPSTREAM_BYTES);
      return json(cachedPayload, 200, cors, { "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}` });
    }

    const results = await Promise.all(components.map((component) => lookupComponent(component, components, env)));
    const responsePayload = { provider: "pricesapi", market, generatedAt: new Date().toISOString(), results };
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

async function lookupComponent(component: Component, components: Component[], env: Env): Promise<PriceResult> {
  if (!PRICEABLE_TYPES.has(component.type)) return { ...component, status: "unsupported", offers: [] };

  const plan = buildSearchPlan(component, components);
  const apiBase = env.PRICES_API_BASE || DEFAULT_PRICES_API_BASE;
  const endpoint = new URL(`${apiBase.replace(/\/$/, "")}/products/search`);
  endpoint.searchParams.set("q", plan.query);
  endpoint.searchParams.set("market", env.PRICES_API_MARKET || "de");
  endpoint.searchParams.set("limit", "3");
  endpoint.searchParams.set("offers_limit", "5");

  const response = await fetchWithTimeout(endpoint, { headers: { Accept: "application/json", Authorization: `Bearer ${env.PRICES_API_KEY}` } });
  if (!response.ok) {
    const error = apiError(`PricesAPI returned HTTP ${response.status}`, response.status === 429 ? 429 : 502, response.status === 429 ? "provider_rate_limited" : "provider_unavailable");
    throw error;
  }

  const payload = await readJsonResponse(response, MAX_UPSTREAM_BYTES);
  const products = isRecord(payload) && isRecord(payload.data) && Array.isArray(payload.data.products) ? payload.data.products : [];
  const offers = products.flatMap((product) => {
    if (!isRecord(product) || !Array.isArray(product.offers)) return [];
    const fallbackTitle = stringValue(product.title) || "Untitled product";
    return product.offers
      .map((offer) => {
        const offerTitle = isRecord(offer) ? stringValue(offer.product_title) || fallbackTitle : fallbackTitle;
        const match = matchProduct(component, components, plan, offerTitle);
        if (!match) return null;
        return normalizeOffer(offer, fallbackTitle, match);
      })
      .filter((item): item is Offer => item !== null);
  });
  const uniqueOffers = [...new Map(offers.map((offer) => [offer.url || `${offer.title}:${offer.price}:${offer.merchant}`, offer])).values()];
  uniqueOffers.sort((a, b) => Number(b.matchType === "exact") - Number(a.matchType === "exact") || Number(b.available === true) - Number(a.available === true) || (a.price ?? Number.POSITIVE_INFINITY) - (b.price ?? Number.POSITIVE_INFINITY));
  return { ...component, status: uniqueOffers.length ? "ok" : "no_match", offers: uniqueOffers.slice(0, 5) };
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

function normalizeOffer(value: unknown, fallbackTitle: string, match: Match): Offer | null {
  if (!isRecord(value)) return null;
  const title = stringValue(value.product_title) || fallbackTitle;
  const priceValue = value.price;
  const price = typeof priceValue === "number" ? priceValue : typeof priceValue === "string" ? Number(priceValue) : null;
  const merchant = stringValue(value.seller);
  const stock = stringValue(value.stock_status);
  const delivery = stringValue(value.delivery_info);
  const url = safeUrl(stringValue(value.url));
  const available = stock ? !/out of stock|unavailable/i.test(stock) : null;
  return { title, price: price !== null && Number.isFinite(price) ? price : null, currency: stringValue(value.currency), merchant, available, stock, delivery, url, ...match };
}

function buildSearchPlan(component: Component, components: Component[]): SearchPlan {
  if (component.type === "GPU") {
    const model = gpuModel(component.name);
    if (model) {
      const vram = memoryCapacityGb(component.name);
      return { query: `${model}${vram ? ` ${vram}GB` : ""} graphics card`, exactModel: model, label: "same GPU chip" };
    }
  }

  if (component.type === "CPU") {
    const socket = cpuSocket(component.name);
    if (socket) {
      const tier = component.name.match(/\bCore\s+Ultra\s+[579]\b/i)?.[0] || component.name.match(/\bRyzen\s+[3579]\b/i)?.[0] || component.name.match(/\bCore\s+i[3579]\b/i)?.[0] || "desktop CPU";
      return { query: `${tier} ${socket} processor`, exactModel: cpuModel(component.name), label: `${socket} · similar CPU` };
    }
  }

  if (component.type === "RAM") {
    const capacity = memoryCapacityGb(component.name);
    const generation = memoryGeneration(component.name);
    if (capacity) {
      const speed = memorySpeed(component.name);
      const parts = [formatCapacity(capacity), generation, speed, "desktop RAM"].filter(Boolean);
      return { query: parts.join(" "), exactModel: null, label: [formatCapacity(capacity), generation, "memory"].filter(Boolean).join(" ") };
    }
  }

  if (component.type === "STORAGE") {
    const capacity = storageCapacity(component.name);
    if (capacity) {
      const technology = storageTechnology(component.name);
      return { query: `${formatCapacity(capacity)} ${technology}`, exactModel: null, label: `${formatCapacity(capacity)} · ${technology}` };
    }
  }

  if (component.type === "MOTHERBOARD") {
    const cpu = components.find((candidate) => candidate.type === "CPU");
    const socket = cpu ? cpuSocket(cpu.name) : null;
    if (socket) {
      const ram = components.find((candidate) => candidate.type === "RAM");
      const actualMemory = ram ? memoryGeneration(ram.name) : null;
      const platformMemory = socketMemoryGeneration(socket);
      const memoryNote = platformMemory && actualMemory && actualMemory !== platformMemory
        ? `${platformMemory} RAM needed`
        : platformMemory || actualMemory;
      return { query: `${socket} motherboard`, exactModel: null, label: [socket, memoryNote, "verify CPU/case fit"].filter(Boolean).join(" · ") };
    }
  }

  return { query: component.name, exactModel: component.name, label: "same model" };
}

function matchProduct(component: Component, components: Component[], plan: SearchPlan, title: string): Match | null {
  if (!title || title === "Untitled product") return null;

  if (component.type === "GPU") {
    if (!plan.exactModel || !matchesGpuModel(plan.exactModel, title) || !/\b(?:geforce|radeon|graphics|\bRTX\b|\bGTX\b|\bRX\b|\bARC\b)/i.test(title)) return null;
    const expectedVram = memoryCapacityGb(component.name);
    const foundVram = memoryCapacityGb(title);
    if (expectedVram && foundVram && !sameCapacity(expectedVram, foundVram)) return null;
    return { matchType: "similar", matchLabel: plan.label };
  }

  if (component.type === "CPU") {
    const exact = plan.exactModel ? matchesCpuModel(plan.exactModel, title) : false;
    if (exact) return { matchType: "exact", matchLabel: "same CPU model" };
    const expectedSocket = cpuSocket(component.name);
    const productSocket = cpuSocket(title);
    if (expectedSocket && productSocket === expectedSocket && /\b(?:processor|CPU|Ryzen|Core|Xeon)\b/i.test(title)) return { matchType: "similar", matchLabel: plan.label };
    return null;
  }

  if (component.type === "RAM") {
    const expectedCapacity = memoryCapacityGb(component.name);
    const foundCapacity = memoryCapacityGb(title);
    const expectedGeneration = memoryGeneration(component.name);
    const foundGeneration = memoryGeneration(title);
    const foundSpeed = memorySpeed(title);
    if (!expectedCapacity || !foundCapacity || !sameCapacity(expectedCapacity, foundCapacity)) return null;
    if (expectedGeneration && expectedGeneration !== foundGeneration) return null;
    if (!/\b(?:RAM|memory|DIMM|DDR[345])\b/i.test(title)) return null;
    return { matchType: "similar", matchLabel: [formatCapacity(foundCapacity), foundGeneration || expectedGeneration, foundSpeed, "RAM"].filter(Boolean).join(" ") };
  }

  if (component.type === "STORAGE") {
    const expectedCapacity = storageCapacity(component.name);
    const foundCapacity = storageCapacity(title);
    const expectedTechnology = storageTechnology(component.name);
    if (!expectedCapacity || !foundCapacity || !sameCapacity(expectedCapacity, foundCapacity)) return null;
    if (expectedTechnology === "NVMe SSD" && !/\b(?:NVMe|PCIe|M\.2)\b/i.test(title)) return null;
    if (expectedTechnology === "SATA SSD" && !/\b(?:SATA|2\.5|SSD)\b/i.test(title)) return null;
    if (!/\b(?:SSD|HDD|hard drive|solid state|NVMe)\b/i.test(title)) return null;
    return { matchType: "similar", matchLabel: `${formatCapacity(foundCapacity)} · ${expectedTechnology}` };
  }

  if (component.type === "MOTHERBOARD") {
    const cpu = components.find((candidate) => candidate.type === "CPU");
    const socket = cpu ? cpuSocket(cpu.name) : null;
    if (socket) {
      if (!/\b(?:motherboard|mainboard|baseboard|ATX|ITX|chipset|Z\d{3,4}|B\d{3,4}|H\d{3,4}|X\d{3,4}|A\d{3,4})\b/i.test(title)) return null;
      if (boardSocket(title) !== socket) return null;
      return { matchType: "similar", matchLabel: plan.label };
    }
    if (!/\b(?:motherboard|mainboard|baseboard|ATX|ITX|chipset|socket)\b/i.test(title)) return null;
  }

  const required = modelTokens(component.name);
  const candidates = new Set(modelTokens(title));
  if (!required.length || !required.some((token) => candidates.has(token))) return null;
  return { matchType: "exact", matchLabel: plan.label };
}

function gpuModel(value: string): string | null {
  const match = value.match(/\b(RTX|GTX)\s*-?\s*(\d{3,4})(?:\s*(TI|SUPER))?\b/i) || value.match(/\b(RX)\s*-?\s*(\d{4})(?:\s*(XT|XTX|GRE))?\b/i) || value.match(/\b(ARC)\s*(A\d{3,4})\b/i);
  if (!match) return null;
  return match.slice(1).filter(Boolean).join(" ").toUpperCase().replace(/\s+/g, " ");
}

function matchesGpuModel(model: string, title: string): boolean {
  const tokens = model.toUpperCase().match(/RTX|GTX|RX|ARC|SUPER|TI|XTX|XT|GRE|A\d{3,4}|\d{3,4}/g) || [];
  if (tokens.length < 2) return false;
  const [family, number, suffix] = tokens;
  const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const suffixPattern = suffix ? `\\s*${suffix}` : "(?!\\s*(?:TI|SUPER|XT|XTX|GRE)\\b)";
  return new RegExp(`\\b${family}\\s*${escaped}${suffixPattern}\\b`, "i").test(title.replace(/-/g, " "));
}

function cpuModel(value: string): string | null {
  return value.match(/\b(?:i[3579]-?\d{4,5}[A-Z]{0,3}|\d{3,5}(?:X3D|XT|KF|KS|K|X|F|G)?|[3579]-\d{4,5}[A-Z]{0,3})\b/i)?.[0] || null;
}

function matchesCpuModel(model: string, title: string): boolean {
  const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(title);
}

function cpuSocket(value: string): string | null {
  const text = value.toUpperCase();
  if (/\bCORE\s+ULTRA\s+[579]\s+2\d{2}[A-Z]*\b/.test(text) || /\bCORE\s+[579]\s+2\d{2}[A-Z]*\b/.test(text)) return "LGA1851";
  const intel = text.match(/\bI[3579]-?([89]|1[0-4])\d{3,4}[A-Z]{0,2}\b/);
  if (intel) {
    const series = Number(intel[1]);
    if (series >= 12) return "LGA1700";
    if (series >= 10) return "LGA1200";
    if (series >= 8) return "LGA1151";
  }
  const ryzen = text.match(/\bRYZEN\s+[3579]\s+(\d{4}[A-Z0-9]*)\b/);
  if (ryzen) {
    const series = Number(ryzen[1][0]);
    if (series >= 7 && series <= 9) return "AM5";
    if (series >= 1 && series <= 5) return "AM4";
  }
  return null;
}

function boardSocket(title: string): string | null {
  const text = title.toUpperCase().replace(/\s+/g, " ");
  const sockets = ["LGA1851", "LGA1700", "LGA1200", "LGA1151", "AM5", "AM4"];
  for (const socket of sockets) {
    const chipsetMap: Record<string, RegExp> = {
      LGA1851: /\b(?:Z890|B860|H810|Q870|W880)\b/,
      LGA1700: /\b(?:Z790|H770|B760|Z690|H670|B660|H610|Q670|W680)\b/,
      LGA1200: /\b(?:Z590|B560|H510|Z490|B460|H410|H570)\b/,
      LGA1151: /\b(?:Z390|Z370|B365|B360|H370|H310|Q370)\b/,
      AM5: /\b(?:X870E?|X670E?|B850|B840|B650E?|A620)\b/,
      AM4: /\b(?:X570|B550|A520|X470|B450|A320|X370|B350)\b/,
    };
    const explicit = socket === "AM5" || socket === "AM4"
      ? new RegExp(`\\b${socket}\\b`)
      : new RegExp(`\\b${socket.slice(0, 3)}\\s*${socket.slice(3)}\\b`);
    if (explicit.test(text) || chipsetMap[socket].test(text)) return socket;
  }
  return null;
}

function socketMemoryGeneration(socket: string): string | null {
  if (socket === "LGA1851" || socket === "AM5") return "DDR5";
  if (socket === "AM4" || socket === "LGA1200" || socket === "LGA1151") return "DDR4";
  return null;
}

function memoryCapacityGb(value: string): number | null {
  const explicit = value.match(/\b(?:total|installed)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(GB|GiB)\b|\b(\d+(?:\.\d+)?)\s*(GB|GiB)\s*(?:total|installed)\b/i);
  if (explicit) return Number(explicit[1] || explicit[3]);
  const kit = value.match(/\b(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(GB|GiB)\b/i);
  if (kit) return Number(kit[1]) * Number(kit[2]);
  const labeled = [...value.matchAll(/\bSize\s*[:=]\s*(\d+(?:\.\d+)?)\s*(GB|GiB|MB|MiB)\b/gi)];
  if (labeled.length) return labeled.reduce((sum, item) => sum + capacityInGb(Number(item[1]), item[2]), 0);
  const moduleGroups = value.split(/\s*\|\s*/);
  if (moduleGroups.length > 1) {
    const total = moduleGroups.reduce((sum, group) => {
      const sizes = [...group.matchAll(/\b(\d+(?:\.\d+)?)\s*(GB|GiB)\b/gi)].map((item) => Number(item[1]));
      return sum + (sizes.length ? Math.max(...sizes) : 0);
    }, 0);
    if (total) return total;
  }
  const sizes = [...value.matchAll(/\b(\d+(?:\.\d+)?)\s*(GB|GiB)\b/gi)].map((item) => Number(item[1]));
  return sizes.length ? Math.max(...sizes) : null;
}

function memoryGeneration(value: string): string | null {
  const match = value.match(/\bDDR\s*([345])\b/i) || value.match(/\bPC([345])\b/i);
  return match ? `DDR${match[1]}` : null;
}

function memorySpeed(value: string): string | null {
  const match = value.match(/\b(\d{3,5})\s*MHz\b/i);
  return match ? `${match[1]}MHz` : null;
}

function storageCapacity(value: string): number | null {
  const matches = [...value.matchAll(/\b(\d+(?:\.\d+)?)\s*(TB|TiB|GB|GiB)\b/gi)];
  if (!matches.length) return null;
  const capacities = matches.map((item) => capacityInGb(Number(item[1]), item[2]));
  return Math.max(...capacities);
}

function storageTechnology(value: string): string {
  if (/\b(?:NVMe|PCIe|M\.2)\b|\b(?:MZVL|MZVP|MZVLB)/i.test(value)) return "NVMe SSD";
  if (/\b(?:HDD|hard drive|5400\s*rpm|7200\s*rpm)\b/i.test(value)) return "hard drive";
  if (/\bSATA\b/i.test(value)) return "SATA SSD";
  return "SSD";
}

function capacityInGb(value: number, unit: string): number {
  return /^(?:TB|TiB)$/i.test(unit) ? value * 1000 : /^(?:MB|MiB)$/i.test(unit) ? value / 1024 : value;
}

function formatCapacity(gb: number): string {
  const nominal = [128, 256, 512, 1000, 2000, 4000, 8000].find((value) => Math.abs(gb - value) / value <= 0.12);
  const normalized = nominal || Math.round(gb);
  return normalized >= 1000 ? `${normalized / 1000}TB` : `${normalized}GB`;
}

function sameCapacity(expected: number, found: number): boolean {
  const normalizedExpected = Number.parseFloat(formatCapacity(expected)) * (formatCapacity(expected).endsWith("TB") ? 1000 : 1);
  const normalizedFound = Number.parseFloat(formatCapacity(found)) * (formatCapacity(found).endsWith("TB") ? 1000 : 1);
  return Math.abs(normalizedExpected - normalizedFound) / Math.max(normalizedExpected, normalizedFound) <= 0.12;
}

function modelTokens(value: string): string[] {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, " ").split(/\s+/).filter((token) => /\d/.test(token) && token.length >= 4);
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

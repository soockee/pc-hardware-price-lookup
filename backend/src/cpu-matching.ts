export type CpuSearchPlan = {
  query: string;
  exactModel: string | null;
  label: string;
  fallbackQuery?: string | null;
};

export type CpuMatch = { matchType: "exact" | "similar"; matchLabel: string };

export function buildCpuSearchPlan(name: string): CpuSearchPlan {
  const normalized = normalizeCpuName(name);
  const socket = cpuSocket(normalized);
  const model = cpuModel(normalized);
  const tier = normalized.match(/\bCore\s+Ultra\s+[579]\b/i)?.[0]
    || normalized.match(/\bRyzen\s+[3579]\b/i)?.[0]
    || normalized.match(/\bCore\s+i[3579]\b/i)?.[0]
    || null;
  const brand = normalized.match(/\b(?:Intel|AMD)\b/i)?.[0] || null;
  const modelIncludesTier = model ? /^i[3579]-/i.test(model) : false;

  const queryParts = model
    ? [brand, modelIncludesTier ? null : tier, model, "processor"]
    : [brand, tier || (socket ? "desktop CPU" : normalized), socket, "processor"];
  const fallbackQuery = model && socket
    ? [brand, tier || "desktop CPU", socket, "processor"].filter((part): part is string => Boolean(part)).join(" ")
    : null;

  return {
    query: queryParts.filter((part): part is string => Boolean(part)).join(" "),
    exactModel: model,
    label: socket ? `${socket} · similar CPU` : "similar CPU",
    fallbackQuery,
  };
}

export function matchCpuProduct(componentName: string, plan: CpuSearchPlan, title: string): CpuMatch | null {
  if (!title || title === "Untitled product") return null;

  if (plan.exactModel && matchesCpuModel(plan.exactModel, title)) {
    return { matchType: "exact", matchLabel: "same CPU model" };
  }

  const expectedSocket = cpuSocket(componentName);
  const productSocket = cpuSocket(title);
  if (expectedSocket && productSocket === expectedSocket && /\b(?:processor|CPU|Ryzen|Core|Xeon)\b/i.test(normalizeCpuName(title))) {
    return { matchType: "similar", matchLabel: plan.label };
  }

  return null;
}

export function shouldSearchCpuFallback(plan: CpuSearchPlan, offers: ReadonlyArray<CpuMatch>): plan is CpuSearchPlan & { fallbackQuery: string } {
  return Boolean(plan.fallbackQuery) && !offers.some((offer) => offer.matchType === "exact");
}

export function cpuSocket(value: string): string | null {
  const text = normalizeCpuName(value).toUpperCase();
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

function normalizeCpuName(value: string): string {
  return value.replace(/\(\s*(?:R|TM)\s*\)|[®™]/gi, " ").replace(/\s+/g, " ").trim();
}

function cpuModel(value: string): string | null {
  return normalizeCpuName(value).match(/\b(?:i[3579]-?\d{4,5}[A-Z]{0,3}|\d{3,5}(?:X3D|XT|KF|KS|K|X|F|G)?|[3579]-\d{4,5}[A-Z]{0,3})\b/i)?.[0] || null;
}

function matchesCpuModel(model: string, title: string): boolean {
  const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(normalizeCpuName(title));
}

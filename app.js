const fileInput = document.querySelector("#report-file");
const dropzone = document.querySelector(".dropzone");
const fileName = document.querySelector("#file-name");
const reportText = document.querySelector("#report-text");
const parseButton = document.querySelector("#parse-button");
const scanButton = document.querySelector("#scan-button");
const results = document.querySelector("#results");
const status = document.querySelector("#status");

const patterns = [
  ["GPU", /(gpu|graphics card|graphics adapter|display adapter|video controller)(?:\s*[:=,-]\s*|\s+)(.+)/i],
  ["CPU", /(cpu|processor|model name)(?:\s*[:=,-]\s*|\s+)(.+)/i],
  ["RAM", /(ram|memory|installed physical memory)(?:\s*[:=,-]\s*|\s+)(.+)/i],
  ["SSD", /(ssd|nvme|storage|disk model)(?:\s*[:=,-]\s*|\s+)(.+)/i],
];

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}

function parseJson(value) {
  try {
    const data = JSON.parse(value);
    return Object.entries(data).map(([key, item]) => `${key}: ${typeof item === "object" ? JSON.stringify(item) : item}`).join("\n");
  } catch {
    return value;
  }
}

function parseReport(raw) {
  const trimmed = raw.trim();
  const text = trimmed.startsWith("{") || trimmed.startsWith("[") ? parseJson(trimmed) : raw;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return patterns.map(([type, pattern]) => {
    const match = lines.map((line) => line.match(pattern)).find(Boolean);
    return match ? { type, value: match[2].trim() } : null;
  }).filter(Boolean);
}

function render(items, source = "report") {
  if (!items.length) {
    results.innerHTML = `<div class="result-empty">No CPU, GPU, RAM or SSD lines found. Try <code>GPU: NVIDIA RTX 4070</code>.</div>`;
    status.textContent = "nothing recognized";
    return;
  }
  results.innerHTML = items.map(({ type, value }) => {
    const url = `https://www.pricesquirrel.com/?q=${encodeURIComponent(value)}`;
    return `<div class="result-row"><span class="result-type">${type}</span><span class="result-value" title="${escapeHtml(value)}">${escapeHtml(value)}</span><a class="price-link" href="${url}" target="_blank" rel="noreferrer">Price ↗</a></div>`;
  }).join("");
  status.textContent = `${items.length} component${items.length === 1 ? "" : "s"} · ${source}`;
}

function readText(raw, source) {
  render(parseReport(raw), source);
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  await loadFile(file);
});

async function loadFile(file) {
  fileName.textContent = `${file.name} · reading…`;
  readText(await file.text(), "local file");
  fileName.textContent = `${file.name} · ready`;
}

dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("is-dragging");
});

dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-dragging"));
dropzone.addEventListener("drop", async (event) => {
  event.preventDefault();
  dropzone.classList.remove("is-dragging");
  const file = event.dataTransfer.files?.[0];
  if (file) await loadFile(file);
});

parseButton.addEventListener("click", () => {
  if (!reportText.value.trim()) {
    status.textContent = "paste report text first";
    reportText.focus();
    return;
  }
  readText(reportText.value, "pasted text");
});

scanButton.addEventListener("click", () => {
  const hints = [];
  if (navigator.hardwareConcurrency) hints.push({ type: "CPU", value: `${navigator.hardwareConcurrency} logical cores reported` });
  if (navigator.deviceMemory) hints.push({ type: "RAM", value: `at least ${navigator.deviceMemory} GB reported` });
  if (navigator.userAgentData?.platform || navigator.platform) hints.push({ type: "OS", value: navigator.userAgentData?.platform || navigator.platform });
  render(hints, "browser hints");
});

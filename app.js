const state = { components: [] };

const demoComponents = [
  { type: "GPU", value: "Browser-visible display adapter", query: "graphics card" },
  { type: "CPU", value: "Browser-visible processor hint", query: "cpu" },
  { type: "RAM", value: "Memory capacity unavailable", query: "ddr5 ram" },
  { type: "SSD", value: "Import a report to identify", query: "nvme ssd" },
];

const scanButton = document.querySelector("#scan-button");
const reportFile = document.querySelector("#report-file");
const fileName = document.querySelector("#file-name");
const scanStatus = document.querySelector("#scan-status");
const scanOutput = document.querySelector("#scan-output");
const hardwarePanel = document.querySelector("#hardware-panel");
const hardwareList = document.querySelector("#hardware-list");
const pricePanel = document.querySelector("#price-panel");
const priceList = document.querySelector("#price-list");

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}

function renderComponents() {
  hardwareList.innerHTML = state.components.map((item) => `
    <div class="hardware-item"><span class="hardware-type">${escapeHtml(item.type)}</span><span class="hardware-value">${escapeHtml(item.value)}</span></div>
  `).join("");
  hardwarePanel.hidden = false;
  pricePanel.hidden = true;
}

function browserHints() {
  const hints = [];
  const uaData = navigator.userAgentData;
  const platform = uaData?.platform || navigator.platform || "Unknown platform";
  const browserCpu = navigator.hardwareConcurrency ? `${navigator.hardwareConcurrency} logical cores reported` : "Core count unavailable";
  hints.push({ type: "CPU", value: browserCpu, query: "cpu" });
  hints.push({ type: "PLATFORM", value: platform, query: "pc hardware" });
  if (navigator.deviceMemory) hints.push({ type: "RAM", value: `At least ${navigator.deviceMemory} GB reported`, query: "ddr5 ram" });
  return hints;
}

async function runScan() {
  scanButton.disabled = true;
  scanStatus.textContent = "reading safe hints…";
  scanButton.innerHTML = "Scanning <span>…</span>";
  let devices = 0;
  try {
    if (navigator.hid?.getDevices) devices += (await navigator.hid.getDevices()).length;
    if (navigator.usb?.getDevices) devices += (await navigator.usb.getDevices()).length;
  } catch (error) {
    // Permission errors are expected until a user authorizes a device.
  }
  state.components = [...browserHints(), { type: "DEVICES", value: devices ? `${devices} authorized device${devices === 1 ? "" : "s"}` : "No authorized USB/HID devices", query: "pc hardware" }];
  scanOutput.innerHTML = `<div class="output-row"><span>Browser hints</span><strong>${state.components.length - 1} signals</strong></div><div class="output-row"><span>Authorized devices</span><strong>${devices}</strong></div><div class="output-row"><span>Data sent</span><strong>nothing</strong></div>`;
  renderComponents();
  scanStatus.textContent = "scan complete";
  scanButton.disabled = false;
  scanButton.innerHTML = "Scan again <span>↗</span>";
}

function parseReport(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const patterns = [
    ["GPU", /(gpu|graphics|display adapter|video controller)\s*[:=-]?\s*(.+)/i, "graphics card"],
    ["CPU", /(cpu|processor|model name)\s*[:=-]?\s*(.+)/i, "cpu"],
    ["RAM", /(ram|memory|installed physical memory)\s*[:=-]?\s*(.+)/i, "ddr5 ram"],
    ["SSD", /(ssd|nvme|storage|disk model)\s*[:=-]?\s*(.+)/i, "nvme ssd"],
  ];
  const found = patterns.map(([type, pattern, query]) => {
    const match = lines.map((line) => line.match(pattern)).find(Boolean);
    return match ? { type, value: match[2].trim(), query } : null;
  }).filter(Boolean);
  return found.length ? found : demoComponents;
}

function renderPrices() {
  priceList.innerHTML = state.components.filter((item) => ["GPU", "CPU", "RAM", "SSD"].includes(item.type)).map((item) => {
    const searchUrl = `https://www.pricesquirrel.com/?q=${encodeURIComponent(item.value === "Browser-visible display adapter" ? item.query : item.value)}`;
    return `<div class="price-item"><span class="hardware-type">${escapeHtml(item.type)}</span><span class="price-value">check live</span><a class="price-link" href="${searchUrl}" target="_blank" rel="noreferrer">Open PriceSquirrel ↗</a></div>`;
  }).join("");
  pricePanel.hidden = false;
  pricePanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

scanButton.addEventListener("click", runScan);

reportFile.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  fileName.textContent = `${file.name} · parsing locally`;
  const text = await file.text();
  state.components = parseReport(text);
  renderComponents();
  fileName.textContent = `${file.name} · ready`;
});

document.querySelector("#price-button").addEventListener("click", renderPrices);

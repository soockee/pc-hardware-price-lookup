const scripts = {
  windows: {
    label: "Windows PowerShell",
    code: `$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name
$gpu = (Get-CimInstance Win32_VideoController | Where-Object Name | Select-Object -ExpandProperty Name) -join ", "
$ram = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
$storage = (Get-CimInstance Win32_DiskDrive | Where-Object Model | ForEach-Object { "$($_.Model) $([math]::Round($_.Size / 1GB)) GB" }) -join "; "
$report = "CPU: $cpu\`nGPU: $gpu\`nRAM: $ram GB\`nSSD: $storage"
Set-Clipboard -Value $report
$report`,
  },
  macos: {
    label: "macOS Terminal",
    code: `cpu=$(sysctl -n machdep.cpu.brand_string)
gpu=$(system_profiler SPDisplaysDataType | awk -F: '/Chipset Model|Chip/{gsub(/^[ \t]+/, "", $2); print $2}' | paste -sd ', ' -)
ram=$(sysctl -n hw.memsize | awk '{printf "%.0f GB", $1/1024/1024/1024}')
storage=$(system_profiler SPStorageDataType | awk -F: '/Device Name|Media Name/{gsub(/^[ \t]+/, "", $2); print $2}' | paste -sd '; ' -)
report=$(printf 'CPU: %s\\nGPU: %s\\nRAM: %s\\nSSD: %s' "$cpu" "$gpu" "$ram" "$storage")
printf '%s' "$report" | pbcopy
printf '%s\\n' "$report"`,
  },
  linux: {
    label: "Linux Terminal",
    code: `cpu=$(lscpu | sed -n 's/^Model name:[[:space:]]*//p' | head -n 1)
gpu=$(lspci 2>/dev/null | grep -Ei 'VGA|3D|Display' | sed 's/^[^:]*: //' | paste -sd ', ' -)
ram=$(free -h | awk '/^Mem:/{print $2}')
storage=$(lsblk -dn -o MODEL,SIZE,TYPE 2>/dev/null | awk '$NF=="disk" { $NF=""; sub(/[ \\t]+$/, ""); print }' | paste -sd '; ' -)
report=$(printf 'CPU: %s\\nGPU: %s\\nRAM: %s\\nSSD: %s' "$cpu" "$gpu" "$ram" "$storage")
printf '%s' "$report" | (command -v xclip >/dev/null && xclip -selection clipboard || command -v xsel >/dev/null && xsel --clipboard --input || cat)
printf '%s\\n' "$report"`,
  },
};

const scriptCode = document.querySelector("#script-code");
const scriptLabel = document.querySelector("#script-label");
const copyScript = document.querySelector("#copy-script");
const copyStatus = document.querySelector("#copy-status");
const osTabs = document.querySelectorAll(".os-tab");
const reportText = document.querySelector("#report-text");
const parseButton = document.querySelector("#parse-button");
const fileInput = document.querySelector("#report-file");
const results = document.querySelector("#results");
const status = document.querySelector("#status");

let selectedOs = /mac/i.test(navigator.platform) ? "macos" : /linux/i.test(navigator.platform) ? "linux" : "windows";

const patterns = [
  ["GPU", /(gpu|graphics card|graphics adapter|display adapter|video controller)(?:\s*[:=,-]\s*|\s+)(.+)/i],
  ["CPU", /(cpu|processor|model name)(?:\s*[:=,-]\s*|\s+)(.+)/i],
  ["RAM", /(ram|memory|installed physical memory)(?:\s*[:=,-]\s*|\s+)(.+)/i],
  ["SSD", /(ssd|nvme|storage|disk model)(?:\s*[:=,-]\s*|\s+)(.+)/i],
];

function setOs(os) {
  selectedOs = os;
  scriptCode.textContent = scripts[os].code;
  scriptLabel.textContent = scripts[os].label;
  osTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.os === os));
  copyStatus.textContent = "Run it in your terminal. The output is copied to your clipboard.";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}

function parseJson(value) {
  try {
    const data = JSON.parse(value);
    return Object.entries(data).map(([key, item]) => `${key}: ${typeof item === "object" ? JSON.stringify(item) : item}`).join("\n");
  } catch { return value; }
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
    results.innerHTML = `<div class="result-empty">No CPU, GPU, RAM or SSD lines found. Try pasting the script output again.</div>`;
    status.textContent = "nothing recognized";
    return;
  }
  results.innerHTML = items.map(({ type, value }) => {
    const url = `https://www.pricesquirrel.com/?q=${encodeURIComponent(value)}`;
    return `<div class="result-row"><span class="result-type">${type}</span><span class="result-value" title="${escapeHtml(value)}">${escapeHtml(value)}</span><a class="price-link" href="${url}" target="_blank" rel="noreferrer">Price ↗</a></div>`;
  }).join("");
  status.textContent = `${items.length} component${items.length === 1 ? "" : "s"} · ${source}`;
}

function readText(raw, source) { render(parseReport(raw), source); }

osTabs.forEach((tab) => tab.addEventListener("click", () => setOs(tab.dataset.os)));

copyScript.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(scripts[selectedOs].code);
    copyScript.textContent = "Copied";
    copyStatus.textContent = "Copied. Run the script, then paste its output on the right.";
    setTimeout(() => { copyScript.textContent = "Copy script"; }, 1400);
  } catch {
    copyStatus.textContent = "Copy was blocked. Select the script text and copy it manually.";
  }
});

parseButton.addEventListener("click", () => {
  if (!reportText.value.trim()) { status.textContent = "paste report text first"; reportText.focus(); return; }
  readText(reportText.value, "pasted text");
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  readText(await file.text(), "local file");
});

setOs(selectedOs);

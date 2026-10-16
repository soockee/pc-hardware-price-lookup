const scripts = {
  windows: {
    label: "Windows PowerShell",
    code: `$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name
$gpu = (Get-CimInstance Win32_VideoController | Where-Object Name | Select-Object -ExpandProperty Name) -join ", "
$ram = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
$storage = (Get-CimInstance Win32_DiskDrive | Where-Object Model | ForEach-Object { "$($_.Model) $([math]::Round($_.Size / 1GB)) GB" }) -join "; "
$board = (Get-CimInstance Win32_BaseBoard | ForEach-Object { "$($_.Manufacturer) $($_.Product)" }) -join "; "
$os = (Get-CimInstance Win32_OperatingSystem).Caption
$report = "CPU: $cpu\`nGPU: $gpu\`nRAM: $ram GB\`nSTORAGE: $storage\`nMOTHERBOARD: $board\`nOS: $os"
Set-Clipboard -Value $report
$report`,
  },
  macos: {
    label: "macOS Terminal",
    code: `cpu=$(sysctl -n machdep.cpu.brand_string)
gpu=$(system_profiler SPDisplaysDataType | awk -F: '/Chipset Model|Chip/{gsub(/^[ \t]+/, "", $2); print $2}' | paste -sd ', ' -)
ram=$(sysctl -n hw.memsize | awk '{printf "%.0f GB", $1/1024/1024/1024}')
storage=$(system_profiler SPStorageDataType | awk -F: '/Device Name|Media Name/{gsub(/^[ \t]+/, "", $2); print $2}' | paste -sd '; ' -)
model=$(system_profiler SPHardwareDataType | awk -F: '/Model Name/{gsub(/^[ \t]+/, "", $2); print $2; exit}')
os=$(sw_vers -productVersion)
report=$(printf 'CPU: %s\\nGPU: %s\\nRAM: %s\\nSTORAGE: %s\\nMOTHERBOARD: %s\\nOS: macOS %s' "$cpu" "$gpu" "$ram" "$storage" "$model" "$os")
printf '%s' "$report" | pbcopy
printf '%s\\n' "$report"`,
  },
  linux: {
    label: "Linux Terminal",
    code: `cpu=$(lscpu | sed -n 's/^Model name:[[:space:]]*//p' | head -n 1)
gpu=$(lspci 2>/dev/null | grep -Ei 'VGA|3D|Display' | sed 's/^[^:]*: //' | paste -sd ', ' -)
ram=$(free -h | awk '/^Mem:/{print $2}')
storage=$(lsblk -dn -o MODEL,SIZE,TYPE 2>/dev/null | awk '$NF=="disk" { $NF=""; sub(/[ \\t]+$/, ""); print }' | paste -sd '; ' -)
board=$(cat /sys/devices/virtual/dmi/id/board_vendor /sys/devices/virtual/dmi/id/board_name 2>/dev/null | paste -sd ' ' -)
os=$( . /etc/os-release 2>/dev/null && printf '%s' "$PRETTY_NAME" )
report=$(printf 'CPU: %s\\nGPU: %s\\nRAM: %s\\nSTORAGE: %s\\nMOTHERBOARD: %s\\nOS: %s' "$cpu" "$gpu" "$ram" "$storage" "$board" "$os")
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
const fileInput = document.querySelector("#report-file");
const results = document.querySelector("#results");
const status = document.querySelector("#status");
let selectedOs = /mac/i.test(navigator.platform) ? "macos" : /linux/i.test(navigator.platform) ? "linux" : "windows";

const patterns = [
  ["GPU", /(gpu|graphics card|graphics adapter|display adapter|video controller)(?:\s*[:=,-]\s*|\s+)(.+)/i],
  ["CPU", /(cpu|processor|model name)(?:\s*[:=,-]\s*|\s+)(.+)/i],
  ["RAM", /(ram|memory|installed physical memory)(?:\s*[:=,-]\s*|\s+)(.+)/i],
  ["STORAGE", /(storage|ssd|nvme|disk model)(?:\s*[:=,-]\s*|\s+)(.+)/i],
  ["MOTHERBOARD", /(motherboard|mainboard|baseboard)(?:\s*[:=,-]\s*|\s+)(.+)/i],
  ["OS", /(os|operating system)(?:\s*[:=,-]\s*|\s+)(.+)/i],
];

function setOs(os) {
  selectedOs = os;
  scriptCode.textContent = scripts[os].code;
  scriptLabel.textContent = scripts[os].label;
  osTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.os === os));
  copyStatus.textContent = "Run the copied command in your terminal. Your report will be copied automatically.";
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

function priceUrl(type, value) {
  const category = { GPU: "gpus", CPU: "cpus", RAM: "ram", STORAGE: "ssds" }[type];
  return category ? `https://www.pricesquirrel.com/${category}` : null;
}

function render(items, source = "report") {
  if (!items.length) {
    results.innerHTML = `<div class="result-empty">No recognizable components yet. Paste the complete output from the command.</div>`;
    status.textContent = "nothing recognized";
    return;
  }
  results.innerHTML = items.map(({ type, value }) => {
    const url = priceUrl(type, value);
    const action = url ? `<a class="price-link" href="${url}" target="_blank" rel="noreferrer">Price check ↗</a>` : `<span class="price-link muted-link">not tracked</span>`;
    return `<div class="result-row"><span class="result-type">${type}</span><span class="result-value" title="${escapeHtml(value)}">${escapeHtml(value)}</span>${action}</div>`;
  }).join("");
  status.textContent = `${items.length} component${items.length === 1 ? "" : "s"} · ${source}`;
}

function readText(raw, source) { render(parseReport(raw), source); }

osTabs.forEach((tab) => tab.addEventListener("click", () => setOs(tab.dataset.os)));

copyScript.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(scripts[selectedOs].code);
    copyScript.textContent = "Copied";
    copyStatus.textContent = "Copied. Run it in your terminal, then paste the report on the right.";
    setTimeout(() => { copyScript.textContent = "Copy command"; }, 1400);
  } catch { copyStatus.textContent = "Copy was blocked. Select the command text and copy it manually."; }
});

reportText.addEventListener("input", () => readText(reportText.value, "pasted text"));

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const text = await file.text();
  reportText.value = text;
  readText(text, "local file");
});

setOs(selectedOs);

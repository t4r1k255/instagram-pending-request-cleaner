import { parseInputFile, extractQueueItems, getHeaders, suggestUsernameColumn } from "./parser.js";

const elements = Object.fromEntries([
  "fileInput", "mappingFields", "sheetSelect", "columnSelect", "headerCheckbox", "previewBox",
  "minDelay", "maxDelay", "batchSize", "maxRetries", "strictVerify", "dryRun", "message", "statusBadge",
  "progressBar", "progressText", "successCount", "skipCount", "errorCount", "currentUser", "startButton",
  "pauseButton", "resumeButton", "exportButton", "resetButton"
].map((id) => [id, document.getElementById(id)]));

let workbook = null;
let selectedItems = [];
let currentState = null;

elements.fileInput.addEventListener("change", loadFile);
elements.sheetSelect.addEventListener("change", refreshMapping);
elements.columnSelect.addEventListener("change", refreshPreview);
elements.headerCheckbox.addEventListener("change", refreshMapping);
elements.startButton.addEventListener("click", start);
elements.pauseButton.addEventListener("click", () => action("PAUSE"));
elements.resumeButton.addEventListener("click", () => action("RESUME"));
elements.resetButton.addEventListener("click", reset);
elements.exportButton.addEventListener("click", exportResults);
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "STATE_UPDATED") renderState(message.state);
});

initialize();

async function initialize() {
  const response = await send({ type: "GET_STATE" });
  if (response?.state) renderState(response.state);
}

async function loadFile(event) {
  clearMessage();
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    workbook = await parseInputFile(file);
    elements.sheetSelect.replaceChildren(...workbook.sheets.map((sheet, index) => option(index, sheet.name)));
    elements.mappingFields.classList.remove("hidden");
    refreshMapping();
    showMessage(file.name + " okundu.", true);
  } catch (error) {
    workbook = null;
    selectedItems = [];
    elements.mappingFields.classList.add("hidden");
    elements.startButton.disabled = true;
    showMessage(error.message || String(error));
  }
}

function refreshMapping() {
  if (!workbook) return;
  const sheet = workbook.sheets[Number(elements.sheetSelect.value) || 0];
  const headers = getHeaders(sheet.rows, elements.headerCheckbox.checked);
  elements.columnSelect.replaceChildren(...headers.map((header, index) => option(index, header)));
  elements.columnSelect.value = String(suggestUsernameColumn(headers));
  refreshPreview();
}

function refreshPreview() {
  if (!workbook) return;
  const sheet = workbook.sheets[Number(elements.sheetSelect.value) || 0];
  selectedItems = extractQueueItems(
    sheet.rows,
    Number(elements.columnSelect.value) || 0,
    elements.headerCheckbox.checked
  );

  if (selectedItems.length) {
    const lines = [
      selectedItems.length + " benzersiz hesap",
      "Gerçek Instagram ID’leri çalışma anında çözülecek.",
      ...selectedItems.slice(0, 5).map((item) => "@" + item.username)
    ];
    if (selectedItems.length > 5) lines.push("…");
    elements.previewBox.textContent = lines.join("\n");
  } else {
    elements.previewBox.textContent = "Bu sütunda geçerli kullanıcı adı bulunamadı.";
  }
  elements.startButton.disabled = selectedItems.length === 0;
}

async function start() {
  clearMessage();
  try {
    const settings = readSettings();
    let response = await send({ type: "INIT_QUEUE", items: selectedItems, settings });
    if (!response?.ok) throw new Error(response?.error || "Liste başlatılamadı.");
    renderState(response.state);
    response = await send({ type: "START" });
    if (!response?.ok) throw new Error(response?.error || "İşlem başlatılamadı.");
    renderState(response.state);
    window.close();
  } catch (error) {
    showMessage(error.message || String(error));
  }
}

function readSettings() {
  const minDelay = Number(elements.minDelay.value);
  const maxDelay = Number(elements.maxDelay.value);
  const batchSize = Number(elements.batchSize.value);
  const maxRetries = Number(elements.maxRetries.value);

  if (!Number.isFinite(minDelay) || !Number.isFinite(maxDelay) || minDelay < 0.5 || maxDelay > 300 || minDelay > maxDelay) {
    throw new Error("Gecikme aralığını kontrol et.");
  }
  if (!Number.isInteger(batchSize) || batchSize < 0) {
    throw new Error("Parti büyüklüğü 0 veya pozitif tam sayı olmalı.");
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3) {
    throw new Error("Geçici hata tekrarı 0–3 arasında olmalı.");
  }

  return {
    minDelay,
    maxDelay,
    batchSize,
    maxRetries,
    strictVerify: elements.strictVerify.checked,
    dryRun: elements.dryRun.checked
  };
}

async function action(type) {
  clearMessage();
  const response = await send({ type });
  if (!response?.ok) return showMessage(response?.error || "İşlem başarısız.");
  renderState(response.state);
  if (type === "RESUME") window.close();
}

async function reset() {
  if (!confirm("Kaydedilmiş kuyruk ve sonuçlar silinsin mi?")) return;
  const response = await send({ type: "RESET" });
  if (!response?.ok) return showMessage(response?.error || "Sıfırlanamadı.");
  currentState = null;
  renderState(null);
}

function renderState(state) {
  currentState = state;
  if (!state) {
    elements.statusBadge.textContent = "Hazır";
    elements.progressBar.style.width = "0%";
    elements.progressText.textContent = "Henüz liste yüklenmedi.";
    elements.successCount.textContent = "0";
    elements.skipCount.textContent = "0";
    elements.errorCount.textContent = "0";
    elements.currentUser.textContent = "";
    elements.pauseButton.disabled = true;
    elements.resumeButton.disabled = true;
    elements.exportButton.disabled = true;
    elements.resetButton.disabled = true;
    return;
  }

  const counts = countStatuses(state.items);
  const processed = state.items.filter((item) => item.status !== "pending").length;
  const total = state.items.length;
  elements.statusBadge.textContent = statusLabel(state.status);
  elements.progressBar.style.width = (total ? (processed / total) * 100 : 0) + "%";
  elements.progressText.textContent = processed + " / " + total + " işlendi — " + (state.statusMessage || "");
  elements.successCount.textContent = String(counts.success + counts["would-cancel"]);
  elements.skipCount.textContent = String(counts["not-requested"] + counts.accepted + counts["not-found"]);
  elements.errorCount.textContent = String(counts.failed);
  elements.currentUser.textContent = state.items[state.cursor]
    ? "Sıradaki: @" + state.items[state.cursor].username
    : "";
  elements.pauseButton.disabled = state.status !== "running";
  elements.resumeButton.disabled = ![
    "paused", "batch-complete", "waiting-login", "rate-limited", "setup-required"
  ].includes(state.status);
  elements.exportButton.disabled = processed === 0;
  elements.resetButton.disabled = false;
}

function countStatuses(items) {
  const result = {
    success: 0,
    "would-cancel": 0,
    "not-requested": 0,
    accepted: 0,
    "not-found": 0,
    failed: 0
  };
  for (const item of items) {
    if (item.status in result) result[item.status] += 1;
  }
  return result;
}

function exportResults() {
  if (!currentState) return;
  const rows = [[
    "username",
    "export_fbid",
    "instagram_user_id",
    "precheck",
    "postcheck",
    "status",
    "reason",
    "message",
    "attempts",
    "updated_at"
  ], ...currentState.items.map((item) => [
    item.username,
    item.exportFbid || "",
    item.instagramUserId || "",
    item.precheck || "",
    item.postcheck || "",
    item.status,
    item.reason || "",
    item.message,
    item.attempts,
    item.updatedAt || ""
  ])];

  const lines = rows.map((row) => row.map(csvCell).join(","));
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "instagram-request-results-" + new Date().toISOString().slice(0, 10) + ".csv";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value) {
  return '"' + String(value ?? "").replace(/"/g, '""') + '"';
}

function option(value, label) {
  const element = document.createElement("option");
  element.value = String(value);
  element.textContent = label;
  return element;
}

function statusLabel(status) {
  return ({
    ready: "Hazır",
    running: "Çalışıyor",
    paused: "Duraklatıldı",
    "batch-complete": "Parti bitti",
    "waiting-login": "Giriş bekliyor",
    "rate-limited": "Sınır bildirildi",
    "setup-required": "Kurulum gerekli",
    complete: "Tamamlandı"
  })[status] || status;
}

function showMessage(text, ok = false) {
  elements.message.textContent = text;
  elements.message.className = "message" + (ok ? " ok" : "");
}

function clearMessage() {
  elements.message.textContent = "";
  elements.message.className = "message hidden";
}

function send(message) {
  return chrome.runtime.sendMessage(message).catch((error) => ({
    ok: false,
    error: error.message
  }));
}

const STATE_KEY = "requestCleanerStateV2";
const LEGACY_STATE_KEY = "requestCleanerStateV1";
const TERMINAL = new Set([
  "success",
  "would-cancel",
  "not-requested",
  "accepted",
  "not-found",
  "failed"
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (!state || state.runnerTabId !== tabId) return;
  state.runnerTabId = null;
  state.runnerTabOwned = false;
  if (state.status === "running") {
    state.status = "paused";
    state.statusMessage = "Arka plan Instagram sekmesi kapatıldığı için duraklatıldı.";
  }
  await saveState(state);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  const state = await getState();
  if (!state || state.status !== "running" || state.runnerTabId !== tabId) return;
  await wakeRunner(tabId);
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "GET_STATE":
      return { ok: true, state: await reconcileState() };
    case "INIT_QUEUE":
      return initializeQueue(message);
    case "START":
      return startQueue(false);
    case "RESUME":
      return startQueue(true);
    case "PAUSE":
      return pauseQueue();
    case "RESET":
      return resetQueue();
    case "RUNNER_READY":
      return runnerReady(sender);
    case "NEXT_TASK":
      return nextTask(sender);
    case "PHASE":
      return recordPhase(message, sender);
    case "RESULT":
      return recordResult(message, sender);
    default:
      return { ok: false, error: "Bilinmeyen mesaj." };
  }
}

async function initializeQueue(message) {
  const inputItems = Array.isArray(message.items)
    ? message.items
    : (Array.isArray(message.usernames) ? message.usernames.map((username) => ({ username })) : []);
  const deduped = new Map();

  for (const input of inputItems) {
    const username = normalizeUsername(input?.username);
    if (!username) continue;
    const exportFbid = normalizeId(input?.exportFbid || input?.targetId);
    const instagramUserId = normalizeId(input?.instagramUserId);
    const existing = deduped.get(username);
    if (!existing) {
      deduped.set(username, { username, exportFbid, instagramUserId });
    } else {
      if (!existing.exportFbid && exportFbid) existing.exportFbid = exportFbid;
      if (!existing.instagramUserId && instagramUserId) existing.instagramUserId = instagramUserId;
    }
  }

  const queueItems = [...deduped.values()];
  if (!queueItems.length) throw new Error("İşlenecek kullanıcı bulunamadı.");

  const previous = await getState();
  if (previous?.runnerTabOwned && previous.runnerTabId !== null) {
    const previousTabId = previous.runnerTabId;
    previous.runnerTabId = null;
    previous.runnerTabOwned = false;
    if (previous.status === "running") previous.status = "paused";
    await saveState(previous);
    chrome.tabs.sendMessage(previousTabId, { type: "RUNNER_STOP" }).catch(() => {});
    try { await chrome.tabs.remove(previousTabId); }
    catch {}
  }

  const now = new Date().toISOString();
  const state = {
    version: 2,
    status: "ready",
    statusMessage: queueItems.length + " kullanıcı hazır; gerçek Instagram ID’leri çalışma anında çözülecek.",
    settings: validateSettings(message.settings || {}),
    items: queueItems.map((item) => ({
      username: item.username,
      exportFbid: item.exportFbid,
      instagramUserId: item.instagramUserId,
      status: "pending",
      precheck: "unknown",
      postcheck: "unknown",
      reason: "",
      message: "",
      attempts: 0,
      updatedAt: null
    })),
    cursor: 0,
    batchProcessed: 0,
    runnerTabId: null,
    runnerTabOwned: false,
    startedAt: null,
    updatedAt: now
  };

  await saveState(state);
  return { ok: true, state };
}

function validateSettings(settings) {
  const minDelay = Number(settings.minDelay);
  const maxDelay = Number(settings.maxDelay);
  const batchSize = Math.floor(Number(settings.batchSize));
  const maxRetries = Math.floor(Number(settings.maxRetries ?? 1));

  if (!Number.isFinite(minDelay) || !Number.isFinite(maxDelay) || minDelay < 0.5 || maxDelay > 300 || minDelay > maxDelay) {
    throw new Error("Gecikme aralığı 0.5–300 saniye olmalı ve minimum maksimumu aşmamalı.");
  }
  if (!Number.isFinite(batchSize) || batchSize < 0 || batchSize > 10000) {
    throw new Error("Parti büyüklüğü geçersiz.");
  }
  if (!Number.isFinite(maxRetries) || maxRetries < 0 || maxRetries > 3) {
    throw new Error("Yeniden deneme sayısı 0–3 arasında olmalı.");
  }

  return {
    minDelay,
    maxDelay,
    batchSize,
    maxRetries,
    strictVerify: Boolean(settings.strictVerify),
    dryRun: Boolean(settings.dryRun)
  };
}

async function startQueue(isResume) {
  const state = await requireState();
  moveCursorToPending(state);
  if (state.cursor >= state.items.length) return complete(state);

  state.status = "running";
  state.statusMessage = isResume ? "Arka plan işlemi devam ediyor." : "Arka plan işlemi başlatıldı.";
  state.batchProcessed = 0;
  state.startedAt ||= new Date().toISOString();

  await ensureRunnerTab(state);
  await saveState(state);
  await wakeRunner(state.runnerTabId);
  return { ok: true, state: await getState() };
}

async function pauseQueue() {
  const state = await requireState();
  state.status = "paused";
  state.statusMessage = "Kullanıcı tarafından duraklatıldı.";
  await saveState(state);
  if (state.runnerTabId !== null) {
    chrome.tabs.sendMessage(state.runnerTabId, { type: "RUNNER_STOP" }).catch(() => {});
  }
  return { ok: true, state };
}

async function resetQueue() {
  const state = await getState();
  const tabId = state?.runnerTabId;
  const shouldClose = Boolean(state?.runnerTabOwned && tabId !== null);
  if (tabId !== null && tabId !== undefined) {
    chrome.tabs.sendMessage(tabId, { type: "RUNNER_STOP" }).catch(() => {});
  }
  await chrome.storage.local.remove([STATE_KEY, LEGACY_STATE_KEY]);
  if (shouldClose) {
    try { await chrome.tabs.remove(tabId); }
    catch {}
  }
  return { ok: true, state: null };
}

async function runnerReady(sender) {
  const state = await getState();
  if (!state || sender.tab?.id !== state.runnerTabId) return { ok: true, action: "IDLE" };
  return { ok: true, action: state.status === "running" ? "RUN" : "IDLE" };
}

async function nextTask(sender) {
  const state = await getState();
  if (!state || sender.tab?.id !== state.runnerTabId || state.status !== "running") {
    return { ok: true, action: "IDLE" };
  }

  moveCursorToPending(state);
  if (state.cursor >= state.items.length) return complete(state);
  const item = state.items[state.cursor];

  return {
    ok: true,
    action: "PROCESS",
    task: {
      username: item.username,
      dryRun: state.settings.dryRun,
      strictVerify: state.settings.strictVerify
    }
  };
}

async function recordResult(message, sender) {
  const state = await requireState();
  if (sender.tab?.id !== state.runnerTabId) return { ok: true, action: "IDLE" };

  const item = state.items[state.cursor];
  if (!item || item.username !== normalizeUsername(message.username)) {
    return { ok: true, action: "IDLE" };
  }

  item.attempts += 1;
  item.updatedAt = new Date().toISOString();
  item.message = String(message.message || "").slice(0, 320);
  item.reason = String(message.reason || "").slice(0, 80);
  item.precheck = normalizeCheck(message.precheck);
  item.postcheck = normalizeCheck(message.postcheck);
  const resolvedId = normalizeId(message.instagramUserId);
  if (resolvedId) item.instagramUserId = resolvedId;

  if (message.status === "login-required") {
    item.status = "pending";
    state.status = "waiting-login";
    state.statusMessage = "Instagram girişi veya hesap doğrulaması bekleniyor.";
    await saveState(state);
    if (state.runnerTabId !== null) chrome.tabs.update(state.runnerTabId, { active: true }).catch(() => {});
    return { ok: true, action: "PAUSE" };
  }

  if (message.status === "rate-limited") {
    item.status = "pending";
    state.status = "rate-limited";
    state.statusMessage = "Instagram işlem sınırı bildirdi; kuyruk güvenli biçimde durduruldu.";
    await saveState(state);
    return { ok: true, action: "PAUSE" };
  }

  if (message.status === "setup-required") {
    item.status = "pending";
    state.status = "setup-required";
    state.statusMessage = "Mutation şablonu yenilenmeli: arka plan sekmesinde bir bekleyen isteği elle iptal et, sonra Devam et’e bas.";
    await saveState(state);
    if (state.runnerTabId !== null) chrome.tabs.update(state.runnerTabId, { active: true }).catch(() => {});
    return { ok: true, action: "PAUSE" };
  }

  if (message.status === "failed" && message.retryable && item.attempts <= state.settings.maxRetries) {
    item.status = "pending";
    const delayMs = Math.max(1500, randomDelayMs(state.settings.minDelay, state.settings.maxDelay));
    state.statusMessage = "@" + item.username + " geçici hata verdi; " + formatSeconds(delayMs) + " saniye sonra yeniden denenecek.";
    await saveState(state);
    return { ok: true, action: "WAIT_AND_CONTINUE", delayMs };
  }

  item.status = TERMINAL.has(message.status) ? message.status : "failed";
  state.cursor += 1;
  state.batchProcessed += 1;
  moveCursorToPending(state);

  if (state.cursor >= state.items.length) return complete(state);

  if (state.settings.batchSize > 0 && state.batchProcessed >= state.settings.batchSize) {
    state.status = "batch-complete";
    state.statusMessage = state.batchProcessed + " işlemlik parti tamamlandı.";
    await saveState(state);
    return { ok: true, action: "PAUSE" };
  }

  if (state.status !== "running") {
    await saveState(state);
    return { ok: true, action: "PAUSE" };
  }

  const delayMs = randomDelayMs(state.settings.minDelay, state.settings.maxDelay);
  state.statusMessage = "Sıradaki hesap " + formatSeconds(delayMs) + " saniye sonra işlenecek.";
  await saveState(state);
  return { ok: true, action: "WAIT_AND_CONTINUE", delayMs };
}

async function recordPhase(message, sender) {
  const state = await getState();
  if (!state || state.status !== "running" || sender.tab?.id !== state.runnerTabId) return { ok: true };
  const item = state.items[state.cursor];
  if (!item || item.username !== normalizeUsername(message.username)) return { ok: true };
  state.statusMessage = String(message.message || "İşlem sürüyor.").slice(0, 240);
  await saveState(state);
  return { ok: true };
}

async function ensureRunnerTab(state) {
  if (state.runnerTabId !== null) {
    try {
      const tab = await chrome.tabs.get(state.runnerTabId);
      if (String(tab.url || "").startsWith("https://www.instagram.com/")) return tab;
    } catch {}
  }

  const tab = await chrome.tabs.create({
    url: "https://www.instagram.com/",
    active: false
  });
  state.runnerTabId = tab.id;
  state.runnerTabOwned = true;
  state.statusMessage = "Arka plan Instagram sekmesi hazırlanıyor.";
  return tab;
}

async function wakeRunner(tabId) {
  if (tabId === null || tabId === undefined) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "RUNNER_WAKE" });
  } catch {
    // Yeni sekmede content script yüklendiğinde RUNNER_READY mesajı gönderir.
  }
}

async function complete(state) {
  const tabId = state.runnerTabId;
  const owned = state.runnerTabOwned;
  state.status = "complete";
  state.statusMessage = "Listedeki tüm hesaplar işlendi.";
  state.runnerTabId = null;
  state.runnerTabOwned = false;
  await saveState(state);

  if (owned && tabId !== null) {
    chrome.tabs.sendMessage(tabId, { type: "RUNNER_STOP" }).catch(() => {});
    chrome.tabs.remove(tabId).catch(() => {});
  }
  return { ok: true, action: "COMPLETE", state };
}

function moveCursorToPending(state) {
  while (state.cursor < state.items.length && state.items[state.cursor].status !== "pending") {
    state.cursor += 1;
  }
}

function randomDelayMs(min, max) {
  return Math.round((min + Math.random() * (max - min)) * 1000);
}

function formatSeconds(ms) {
  return (ms / 1000).toFixed(ms % 1000 ? 1 : 0);
}

function normalizeUsername(value) {
  const username = String(value || "").trim().replace(/^@+/, "").toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(username) ? username : "";
}

function normalizeId(value) {
  const id = String(value || "").trim();
  return /^\d{3,30}$/.test(id) ? id : "";
}

function normalizeCheck(value) {
  const check = String(value || "unknown");
  return /^(unknown|pending|clear|accepted|unchanged|not-run)$/.test(check) ? check : "unknown";
}

async function getState() {
  return (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || null;
}

async function reconcileState() {
  const state = await getState();
  if (!state || state.status !== "running" || state.runnerTabId === null) return state;
  try {
    await chrome.tabs.get(state.runnerTabId);
  } catch {
    state.runnerTabId = null;
    state.runnerTabOwned = false;
    state.status = "paused";
    state.statusMessage = "Arka plan Instagram sekmesi bulunamadığı için duraklatıldı.";
    await saveState(state);
  }
  return state;
}

async function requireState() {
  const state = await getState();
  if (!state) throw new Error("Önce bir liste yüklemelisin.");
  return state;
}

async function saveState(state) {
  state.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ [STATE_KEY]: state });
  chrome.runtime.sendMessage({ type: "STATE_UPDATED", state }).catch(() => {});
}

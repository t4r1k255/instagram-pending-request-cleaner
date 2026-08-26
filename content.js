(() => {
  if (window.top !== window || window.__pendingRequestCleanerLoaded) return;
  window.__pendingRequestCleanerLoaded = true;

  let loopRunning = false;
  let stopRequested = false;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "RUNNER_WAKE") {
      stopRequested = false;
      runLoop().catch(() => {});
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "RUNNER_STOP") {
      stopRequested = true;
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  boot();

  async function boot() {
    await sleep(500);
    const response = await send({ type: "RUNNER_READY" });
    if (response?.action === "RUN") runLoop().catch(() => {});
  }

  async function runLoop() {
    if (loopRunning) return;
    loopRunning = true;
    stopRequested = false;

    try {
      while (!stopRequested) {
        const next = await send({ type: "NEXT_TASK" });
        if (next?.action !== "PROCESS" || !next.task) break;

        const task = next.task;
        await phase(task.username, "@" + task.username + ": gerçek kullanıcı ID’si ve mevcut durum sorgulanıyor.");

        let result;
        if (isLoginOrChallenge()) {
          result = {
            status: "login-required",
            message: "Instagram girişi veya hesap doğrulaması gerekiyor.",
            precheck: "unknown",
            postcheck: "unknown",
            retryable: false
          };
        } else {
          result = await processThroughPageBridge(task, 40000);
        }

        const outcome = await send({
          type: "RESULT",
          username: task.username,
          ...result
        });

        if (outcome?.action !== "WAIT_AND_CONTINUE") break;
        await sleepInterruptible(Number(outcome.delayMs) || 0);
      }
    } finally {
      loopRunning = false;
    }
  }

  function processThroughPageBridge(task, timeoutMs) {
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve({
          status: "failed",
          message: "Instagram sayfa köprüsü zamanında yanıt vermedi.",
          precheck: "unknown",
          postcheck: "unknown",
          retryable: true,
          reason: "bridge-timeout"
        });
      }, timeoutMs);

      function onMessage(event) {
        const data = event.data;
        if (
          event.source !== window ||
          data?.source !== "IPRC_PAGE_BRIDGE" ||
          data?.type !== "PROCESS_RESULT" ||
          data?.requestId !== requestId
        ) return;

        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve({
          status: String(data.status || "failed"),
          message: String(data.message || ""),
          instagramUserId: /^\d{3,30}$/.test(String(data.instagramUserId || "")) ? String(data.instagramUserId) : "",
          precheck: String(data.precheck || "unknown"),
          postcheck: String(data.postcheck || "unknown"),
          retryable: Boolean(data.retryable),
          reason: String(data.reason || "")
        });
      }

      window.addEventListener("message", onMessage);
      window.postMessage({
        source: "IPRC_CONTENT",
        type: "PROCESS_USER",
        requestId,
        username: task.username,
        dryRun: Boolean(task.dryRun),
        strictVerify: Boolean(task.strictVerify)
      }, location.origin);
    });
  }

  function isLoginOrChallenge() {
    return /^\/(accounts\/login|accounts\/onetap|challenge|checkpoint)\b/.test(location.pathname) ||
      Boolean(document.querySelector('input[name="username"], input[name="password"]'));
  }

  async function sleepInterruptible(ms) {
    let remaining = Math.max(0, ms);
    while (remaining > 0 && !stopRequested) {
      const slice = Math.min(remaining, 500);
      await sleep(slice);
      remaining -= slice;
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function phase(username, message) {
    return send({ type: "PHASE", username, message });
  }

  function send(message) {
    return chrome.runtime.sendMessage(message).catch((error) => ({
      ok: false,
      error: error.message || String(error)
    }));
  }
})();

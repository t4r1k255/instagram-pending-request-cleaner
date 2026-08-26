(() => {
  if (window.__iprcPageBridgeLoaded) return;
  window.__iprcPageBridgeLoaded = true;

  const MUTATION_NAME = "usePolarisUnfollowMutation";
  const DEFAULT_MUTATION_DOC_ID = "27789106940691111";
  const DEFAULT_IG_APP_ID = "936619743392459";
  const SAFE_HEADER_NAMES = new Set([
    "x-asbd-id",
    "x-csrftoken",
    "x-fb-lsd",
    "x-ig-app-id",
    "x-ig-www-claim",
    "x-requested-with"
  ]);

  const nativeFetch = window.fetch.bind(window);
  const capturedHeaders = new Map();
  let latestGraphqlParams = null;
  let mutationTemplate = null;
  let mutationDocId = DEFAULT_MUTATION_DOC_ID;
  let requestSequence = 0;

  installNetworkObserver();

  window.addEventListener("message", async (event) => {
    const message = event.data;
    if (event.source !== window || message?.source !== "IPRC_CONTENT") return;

    const requestId = String(message.requestId || "");
    if (!requestId) return;

    if (message.type === "PING") {
      return postResult(requestId, {
        status: "ready",
        message: "Instagram sayfa köprüsü hazır."
      });
    }

    if (message.type !== "PROCESS_USER") return;
    const username = normalizeUsername(message.username);
    if (!username) {
      return postResult(requestId, {
        status: "failed",
        message: "Geçersiz kullanıcı adı.",
        retryable: false
      });
    }

    try {
      const result = await processUser(username, {
        dryRun: Boolean(message.dryRun),
        strictVerify: Boolean(message.strictVerify)
      });
      postResult(requestId, result);
    } catch {
      postResult(requestId, {
        status: "failed",
        message: "Instagram isteği beklenmeyen bir hatayla durdu.",
        retryable: true
      });
    }
  });

  async function processUser(username, options) {
    const resolved = await resolveProfile(username);
    if (!resolved.ok) return failureResult(resolved);

    const instagramUserId = resolved.userId;
    let relationship = resolved.relationship;
    if (!isCompleteRelationship(relationship)) {
      const checked = await fetchFriendshipStatus(instagramUserId);
      if (!checked.ok) return failureResult(checked, instagramUserId);
      relationship = checked.relationship;
    }

    if (relationship.following === true) {
      return {
        status: "accepted",
        message: "İstek kabul edilmiş; takip edilen hesaba dokunulmadı.",
        instagramUserId,
        precheck: "accepted",
        postcheck: "unchanged"
      };
    }

    if (relationship.outgoingRequest !== true) {
      return {
        status: "not-requested",
        message: "Bu hesapta bekleyen takip isteği bulunmuyor.",
        instagramUserId,
        precheck: "clear",
        postcheck: "unchanged"
      };
    }

    if (options.dryRun) {
      return {
        status: "would-cancel",
        message: "Önizleme: bekleyen istek doğrulandı; iptal edilebilirdi.",
        instagramUserId,
        precheck: "pending",
        postcheck: "not-run"
      };
    }

    const mutation = await destroyPendingRequest(username, instagramUserId);
    if (!mutation.ok) return failureResult(mutation, instagramUserId, "pending");

    if (options.strictVerify) {
      await sleep(350);
      const verified = await fetchFriendshipStatus(instagramUserId);
      if (!verified.ok) {
        return {
          status: "failed",
          message: "Mutation başarılıydı ancak son durum sorgulanamadı.",
          instagramUserId,
          precheck: "pending",
          postcheck: "unknown",
          retryable: true
        };
      }
      if (verified.relationship.outgoingRequest !== false) {
        return {
          status: "failed",
          message: "Son kontrolde bekleyen istek hâlâ açık görünüyor.",
          instagramUserId,
          precheck: "pending",
          postcheck: "pending",
          retryable: true
        };
      }
    }

    return {
      status: "success",
      message: options.strictVerify
        ? "İstek doğrudan iptal edildi ve ikinci sorguyla doğrulandı."
        : "İstek doğrudan iptal edildi; mutation yanıtı doğrulandı.",
      instagramUserId,
      precheck: "pending",
      postcheck: "clear"
    };
  }

  async function resolveProfile(username) {
    const encoded = encodeURIComponent(username);
    const profile = await requestJson("/api/v1/users/web_profile_info/?username=" + encoded);
    if (profile.ok) {
      const user = extractProfileUser(profile.data);
      if (user) return validateResolvedUser(user, username);
    } else if (isBlockingFailure(profile)) {
      return profile;
    }

    const searchPaths = [
      "/api/v1/web/search/topsearch/?context=blended&query=" + encoded + "&include_reel=true",
      "/web/search/topsearch/?context=blended&query=" + encoded + "&include_reel=true"
    ];

    let lastFailure = profile;
    for (const path of searchPaths) {
      const searched = await requestJson(path);
      if (!searched.ok) {
        lastFailure = searched;
        if (isBlockingFailure(searched)) return searched;
        continue;
      }
      const user = extractSearchUser(searched.data, username);
      if (user) return validateResolvedUser(user, username);
    }

    if (lastFailure?.kind === "rate-limited" || lastFailure?.kind === "login-required") return lastFailure;
    return {
      ok: false,
      kind: "not-found",
      message: "Kullanıcı adı çözülemedi veya profil artık mevcut değil.",
      retryable: false
    };
  }

  function validateResolvedUser(user, expectedUsername) {
    const actualUsername = normalizeUsername(user.username);
    const userId = normalizeId(user.id ?? user.pk ?? user.pk_id ?? user.user_id);
    if (!actualUsername || actualUsername !== expectedUsername || !userId) {
      return {
        ok: false,
        kind: "identity-mismatch",
        message: "Profil kimliği kullanıcı adıyla güvenli biçimde eşleştirilemedi.",
        retryable: false
      };
    }
    return {
      ok: true,
      userId,
      relationship: normalizeFriendship(user)
    };
  }

  async function fetchFriendshipStatus(userId) {
    const response = await requestJson("/api/v1/friendships/show/" + encodeURIComponent(userId) + "/");
    if (!response.ok) return response;
    const relationship = normalizeFriendship(response.data);
    if (!isCompleteRelationship(relationship)) {
      return {
        ok: false,
        kind: "unverified-state",
        message: "Instagram mevcut takip durumunu eksiksiz döndürmedi.",
        retryable: true
      };
    }
    return { ok: true, relationship };
  }

  async function destroyPendingRequest(expectedUsername, targetId) {
    const tokens = readRuntimeTokens();
    const body = cloneParams(mutationTemplate || latestGraphqlParams);

    body.set("__d", "www");
    body.set("__user", "0");
    body.set("__a", "1");
    body.set("__comet_req", body.get("__comet_req") || "7");
    body.set("__req", nextRequestCode(body.get("__req")));
    body.set("fb_api_caller_class", "RelayModern");
    body.set("fb_api_req_friendly_name", MUTATION_NAME);
    body.set("server_timestamps", "true");
    body.set("variables", JSON.stringify({
      target_user_id: targetId,
      container_module: "profile",
      nav_chain: "PolarisProfilePostsTabRoot:profilePage:1:via_cold_start"
    }));
    body.set("doc_id", mutationDocId || DEFAULT_MUTATION_DOC_ID);

    if (tokens.fbDtsg) {
      body.set("fb_dtsg", tokens.fbDtsg);
      body.set("jazoest", makeJazoest(tokens.fbDtsg));
    }
    if (tokens.lsd) body.set("lsd", tokens.lsd);
    if (tokens.actorId) body.set("av", tokens.actorId);

    const fbDtsg = body.get("fb_dtsg");
    const lsd = body.get("lsd");
    if (!fbDtsg || !lsd) {
      return {
        ok: false,
        kind: "login-required",
        message: "Instagram oturum anahtarları okunamadı; sekmeyi yenileyip giriş durumunu kontrol et.",
        retryable: false
      };
    }

    const headers = runtimeHeaders();
    headers["content-type"] = "application/x-www-form-urlencoded";
    headers["x-fb-friendly-name"] = MUTATION_NAME;
    headers["x-fb-lsd"] = lsd;

    let response;
    try {
      response = await nativeFetch("/api/graphql", {
        method: "POST",
        credentials: "include",
        headers,
        body: body.toString(),
        referrer: location.href,
        referrerPolicy: "strict-origin-when-cross-origin"
      });
    } catch {
      return {
        ok: false,
        kind: "network-error",
        message: "Mutation gönderilirken bağlantı kesildi.",
        retryable: true
      };
    }

    const text = await safeResponseText(response);
    const payload = parseJsonPreservingIds(text);
    const transportFailure = classifyFailure(response.status, payload, text);
    if (transportFailure) return transportFailure;

    const node = payload?.data?.xdt_destroy_friendship;
    const returnedUsername = normalizeUsername(node?.username);
    const returnedId = normalizeId(node?.id);
    const friendship = normalizeFriendship(node?.friendship_status);

    if (!node && Array.isArray(payload?.errors)) {
      return {
        ok: false,
        kind: "template-stale",
        message: "Instagram mutation şablonunu reddetti. Bir isteği elle iptal edip sekmeyi yenileyerek tekrar dene.",
        retryable: false
      };
    }

    if (returnedUsername !== expectedUsername || returnedId !== targetId) {
      return {
        ok: false,
        kind: "identity-mismatch",
        message: "Mutation yanıtındaki hesap kimliği beklenen hesapla eşleşmedi.",
        retryable: false
      };
    }

    if (friendship.outgoingRequest !== false || friendship.following !== false) {
      return {
        ok: false,
        kind: "mutation-unconfirmed",
        message: "Mutation yanıtı bekleyen isteğin kapandığını doğrulamadı.",
        retryable: true
      };
    }

    return { ok: true };
  }

  async function requestJson(url) {
    let response;
    try {
      response = await nativeFetch(url, {
        method: "GET",
        credentials: "include",
        headers: runtimeHeaders(),
        referrer: location.href,
        referrerPolicy: "strict-origin-when-cross-origin"
      });
    } catch {
      return {
        ok: false,
        kind: "network-error",
        message: "Instagram durum sorgusuna ulaşılamadı.",
        retryable: true
      };
    }

    const text = await safeResponseText(response);
    const payload = parseJsonPreservingIds(text);
    const failure = classifyFailure(response.status, payload, text);
    if (failure) return failure;
    if (!payload || typeof payload !== "object") {
      return {
        ok: false,
        kind: "invalid-response",
        message: "Instagram JSON yerine beklenmeyen bir yanıt döndürdü.",
        retryable: true
      };
    }
    return { ok: true, data: payload };
  }

  function classifyFailure(statusCode, payload, rawText) {
    const text = (JSON.stringify(payload || {}) + " " + String(rawText || "")).toLowerCase();
    if (statusCode === 401 || statusCode === 403 || /login_required|checkpoint_required|challenge_required|accounts\/login/.test(text)) {
      return {
        ok: false,
        kind: "login-required",
        message: "Instagram giriş veya hesap doğrulaması istiyor.",
        statusCode,
        retryable: false
      };
    }
    if (statusCode === 429 || /feedback_required|please wait|rate.?limit|sentry_block|try again later/.test(text)) {
      return {
        ok: false,
        kind: "rate-limited",
        message: "Instagram işlem sınırı veya geçici engel bildirdi.",
        statusCode,
        retryable: false
      };
    }
    if (statusCode === 404) {
      return {
        ok: false,
        kind: "not-found",
        message: "Profil veya durum uç noktası bulunamadı.",
        statusCode,
        retryable: false
      };
    }
    if (statusCode >= 500) {
      return {
        ok: false,
        kind: "server-error",
        message: "Instagram geçici bir sunucu hatası döndürdü.",
        statusCode,
        retryable: true
      };
    }
    if (statusCode < 200 || statusCode >= 300) {
      return {
        ok: false,
        kind: "http-error",
        message: "Instagram isteği HTTP " + statusCode + " ile reddetti.",
        statusCode,
        retryable: statusCode === 0 || statusCode >= 500
      };
    }
    return null;
  }

  function failureResult(failure, instagramUserId = "", precheck = "unknown") {
    const kind = String(failure?.kind || "failed");
    const status = kind === "login-required"
      ? "login-required"
      : (kind === "rate-limited"
        ? "rate-limited"
        : (kind === "template-stale"
          ? "setup-required"
          : (kind === "not-found" ? "not-found" : "failed")));
    return {
      status,
      message: String(failure?.message || "İşlem doğrulanamadı."),
      instagramUserId: normalizeId(instagramUserId),
      precheck,
      postcheck: "unknown",
      retryable: Boolean(failure?.retryable),
      reason: kind
    };
  }

  function isBlockingFailure(failure) {
    return failure?.kind === "login-required" || failure?.kind === "rate-limited";
  }

  function extractProfileUser(payload) {
    return payload?.data?.user || payload?.user || payload?.data?.xdt_api__v1__users__web_profile_info?.user || null;
  }

  function extractSearchUser(payload, expectedUsername) {
    const candidates = payload?.users || payload?.data?.users || payload?.data?.xdt_users || [];
    for (const entry of Array.isArray(candidates) ? candidates : []) {
      const user = entry?.user || entry;
      if (normalizeUsername(user?.username) === expectedUsername) return user;
    }
    return null;
  }

  function normalizeFriendship(value) {
    const root = value?.friendship_status || value?.friendship || value?.data?.friendship_status || value?.data || value || {};
    return {
      following: firstBoolean(root.following, root.followed_by_viewer, value?.followed_by_viewer),
      outgoingRequest: firstBoolean(
        root.outgoing_request,
        root.requested_by_viewer,
        root.has_requested_viewer,
        value?.requested_by_viewer,
        value?.has_requested_viewer
      ),
      followedBy: firstBoolean(root.followed_by, root.follows_viewer, value?.follows_viewer)
    };
  }

  function isCompleteRelationship(value) {
    return typeof value?.following === "boolean" && typeof value?.outgoingRequest === "boolean";
  }

  function firstBoolean(...values) {
    for (const value of values) {
      if (typeof value === "boolean") return value;
      if (value === 1 || value === "1" || value === "true") return true;
      if (value === 0 || value === "0" || value === "false") return false;
    }
    return null;
  }

  function runtimeHeaders() {
    const tokens = readRuntimeTokens();
    const headers = {
      accept: "*/*",
      "x-ig-app-id": tokens.appId || DEFAULT_IG_APP_ID,
      "x-requested-with": "XMLHttpRequest"
    };
    for (const [name, value] of capturedHeaders) if (value) headers[name] = value;
    if (tokens.csrfToken) headers["x-csrftoken"] = tokens.csrfToken;
    return headers;
  }

  function readRuntimeTokens() {
    const dtsgModule = readModule("DTSGInitialData");
    const lsdModule = readModule("LSD");
    const userModule = readModule("CurrentUserInitialData");
    const configModule = readModule("InstagramWebConfig") || readModule("PolarisConfig");
    return {
      fbDtsg: dtsgModule?.token || inputValue("fb_dtsg") || tokenFromScripts("DTSGInitialData"),
      lsd: lsdModule?.token || inputValue("lsd") || metaValue("lsd") || tokenFromScripts("LSD"),
      actorId: firstNumeric(
        userModule?.ACCOUNT_ID,
        userModule?.USER_ID,
        userModule?.IG_USER_ID,
        userModule?.NON_FACEBOOK_USER_ID,
        window._sharedData?.config?.viewer?.id,
        valueFromScripts("CurrentUserInitialData", ["ACCOUNT_ID", "USER_ID", "IG_USER_ID"])
      ),
      csrfToken: cookieValue("csrftoken") || capturedHeaders.get("x-csrftoken") || "",
      appId: firstNumeric(
        capturedHeaders.get("x-ig-app-id"),
        configModule?.appId,
        configModule?.APP_ID,
        DEFAULT_IG_APP_ID
      )
    };
  }

  function installNetworkObserver() {
    const originalFetch = window.fetch;
    window.fetch = function observedFetch(input, init) {
      try { observeFetchRequest(input, init); } catch {}
      return Reflect.apply(originalFetch, this, arguments);
    };

    const XHR = window.XMLHttpRequest;
    if (!XHR?.prototype) return;
    const originalOpen = XHR.prototype.open;
    const originalSend = XHR.prototype.send;
    const requestMeta = Symbol("iprcRequestMeta");

    XHR.prototype.open = function observedOpen(method, url) {
      this[requestMeta] = { method: String(method || "GET"), url: String(url || "") };
      return Reflect.apply(originalOpen, this, arguments);
    };
    XHR.prototype.send = function observedSend(body) {
      try { observeGraphql(this[requestMeta]?.url, body, null); } catch {}
      return Reflect.apply(originalSend, this, arguments);
    };
  }

  function observeFetchRequest(input, init) {
    const url = typeof input === "string" || input instanceof URL ? String(input) : String(input?.url || "");
    observeHeaders(init?.headers || input?.headers);
    if (init?.body !== undefined) {
      observeGraphql(url, init.body, init?.headers);
      return;
    }
    if (input && typeof input.clone === "function") {
      input.clone().text().then((body) => observeGraphql(url, body, input.headers)).catch(() => {});
    }
  }

  function observeGraphql(url, body, headers) {
    let parsedUrl;
    try { parsedUrl = new URL(String(url || ""), location.href); }
    catch { return; }
    if (parsedUrl.origin !== location.origin || !parsedUrl.pathname.includes("/api/graphql")) return;
    observeHeaders(headers);
    const params = bodyToParams(body);
    if (!params || !params.get("doc_id")) return;
    latestGraphqlParams = cloneParams(params);
    if (params.get("fb_api_req_friendly_name") === MUTATION_NAME) {
      mutationTemplate = cloneParams(params);
      mutationDocId = params.get("doc_id") || mutationDocId;
    }
  }

  function observeHeaders(headers) {
    if (!headers) return;
    const accept = (name, value) => {
      const normalized = String(name || "").toLowerCase();
      if (SAFE_HEADER_NAMES.has(normalized) && value) capturedHeaders.set(normalized, String(value));
    };
    try {
      if (typeof headers.forEach === "function") {
        headers.forEach((value, name) => accept(name, value));
      } else if (Array.isArray(headers)) {
        headers.forEach(([name, value]) => accept(name, value));
      } else {
        Object.entries(headers).forEach(([name, value]) => accept(name, value));
      }
    } catch {}
  }

  function bodyToParams(body) {
    if (body instanceof URLSearchParams) return cloneParams(body);
    if (typeof body === "string") {
      try { return new URLSearchParams(body); }
      catch { return null; }
    }
    return null;
  }

  function cloneParams(params) {
    return params ? new URLSearchParams(params.toString()) : new URLSearchParams();
  }

  function nextRequestCode(previous) {
    const parsed = parseInt(String(previous || ""), 36);
    if (Number.isFinite(parsed)) return (parsed + 1).toString(36);
    requestSequence += 1;
    return requestSequence.toString(36);
  }

  function readModule(name) {
    try { return typeof window.require === "function" ? window.require(name) : null; }
    catch { return null; }
  }

  function inputValue(name) {
    try { return document.querySelector('input[name="' + CSS.escape(name) + '"]')?.value || ""; }
    catch { return ""; }
  }

  function metaValue(name) {
    try { return document.querySelector('meta[name="' + CSS.escape(name) + '"]')?.content || ""; }
    catch { return ""; }
  }

  function tokenFromScripts(moduleName) {
    return valueFromScripts(moduleName, ["token"]);
  }

  function valueFromScripts(moduleName, keys) {
    for (const script of document.scripts || []) {
      const text = script.textContent || "";
      const moduleIndex = text.indexOf('"' + moduleName + '"');
      if (moduleIndex < 0) continue;
      const fragment = text.slice(moduleIndex, moduleIndex + 5000);
      for (const key of keys) {
        const match = fragment.match(new RegExp('"' + key + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"'));
        if (match) return decodeJsonString(match[1]);
      }
    }
    return "";
  }

  function decodeJsonString(value) {
    try { return JSON.parse('"' + value + '"'); }
    catch { return value; }
  }

  function cookieValue(name) {
    const prefix = encodeURIComponent(name) + "=";
    for (const part of String(document.cookie || "").split(";")) {
      const item = part.trim();
      if (item.startsWith(prefix)) return decodeURIComponent(item.slice(prefix.length));
    }
    return "";
  }

  function firstNumeric(...values) {
    return values.map((value) => normalizeId(value)).find(Boolean) || "";
  }

  function normalizeId(value) {
    const id = String(value ?? "").trim();
    return /^\d{3,30}$/.test(id) ? id : "";
  }

  function normalizeUsername(value) {
    const username = String(value ?? "").trim().replace(/^@+/, "").toLowerCase();
    return /^[a-z0-9._]{1,30}$/.test(username) ? username : "";
  }

  function makeJazoest(token) {
    return "2" + [...token].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  }

  function parseJsonPreservingIds(text) {
    if (!text) return null;
    try {
      const raw = String(text).replace(/^\s*for\s*\(\s*;;\s*\)\s*;\s*/, "");
      const protectedText = raw.replace(
        /("(?:id|pk|pk_id|user_id|target_user_id)"\s*:\s*)(\d{16,})(?=\s*[,}])/g,
        '$1"$2"'
      );
      return JSON.parse(protectedText);
    } catch {
      return null;
    }
  }

  async function safeResponseText(response) {
    try { return await response.text(); }
    catch { return ""; }
  }

  function postResult(requestId, result) {
    window.postMessage({
      source: "IPRC_PAGE_BRIDGE",
      type: "PROCESS_RESULT",
      requestId,
      status: String(result.status || "failed"),
      message: String(result.message || "").slice(0, 320),
      instagramUserId: normalizeId(result.instagramUserId),
      precheck: String(result.precheck || "unknown"),
      postcheck: String(result.postcheck || "unknown"),
      retryable: Boolean(result.retryable),
      reason: String(result.reason || "")
    }, location.origin);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();

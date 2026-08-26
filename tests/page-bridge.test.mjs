import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../page-bridge.js", import.meta.url), "utf8");
const listeners = new Map();
const posted = [];
const requests = [];
let requestBody = "";
let relationshipMode = "pending";

function jsonResponse(payload, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(payload)
  };
}

async function mockFetch(url, options = {}) {
  const target = String(url);
  requests.push({ url: target, options });

  if (target.includes("/api/v1/users/web_profile_info/")) {
    return jsonResponse({
      data: {
        user: {
          id: "987654321",
          username: "example_user"
        }
      }
    });
  }

  if (target.includes("/api/v1/friendships/show/987654321/")) {
    return jsonResponse(relationshipMode === "accepted"
      ? { following: true, outgoing_request: false, followed_by: true }
      : { following: false, outgoing_request: true, followed_by: false });
  }

  if (target === "/api/graphql") {
    requestBody = options.body;
    return jsonResponse({
      data: {
        xdt_destroy_friendship: {
          username: "example_user",
          id: "987654321",
          friendship_status: {
            following: false,
            outgoing_request: false,
            followed_by: false,
            is_bestie: false
          }
        }
      }
    });
  }

  throw new Error("Unexpected URL: " + target);
}

const pageWindow = {
  fetch: mockFetch,
  addEventListener(type, listener) { listeners.set(type, listener); },
  postMessage(message) { posted.push(message); },
  require(name) {
    if (name === "DTSGInitialData") return { token: "RUNTIME_DTSG_TOKEN" };
    if (name === "LSD") return { token: "RUNTIME_LSD_TOKEN" };
    if (name === "CurrentUserInitialData") return { ACCOUNT_ID: "111222333" };
    return null;
  }
};
pageWindow.window = pageWindow;

const context = vm.createContext({
  window: pageWindow,
  document: {
    cookie: "csrftoken=RUNTIME_CSRF_TOKEN",
    querySelector: () => null,
    scripts: []
  },
  CSS: { escape: (value) => value },
  location: {
    href: "https://www.instagram.com/",
    origin: "https://www.instagram.com",
    pathname: "/"
  },
  URL,
  URLSearchParams,
  JSON,
  Reflect,
  Symbol,
  setTimeout,
  clearTimeout,
  encodeURIComponent,
  decodeURIComponent
});

vm.runInContext(source, context);
const listener = listeners.get("message");
assert.equal(typeof listener, "function");

await listener({
  source: pageWindow,
  data: {
    source: "IPRC_CONTENT",
    type: "PROCESS_USER",
    requestId: "request-1",
    username: "example_user",
    dryRun: false,
    strictVerify: false
  }
});

const params = new URLSearchParams(requestBody);
assert.equal(JSON.parse(params.get("variables")).target_user_id, "987654321");
assert.equal(params.get("fb_api_req_friendly_name"), "usePolarisUnfollowMutation");
assert.equal(params.get("fb_dtsg"), "RUNTIME_DTSG_TOKEN");
assert.equal(params.get("lsd"), "RUNTIME_LSD_TOKEN");
assert.equal(params.get("av"), "111222333");
assert.deepEqual(JSON.parse(JSON.stringify(posted.at(-1))), {
  source: "IPRC_PAGE_BRIDGE",
  type: "PROCESS_RESULT",
  requestId: "request-1",
  status: "success",
  message: "İstek doğrudan iptal edildi; mutation yanıtı doğrulandı.",
  instagramUserId: "987654321",
  precheck: "pending",
  postcheck: "clear",
  retryable: false,
  reason: ""
});

const mutationCount = requests.filter((request) => request.url === "/api/graphql").length;
relationshipMode = "accepted";
await listener({
  source: pageWindow,
  data: {
    source: "IPRC_CONTENT",
    type: "PROCESS_USER",
    requestId: "request-2",
    username: "example_user",
    dryRun: false,
    strictVerify: false
  }
});

assert.equal(posted.at(-1).status, "accepted");
assert.equal(requests.filter((request) => request.url === "/api/graphql").length, mutationCount);
assert.equal(JSON.stringify(posted).includes("RUNTIME_DTSG_TOKEN"), false);
assert.equal(JSON.stringify(posted).includes("RUNTIME_LSD_TOKEN"), false);
assert.equal(JSON.stringify(posted).includes("RUNTIME_CSRF_TOKEN"), false);

console.log("page bridge tests: ok");

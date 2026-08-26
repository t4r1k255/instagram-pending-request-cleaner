import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");
const storageData = {};
const runtimeListeners = [];
const tabs = new Map();
let nextTabId = 40;

const chrome = {
  runtime: {
    onMessage: { addListener(listener) { runtimeListeners.push(listener); } },
    sendMessage() { return Promise.resolve(); }
  },
  storage: {
    local: {
      async get(key) {
        if (typeof key === "string") return { [key]: storageData[key] };
        return { ...storageData };
      },
      async set(values) { Object.assign(storageData, values); },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete storageData[key];
      }
    }
  },
  tabs: {
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} },
    async create(options) {
      const tab = { id: ++nextTabId, url: options.url, active: options.active };
      tabs.set(tab.id, tab);
      return tab;
    },
    async get(tabId) {
      if (!tabs.has(tabId)) throw new Error("No tab");
      return tabs.get(tabId);
    },
    async sendMessage() { return { ok: true }; },
    async update(tabId, changes) {
      Object.assign(tabs.get(tabId), changes);
      return tabs.get(tabId);
    },
    async remove(tabId) { tabs.delete(tabId); }
  }
};

vm.runInContext(source, vm.createContext({
  chrome,
  console,
  Date,
  Math,
  Set,
  String,
  Number,
  Array,
  RegExp,
  Promise
}));

const listener = runtimeListeners[0];
assert.equal(typeof listener, "function");

function dispatch(message, sender = {}) {
  return new Promise((resolve) => {
    listener(message, sender, resolve);
  });
}

let response = await dispatch({
  type: "INIT_QUEUE",
  items: [{
    username: "EXAMPLE_USER",
    targetId: "900719925474099312"
  }],
  settings: {
    minDelay: 1.3,
    maxDelay: 2,
    batchSize: 0,
    maxRetries: 1,
    strictVerify: false,
    dryRun: false
  }
});
assert.equal(response.ok, true);
assert.equal(response.state.items[0].exportFbid, "900719925474099312");
assert.equal(response.state.items[0].instagramUserId, "");

response = await dispatch({ type: "START" });
assert.equal(response.ok, true);
assert.equal(response.state.status, "running");
const runnerTabId = response.state.runnerTabId;
assert.equal(typeof runnerTabId, "number");

response = await dispatch({ type: "NEXT_TASK" }, { tab: { id: runnerTabId } });
assert.deepEqual(JSON.parse(JSON.stringify(response.task)), {
  username: "example_user",
  dryRun: false,
  strictVerify: false
});

response = await dispatch({
  type: "RESULT",
  username: "example_user",
  status: "accepted",
  message: "İstek kabul edilmiş; dokunulmadı.",
  instagramUserId: "987654321",
  precheck: "accepted",
  postcheck: "unchanged",
  retryable: false,
  reason: ""
}, { tab: { id: runnerTabId } });

assert.equal(response.action, "COMPLETE");
assert.equal(response.state.items[0].status, "accepted");
assert.equal(response.state.items[0].instagramUserId, "987654321");
assert.equal(response.state.items[0].exportFbid, "900719925474099312");

response = await dispatch({ type: "RESET" });
assert.equal(response.ok, true);
assert.equal(storageData.requestCleanerStateV2, undefined);

console.log("background tests: ok");

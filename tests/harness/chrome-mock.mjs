/**
 * chrome.* API 模拟层。
 * 覆盖扩展实际用到的全部 API，并把调用记录进 log 供断言。
 */
export function makeChrome(opts = {}) {
  const store = Object.assign({}, opts.store || {});
  const tabs = opts.tabs || [{ id: 1, active: true, url: opts.activeUrl || "https://example.com/a" }];

  const log = {
    badgeText: [],
    badgeColor: [],
    title: [],
    openOptions: 0,
    runtimeSendMessage: [],
    tabsSendMessage: [],
    tabsQuery: 0
  };

  const listeners = {
    message: [],
    storageChanged: [],
    command: [],
    installed: [],
    startup: []
  };

  function pick(keys) {
    if (keys == null) return Object.assign({}, store);
    if (typeof keys === "string") return keys in store ? { [keys]: store[keys] } : {};
    if (Array.isArray(keys)) {
      const out = {};
      for (const k of keys) if (k in store) out[k] = store[k];
      return out;
    }
    if (typeof keys === "object") {
      const out = {};
      for (const k of Object.keys(keys)) out[k] = k in store ? store[k] : keys[k];
      return out;
    }
    return {};
  }

  const chrome = {
    __log: log,
    __store: store,
    __listeners: listeners,

    storage: {
      local: {
        async get(keys) {
          return pick(keys);
        },
        async set(obj) {
          const changes = {};
          for (const k of Object.keys(obj || {})) {
            changes[k] = { oldValue: store[k], newValue: obj[k] };
            store[k] = obj[k];
          }
          emit(listeners.storageChanged, changes, "local");
          return undefined;
        },
        async remove(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          const changes = {};
          for (const k of list) {
            changes[k] = { oldValue: store[k] };
            delete store[k];
          }
          emit(listeners.storageChanged, changes, "local");
          return undefined;
        },
        async clear() {
          for (const k of Object.keys(store)) delete store[k];
          return undefined;
        }
      },
      onChanged: {
        addListener: (fn) => listeners.storageChanged.push(fn),
        removeListener: (fn) => drop(listeners.storageChanged, fn)
      }
    },

    runtime: {
      onMessage: {
        addListener: (fn) => listeners.message.push(fn),
        removeListener: (fn) => drop(listeners.message, fn)
      },
      onInstalled: {
        addListener: (fn) => listeners.installed.push(fn)
      },
      onStartup: {
        addListener: (fn) => listeners.startup.push(fn)
      },
      async sendMessage(msg) {
        log.runtimeSendMessage.push(msg);
        if (typeof opts.onRuntimeSendMessage === "function") {
          return opts.onRuntimeSendMessage(msg);
        }
        const responder = opts.background;
        if (responder) return dispatch(responder.__listeners.message, msg, {});
        return undefined;
      },
      getURL: (p) => "chrome-extension://readorskip/" + String(p).replace(/^\/+/, ""),
      openOptionsPage() {
        log.openOptions++;
        return undefined;
      },
      lastError: undefined
    },

    action: {
      async setBadgeText(o) {
        log.badgeText.push(o);
      },
      async setBadgeBackgroundColor(o) {
        log.badgeColor.push(o);
      },
      async setTitle(o) {
        log.title.push(o);
      }
    },

    tabs: {
      async query() {
        log.tabsQuery++;
        return tabs;
      },
      async sendMessage(tabId, msg) {
        log.tabsSendMessage.push({ tabId, msg });
        if (typeof opts.onTabsSendMessage === "function") return opts.onTabsSendMessage(tabId, msg);
        const responder = opts.content;
        if (responder) return dispatch(responder.__listeners.message, msg, { tab: { id: tabId } });
        return undefined;
      }
    },

    commands: {
      onCommand: {
        addListener: (fn) => listeners.command.push(fn)
      }
    }
  };

  return chrome;
}

/** 按扩展约定投递一条 onMessage，返回 sendResponse 的值 */
export function dispatch(listenerList, msg, sender, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let done = false;
    let asyncWanted = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      if (asyncWanted) {
        reject(new Error("监听器声明了异步响应（return true），但 " + timeoutMs + "ms 内没有调用 sendResponse"));
      } else {
        resolve(undefined);
      }
    }, timeoutMs);

    const sendResponse = (v) => finish(v);
    try {
      for (const fn of listenerList) {
        const keep = fn(msg, sender, sendResponse);
        if (keep === true) asyncWanted = true;
      }
    } catch (e) {
      clearTimeout(timer);
      done = true;
      reject(e);
      return;
    }
  });
}

/** 向 storage 监听器广播一次变更（等价于别的上下文改了 storage） */
export function emit(list, ...args) {
  for (const fn of list.slice()) {
    try {
      fn(...args);
    } catch (e) {
      /* 监听器自身抛错不应影响调用方，交给测试断言 */
    }
  }
}

function drop(list, fn) {
  const i = list.indexOf(fn);
  if (i >= 0) list.splice(i, 1);
}

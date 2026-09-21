/**
 * 极简断言库（零依赖）。
 * 失败时抛 AssertionError，由 tests/run.mjs 捕获并计入失败。
 */
export class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssertionError";
  }
}

export function fail(msg) {
  throw new AssertionError(msg);
}

export function ok(value, msg) {
  if (!value) fail((msg || "期望为真") + " —— 实际拿到 " + show(value));
}

export function notOk(value, msg) {
  if (value) fail((msg || "期望为假") + " —— 实际拿到 " + show(value));
}

export function equal(actual, expected, msg) {
  if (actual !== expected) {
    fail((msg || "值不相等") + "\n      实际: " + show(actual) + "\n      期望: " + show(expected));
  }
}

export function notEqual(actual, unexpected, msg) {
  if (actual === unexpected) fail((msg || "值不应相等") + " —— 两者都是 " + show(actual));
}

export function near(actual, expected, tol, msg) {
  const t = tol == null ? 1e-6 : tol;
  if (typeof actual !== "number" || Math.abs(actual - expected) > t) {
    fail((msg || "数值不在容差内") + "\n      实际: " + show(actual) + "\n      期望: " + show(expected) + " ±" + t);
  }
}

export function deepEqual(actual, expected, msg) {
  const a = stable(actual);
  const b = stable(expected);
  if (a !== b) {
    fail((msg || "深度不相等") + "\n      实际: " + a + "\n      期望: " + b);
  }
}

export function includes(haystack, needle, msg) {
  const h = typeof haystack === "string" ? haystack : JSON.stringify(haystack);
  if (!String(h).includes(needle)) {
    fail((msg || "未包含子串") + "\n      内容: " + truncate(String(h)) + "\n      要找: " + show(needle));
  }
}

export function notIncludes(haystack, needle, msg) {
  const h = typeof haystack === "string" ? haystack : JSON.stringify(haystack);
  if (String(h).includes(needle)) {
    fail((msg || "不应包含子串") + "\n      内容: " + truncate(String(h)) + "\n      不该有: " + show(needle));
  }
}

export function match(str, re, msg) {
  if (!re.test(String(str))) {
    fail((msg || "未匹配正则") + "\n      内容: " + truncate(String(str)) + "\n      正则: " + re);
  }
}

export function gt(a, b, msg) {
  if (!(a > b)) fail((msg || "期望大于") + " —— " + show(a) + " 不大于 " + show(b));
}

export function gte(a, b, msg) {
  if (!(a >= b)) fail((msg || "期望大于等于") + " —— " + show(a) + " 小于 " + show(b));
}

export function lt(a, b, msg) {
  if (!(a < b)) fail((msg || "期望小于") + " —— " + show(a) + " 不小于 " + show(b));
}

export function lte(a, b, msg) {
  if (!(a <= b)) fail((msg || "期望小于等于") + " —— " + show(a) + " 大于 " + show(b));
}

export function between(v, lo, hi, msg) {
  if (!(v >= lo && v <= hi)) fail((msg || "超出区间") + " —— " + show(v) + " 不在 [" + lo + ", " + hi + "]");
}

export function isArray(v, msg) {
  if (!Array.isArray(v)) fail((msg || "期望是数组") + " —— 实际 " + show(v));
}

export function hasKey(obj, key, msg) {
  if (!obj || !(key in obj)) fail((msg || "缺少字段") + " —— " + show(key) + "，实际字段 " + show(Object.keys(obj || {})));
}

export function isFunction(v, msg) {
  if (typeof v !== "function") fail((msg || "期望是函数") + " —— 实际 " + show(v));
}

export function isString(v, msg) {
  if (typeof v !== "string") fail((msg || "期望是字符串") + " —— 实际 " + show(v));
}

export function isNumber(v, msg) {
  if (typeof v !== "number" || Number.isNaN(v)) fail((msg || "期望是数字") + " —— 实际 " + show(v));
}

/** 断言 fn 抛错，返回错误对象；可校验 code / message 片段 */
export function throws(fn, expect, msg) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  if (!err) fail(msg || "期望抛错，但没有");
  if (expect && typeof expect === "string" && !String(err.message).includes(expect)) {
    fail((msg || "错误信息不符") + "\n      实际信息: " + err.message + "\n      期望包含: " + expect);
  }
  if (expect && expect instanceof RegExp && !expect.test(String(err.message))) {
    fail((msg || "错误信息不匹配正则") + "\n      实际信息: " + err.message);
  }
  if (expect && typeof expect === "object" && expect.code) {
    equal(err.code, expect.code, msg || "错误码不符");
  }
  return err;
}

export async function rejects(promiseOrFn, expect, msg) {
  let err = null;
  try {
    await (typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn);
  } catch (e) {
    err = e;
  }
  if (!err) fail(msg || "期望被拒绝，但没有");
  if (expect && typeof expect === "object" && expect.code) {
    equal(err.code, expect.code, msg || "错误码不符");
  }
  if (expect && typeof expect === "string" && !String(err.message).includes(expect)) {
    fail((msg || "错误信息不符") + "\n      实际信息: " + err.message + "\n      期望包含: " + expect);
  }
  return err;
}

/* ---------- 内部工具 ---------- */

function show(v) {
  if (typeof v === "string") return JSON.stringify(truncate(v));
  if (typeof v === "function") return "[function " + (v.name || "anonymous") + "]";
  if (v === undefined) return "undefined";
  if (v && typeof v === "object") {
    try {
      return truncate(JSON.stringify(v));
    } catch (e) {
      return "[object]";
    }
  }
  return String(v);
}

function truncate(s, n) {
  const max = n || 220;
  const str = String(s);
  return str.length > max ? str.slice(0, max) + " …(共 " + str.length + " 字符)" : str;
}

function stable(v) {
  return JSON.stringify(sortDeep(v));
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

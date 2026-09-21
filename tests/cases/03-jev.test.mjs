/**
 * Jev 客户端（jev.js）。
 * 这层是唯一和外部服务说话的地方，错误分类错了上层就没法给出正确的用户提示。
 */
import { describe, it } from "../harness/registry.mjs";
import * as a from "../harness/assert.mjs";
import { createEnv, loadLibs, jsonResponse } from "../harness/env.mjs";

function boot(fetchImpl) {
  const env = createEnv({ fetch: fetchImpl });
  loadLibs(env, ["jev.js"]);
  return env;
}

const ANSWER = {
  model: "jev-1.13.0",
  answers: { is_urgent: { type: "noul", noul: 0.98 } },
  usage: { input_tokens: 302, output_tokens: 23 }
};

describe("jev / 答案解析", () => {
  it("scoreToPct 按档位换算并夹紧到 0~100", () => {
    const env = boot();
    const { scoreToPct, scoreToRatio } = env.win.RS.jev;
    a.equal(scoreToPct({ score: 4 }, 5), 100);
    a.equal(scoreToPct({ score: 2 }, 5), 50);
    a.equal(scoreToPct({ score: 0 }, 5), 0);
    a.equal(scoreToPct({ score: 3.87 }, 5), 97, "四舍五入");
    a.equal(scoreToPct({ score: 9 }, 5), 100, "超过上限要夹紧");
    a.equal(scoreToPct({ score: -3 }, 5), 0, "负数要夹紧");
    a.equal(scoreToPct({ score: 2 }, 3), 100, "3 档时满分是 2");
    a.equal(scoreToPct({}, 5), null, "缺 score 返回 null");
    a.equal(scoreToPct(null, 5), null);
    a.equal(scoreToRatio({ score: 2 }, 5), 0.5);
    a.equal(scoreToRatio({ score: "3" }, 5), null, "字符串不算数字");
  });

  it("noulValue 支持数值与布尔两种返回", () => {
    const env = boot();
    const n = env.win.RS.jev.noulValue;
    a.equal(n({ noul: 0.98 }), 0.98);
    a.equal(n({ noul: true }), 1);
    a.equal(n({ noul: false }), 0);
    a.equal(n({ noul: 0 }), 0);
    a.equal(n({}), null);
    a.equal(n(null), null);
  });

  it("choiceValue 优先用 choice 字段，缺失时回落到概率最大项", () => {
    const env = boot();
    const c = env.win.RS.jev.choiceValue;
    a.equal(c({ choice: "billing", probabilities: { billing: 0.84, technical: 0.16 } }), "billing");
    a.equal(c({ probabilities: { billing: 0.2, technical: 0.7, sales: 0.1 } }), "technical", "没有 choice 时取概率最大");
    a.equal(c({ probabilities: {} }), null);
    a.equal(c({}), null);
    a.equal(c(null), null);
  });
});

describe("jev / 请求构造", () => {
  it("没有 API Key 时不发请求，抛出 NO_KEY", async () => {
    let called = 0;
    const env = boot(() => {
      called++;
      return Promise.resolve(jsonResponse(ANSWER));
    });
    const err = await a.rejects(
      env.win.RS.jev.systemOne({ state: "x", questions: {}, apiKey: "" }),
      { code: "NO_KEY" }
    );
    a.includes(err.message, "API Key");
    a.equal(called, 0, "没 Key 就一个请求都不该发");
  });

  it("请求打到正确端点，带 Bearer 头与 model 字段", async () => {
    const env = boot(() => Promise.resolve(jsonResponse(ANSWER)));
    const resp = await env.win.RS.jev.systemOne({
      state: { a: 1 },
      questions: { q: { type: "noul", instructions: "?" } },
      apiKey: "apikey_test",
      model: "jev-1.13.0"
    });
    a.equal(resp.model, "jev-1.13.0");
    a.equal(resp.answers.is_urgent.noul, 0.98);
    a.equal(env.fetchCalls.length, 1);

    const [url, init] = env.fetchCalls[0];
    a.equal(url, env.win.RS.API_URL);
    a.equal(init.method, "POST");
    a.equal(init.headers.Authorization, "Bearer apikey_test");
    a.equal(init.headers["Content-Type"], "application/json");
    const body = JSON.parse(init.body);
    a.equal(body.model, "jev-1.13.0");
    a.deepEqual(body.state, { a: 1 });
    a.equal(body.questions.q.type, "noul");
  });

  it("不传 model 时用默认模型 jev-latest", async () => {
    const env = boot(() => Promise.resolve(jsonResponse(ANSWER)));
    await env.win.RS.jev.systemOne({ state: "x", questions: {}, apiKey: "k" });
    const body = JSON.parse(env.fetchCalls[0][1].body);
    a.equal(body.model, "jev-latest");
    a.equal(body.model, env.win.RS.DEFAULT_MODEL);
  });
});

describe("jev / 错误分类与重试", () => {
  it("401 不重试，提示去设置更新 Key", async () => {
    let calls = 0;
    const env = boot(() => {
      calls++;
      return Promise.resolve(jsonResponse({ error: "unauthorized" }, 401));
    });
    const err = await a.rejects(
      env.win.RS.jev.systemOne({ state: "x", questions: {}, apiKey: "bad", maxRetries: 2 }),
      { code: "HTTP_401" }
    );
    a.includes(err.message, "API Key");
    a.equal(calls, 1, "401 属于不可重试错误");
    a.equal(err.retryable, false);
  });

  it("422 不重试，错误里带上服务端返回的片段", async () => {
    const env = boot(() => Promise.resolve(jsonResponse({ detail: "field state is required" }, 422)));
    const err = await a.rejects(
      env.win.RS.jev.systemOne({ state: null, questions: {}, apiKey: "k", maxRetries: 2 }),
      { code: "HTTP_422" }
    );
    a.includes(err.message, "参数校验");
    a.includes(err.message, "field state is required");
  });

  it("429 属于可重试：第一次 429、第二次成功", async () => {
    let calls = 0;
    const env = boot(() => {
      calls++;
      return Promise.resolve(calls === 1 ? jsonResponse({}, 429) : jsonResponse(ANSWER));
    });
    const resp = await env.win.RS.jev.systemOne({
      state: "x",
      questions: {},
      apiKey: "k",
      maxRetries: 1
    });
    a.equal(calls, 2, "应该重试一次");
    a.equal(resp.model, "jev-1.13.0");
  });

  it("持续 429 → 重试耗尽后抛出，提示限流", async () => {
    let calls = 0;
    const env = boot(() => {
      calls++;
      return Promise.resolve(jsonResponse({}, 429));
    });
    const err = await a.rejects(
      env.win.RS.jev.systemOne({ state: "x", questions: {}, apiKey: "k", maxRetries: 1 }),
      { code: "HTTP_429" }
    );
    a.includes(err.message, "限流");
    a.equal(calls, 2, "maxRetries 1 → 共 2 次请求");
  });

  it("529 服务过载也走重试", async () => {
    let calls = 0;
    const env = boot(() => {
      calls++;
      return Promise.resolve(calls < 2 ? jsonResponse({}, 529) : jsonResponse(ANSWER));
    });
    const resp = await env.win.RS.jev.systemOne({ state: "x", questions: {}, apiKey: "k", maxRetries: 2 });
    a.ok(resp.answers);
    a.equal(calls, 2);
  });

  it("超时会被 AbortController 打断并标成 TIMEOUT", async () => {
    const env = boot(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        })
    );
    const err = await a.rejects(
      env.win.RS.jev.systemOne({ state: "x", questions: {}, apiKey: "k", timeoutMs: 40, maxRetries: 0 }),
      { code: "TIMEOUT" }
    );
    a.includes(err.message, "超时");
  });

  it("网络错误重试一次后仍失败 → NETWORK", async () => {
    let calls = 0;
    const env = boot(() => {
      calls++;
      return Promise.reject(new TypeError("Failed to fetch"));
    });
    await a.rejects(
      env.win.RS.jev.systemOne({ state: "x", questions: {}, apiKey: "k", maxRetries: 1 }),
      { code: "NETWORK" }
    );
    a.equal(calls, 2);
  });

  it("200 但响应体缺 answers → BAD_SHAPE，不重试", async () => {
    let calls = 0;
    const env = boot(() => {
      calls++;
      return Promise.resolve(jsonResponse({ model: "jev-1.13.0" }));
    });
    await a.rejects(
      env.win.RS.jev.systemOne({ state: "x", questions: {}, apiKey: "k", maxRetries: 2 }),
      { code: "BAD_SHAPE" }
    );
    a.equal(calls, 1, "结构错误重试也没用");
  });

  it("错误对象带上 status，方便上层判断", async () => {
    const env = boot(() => Promise.resolve(jsonResponse({}, 403)));
    const err = await a.rejects(
      env.win.RS.jev.systemOne({ state: "x", questions: {}, apiKey: "k", maxRetries: 0 }),
      { code: "HTTP_403" }
    );
    a.equal(err.status, 403);
    a.equal(err.name, "JevError");
  });
});

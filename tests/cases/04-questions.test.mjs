/**
 * 问题定义与结果归一化（questions.js）。
 * 归一化层是把"模型的结构化答案"翻译成"界面能吃的对象"的唯一关口，
 * 任何一项映射错了，用户看到的百分比就是假的。
 */
import { describe, it } from "../harness/registry.mjs";
import * as a from "../harness/assert.mjs";
import { createEnv, loadLibs } from "../harness/env.mjs";

function boot() {
  const env = createEnv();
  loadLibs(env, ["jev.js", "questions.js"]);
  return env;
}

const SETTINGS = { topics: ["浏览器扩展开发", "AI Agent 编排"] };

function answers(over = {}) {
  return Object.assign(
    {
      verdict: { type: "choice", choice: "read", confidence: 0.82, probabilities: { read: 0.88, skim: 0.11, skip: 0.01 } },
      relevance: { type: "score", score: 4 },
      novelty: { type: "score", score: 4 },
      credibility: { type: "score", score: 4 },
      redundancy: { type: "noul", noul: 0.1 },
      value: { type: "choice", choice: "high", probabilities: { high: 0.9, medium: 0.08, low: 0.02 } },
      contentType: { type: "choice", choice: "tutorial", probabilities: { tutorial: 0.9 } },
      timelessness: { type: "score", score: 3 }
    },
    over
  );
}

describe("questions / 网页问题定义", () => {
  it("覆盖 8 个维度，类型正确", () => {
    const env = boot();
    const q = env.win.RS.questions.pageQuestions(SETTINGS);
    a.deepEqual(Object.keys(q).sort(), [
      "contentType",
      "credibility",
      "novelty",
      "redundancy",
      "relevance",
      "timelessness",
      "value",
      "verdict"
    ]);
    a.equal(q.verdict.type, "choice");
    a.equal(q.value.type, "choice");
    a.equal(q.contentType.type, "choice");
    a.equal(q.relevance.type, "score");
    a.equal(q.novelty.type, "score");
    a.equal(q.credibility.type, "score");
    a.equal(q.timelessness.type, "score");
    a.equal(q.redundancy.type, "noul");
  });

  it("每个问题都有非空 instructions", () => {
    const env = boot();
    const q = env.win.RS.questions.pageQuestions(SETTINGS);
    for (const [name, def] of Object.entries(q)) {
      a.isString(def.instructions, name + " 缺 instructions");
      a.gt(def.instructions.trim().length, 10, name + " 的 instructions 太短");
    }
  });

  it("score 档位是有序数组且长度一致（Jev 要求 2~10 档）", () => {
    const env = boot();
    const q = env.win.RS.questions.pageQuestions(SETTINGS);
    for (const name of ["relevance", "novelty", "credibility", "timelessness"]) {
      a.isArray(q[name].criteria, name + " 的 criteria 应是数组");
      a.between(q[name].criteria.length, 2, 10, name + " 档位数应在 2~10");
      for (const level of q[name].criteria) a.gt(String(level).trim().length, 2);
    }
  });

  it("choice 选项是对象，且不超过 Jev 的 255 上限", () => {
    const env = boot();
    const q = env.win.RS.questions.pageQuestions(SETTINGS);
    for (const name of ["verdict", "value", "contentType"]) {
      const c = q[name].criteria;
      a.ok(c && typeof c === "object" && !Array.isArray(c), name + " 的 criteria 应是对象");
      const keys = Object.keys(c);
      a.between(keys.length, 2, 255, name + " 选项数不合法");
      for (const k of keys) a.gte(String(c[k]).trim().length, 2, name + "." + k + " 描述太短");
    }
    a.deepEqual(Object.keys(q.verdict.criteria), ["read", "skim", "skip"]);
    a.deepEqual(Object.keys(q.value.criteria), ["high", "medium", "low"]);
  });

  it("noul 问题不带 criteria", () => {
    const env = boot();
    const q = env.win.RS.questions.pageQuestions(SETTINGS);
    a.equal(q.redundancy.criteria, undefined);
  });

  it("把关注主题写进 instructions，让模型知道跟什么比", () => {
    const env = boot();
    const q = env.win.RS.questions.pageQuestions(SETTINGS);
    for (const name of ["verdict", "relevance", "novelty", "redundancy"]) {
      for (const topic of SETTINGS.topics) {
        a.includes(q[name].instructions, topic, name + " 的 instructions 没带上主题 " + topic);
      }
    }
  });

  it("没有设置主题时给出明确的兜底说明，而不是空字符串", () => {
    const env = boot();
    const q = env.win.RS.questions.pageQuestions({ topics: [] });
    a.includes(q.verdict.instructions, "未设置");
    a.notIncludes(q.verdict.instructions, "undefined");
  });

  it("问题定义里不该出现 undefined / NaN 这类脏值", () => {
    const env = boot();
    const text = JSON.stringify(env.win.RS.questions.pageQuestions(SETTINGS));
    a.notIncludes(text, "undefined");
    a.notIncludes(text, "NaN");
    a.notIncludes(text, "null");
  });
});

describe("questions / 搜索结果问题定义", () => {
  it("只问 4 个维度，够用又不浪费 token", () => {
    const env = boot();
    const q = env.win.RS.questions.serpQuestions(SETTINGS);
    a.deepEqual(Object.keys(q).sort(), ["credibility", "intentMatch", "relevance", "verdict"]);
    a.equal(q.verdict.type, "choice");
    a.equal(q.intentMatch.type, "noul");
    a.deepEqual(Object.keys(q.verdict.criteria), ["read", "skim", "skip"]);
  });

  it("明确告诉模型只看标题 / URL / 摘要", () => {
    const env = boot();
    const q = env.win.RS.questions.serpQuestions(SETTINGS);
    a.includes(q.verdict.instructions, "snippet");
    a.includes(q.credibility.instructions, "domain");
  });
});

describe("questions / normalizePage 映射", () => {
  it("完整答案映射成界面对象", () => {
    const env = boot();
    const r = env.win.RS.questions.normalizePage(answers(), { model: "jev-1.13.0", usage: { input_tokens: 10 } });
    a.equal(r.kind, "page");
    a.equal(r.source, "jev");
    a.equal(r.verdict, "read");
    a.equal(r.relevance, 100);
    a.equal(r.novelty, 100);
    a.equal(r.credibility, 100);
    a.equal(r.timelessness, 75, "score 3 / 4 档 = 75%");
    a.equal(r.value, "high");
    a.equal(r.valueKey, "high");
    a.equal(r.contentType, "tutorial");
    a.equal(r.redundancy, 0.1);
    a.equal(r.confidence, 0.82);
    a.equal(r.warning, null);
    a.equal(r.lowConfidence, false);
    a.equal(r.model, "jev-1.13.0");
    a.equal(r.usage.input_tokens, 10);
    a.isNumber(r.at);
  });

  it("缺字段 / 空对象都不抛错，给出保守兜底", () => {
    const env = boot();
    const r = env.win.RS.questions.normalizePage({}, {});
    a.equal(r.verdict, "skim", "没有判定时保守给快速扫，不给跳过");
    a.equal(r.relevance, null);
    a.equal(r.novelty, null);
    a.equal(r.value, null);
    a.equal(r.contentType, "other");
    a.equal(r.redundancy, null);
    a.equal(r.confidence, null);
    a.equal(r.warning, null);
    a.equal(r.lowConfidence, false, "没有置信度时不该报低置信");
    a.isString(r.reason);
  });

  it("完全不传 answers 也不抛错", () => {
    const env = boot();
    const r = env.win.RS.questions.normalizePage(undefined, undefined);
    a.equal(r.kind, "page");
    a.equal(r.verdict, "skim");
  });

  it("模型返回未知枚举值时不污染界面", () => {
    const env = boot();
    const r = env.win.RS.questions.normalizePage(
      answers({
        verdict: { type: "choice", choice: "definitely_read_this" },
        value: { type: "choice", choice: "very_high" },
        contentType: { type: "choice", choice: "podcast" }
      }),
      {}
    );
    a.equal(r.verdict, "skim", "非法判定回落");
    a.equal(r.value, null, "非法价值回落为 null");
    a.equal(r.contentType, "other", "非法类型回落为 other");
  });

  it("高重复度 → 触发 redundant 警告，理由是醒目提示", () => {
    const env = boot();
    const r = env.win.RS.questions.normalizePage(answers({ redundancy: { type: "noul", noul: 0.78 } }), {});
    a.equal(r.warning, "redundant");
    a.includes(r.reason, "⚠️");
    a.includes(r.reason, "可能没有太多新信息");
  });

  it("重复度刚好在阈值下方不报警", () => {
    const env = boot();
    const r = env.win.RS.questions.normalizePage(answers({ redundancy: { type: "noul", noul: 0.59 } }), {});
    a.equal(r.warning, null);
  });

  it("置信度偏低时单独标记，供界面加提示", () => {
    const env = boot();
    const r = env.win.RS.questions.normalizePage(
      answers({ verdict: { type: "choice", choice: "read", confidence: 0.31 } }),
      {}
    );
    a.equal(r.lowConfidence, true);
    a.equal(r.confidence, 0.31);
  });

  it("置信度四舍五入到两位小数", () => {
    const env = boot();
    const r = env.win.RS.questions.normalizePage(
      answers({ verdict: { type: "choice", choice: "read", confidence: 0.8237 } }),
      {}
    );
    a.equal(r.confidence, 0.82);
  });
});

describe("questions / 理由文案分支", () => {
  const cases = [
    ["read + 新且可信", { verdict: "read", novelty: 4, credibility: 4 }, "内容新且来源可信"],
    ["read + 主题重合", { verdict: "read", novelty: 1, credibility: 4 }, "与你的关注点高度重合"],
    ["read + 只新不信", { verdict: "read", novelty: 4, credibility: 1 }, "含较多新信息"],
    ["skim + 相关但一般", { verdict: "skim", relevance: 3, credibility: 4 }, "主题相关，但信息密度中等"],
    ["skim + 可信度低", { verdict: "skim", relevance: 3, credibility: 0.4 }, "来源可信度偏低"],
    ["skim + 相关性一般", { verdict: "skim", relevance: 1.5, credibility: 4 }, "有一定信息量"],
    ["skip + 不相关", { verdict: "skip", relevance: 0.8, novelty: 4, credibility: 4 }, "与当前关注方向关系不大"],
    ["skip + 全是老信息", { verdict: "skip", relevance: 4, novelty: 0.4, credibility: 4 }, "几乎没有新信息"],
    ["skip + 来源差", { verdict: "skip", relevance: 4, novelty: 4, credibility: 0.4 }, "来源可信度低"],
    ["skip + 全项还行", { verdict: "skip", relevance: 4, novelty: 4, credibility: 4 }, "综合判断收益不足"]
  ];

  for (const [label, over, expect] of cases) {
    it(label + " → 理由包含「" + expect + "」", () => {
      const env = boot();
      const r = env.win.RS.questions.normalizePage(
        answers({
          verdict: { type: "choice", choice: over.verdict, confidence: 0.8 },
          relevance: { type: "score", score: over.relevance != null ? over.relevance : 4 },
          novelty: { type: "score", score: over.novelty != null ? over.novelty : 4 },
          credibility: { type: "score", score: over.credibility != null ? over.credibility : 4 },
          redundancy: { type: "noul", noul: 0.1 }
        }),
        {}
      );
      a.includes(r.reason, expect);
      a.equal(r.verdict, over.verdict);
      a.match(r.reason, /。$/, "理由应以句号收尾");
    });
  }

  it("理由永远不为空", () => {
    const env = boot();
    for (const v of ["read", "skim", "skip"]) {
      const r = env.win.RS.questions.normalizePage(answers({ verdict: { type: "choice", choice: v } }), {});
      a.isString(r.reason);
      a.gt(r.reason.length, 3, v + " 的理由太短");
    }
  });
});

describe("questions / normalizeSerp 映射", () => {
  const serp = {
    verdict: { type: "choice", choice: "read", confidence: 0.88, probabilities: { read: 0.92 } },
    relevance: { type: "score", score: 3.91 },
    credibility: { type: "score", score: 2.1 },
    intentMatch: { type: "noul", noul: 0.91 }
  };

  it("标记为 partial，且不需要新信息维度", () => {
    const env = boot();
    const r = env.win.RS.questions.normalizeSerp(serp, { model: "jev-1.13.0" });
    a.equal(r.kind, "serp");
    a.equal(r.partial, true, "搜索结果预判必须标 partial，否则会挡住完整评估写缓存");
    a.equal(r.novelty, null, "只有标题和摘要，判断不了新信息量");
    a.equal(r.relevance, 98);
    a.equal(r.credibility, 53);
    a.equal(r.intentMatch, 0.91);
    a.equal(r.confidence, 0.88);
    a.equal(r.warning, null);
  });

  it("名不副实 / 商业页 → intent 警告", () => {
    const env = boot();
    const r = env.win.RS.questions.normalizeSerp(Object.assign({}, serp, { intentMatch: { type: "noul", noul: 0.12 } }), {});
    a.equal(r.warning, "intent");
  });

  it("阈值边界：0.35 不报，0.34 报", () => {
    const env = boot();
    a.equal(env.win.RS.questions.normalizeSerp(Object.assign({}, serp, { intentMatch: { type: "noul", noul: 0.35 } }), {}).warning, null);
    a.equal(env.win.RS.questions.normalizeSerp(Object.assign({}, serp, { intentMatch: { type: "noul", noul: 0.34 } }), {}).warning, "intent");
  });

  it("空答案不抛错", () => {
    const env = boot();
    const r = env.win.RS.questions.normalizeSerp({}, {});
    a.equal(r.verdict, "skim");
    a.equal(r.relevance, null);
    a.equal(r.warning, null);
  });
});

describe("questions / 与启发式结果同构", () => {
  it("两种来源的字段集合一致，界面用同一套渲染代码", () => {
    const env = createEnv();
    loadLibs(env, ["jev.js", "questions.js", "heuristics.js"]);
    const fromModel = env.win.RS.questions.normalizePage({}, {});
    const fromLocal = env.win.RS.heuristics.scorePage(
      { url: "https://example.com/p/1", title: "标题", text: "内容".repeat(600) },
      { topics: ["测试"], minTextLength: 400 }
    );
    const modelKeys = Object.keys(fromModel).sort();
    const localKeys = Object.keys(fromLocal).sort();
    const missingInLocal = modelKeys.filter((k) => !localKeys.includes(k));
    const missingInModel = localKeys.filter((k) => !modelKeys.includes(k));
    // 启发式可以多带 approximate / readingMinutes 这类辅助字段，但不能少
    a.deepEqual(missingInLocal, [], "启发式结果缺少模型结果的字段：" + missingInLocal.join(", "));
    for (const extra of missingInModel) {
      a.ok(
        ["approximate", "readingMinutes", "localOnly"].includes(extra),
        "启发式引入了未约定字段：" + extra
      );
    }
  });
});

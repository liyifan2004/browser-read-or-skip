/**
 * Read or Skip —— Jev (TypeSafe System One) 客户端。
 *
 * 端点：POST https://api.typesafe.ai/v1/systemone
 * 鉴权：Authorization: Bearer <TYPESAFE_API_KEY>
 * 请求：{ model, state, questions }
 * 响应：{ model, answers: { <key>: { type, noul|choice|score, probabilities?, legend?, confidence? } }, usage: { input_tokens, output_tokens } }
 *
 * 三种问题原语（TypeSafe 官方定义）：
 *   noul   —— 是 / 否，返回 0~1 的概率
 *   choice —— 从 criteria 里选一个，返回 choice + probabilities + confidence
 *   score  —— 按 criteria 有序等级打分，返回连续 score + legend
 *
 * 该模型"不生成文字"，只返回可被代码直接分支的结构化答案。这正是本扩展快的原因。
 */
(function (RS) {
  class JevError extends Error {
    constructor(code, message, status, retryable) {
      super(message);
      this.name = "JevError";
      this.code = code;
      this.status = status || 0;
      this.retryable = !!retryable;
    }
  }

  const RETRY_STATUS = [429, 500, 502, 503, 504, 529];

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function friendly(status, bodyText) {
    switch (status) {
      case 401:
        return "API Key 无效或已过期，请在设置中更新。";
      case 403:
        return "没有访问该模型的权限。";
      case 422:
        return "请求参数校验失败（" + String(bodyText || "").slice(0, 160) + "）";
      case 429:
        return "触发限流，请稍后重试。";
      case 529:
        return "服务过载，请稍后重试。";
      default:
        return "请求失败（HTTP " + status + "）";
    }
  }

  /**
   * 单次裸调用。
   * @param {{state:any, questions:Object, apiKey:string, model?:string, timeoutMs?:number, maxRetries?:number}} opts
   * @returns {Promise<{model:string, answers:Object, usage:Object}>}
   */
  async function systemOne(opts) {
    const {
      state,
      questions,
      apiKey,
      model = RS.DEFAULT_MODEL,
      timeoutMs = RS.DEFAULT_SETTINGS.timeoutMs,
      maxRetries = 2
    } = opts;

    if (!apiKey) throw new JevError("NO_KEY", "尚未配置 TypeSafe API Key。", 0, false);

    const body = JSON.stringify({ model, state, questions });
    let lastErr = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(RS.API_URL, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + apiKey,
            "Content-Type": "application/json"
          },
          body,
          signal: ctrl.signal
        });

        if (res.ok) {
          const json = await res.json();
          if (!json || typeof json !== "object" || !json.answers) {
            throw new JevError("BAD_SHAPE", "响应缺少 answers 字段。", res.status, false);
          }
          return json;
        }

        const text = await res.text().catch(() => "");
        const err = new JevError(
          "HTTP_" + res.status,
          friendly(res.status, text),
          res.status,
          RETRY_STATUS.indexOf(res.status) >= 0
        );
        if (!err.retryable || attempt === maxRetries) throw err;
        lastErr = err;
      } catch (e) {
        if (e instanceof JevError) {
          if (!e.retryable || attempt === maxRetries) throw e;
          lastErr = e;
        } else if (e && e.name === "AbortError") {
          throw new JevError("TIMEOUT", "请求超时（" + timeoutMs + "ms）。", 0, false);
        } else {
          const err = new JevError("NETWORK", "网络错误：" + (e && e.message ? e.message : e), 0, true);
          if (attempt === maxRetries) throw err;
          lastErr = err;
        }
      } finally {
        clearTimeout(timer);
      }
      // 指数退避：400ms, 1200ms
      await sleep(400 * Math.pow(3, attempt));
    }
    throw lastErr || new JevError("UNKNOWN", "未知错误", 0, false);
  }

  /* ---------- 答案解析辅助 ---------- */

  /** score 原语 → 0~1 百分比。criteria 层级数由 levelCount 决定。 */
  function scoreToRatio(answer, levelCount) {
    if (!answer || typeof answer.score !== "number") return null;
    const max = Math.max(1, (levelCount || 5) - 1);
    return Math.max(0, Math.min(1, answer.score / max));
  }

  function scoreToPct(answer, levelCount) {
    const r = scoreToRatio(answer, levelCount);
    return r === null ? null : Math.round(r * 100);
  }

  /** noul 原语 → 0~1 */
  function noulValue(answer) {
    if (!answer) return null;
    if (typeof answer.noul === "number") return answer.noul;
    if (typeof answer.noul === "boolean") return answer.noul ? 1 : 0;
    return null;
  }

  /** choice 原语 → 选中的键 */
  function choiceValue(answer) {
    if (!answer) return null;
    if (typeof answer.choice === "string") return answer.choice;
    if (answer.probabilities) {
      let best = null;
      let bestP = -1;
      for (const k of Object.keys(answer.probabilities)) {
        if (answer.probabilities[k] > bestP) {
          bestP = answer.probabilities[k];
          best = k;
        }
      }
      return best;
    }
    return null;
  }

  RS.JevError = JevError;
  RS.jev = { systemOne, scoreToRatio, scoreToPct, noulValue, choiceValue };
})(globalThis.RS);

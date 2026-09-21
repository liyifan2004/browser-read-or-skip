/**
 * 测试框架的注册表（零依赖）。
 * 测试文件 import 这里的 describe / it，run.mjs 负责执行。
 */
export const suites = [];

let current = null;

export function describe(name, fn) {
  const suite = { name, tests: [] };
  suites.push(suite);
  const prev = current;
  current = suite;
  try {
    fn();
  } finally {
    current = prev;
  }
}

export function it(name, fn) {
  if (!current) {
    describe("(未分组)", () => it(name, fn));
    return;
  }
  current.tests.push({ name, fn });
}

export const test = it;

export function reset() {
  suites.length = 0;
  current = null;
}

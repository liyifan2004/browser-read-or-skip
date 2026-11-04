/**
 * Version-sync decision logic (suite 14).
 *
 * 版本号决策是发版链路上最容易出错、代价最高的一环：版本号一旦错配，
 * 用户以后就再也收不到真正的修复版本（版本号已被占用）。这段逻辑曾经
 * 内联在脚本里，既没法单独测，出错时也是直接写坏文件 —— 现在抽到
 * tools/version-sync.mjs，这里把它的行为钉住。
 */
import { it } from '../harness/registry.mjs';
import * as assert from '../harness/assert.mjs';
import { readFile } from '../harness/env.mjs';
import {
  compareSemver,
  computeVersionSync,
  parseSemver,
  pickVersion,
  replaceVersionInJsonText,
} from '../../tools/version-sync.mjs';

it('parseSemver accepts only a bare three-part version', () => {
  assert.deepEqual(parseSemver('1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseSemver('10.20.30'), [10, 20, 30]);
  assert.equal(parseSemver('1.2'), null);
  assert.equal(parseSemver('v1.2.3'), null);
  assert.equal(parseSemver('1.2.3-rc1'), null);
  assert.equal(parseSemver(''), null);
});

it('compareSemver orders by major, then minor, then patch', () => {
  assert.equal(compareSemver('1.0.0', '1.0.1'), -1);
  assert.equal(compareSemver('1.0.1', '1.0.0'), 1);
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('1.2.0', '1.10.0'), -1);
  assert.equal(compareSemver('1.2', '1.2.3'), null);
});

it('pickVersion prefers the newer npm version', () => {
  assert.equal(pickVersion({ manifestVersion: '1.2.0', npmVersion: '1.2.1' }), '1.2.1');
  assert.equal(pickVersion({ manifestVersion: '1.2.0', npmVersion: '1.2.0' }), '1.2.0');
});

it('pickVersion never downgrades a lagging package.json', () => {
  // 回归用例：npm run version（只同步、不升版）传进来的是 package.json 的
  // 旧值。若 package.json 漂移落后于 manifest，直接采用就会把正确的版本号
  // 降级 —— 那才是事故。
  assert.equal(pickVersion({ manifestVersion: '1.2.0', npmVersion: '1.1.0' }), '1.2.0');
});

it('pickVersion falls back to the manifest when npm gives nothing usable', () => {
  assert.equal(pickVersion({ manifestVersion: '1.2.0' }), '1.2.0');
  assert.equal(pickVersion({ manifestVersion: '1.2.0', npmVersion: '' }), '1.2.0');
  assert.equal(pickVersion({ manifestVersion: undefined, npmVersion: undefined }), null);
});

it('computeVersionSync syncs manifest and package.json', () => {
  const next = computeVersionSync({
    manifest: { manifest_version: 3, version: '1.2.0' },
    packageJson: { name: 'x', version: '1.2.0' },
    versions: {},
    targetVersion: '1.2.1',
  });
  assert.equal(next.manifest.version, '1.2.1');
  assert.equal(next.packageJson.version, '1.2.1');
});

it('computeVersionSync pulls a lagging package.json back', () => {
  const next = computeVersionSync({
    manifest: { manifest_version: 3, version: '1.2.0' },
    packageJson: { name: 'x', version: '1.1.0' },
    versions: {},
    targetVersion: '1.2.0',
  });
  assert.equal(next.packageJson.version, '1.2.0');
});

it('computeVersionSync never produces an undefined version field', () => {
  // 回归用例：旧脚本在没有 npm 环境变量时会把 manifest.version 写成
  // undefined，JSON.stringify 会直接丢掉这个字段 —— Chrome 读到的 manifest
  // 少了 version，商店会拒收。
  const next = computeVersionSync({
    manifest: { manifest_version: 3, version: '1.2.0' },
    packageJson: { version: '1.2.0' },
    versions: {},
    targetVersion: '1.2.1',
  });
  assert.ok(Object.prototype.hasOwnProperty.call(next.manifest, 'version'));
});

it('computeVersionSync does not mutate its inputs', () => {
  const manifest = { manifest_version: 3, version: '1.2.0' };
  const packageJson = { version: '1.2.0' };
  computeVersionSync({ manifest, packageJson, versions: {}, targetVersion: '1.2.1' });
  assert.equal(manifest.version, '1.2.0');
  assert.equal(packageJson.version, '1.2.0');
});

/* ------------------------------------------------------------------ *
 * 版本号替换必须只动一个字段
 *
 * 回归用例：旧实现用 JSON.stringify 写回整个文件，
 * 原文件里手写的紧凑单行数组（"permissions": ["storage", "activeTab"]）
 * 会被展开成多行 —— 一次版本号改动产生 28 行 diff，其中只有 1 行是真改动。
 * 版本号改动被噪音淹没，review 与自动化 diff 审查都看不出改了什么。
 * ------------------------------------------------------------------ */

it('replaceVersionInJsonText only changes the version value', () => {
  const before = [
    '{',
    '  "manifest_version": 3,',
    '  "version": "1.1.0",',
    '  "permissions": ["storage", "activeTab"],',
    '}',
  ].join('\n');
  const after = replaceVersionInJsonText(before, '1.2.0');
  assert.includes(after, '"version": "1.2.0"');
  assert.includes(after, '"permissions": ["storage", "activeTab"]');
  // 紧凑数组必须原样保留 —— 这正是旧实现破坏的东西
  assert.equal(
    after.split('\n').length,
    before.split('\n').length,
    '行数不应变化（旧实现会把紧凑数组展开成多行）'
  );
});

it('replaceVersionInJsonText preserves CRLF line endings and trailing newline', () => {
  const before = '{\r\n  "version": "1.1.0",\r\n  "permissions": ["storage"]\r\n}\r\n';
  const after = replaceVersionInJsonText(before, '1.2.0');
  assert.includes(after, '"version": "1.2.0"');
  assert.includes(after, '\r\n');
  assert.ok(after.endsWith('\r\n'), '结尾换行必须保留');
});

it('replaceVersionInJsonText does not touch other keys containing "version"', () => {
  const before = '{\n  "version": "1.1.0",\n  "minAppVersion": "1.5.0",\n  "version_name": "keep"\n}';
  const after = replaceVersionInJsonText(before, '1.2.0');
  assert.includes(after, '"minAppVersion": "1.5.0"', 'minAppVersion 不得被改');
  assert.includes(after, '"version_name": "keep"', 'version_name 不得被改');
  assert.includes(after, '"version": "1.2.0"');
});

it('replaceVersionInJsonText returns null when there is no version field', () => {
  assert.equal(replaceVersionInJsonText('{"a": 1}', '1.2.0'), null);
});

it('replaceVersionInJsonText is idempotent', () => {
  const before = '{\n  "version": "1.1.0"\n}';
  const once = replaceVersionInJsonText(before, '1.2.0');
  const twice = replaceVersionInJsonText(once, '1.2.0');
  assert.equal(twice, once);
});

it('the real manifest.json version bump changes exactly one line', () => {
  // 直接拿仓库里的真 manifest.json 做断言：这是最贴近真实用法的守门。
  const before = readFile('manifest.json');
  const after = replaceVersionInJsonText(before, '9.9.9');
  assert.ok(after, '应能替换出结果');

  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  assert.equal(afterLines.length, beforeLines.length, '行数必须一致');

  const changed = afterLines.filter((line, i) => line !== beforeLines[i]);
  assert.equal(changed.length, 1, '只应有一行发生变化，实际: ' + changed.length);
  assert.includes(changed[0], '"version"');
});

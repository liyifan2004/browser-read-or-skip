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
import {
  compareSemver,
  computeVersionSync,
  parseSemver,
  pickVersion,
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

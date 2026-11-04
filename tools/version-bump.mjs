import { readFileSync, writeFileSync } from 'node:fs';
import { pickVersion, computeVersionSync, replaceVersionInJsonText } from './version-sync.mjs';

/**
 * 版本号同步脚本 —— 让 `npm version` 成为唯一的版本号入口。
 *
 * Chrome Web Store 按 manifest.json 的 version 字段识别版本；GitHub Release
 * 的 tag 也必须与之一致（release.yml 里有一道闸门在核对）。本仓库原先没有
 * 任何同步脚本，两处版本号靠手工维护 —— 迟早会漂移，而漂移的后果是
 * 「发出去的包版本号对不上商店后台的版本号」，用户装到的是旧代码。
 *
 * 用法：
 *   npm version patch       # 1.2.0 -> 1.2.1，自动同步两处
 *   npm run version         # 不改版本号，只把已有版本号同步到两处
 *
 * 同步目标：
 *   - manifest.json  的 version（基准，商店读的那份）
 *   - package.json   的 version
 *
 * 决策逻辑在 tools/version-sync.mjs（纯函数，有单元测试覆盖）。
 */

/**
 * 只替换 JSON 文本里的 version 字段值，其余字节一个都不动。
 *
 * ## 为什么不 JSON.stringify 写回
 *
 * `JSON.stringify(data, null, indent)` 会对所有数组与对象做统一展开，
 * 原文件里手写的紧凑单行数组会被改写成多行：
 *
 * ```diff
 * -  "permissions": ["storage", "activeTab"],
 * +  "permissions": [
 * +    "storage",
 * +    "activeTab"
 * +  ],
 * ```
 *
 * 后果：一次版本号改动产生 28 行 diff，其中只有 1 行是真正的改动。
 * review 的人看不出改了什么，自动化 diff 审查也被噪音淹没。
 * 详见 tools/version-sync.mjs 的 replaceVersionInJsonText 注释。
 */
function patchVersionField(path, version) {
	const before = readFileSync(path, 'utf8');
	const after = replaceVersionInJsonText(before, version);
	if (after === null) {
		console.error(`version-bump.mjs: ${path} 里找不到 "version" 字段，无法更新版本号。`);
		process.exit(1);
	}
	if (after !== before) writeFileSync(path, after);
	return after !== before;
}

const manifestText = readFileSync('manifest.json', 'utf8');
const pkgText = readFileSync('package.json', 'utf8');

let manifestData;
let pkgData;
try {
	manifestData = JSON.parse(manifestText);
	pkgData = JSON.parse(pkgText);
} catch (e) {
	console.error('version-bump.mjs: manifest.json 或 package.json 不是合法 JSON。', e && e.message);
	process.exit(1);
}

/** npm 刚写入的版本号（`npm run version` 时为 package.json 的现值）。 */
const npmVersion = process.env.npm_package_version;

const targetVersion = pickVersion({
	manifestVersion: manifestData.version,
	npmVersion,
});

if (!targetVersion) {
	console.error(
		'version-bump.mjs 无法确定目标版本号：manifest.json 与 package.json 都缺少合法的 version 字段。',
	);
	process.exit(1);
}

const next = computeVersionSync({
	manifest: manifestData,
	packageJson: pkgData,
	versions: {},
	targetVersion,
});

if (!next) {
	console.error('version-bump.mjs 读取到的 manifest.json 结构不合法。');
	process.exit(1);
}

const manifestChanged = patchVersionField('manifest.json', next.manifest.version);
const pkgChanged = patchVersionField('package.json', next.packageJson.version);

console.log(
	`version-bump: ${targetVersion} — manifest.json / package.json 已同步` +
		(manifestChanged || pkgChanged ? '' : '（本来就是目标版本号，无需改动）'),
);

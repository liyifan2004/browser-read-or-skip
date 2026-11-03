import { readFileSync, writeFileSync } from 'node:fs';
import { pickVersion, computeVersionSync } from './version-sync.mjs';

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
 * 读写 JSON 时保留原文件的缩进风格、行尾和结尾换行。
 *
 * 本仓库的 manifest.json 是 CRLF 行尾：直接 JSON.stringify + writeFileSync
 * 会写成 LF，产生一个「整个文件都变了」的 diff —— 真正的版本号改动就被
 * 淹没在噪音里，review 的人根本看不出改了什么。
 */
function readJson(path) {
	const raw = readFileSync(path, 'utf8');
	return {
		data: JSON.parse(raw),
		indent: /^\t/m.test(raw) ? '\t' : /^\s+/m.test(raw) ? '  ' : '\t',
		crlf: raw.includes('\r\n'),
		trailingNewline: raw.endsWith('\n'),
	};
}

function writeJson(path, data, indent, crlf, trailingNewline) {
	let text = JSON.stringify(data, null, indent);
	if (crlf) text = text.replace(/\n/g, '\r\n');
	if (trailingNewline && !text.endsWith('\n')) text += '\n';
	writeFileSync(path, text);
}

const manifestFile = readJson('manifest.json');
const pkgFile = readJson('package.json');

/** npm 刚写入的版本号（`npm run version` 时为 package.json 的现值）。 */
const npmVersion = process.env.npm_package_version;

const targetVersion = pickVersion({
	manifestVersion: manifestFile.data.version,
	npmVersion,
});

if (!targetVersion) {
	console.error(
		'version-bump.mjs 无法确定目标版本号：manifest.json 与 package.json 都缺少合法的 version 字段。',
	);
	process.exit(1);
}

const next = computeVersionSync({
	manifest: manifestFile.data,
	packageJson: pkgFile.data,
	versions: {},
	targetVersion,
});

if (!next) {
	console.error('version-bump.mjs 读取到的 manifest.json 结构不合法。');
	process.exit(1);
}

writeJson('manifest.json', next.manifest, manifestFile.indent, manifestFile.crlf, manifestFile.trailingNewline);
writeJson('package.json', next.packageJson, pkgFile.indent, pkgFile.crlf, pkgFile.trailingNewline);

console.log(
	`version-bump: ${targetVersion} — manifest.json / package.json 已同步`,
);

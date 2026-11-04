/**
 * sync-engines.mjs —— 把 manifest.json 的结果页 match pattern 同步到单一事实源。
 *
 * 为什么需要这个脚本：
 * 「哪些页面是搜索结果页」必须让三处保持一致：
 *   1. manifest.json 的 content_scripts[1].matches —— 决定 serp.js 会不会被注入
 *   2. src/lib/heuristics.js 的 isSearchResultsPage —— 决定 HUD 会不会让位
 *   3. src/content/serp.js 的 ENGINES —— 决定 serp.js 内部认不认这个引擎
 * 三处各写一遍必然漂移，而漂移的后果是用户可见的静默故障：
 * 「HUD 让位了但没注入标注」= 结果页上整页没有任何反馈（空窗）。
 *
 * 本脚本从 src/lib/engines.js 的 ENGINES 里读出 matchPatterns，写进 manifest。
 * src/lib/engines.js 是纯浏览器脚本（IIFE 挂到 globalThis.RS），这里用最小
 * 的沙箱把它加载起来读数据 —— 不引入任何依赖，也不复制一份引擎表。
 *
 * 用法：
 *   node tools/sync-engines.mjs           # 写入 manifest.json
 *   node tools/sync-engines.mjs --check   # 只校验，不写（CI 用）
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

/** 在沙箱里加载 engines.js，取出 ENGINES 与派生出的 match pattern 列表。 */
function loadEngines() {
	const src = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'engines.js'), 'utf8');
	// engines.js 是浏览器 IIFE：挂到 globalThis.RS 上。沙箱里要自己提供
	// globalThis 与一个空 RS 对象，否则 `RS.engines = {...}` 会炸。
	const sandbox = {};
	sandbox.globalThis = sandbox;
	sandbox.RS = {};
	vm.createContext(sandbox);
	vm.runInContext(src, sandbox, { filename: 'src/lib/engines.js' });
	const RS = sandbox.RS;
	if (!RS || !RS.engines || !Array.isArray(RS.engines.ENGINES)) {
		throw new Error('engines.js 没有导出 RS.engines.ENGINES');
	}
	return RS.engines;
}

/** 读 JSON 并保留原文件的缩进风格、行尾与结尾换行。 */
function readJson(file) {
	const raw = fs.readFileSync(file, 'utf8');
	return {
		data: JSON.parse(raw),
		indent: /^\t/m.test(raw) ? '\t' : /^\s+/m.test(raw) ? '  ' : '\t',
		crlf: raw.includes('\r\n'),
		trailingNewline: raw.endsWith('\n'),
	};
}

function writeJson(file, data, indent, crlf, trailingNewline) {
	let text = JSON.stringify(data, null, indent);
	if (crlf) text = text.replace(/\n/g, '\r\n');
	if (trailingNewline && !text.endsWith('\n')) text += '\n';
	fs.writeFileSync(file, text);
}

const engines = loadEngines();
const patterns = engines.allMatchPatterns();

const manifestFile = path.join(ROOT, 'manifest.json');
const mf = readJson(manifestFile);
const cs = mf.data.content_scripts && mf.data.content_scripts[1];

if (!cs) {
	console.error('manifest.json 里找不到 content_scripts[1]（结果页脚本）。');
	process.exit(1);
}

const current = cs.matches || [];
const same =
	current.length === patterns.length && current.every((p, i) => p === patterns[i]);

if (process.argv.includes('--check')) {
	if (same) {
		console.log(`sync-engines: manifest 的结果页 match pattern 与单一事实源一致（${patterns.length} 条）。`);
		process.exit(0);
	}
	console.error('sync-engines: manifest 的结果页 match pattern 与 src/lib/engines.js 不一致。');
	console.error('  manifest : ' + JSON.stringify(current));
	console.error('  期望     : ' + JSON.stringify(patterns));
	console.error('  修复     : node tools/sync-engines.mjs');
	process.exit(1);
}

if (same) {
	console.log(`sync-engines: manifest 已是最新（${patterns.length} 条 match pattern）。`);
	process.exit(0);
}

cs.matches = patterns;
writeJson(manifestFile, mf.data, mf.indent, mf.crlf, mf.trailingNewline);
console.log(
	`sync-engines: manifest 的结果页 match pattern 已同步为 ${patterns.length} 条。`,
);

/**
 * version-sync.mjs —— 版本号同步的纯逻辑（无文件系统副作用）。
 *
 * 为什么要抽成纯模块：
 * - 版本号决策是整个发版链路上最容易出错的一环，写错了会产出「用户永远
 *   收不到修复版本」的发布物，而这类错误只有真正跑一次发版才会暴露。
 * - 纯函数可以在单元测试里直接验证，不必真的执行 `npm version`、也不必
 *   往磁盘写文件——测试既快又不会污染仓库。
 *
 * 本模块不导出任何带副作用的入口，`version-bump.mjs` 负责 IO。
 */

/** 解析 "1.2.3" → [1, 2, 3]；不是合法的三段式 semver 时返回 null。 */
export function parseSemver(value) {
	const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? "").trim());
	if (!m) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * 比较两个 semver：a < b → -1，a === b → 0，a > b → 1。
 * 任一不是合法 semver → null（调用方据此放弃比较，而不是当成 0）。
 */
export function compareSemver(a, b) {
	const x = parseSemver(a);
	const y = parseSemver(b);
	if (!x || !y) return null;
	for (let i = 0; i < 3; i += 1) {
		if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
	}
	return 0;
}

/**
 * 选目标版本号。
 *
 * npm 的两种调用方式都会把版本号通过 `npm_package_version` 传进来，脚本
 * 本身区分不了，只能靠数值比较：
 *   `npm version patch` → npm 先把新版本写进 package.json，再跑 version 脚本
 *   `npm run version`   → 不改版本号，只跑版本脚本（用于修复历史漂移）
 *
 * 决策规则：
 *   1. 没有可用的 npm 版本号（未设置 / 非法）→ 用 manifest.json 的版本号。
 *      绝不能把 manifest.version 覆盖成 undefined——那会让 Obsidian 读到
 *      一个没有 version 字段的 manifest，插件直接无法安装。
 *   2. npm 的版本号 >= manifest 的版本号 → 用 npm 的（正常发版路径）。
 *   3. npm 的版本号 <  manifest 的版本号 → 用 manifest 的。
 *      说明 package.json 漂移落后了，把正确的版本号「降级」才是事故。
 */
export function pickVersion({ manifestVersion, npmVersion } = {}) {
	const manifest = parseSemver(manifestVersion);
	const npm = parseSemver(npmVersion);
	if (!npm) return manifest ? manifestVersion : null;
	if (!manifest) return npmVersion;
	return compareSemver(npmVersion, manifestVersion) >= 0 ? npmVersion : manifestVersion;
}

/**
 * 计算同步后的三份文件内容（纯函数，不修改入参）。
 *
 * - manifest.json 的 version 设为 targetVersion
 * - versions.json 追加 "<targetVersion>": "<minAppVersion>"（已存在则不改，
 *   因为它记录的是「该版本起要求的最低 Obsidian 版本」，是历史事实）
 * - package.json 的 version 与 manifest 对齐
 *
 * minAppVersion 缺失时不写入 versions.json 的新条目（Obsidian 会把
 * undefined 当成空字符串写进去，污染这张兼容表），由调用方给出警告。
 */
export function computeVersionSync({ manifest, packageJson, versions, targetVersion } = {}) {
	if (!targetVersion) return null;
	if (!manifest || typeof manifest !== "object") return null;
	if (!versions || typeof versions !== "object") return null;

	const nextManifest = { ...manifest, version: targetVersion };
	const nextVersions = { ...versions };

	const minAppVersion = manifest.minAppVersion;
	const hasMinAppVersion =
		typeof minAppVersion === "string" && minAppVersion.trim() !== "";
	if (!(targetVersion in nextVersions) && hasMinAppVersion) {
		nextVersions[targetVersion] = minAppVersion;
	}

	const nextPackage = { ...(packageJson ?? {}), version: targetVersion };

	return {
		manifest: nextManifest,
		packageJson: nextPackage,
		versions: nextVersions,
		/** versions.json 是否因为缺 minAppVersion 而没写新条目。 */
		skippedVersionsEntry: !(targetVersion in versions) && !hasMinAppVersion,
	};
}

/**
 * 只替换 JSON 文本里的 version 字段值，**不重新序列化整个文件**。
 *
 * ## 为什么不能直接 JSON.stringify 写回
 *
 * `JSON.stringify(data, null, indent)` 会对所有数组与对象做统一展开：
 * 原文件里手写的紧凑单行数组（`"permissions": ["storage", "activeTab"]`）
 * 会被改写成多行：
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
 * review 的人看不出改了什么，自动化的 diff 审查也会被噪音淹没。
 * **这是「保留原格式」这个承诺只兑现了一半** —— 行尾保留了，数组排版没保留。
 *
 * ## 做法
 *
 * 只做一次**文本替换**：定位 `"version"` 这个键，把它的值换成新的版本号，
 * 其余字节一个都不动。文件里其余部分的排版、行尾、结尾换行自然全部保留。
 *
 * @param {string} text 原文件文本
 * @param {string} version 新的版本号
 * @returns {string} 只改了 version 值的新文本；找不到 version 字段时返回 null
 */
export function replaceVersionInJsonText(text, version) {
	const source = String(text ?? "");
	// 匹配 "version": "任意非引号字符" —— 只改顶层/嵌套的 version 键，
	// 不碰 "minAppVersion" / "version_name" 之类含 version 的其它键。
	const re = /("version"\s*:\s*)"([^"\\]*)"/;
	const m = re.exec(source);
	if (!m) return null;
	const start = m.index;
	const valueStart = start + m[1].length;
	const valueEnd = valueStart + m[2].length + 2; // 含两侧引号
	return source.slice(0, valueStart) + JSON.stringify(version) + source.slice(valueEnd);
}

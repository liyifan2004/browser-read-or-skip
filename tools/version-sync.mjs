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

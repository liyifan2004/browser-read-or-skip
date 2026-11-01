#!/usr/bin/env node
/**
 * 商店发布打包（白名单式）。
 *
 *   node tools/pack.mjs            # 生成 read-or-skip.zip
 *   node tools/pack.mjs --check    # 只自检，不写 zip
 *
 * 为什么要白名单而不是黑名单：
 * 黑名单（"排除 tools/ tests/ docs/"）会在新增目录时静默漏排——只要有人
 * 忘了加排除项，开发产物就会进商店包。白名单只认「运行必需文件」，
 * 新增文件默认不打包，要进包必须显式改这份清单。
 *
 * 两条硬红线：
 *   1. `src/lib/config.js` 含真实 API Key，**永远不进包**。
 *      扩展在缺 config.js 时会回退到 config.example.js（apiKey 为空），
 *      用户在设置页手填 Key——这是设计好的降级路径。
 *   2. 打包后逐条核对 manifest 引用的文件都在包里、包里没有多余文件。
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const OUT_ZIP = path.join(ROOT, "read-or-skip.zip");
const CHECK_ONLY = process.argv.includes("--check");

/** 进包的顶层目录 / 文件（白名单） */
const INCLUDE_TOP = new Set(["manifest.json", "README.md", "LICENSE"]);
const INCLUDE_DIRS = ["src", "icons"];

/** 永远不进包的文件（相对仓库根） */
const NEVER_SHIP = [
  "src/lib/config.js", // 真实 API Key
];

/**
 * 扩展运行时真正需要的源码文件（相对 src/）。
 *
 * 注意 `lib/config.example.js` **必须进包**：service-worker.js 在
 * `config.js` 缺失时 importScripts 回退到它（apiKey 为空），用户随后在设置页手填 Key。
 * 少了这个文件，SW 的 importScripts 会抛错，整个后台起不来。
 */
const RUNTIME_SRC = [
  "background/service-worker.js",
  "content/hud.js",
  "content/serp.js",
  "lib/namespace.js",
  "lib/config.example.js",
  "lib/constants.js",
  "lib/storage.js",
  "lib/heuristics.js",
  "lib/extract.js",
  "lib/jev.js",
  "lib/questions.js",
  "options/options.css",
  "options/options.html",
  "options/options.js",
  "popup/popup.css",
  "popup/popup.html",
  "popup/popup.js",
];

function fail(msg) {
  console.error(`  FAIL  ${msg}`);
  process.exitCode = 1;
}

function ok(msg) {
  console.log(`  ok    ${msg}`);
}

/** 收集要打包的文件（相对仓库根，正斜杠路径），递归 */
function collectFiles() {
  const files = [];
  for (const name of INCLUDE_TOP) {
    if (fs.existsSync(path.join(ROOT, name))) files.push(name);
  }
  const walk = (dir, prefix) => {
    const base = path.join(ROOT, dir);
    if (!fs.existsSync(base)) return;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(`${dir}/${entry.name}`, rel);
      } else if (entry.isFile()) {
        if (NEVER_SHIP.includes(rel)) continue;
        files.push(rel);
      }
    }
  };
  for (const dir of INCLUDE_DIRS) walk(dir, dir);
  return files.sort();
}

function checkFiles(files) {
  console.log("自检：");

  // 1. 密钥文件绝不在包里
  for (const bad of NEVER_SHIP) {
    if (files.includes(bad)) fail(`${bad} 含真实 API Key，绝不能进包`);
    else ok(`${bad} 未进包`);
  }

  // 2. 运行时必需文件都在
  for (const need of RUNTIME_SRC) {
    if (!files.includes(`src/${need}`)) fail(`缺运行时文件 src/${need}`);
  }

  // 3. manifest 引用的文件都在包里
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const referenced = new Set();
  const collect = (obj) => {
    if (typeof obj === "string") {
      if (/\.(js|html|css|png)$/.test(obj) && !obj.startsWith("http")) referenced.add(obj);
    } else if (Array.isArray(obj)) {
      obj.forEach(collect);
    } else if (obj && typeof obj === "object") {
      Object.values(obj).forEach(collect);
    }
  };
  collect(manifest);
  for (const ref of referenced) {
    if (!files.includes(ref)) fail(`manifest 引用了不在包里的文件：${ref}`);
  }
  ok(`manifest 引用文件 ${referenced.size} 个，均在包内`);

  // 4. 包里没有开发产物
  for (const f of files) {
    if (/^(tests|tools|docs|assets)\//.test(f)) fail(`开发目录混进包：${f}`);
    if (/^(design-review|gh-push|github-push-from-agent)/.test(f)) fail(`开发文件混进包：${f}`);
    if (/\.(jpeg|jpg)$/i.test(f)) fail(`商店包不需要大图源文件：${f}`);
  }

  // 5. manifest 自身的基本形态
  if (manifest.manifest_version !== 3) fail("manifest_version 必须为 3");
  if (!manifest.background?.service_worker) fail("manifest 缺少 background.service_worker");

  return { manifest, referenced };
}

function writeZip(files) {
  // 用 node 自带的 zlib 手工构造 zip，避免引入 zip 依赖（运行时零依赖是本项目的硬约束）。
  const zlib = require("node:zlib");

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const rel of files) {
    const data = fs.readFileSync(path.join(ROOT, rel));
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const nameBuf = Buffer.from(rel, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (1996-01-01，固定值保证可复现)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(cdStart, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(OUT_ZIP, Buffer.concat([...chunks, ...central, end]));
  return fs.statSync(OUT_ZIP).size;
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

// ------------------------------------------------------------------ 主流程

const files = collectFiles();
console.log(`待打包文件 ${files.length} 个：`);
for (const f of files) console.log(`  ${f}`);

checkFiles(files);

if (process.exitCode) {
  console.error("\n自检未通过，已中止。");
  process.exit(1);
}

if (CHECK_ONLY) {
  console.log("\n--check：自检通过，未写 zip。");
} else {
  const size = writeZip(files);
  console.log(`\n写出 ${path.relative(ROOT, OUT_ZIP)}（${(size / 1024).toFixed(1)} KB，${files.length} 个文件）`);
}

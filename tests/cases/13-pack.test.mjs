/**
 * 商店发布包的结构约束（IMP-10）。
 *
 * 这组用例守的是「不能出错」的那部分：
 *   - 本地真实 API Key 绝不能进包；
 *   - manifest 引用的文件必须都在包里（少一个，扩展装上就是坏的）；
 *   - 开发目录与源图大文件不能进包（商店审核会挑刺，包也更大）。
 *
 * 只断言包的内容，不关心压缩算法——那是 pack.mjs 自己的实现细节。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "../harness/registry.mjs";
import * as a from "../harness/assert.mjs";
import { ROOT, readManifest } from "../harness/env.mjs";

const ZIP = path.join(ROOT, "read-or-skip.zip");

/** 读 zip 里的中央目录（只取文件名，不解压内容） */
function listZipEntries() {
  const buf = fs.readFileSync(ZIP);
  // End of Central Directory 记录在文件尾部，签名 0x06054b50
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip 里找不到 EOCD 记录，不是合法 zip");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("中央目录项签名不对");
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    names.push(buf.toString("utf8", off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

describe("商店发布包（tools/pack.mjs）", () => {
  it("打包自检通过", () => {
    // pack.mjs --check 自检不通过时会以非 0 退出码结束
    const out = execFileSync(process.execPath, [path.join(ROOT, "tools", "pack.mjs"), "--check"], {
      cwd: ROOT,
      encoding: "utf8"
    });
    a.ok(out.includes("自检通过"), "自检应报告通过，实际输出：\n" + out);
  });

  it("zip 是合法归档且不含本地密钥文件", () => {
    execFileSync(process.execPath, [path.join(ROOT, "tools", "pack.mjs")], { cwd: ROOT });
    a.ok(fs.existsSync(ZIP), "应生成 read-or-skip.zip");

    const names = listZipEntries();
    a.notOk(
      names.includes("src/lib/config.js"),
      "src/lib/config.js 含真实 API Key，绝不能进包"
    );
    // config.example.js 必须进包：SW 在 config.js 缺失时回退到它
    a.ok(
      names.includes("src/lib/config.example.js"),
      "config.example.js 必须进包，缺了 SW 的 importScripts 会抛错"
    );
  });

  it("manifest 引用的文件都在包里", () => {
    const manifest = readManifest();
    const names = listZipEntries();
    const referenced = new Set();
    const collect = (v) => {
      if (typeof v === "string") {
        if (/\.(js|html|css|png)$/.test(v) && !v.startsWith("http")) referenced.add(v);
      } else if (Array.isArray(v)) {
        v.forEach(collect);
      } else if (v && typeof v === "object") {
        Object.values(v).forEach(collect);
      }
    };
    collect(manifest);
    a.gt(referenced.size, 0, "manifest 应至少引用一些文件");
    for (const ref of referenced) {
      a.ok(names.includes(ref), `manifest 引用的 ${ref} 应在包里`);
    }
  });

  it("包里没有开发目录与源图大文件", () => {
    const names = listZipEntries();
    for (const n of names) {
      a.notOk(/^(tests|tools|docs|assets)\//.test(n), `开发目录不该进包：${n}`);
      a.notOk(
        /^(design-review|gh-push|github-push-from-agent)/.test(n),
        `开发文件不该进包：${n}`
      );
      a.notOk(/\.(jpeg|jpg)$/i.test(n), `商店包不需要 jpg 源图：${n}`);
      a.notOk(/icon@2x\.png$/.test(n), `商店包不需要 @2x 源图标：${n}`);
    }
  });

  it("包里不含大体积源图（扩展本体应足够小）", () => {
    const buf = fs.readFileSync(ZIP);
    // 24 个运行文件、含 4 个小图标，体积应远小于 1MB
    a.ok(buf.length < 1024 * 1024, `商店包应小于 1MB，实际 ${buf.length} 字节`);
  });
});

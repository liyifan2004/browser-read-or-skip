/**
 * Read or Skip —— 共享命名空间。
 * 必须最先加载：所有其他脚本都挂在 globalThis.RS 上。
 * 兼容三种上下文：MV3 service worker（importScripts）、内容脚本、扩展页面。
 */
(function () {
  const RS = (globalThis.RS = globalThis.RS || {});
  if (RS.__ready) return;
  RS.__ready = true;
  RS.version = "1.0.0";
})();

/**
 * 本地配置模板。
 *
 * 用法：复制本文件为同目录下的 config.js，填入你的 API Key。
 *   cp src/lib/config.example.js src/lib/config.js
 *
 * config.js 已被 .gitignore 忽略，不会提交到仓库。
 * 若 config.js 不存在，扩展会自动回退到本文件（apiKey 为空），
 * 此时请在扩展的「设置」页面手动填写 Key。
 *
 * API Key 获取地址：https://console.typesafe.ai  →  API Keys
 */
(function (RS) {
  RS.DEFAULT_CONFIG = {
    apiKey: "",
    model: "jev-latest"
  };
})(globalThis.RS);

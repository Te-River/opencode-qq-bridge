// bridge.test.ts 专用环境：必须在导入 bridge.ts 之前生效（ESM 按声明顺序求值）。
// MONITOR=off 关闭后台监视器，避免其 setInterval/路由监听泄漏到其他用例。
process.env.MONITOR = "off"

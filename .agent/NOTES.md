# 项目经验（pi-web-sky）

> 只记录隐含的、约定的、从代码中无法直接获取的信息。任务清单/验收报告类内容不在此保存。

## 毛玻璃（backdrop-filter）的坑

1. **嵌套 backdrop-filter 无效**：子元素再挂 backdrop-filter 时不会重新采样背景（父级已有 blur 时尤其明显），只会得到实心色块。做法：去掉嵌套层，把背景 alpha 调低让它读作玻璃片（2026-08 玻璃改造 q6 的结论）。
2. **topbar 的 backdrop-filter 会成为 fixed 后代的 containing block**：顶栏面板若内联渲染会被困在顶栏坐标系里、随右侧面板收窄而偏移。必须 portal 到 `<body>` 并用按钮 rect 锚定（AppShell.tsx 内有注释，todo/语言/系统面板均此模式，新面板照抄）。

## 端口约定

- `npm run dev` / `start`：127.0.0.1:30143（见 package.json）；历史上有过 30141/30142 双实例并存时期，遇到旧文档提到这两个端口一律以 package.json 为准。

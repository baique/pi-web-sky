# Third-Party Notices

本发行版（`@baique/pi-web-sky`）自身代码以 MIT 协议发布（见 [LICENSE](./LICENSE)），
依赖的第三方组件均为宽松许可（MIT / Apache-2.0 / BSD-2-Clause 等），与 MIT 主协议兼容。

---

## 画布依赖（会话看板 / 任务即看板）

| 组件 | 版本 | 许可 | 用途 |
|---|---|---|---|
| @xyflow/react | 12.11.6 | MIT | 看板画布渲染（无限画布 / 节点 / 连线） |
| yjs | 13.6.32 | MIT | 画布文档 CRDT 协同（每看板一个 Y.Doc） |
| @hocuspocus/server | 4.6.0 | MIT | yjs 协同服务端（WebSocket 房间 + SQLite 持久化） |
| @hocuspocus/provider | 4.6.0 | MIT | yjs 协同客户端（前端连接） |

> 说明：历史版本依赖 tldraw SDK（source-available 自有许可）实现画布，已在本版移除，
> 改用上述 MIT 组件完全自研画布数据层与渲染层。

---

## 其他第三方依赖

以下直接依赖均为宽松许可（MIT / Apache-2.0 / BSD-2-Clause），与 MIT 主协议兼容：

| 组件 | 版本 | 许可 |
|---|---|---|
| @earendil-works/pi-agent-core / pi-ai / pi-coding-agent / pi-tui | 0.84.3 | MIT |
| next | 16.3.1 | MIT |
| react / react-dom | 19.2.4 | MIT |
| @xterm/xterm / @xterm/addon-fit | 6.0.0 / 0.11.0 | MIT |
| thinking-orbs | 0.3.1 | MIT |
| js-yaml | 5.2.3 | MIT |
| undici | 8.10.0 | MIT |
| proper-lockfile | 4.1.2 | MIT |
| remark-frontmatter | 5.0.0 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| mammoth | 1.12.0 | BSD-2-Clause |
| 其余 devDependencies（eslint / tailwindcss / mermaid / katex 等） | — | MIT / Apache-2.0 等宽松许可 |

完整的传递依赖许可信息见各包的 LICENSE 文件。

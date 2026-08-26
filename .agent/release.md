# 发布 npm：@baique/pi-web-sky

本仓库唯一正确的发布方式。不要发明其他流程（不要 npm login、不要用 npm 自动打 tag、不要建项目级 .npmrc）。

## 事实与约定（发布前先读）

- 发布动作封装在 `package.json` 的 `release` script：**版本 patch → next build → publish**，一步跑完。
- 发布凭据在全局 `~/.npmrc`（`//registry.npmjs.org/:_authToken=...`），`npm whoami` 应输出 `baique`。
- 本仓库**故意没有**项目级 `.npmrc`：token 绝不能进仓库、不能进 CI 明文。CI 发布用 GitHub Secret。
- 包名带 scope（`@baique/`），publish 必须带 `--access public`，否则报私有错误。
- 版本命令用 `--no-git-tag-version`：npm **不会自动提交、不会自动打 tag**。发布后需手动提交版本变更（步骤 5）、手动打版本 tag（步骤 6）。
- **版本 tag 触发 GitHub Release**：推送 `v*` tag 到 GitHub 会触发 `.github/workflows/release.yml`，自动把该 tag 的源码打包成 `pi-web-sky-<tag>.tar.gz` 并创建 GitHub Release。tag 即版本快照，必须打在本版本提交上。
- 发布产物包含 `.next`（见 `files`），所以发布前必须 build。**build 会污染 dev 的 `.next`**，发布后如需继续 `npm run dev`，重启 dev 命令即可。
- **npm 版本号与 git 必须同步**：每次发布后 package.json / package-lock.json 的版本变更必须提交并推送。npm 上存在而 git 里不存在的版本号，说明上次发布没提交——先修复同步，再继续下一次发布。

## 步骤

1. **确认工作区干净**：`git status` 无未提交改动（发布产物只该来自已提交的代码）。若有，先提交。
2. **确认 token 有效**：`npm whoami` 输出 `baique`。不是 → 换 token（见故障）。
3. **发布**：`npm run release`。内部依次完成：版本号 patch +1 → `next build` → `npm publish --access public`。
4. **验证发布成功**：`npm view @baique/pi-web-sky version` 输出必须等于 package.json 的 `version`。
   - **注意**：npm 新后端对 publish 返回 `PUT 202 Accepted` 并在日志打印 `+ @baique/pi-web-sky@0.1.x`，但版本要**几分钟后才会出现在 registry 的 versions 列表**。日志成功行出现后别急着验证；等 2–5 分钟再查，或直接用 `curl -s https://registry.npmjs.org/@baique%2Fpi-web-sky` 检查 `dist-tags.latest`。期间 `npm view` 仍显示上一版是正常的传播延迟，不是发布失败。
5. **提交版本变更**：`git add package.json package-lock.json && git commit -m "chore: release 0.1.x"`（x = 新版本号，沿用历史提交风格）。
6. **打版本 tag**：`git tag v0.1.x`。必须先确认 HEAD 指向第 5 步的版本提交（`git rev-parse HEAD`，或打 tag 后 `git rev-parse v0.1.x` 比对）；轻量 tag 即可。
7. **推送 GitHub**：`git push origin main v0.1.x`。推送 `v*` tag 会自动触发 CI 打包源码并创建 GitHub Release；确认远端与本地同步、workflow 变绿、Release 里出现 `pi-web-sky-v0.1.x.tar.gz`。

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `npm whoami` 报错 / publish 401 | `~/.npmrc` token 失效 | 到 npmjs.com 重新生成 token，写回 `~/.npmrc` 的 `//registry.npmjs.org/:_authToken=`，不要放进仓库 |
| publish 报私有包错误 | 忘了 `--access public` | 用 `npm publish --access public` |
| `npm view` 版本比本地大 | 之前发布未提交 | 先同步 git（按版本号补提交），再继续 |
| 发布后 `npm run dev` 异常 | build 污染了 `.next` | 重启 dev，或删除 `.next` 后重跑 dev |
| GitHub Release 失败，日志报 `no matches found for ''`（老版 gh 报 `stat 错误`） | 工作流 env 变量大小写不一致，`gh release create` 收到空文件参数 | release.yml 已改为文件名直接由 `GITHUB_REF_NAME` 拼出（`pi-web-sky-${GITHUB_REF_NAME}.tar.gz`），不再跨步骤传环境变量；勿回退为 env 传递写法 |
| workflow 修改后重跑仍失败 | GitHub Actions rerun 用的是触发时的旧 workflow 快照 | 不要 rerun；重打 tag 重新推送触发（`git push origin v0.1.x --force`，或删 tag 重打重推） |
| 推送 tag 被拒（远端已存在同名 tag） | 同名 tag 已存在 | 确认意图后 `git push origin v0.1.x --force`；正常流程不应发生 |

## 一次发布的产物清单（完成标准）

- [ ] npm 上版本号 = package.json 版本号
- [ ] git 有 `chore: release 0.1.x` 提交
- [ ] 远端有 `v0.1.x` tag，与本地同步
- [ ] GitHub Release `v0.1.x` 已创建，含源码包 `pi-web-sky-v0.1.x.tar.gz`
- [ ] GitHub 远端 main 包含该提交，与本地同步

# 发布 npm：@baique/pi-web-sky

本仓库唯一正确的发布方式。不要发明其他流程（不要 npm login、不要打 git tag、不要建项目级 .npmrc）。

## 事实与约定（发布前先读）

- 发布动作封装在 `package.json` 的 `release` script：**版本 patch → next build → publish**，一步跑完。
- 发布凭据在全局 `~/.npmrc`（`//registry.npmjs.org/:_authToken=...`），`npm whoami` 应输出 `baique`。
- 本仓库**故意没有**项目级 `.npmrc`：token 绝不能进仓库、不能进 CI 明文。CI 发布用 GitHub Secret。
- 包名带 scope（`@baique/`），publish 必须带 `--access public`，否则报私有错误。
- 版本命令用 `--no-git-tag-version`：**不会自动提交、不会打 tag**。发布后必须手动提交版本变更。
- 发布产物包含 `.next`（见 `files`），所以发布前必须 build。**build 会污染 dev 的 `.next`**，发布后如需继续 `npm run dev`，重启 dev 命令即可。
- **npm 版本号与 git 必须同步**：每次发布后 package.json / package-lock.json 的版本变更必须提交并推送。npm 上存在而 git 里不存在的版本号，说明上次发布没提交——先修复同步，再继续下一次发布。

## 步骤

1. **确认工作区干净**：`git status` 无未提交改动（发布产物只该来自已提交的代码）。若有，先提交。
2. **确认 token 有效**：`npm whoami` 输出 `baique`。不是 → 换 token（见故障）。
3. **发布**：`npm run release`。内部依次完成：版本号 patch +1 → `next build` → `npm publish --access public`。
4. **验证发布成功**：`npm view @baique/pi-web-sky version` 输出必须等于 package.json 的 `version`。
5. **提交版本变更**：`git add package.json package-lock.json && git commit -m "chore: release 0.1.x"`（x = 新版本号，沿用历史提交风格）。
6. **推送 GitHub**：`git push origin main`，确认远端与本地同步。

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `npm whoami` 报错 / publish 401 | `~/.npmrc` token 失效 | 到 npmjs.com 重新生成 token，写回 `~/.npmrc` 的 `//registry.npmjs.org/:_authToken=`，不要放进仓库 |
| publish 报私有包错误 | 忘了 `--access public` | 用 `npm publish --access public` |
| `npm view` 版本比本地大 | 之前发布未提交 | 先同步 git（按版本号补提交），再继续 |
| 发布后 `npm run dev` 异常 | build 污染了 `.next` | 重启 dev，或删除 `.next` 后重跑 dev |

## 一次发布的产物清单（完成标准）

- [ ] npm 上版本号 = package.json 版本号
- [ ] git 有 `chore: release 0.1.x` 提交
- [ ] GitHub 远端包含该提交，与本地同步

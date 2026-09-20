# 发布 npm：@baique/pi-web-sky

本仓库唯一正确的发布方式。不要发明其他流程（不要 npm login、不要用 npm 自动打 tag、不要建项目级 .npmrc）。

## 事实与约定（发布前先读）

- 发布动作封装在 `package.json` 的 `release` script：**版本 patch → next build → publish**，一步跑完。
- 发布凭据在全局 `~/.npmrc`（`//registry.npmjs.org/:_authToken=...`），`npm whoami` 应输出 `baique`。
- 本仓库**故意没有**项目级 `.npmrc`：token 绝不能进仓库、不能进 CI 明文。CI 发布用 GitHub Secret。
- 包名带 scope（`@baique/`），publish 必须带 `--access public`，否则报私有错误。
- 版本命令用 `--no-git-tag-version`：npm **不会自动提交、不会自动打 tag**。发布后需手动提交版本变更（步骤 5）、手动打版本 tag（步骤 6）。
- **版本 tag 触发 GitHub Release**：推送 `v*` tag 到 GitHub 会触发 `.github/workflows/release.yml`，自动把该 tag 的源码打包成 `pi-web-sky-<tag>.tar.gz` 并创建 GitHub Release。tag 即版本快照，必须打在本版本提交上。
- 发布产物包含 `.next`（见 `files`），所以发布前必须 build。build 与 dev 共用 `.next` **互不干扰**（Next 16 的 dev 产物在 `.next/dev`，2026-09-12 实测同目录并发运行正常：dev 仍服务 dev 产物、成品文件未被改动），发布时不必先停 dev。
- **npm 版本号与 git 必须同步**：每次发布后 package.json / package-lock.json 的版本变更必须提交并推送。npm 上存在而 git 里不存在的版本号，说明上次发布没提交——先修复同步，再继续下一次发布。
- 发布流程已固化为 `.agent/script/tools/` 下的脚本（见下方「脚本入口」）。正常发布**不必手敲长命令**，直接调脚本；`.agent/script/` 不入库，仅本机使用。

## 脚本入口（推荐）

| 脚本 | 作用 | 参数 |
|---|---|---|
| `release.sh` | 前置检查（工作区干净 + token=baique）→ patch 版本 → `next build` → `npm publish` | `--dry-run` 只检查不发布；`--skip-checks` 跳过前置检查 |
| `wait-npm.sh` | 轮询 registry，等 `dist-tags.latest` == 目标版本 | 位置参数=版本（默认读 `package.json`）；`--timeout <秒>`（默认 900）；`--interval <秒>`（默认 15）；`--package <名>`；`--verbose` 打印每次轮询 |
| `release-finish.sh` | 提交版本变更 → 打 `v<版本>` tag → 推送 → 等 CI 创建 GitHub Release | 位置参数=版本（默认读 `package.json`）；`--no-push` 只提交 + 打 tag；`--skip-release-check` 跳过 Release 验证 |

一次完整发布 = 三条命令（替代下文手工步骤 1–7）：

```bash
.agent/script/tools/release.sh           # 发布；成功回显 0.1.x → 0.1.y
.agent/script/tools/wait-npm.sh          # 等传播就绪（默认读 package.json 版本）
.agent/script/tools/release-finish.sh    # 收尾：提交 + tag + push + 验 Release
```

脚本里已固化的细节（不必再手敲）：

- 一律带 `env -u TURBOPACK npm_config_registry=https://registry.npmjs.org/`（绕开 Nexus 覆盖 + TURBOPACK 与 `--webpack` 冲突）。
- `release.sh` 把 build/publish 长输出写 `.agent/logs/release-<时间戳>.log`，终端只回显关键结果；失败时打印日志尾部并提示还原版本号。
- `wait-npm.sh` 直查 registry 的 `dist-tags.latest`（比 `npm view` 实时），超时返回非 0，可重复运行。
- `release-finish.sh` 校验 tag 与 HEAD 指向同一提交，并轮询 `gh release view` 确认 Release 与 asset 就绪。

## 步骤（手工等价命令，脚本内部执行）

> 正常发布走上面的脚本。以下为脚本内部的等价命令，供排查或手工兜底时参考。

1. **确认工作区干净**：`git status` 无未提交改动（发布产物只该来自已提交的代码）。若有，先提交。
2. **确认 token 有效**：`npm_config_registry=https://registry.npmjs.org/ npm whoami` 输出 `baique`。不是 → 换 token（见故障）。前缀不能省：环境里的 `npm_config_registry` 会盖掉 `~/.npmrc`，直接跑 `npm whoami` 报的是 `need auth`。
3. **发布**：`npm run release`。内部依次完成：版本号 patch +1 → `next build` → `npm publish --access public`。
4. **验证发布成功**：`npm view @baique/pi-web-sky version` 输出必须等于 package.json 的 `version`。
   - **注意**：npm 新后端对 publish 返回 `PUT 202 Accepted` 并在日志打印 `+ @baique/pi-web-sky@0.1.x`，但版本要**几分钟后才会出现在 registry 的 versions 列表**。日志成功行出现后别急着验证；等 2–5 分钟再查，或直接用 `curl -s https://registry.npmjs.org/@baique%2Fpi-web-sky` 检查 `dist-tags.latest`。期间 `npm view` 仍显示上一版是正常的传播延迟，不是发布失败。
5. **提交版本变更**：`git add package.json package-lock.json && git commit -m "chore: release 0.1.x"`（x = 新版本号，沿用历史提交风格）。
6. **打版本 tag**：`git tag v0.1.x`。必须先确认 HEAD 指向第 5 步的版本提交（`git rev-parse HEAD`，或打 tag 后 `git rev-parse v0.1.x` 比对）；轻量 tag 即可。
7. **推送 GitHub**：`git push origin main v0.1.x`。推送 `v*` tag 会自动触发 CI 打包源码并创建 GitHub Release；确认远端与本地同步、workflow 变绿、Release 里出现 `pi-web-sky-v0.1.x.tar.gz`。

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `npm whoami` 报错 / publish 401 / `need auth` | 两种：① `~/.npmrc` token 失效；② 进程环境带了 `npm_config_registry`，指向公司 Nexus（`https://maven.hljzj.tech/repository/npm/`）——它**优先于** `~/.npmrc` 的 `registry=` 和 `//registry.npmjs.org/:_authToken=`（2026-09-12 实录） | 先区分：`npm_config_registry=https://registry.npmjs.org/ npm whoami` → 输出 `baique` 就是 ②，发布一律带前缀（`env -u TURBOPACK npm_config_registry=https://registry.npmjs.org/ npm run release`）；仍报 401 就是 ①，到 npmjs.com 重生成 token 写回 `~/.npmrc`（不进仓库）。**绝不要在 Nexus 上 publish** |
| publish 报私有包错误 | 忘了 `--access public` | 用 `npm publish --access public` |
| `npm view` 版本比本地大 | 之前发布未提交 | 先同步 git（按版本号补提交），再继续 |
| `next build` 报 `Multiple bundler flags set: TURBOPACK=auto, --webpack` | 进程环境带了 `TURBOPACK=auto`（npm exec / 某些 shell 注入），与 build 脚本的 `--webpack` 冲突 | 用 `env -u TURBOPACK npm run release` 重跑；重跑前先 `git checkout -- package.json package-lock.json` 把已 patch 的版本号还原，避免留半次发布的脏状态 |
| GitHub Release 失败，日志报 `no matches found for ''`（老版 gh 报 `stat 错误`） | 工作流 env 变量大小写不一致，`gh release create` 收到空文件参数 | release.yml 已改为文件名直接由 `GITHUB_REF_NAME` 拼出（`pi-web-sky-${GITHUB_REF_NAME}.tar.gz`），不再跨步骤传环境变量；勿回退为 env 传递写法 |
| workflow 修改后重跑仍失败 | GitHub Actions rerun 用的是触发时的旧 workflow 快照 | 不要 rerun；重打 tag 重新推送触发（`git push origin v0.1.x --force`，或删 tag 重打重推） |
| 推送 tag 被拒（远端已存在同名 tag） | 同名 tag 已存在 | 确认意图后 `git push origin v0.1.x --force`；正常流程不应发生 |

## 一次发布的产物清单（完成标准）

- [ ] npm 上版本号 = package.json 版本号
- [ ] git 有 `chore: release 0.1.x` 提交
- [ ] 远端有 `v0.1.x` tag，与本地同步
- [ ] GitHub Release `v0.1.x` 已创建，含源码包 `pi-web-sky-v0.1.x.tar.gz`
- [ ] GitHub 远端 main 包含该提交，与本地同步

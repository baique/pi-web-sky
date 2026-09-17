# 插件与技能

> 改 /api/plugins / /api/skills / 技能开关 / 插件安装移除前阅读。

- `/api/plugins` uses pi's `SettingsManager` + `DefaultPackageManager` for global/project package install, remove, update, enable, and disable. Disabling writes empty `extensions/skills/prompts/themes` arrays for that package entry.
- `/api/skills` uses `DefaultResourceLoader` so settings paths, package skills, and project `.agents/skills` are listed the same way the runtime sees them.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent pi`; project installs run with the selected cwd.
- `/api/skills/check` 逐技能返回可更新状态（`lib/skill-updates.ts` 拉取 skills.sh / GitHub 侧最新 tree hash 比对），`/api/skills/update` 走 `runNpx` 执行更新；两者都受允许根校验，且只处理带安装信息（`lib/skill-lock.ts` 标注）的技能——手动放进目录的技能不认领。

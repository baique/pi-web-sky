import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";

/** pi 的合法思考等级；UI 的 "auto" 只是占位，不在此列（写库会被 SDK 兜底成 off）。 */
const VALID_THINKING_LEVELS = new Set<ThinkingLevel>([
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
]);

function isThinkingLevel(value: string): value is ThinkingLevel {
  return VALID_THINKING_LEVELS.has(value as ThinkingLevel);
}

export interface ExplicitStartupPreferences {
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
}

export interface EffectiveStartupPreferences {
  model?: { provider: string; modelId: string };
  thinkingLevel: ThinkingLevel;
  supportsThinking: boolean;
}

/**
 * Persist explicit browser selections without re-running AgentSession setters.
 *
 * The session constructor already records the effective model and thinking
 * level. Calling setModel()/setThinkingLevel() again would append duplicate
 * session entries and emit duplicate extension events.
 */
export async function persistExplicitStartupPreferences(
  settingsManager: SettingsManager,
  explicit: ExplicitStartupPreferences,
  effective: EffectiveStartupPreferences,
): Promise<{ modelDefaultChanged: boolean }> {
  if (!explicit.model && !explicit.thinkingLevel) {
    return { modelDefaultChanged: false };
  }

  let modelDefaultChanged = false;

  if (
    explicit.model
    && effective.model
    && explicit.model.provider === effective.model.provider
    && explicit.model.modelId === effective.model.modelId
  ) {
    settingsManager.setDefaultModelAndProvider(
      effective.model.provider,
      effective.model.modelId,
    );
    modelDefaultChanged = true;
  }

  if (explicit.thinkingLevel && (effective.supportsThinking || effective.thinkingLevel !== "off")) {
    // auto 是 pi-web 的占位值，pi 不认（SDK 收到会把新会话钳成 off）。
    // 这里删除字段 = 回到 pi 默认（不写 defaultThinkingLevel），而不是固化 off。
    // JSON.stringify 会丢弃 undefined 字段值，SDK 落盘时即删除该键。
    const level = isThinkingLevel(effective.thinkingLevel) ? effective.thinkingLevel : undefined;
    settingsManager.setDefaultThinkingLevel(level as ThinkingLevel);
  }

  await settingsManager.flush();
  return { modelDefaultChanged };
}

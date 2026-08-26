import type { AgentPhase } from "@/hooks/useAgentSession";

/** 播报槽用阶段文案（从 ChatWindow 抽出，供 ChatInput 使用，避免循环依赖） */
export function phaseLabel(phase: AgentPhase, t: (key: string, params?: Record<string, string | number>) => string): string | null {
  if (phase?.kind === "running_tools") {
    const latest = phase.tools[phase.tools.length - 1];
    if (latest?.progress) {
      return `${t("chat.runningNamedTool", { name: latest.name })} ${latest.progress}`;
    }
    const names = phase.tools.map((t) => t.name);
    if (names.length === 0) return t("chat.runningTool");
    if (names.length === 1) return t("chat.runningNamedTool", { name: names[0] });
    if (names.length <= 3) return t("chat.runningTools", { names: names.join(", ") });
    return t("chat.runningToolsMore", { names: names.slice(0, 2).join(", "), count: names.length - 2 });
  }
  if (phase?.kind === "waiting_model") return t("chat.waitingModel");
  if (phase?.kind === "running_command") return t("chat.runningCommand");
  return null;
}

/** 状态行的思考球：等待模型 = breathing，执行工具/命令 = working */
export function orbModeForPhase(phase: AgentPhase): "breathing" | "working" {
  return phase?.kind === "waiting_model" ? "breathing" : "working";
}

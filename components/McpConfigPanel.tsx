"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import type { McpResponse, McpScope, McpServerInfo } from "@/lib/api-types";

// ============================================================================
// McpConfigPanel — MCP server manager as a standalone anchored popover.
//
// Ported from upstream #470 (MCP management in the plugins panel), but mounted
// as an independent panel next to the topbar Terminal button instead of inside
// the plugins modal, since this repo's PluginsConfig diverged from upstream.
// The API layer (/api/mcp) is ported as-is.
// ============================================================================

function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function ScopeTag({ scope }: { scope: McpScope }) {
  return (
    <span
      style={{
        fontSize: 10,
        padding: "1px 5px",
        borderRadius: 3,
        flexShrink: 0,
        background: scope === "project" ? "rgba(99,102,241,0.12)" : "rgba(120,120,120,0.12)",
        color: scope === "project" ? "rgba(99,102,241,0.85)" : "var(--text-meta)",
      }}
    >
      {scope}
    </span>
  );
}

function buttonStyle(disabled?: boolean, danger?: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    background: danger ? "rgba(239,68,68,0.08)" : "none",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: danger ? "#ef4444" : "var(--text-muted)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 12,
    opacity: disabled ? 0.5 : 1,
  };
}

function Toggle({
  enabled,
  loading,
  onToggle,
  label,
}: {
  enabled: boolean;
  loading: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={loading}
      title={label}
      aria-label={label}
      aria-pressed={enabled}
      style={{
        flexShrink: 0,
        width: 40,
        height: 22,
        borderRadius: 11,
        border: "none",
        padding: 0,
        cursor: loading ? "wait" : "pointer",
        background: enabled ? "var(--accent)" : "var(--border)",
        position: "relative",
        transition: "background 0.18s",
        outline: "none",
        opacity: loading ? 0.65 : 1,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: enabled ? 21 : 3,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "var(--bg)",
          boxShadow: "0 1px 4px rgba(0,0,0,0.22)",
          transition: "left 0.18s cubic-bezier(.4,0,.2,1)",
        }}
      />
    </button>
  );
}

function SegmentedScope({
  value,
  projectResourcesLoaded,
  onChange,
}: {
  value: McpScope;
  projectResourcesLoaded: boolean;
  onChange: (scope: McpScope) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        display: "inline-flex",
        border: "1px solid var(--border)",
        borderRadius: 7,
        overflow: "hidden",
        height: 30,
      }}
    >
      {(["global", "project"] as McpScope[]).map((scope) => {
        const active = value === scope;
        const disabled = scope === "project" && !projectResourcesLoaded;
        return (
          <button
            key={scope}
            onClick={() => {
              if (!disabled) onChange(scope);
            }}
            disabled={disabled}
            title={disabled ? t("trust.projectScopeUnavailable") : undefined}
            style={{
              width: 76,
              border: "none",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.4 : 1,
              fontSize: 11,
              background: active ? "var(--bg-selected)" : "none",
              color: active ? "var(--text)" : "var(--text-muted)",
            }}
          >
            {scope}
          </button>
        );
      })}
    </div>
  );
}

function McpServerDetail({
  server,
  cwd,
  busy,
  actionError,
  actionMessage,
  onToggle,
  onRemove,
  onMove,
  onTest,
  onEdit,
}: {
  server: McpServerInfo;
  cwd: string;
  busy: boolean;
  actionError: string | null;
  actionMessage: string | null;
  onToggle: () => void;
  onRemove: () => void;
  onMove: () => void;
  onTest: () => void;
  onEdit: () => void;
}) {
  const { t } = useI18n();
  const enabled = !server.disabled;
  const otherScope = server.scope === "project" ? "global" : "project";
  const target =
    server.kind === "url" ? server.url : server.kind === "socket" ? server.socket : server.command;
  const row: React.CSSProperties = { color: "var(--text-meta)" };
  const val: React.CSSProperties = {
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono)",
    overflowWrap: "anywhere",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 680 }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
          minWidth: 0,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 180, flex: 1 }}>
          <Toggle
            enabled={enabled}
            loading={busy}
            onToggle={onToggle}
            label={enabled ? t("mcp.disable") : t("mcp.enable")}
          />
          <ScopeTag scope={server.scope} />
          {server.disabled && (
            <span
              style={{
                fontSize: 10,
                padding: "1px 5px",
                borderRadius: 3,
                background: "rgba(120,120,120,0.12)",
                color: "var(--text-meta)",
              }}
            >
              {t("mcp.disabledBadge")}
            </span>
          )}
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {server.name}
          </span>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={onTest} disabled={busy} style={buttonStyle(busy)}>
            {busy ? t("mcp.testing") : t("mcp.test")}
          </button>
          <button onClick={onEdit} disabled={busy} style={buttonStyle(busy)}>
            {t("mcp.edit")}
          </button>
          <button onClick={onMove} disabled={busy} style={buttonStyle(busy)}>
            {otherScope === "project" ? t("mcp.moveToProject") : t("mcp.moveToGlobal")}
          </button>
          <button onClick={onRemove} disabled={busy} style={buttonStyle(busy, true)}>
            {t("mcp.delete")}
          </button>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(96px, 130px) minmax(0, 1fr)",
          gap: "9px 14px",
          fontSize: 12,
          lineHeight: 1.45,
        }}
      >
        <div style={row}>{t("mcp.fieldType")}</div>
        <div style={val}>{server.kind}</div>
        <div style={row}>{server.kind === "url" ? t("mcp.kindUrl") : server.kind === "socket" ? t("mcp.kindSocket") : t("mcp.kindCommand")}</div>
        <div style={val}>{target ?? "—"}</div>
        {server.kind === "command" && (
          <>
            <div style={row}>{t("mcp.fieldArgs")}</div>
            <div style={val}>{server.args.length ? server.args.join(" ") : "—"}</div>
          </>
        )}
        <div style={row}>{t("mcp.fieldEnv")}</div>
        <div style={val}>{server.envKeys.length ? server.envKeys.join(", ") : "—"}</div>
        <div style={row}>{t("mcp.fieldOptions")}</div>
        <div style={val}>
          {Object.keys(server.options).length ? JSON.stringify(server.options) : "—"}
        </div>
        <div style={row}>{t("mcp.fieldSource")}</div>
        <div style={{ color: "var(--text-meta)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
          {shortenPath(server.source)}
        </div>
        <div style={row}>{t("mcp.fieldCwd")}</div>
        <div style={{ color: "var(--text-meta)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>
          {shortenPath(cwd)}
        </div>
      </div>

      {actionMessage && (
        <div style={{ fontSize: 12, color: "#16a34a", whiteSpace: "pre-wrap" }}>{actionMessage}</div>
      )}
      {actionError && (
        <div style={{ fontSize: 12, color: "#ef4444", whiteSpace: "pre-wrap" }}>{actionError}</div>
      )}
    </div>
  );
}

function AddMcpServer({
  cwd,
  scope,
  projectResourcesLoaded,
  busy,
  actionError,
  initial,
  onScopeChange,
  onSave,
  onFetchDef,
  onCancel,
}: {
  cwd: string;
  scope: McpScope;
  projectResourcesLoaded: boolean;
  busy: boolean;
  actionError: string | null;
  initial?: McpServerInfo | null;
  onScopeChange: (scope: McpScope) => void;
  onSave: (name: string, def: Record<string, unknown>) => void;
  onFetchDef: (name: string, serverScope: McpScope) => Promise<Record<string, unknown> | null>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const isEdit = !!initial;
  const [name, setName] = useState(isEdit && initial ? initial.name : "");
  const [spec, setSpec] = useState(() => {
    if (!initial) return "";
    if (initial.kind === "command") return [initial.command, ...initial.args].join(" ");
    return initial.url ?? initial.socket ?? "";
  });
  const [argsText, setArgsText] = useState("");
  const [mode, setMode] = useState<"basic" | "json">("basic");
  const [jsonText, setJsonText] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [loadingJson, setLoadingJson] = useState(false);

  const inputStyle: React.CSSProperties = {
    width: "100%",
    height: 36,
    padding: "0 11px",
    border: "1px solid var(--border)",
    borderRadius: 6,
    background: "var(--bg-panel)",
    color: "var(--text)",
    fontFamily: "var(--font-mono)",
    fontSize: 13,
    outline: "none",
  };
  const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--text-muted)" };
  const isUrl = /^https?:\/\//.test(spec.trim());

  const buildBasicDef = (): Record<string, unknown> => {
    const specTrim = spec.trim();
    if (/^https?:\/\//.test(specTrim)) return { url: specTrim };
    const tokens = specTrim.split(/\s+/);
    const command = tokens[0] ?? "";
    const extra = argsText.trim() ? argsText.trim().split(/\s+/) : [];
    return { command, args: [...tokens.slice(1), ...extra] };
  };

  const switchToJson = async (): Promise<void> => {
    setJsonError(null);
    if (jsonText !== null) {
      setMode("json");
      return;
    }
    if (isEdit && initial) {
      setMode("json");
      setLoadingJson(true);
      try {
        const def = await onFetchDef(initial.name, initial.scope);
        setJsonText(JSON.stringify(def ?? buildBasicDef(), null, 2));
      } finally {
        setLoadingJson(false);
      }
    } else {
      setJsonText(JSON.stringify(buildBasicDef(), null, 2));
      setMode("json");
    }
  };

  const handleSave = (): void => {
    setJsonError(null);
    if (mode === "json") {
      const text = jsonText ?? "";
      if (!text.trim()) {
        setJsonError(t("mcp.jsonEmpty"));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        setJsonError(t("mcp.jsonParseError", { message: error instanceof Error ? error.message : String(error) }));
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setJsonError(t("mcp.jsonNotObject"));
        return;
      }
      const def = parsed as Record<string, unknown>;
      if (!def.command && !def.url && !def.socket) {
        setJsonError(t("mcp.jsonNeedsEntry"));
        return;
      }
      onSave(name, def);
      return;
    }
    onSave(name, buildBasicDef());
  };

  const canSave =
    name.trim() &&
    (mode === "json" ? (jsonText ?? "").trim().length > 0 : spec.trim().length > 0);

  const jsonEditorStyle: React.CSSProperties = {
    width: "100%",
    minHeight: 200,
    padding: "9px 11px",
    border: "1px solid var(--border)",
    borderRadius: 6,
    background: "var(--bg-panel)",
    color: "var(--text)",
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    lineHeight: 1.5,
    outline: "none",
    resize: "vertical",
    whiteSpace: "pre",
    overflow: "auto",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 660, minHeight: "100%" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
          {isEdit ? t("mcp.editTitle", { name: initial?.name ?? "" }) : t("mcp.addTitle")}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-meta)", fontFamily: "var(--font-mono)" }}>
          {scope === "project" ? `${shortenPath(cwd)}/.pi/mcp.json` : "~/.pi/agent/mcp.json"}
        </div>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        {(["basic", "json"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => (m === "json" ? void switchToJson() : setMode("basic"))}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              cursor: "pointer",
              fontSize: 12,
              background: mode === m ? "var(--accent)" : "none",
              color: mode === m ? "white" : "var(--text-muted)",
            }}
          >
            {m === "basic" ? t("mcp.modeBasic") : t("mcp.modeJson")}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        <label style={labelStyle}>{t("mcp.nameLabel")}</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("mcp.namePlaceholder")}
          style={inputStyle}
        />
      </div>

      {mode === "json" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          <label style={labelStyle}>{t("mcp.jsonLabel")}</label>
          {loadingJson ? (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("mcp.loadingDef")}</div>
          ) : (
            <textarea
              value={jsonText ?? ""}
              onChange={(e) => setJsonText(e.target.value)}
              spellCheck={false}
              placeholder={
                '{\n  "command": "npx",\n  "args": ["-y", "@modelcontextprotocol/server-github"],\n  "env": {}\n}'
              }
              style={jsonEditorStyle}
            />
          )}
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <label style={labelStyle}>{t("mcp.specLabel")}</label>
            <input
              value={spec}
              onChange={(e) => setSpec(e.target.value)}
              placeholder={t("mcp.specPlaceholder")}
              style={inputStyle}
            />
          </div>

          {!isUrl && (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <label style={labelStyle}>{t("mcp.argsLabel")}</label>
              <input value={argsText} onChange={(e) => setArgsText(e.target.value)} style={inputStyle} />
            </div>
          )}
        </>
      )}

      {jsonError && (
        <div style={{ fontSize: 12, color: "#ef4444", whiteSpace: "pre-wrap" }}>{jsonError}</div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <SegmentedScope
          value={scope}
          projectResourcesLoaded={projectResourcesLoaded}
          onChange={onScopeChange}
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={busy || !canSave}
          style={{
            ...buttonStyle(busy || !canSave),
            background: "var(--accent)",
            color: "white",
            borderColor: "var(--accent)",
          }}
        >
          {busy ? t("mcp.saving") : isEdit ? t("mcp.saveEdit") : t("mcp.save")}
        </button>
        <button type="button" onClick={onCancel} style={buttonStyle(false)}>
          {t("mcp.cancel")}
        </button>
      </div>

      {actionError && (
        <div style={{ fontSize: 12, color: "#ef4444", whiteSpace: "pre-wrap" }}>{actionError}</div>
      )}
    </div>
  );
}

export function McpConfigPanel({
  anchorRect,
  cwd,
  hidden,
  onClose,
}: {
  /** Trigger button rect — anchors the panel below the topbar MCP button. */
  anchorRect?: { top: number; left: number; right: number; bottom: number } | null;
  /** cwd for project vs global scope decisions. */
  cwd: string | null;
  hidden: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<McpResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [scope, setScope] = useState<McpScope>("global");
  const [editTarget, setEditTarget] = useState<McpServerInfo | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const projectResourcesLoaded = data?.projectResourcesLoaded ?? true;

  const selectedServer = useMemo(
    () => data?.servers.find((s) => s.name === selected) ?? null,
    [data, selected],
  );
  const groupedServers = useMemo(() => {
    return (["project", "global"] as McpScope[])
      .map((scopeKey) => ({
        scope: scopeKey,
        servers: (data?.servers ?? []).filter((s) => s.scope === scopeKey),
      }))
      .filter((group) => group.servers.length > 0);
  }, [data]);

  const effectiveCwd = cwd ?? "";

  const load = useCallback(async () => {
    if (!effectiveCwd) return;
    setLoading(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/mcp?cwd=${encodeURIComponent(effectiveCwd)}`);
      const next = (await res.json()) as McpResponse & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
      setSelected((current) =>
        current && next.servers.some((s) => s.name === current)
          ? current
          : next.servers[0]?.name ?? null,
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [effectiveCwd]);

  useEffect(() => {
    if (!hidden) void load();
  }, [hidden, load]);

  // Close on outside click or Escape (same as the other topbar panels).
  useEffect(() => {
    if (hidden) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      // The trigger button manages the toggle — exclude it so a click there
      // toggles instead of (close + reopen) racing.
      const el = target as HTMLElement;
      if (el.closest?.("#mcp-topbar-btn")) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [hidden, onClose]);

  const runAction = useCallback(
    async (action: string, payload: Record<string, unknown>): Promise<McpResponse | null> => {
      if (!effectiveCwd) return null;
      setBusyKey(`mcp:${action}`);
      setActionError(null);
      setActionMessage(null);
      try {
        const res = await fetch("/api/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: effectiveCwd, action, ...payload }),
        });
        const next = (await res.json()) as McpResponse & { error?: string };
        if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
        setData(next);
        return next;
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setBusyKey(null);
      }
    },
    [effectiveCwd],
  );

  const toggleServer = useCallback(
    async (server: McpServerInfo) => {
      const next = await runAction(server.disabled ? "enable" : "disable", {
        name: server.name,
        scope: server.scope,
      });
      if (next) {
        setActionMessage(
          server.disabled
            ? t("mcp.msgEnabled", { name: server.name })
            : t("mcp.msgDisabled", { name: server.name }),
        );
      }
    },
    [runAction, t],
  );

  const removeServer = useCallback(
    async (server: McpServerInfo) => {
      const next = await runAction("remove", { name: server.name, scope: server.scope });
      if (next) {
        setSelected(next.servers[0]?.name ?? null);
        setActionMessage(t("mcp.msgDeleted", { name: server.name }));
        if (next.servers.length === 0) setAddMode(true);
      }
    },
    [runAction, t],
  );

  const moveServer = useCallback(
    async (server: McpServerInfo) => {
      const to = server.scope === "project" ? "global" : "project";
      const next = await runAction("move", {
        name: server.name,
        fromScope: server.scope,
        toScope: to,
      });
      if (next) setActionMessage(t("mcp.msgMoved", { name: server.name, scope: to }));
    },
    [runAction, t],
  );

  const saveServer = useCallback(
    async (name: string, def: Record<string, unknown>) => {
      const isEdit = !!editTarget;
      const action = isEdit ? "update" : "add";
      const nameFinal = isEdit && editTarget ? editTarget.name : name.trim();
      const next = await runAction(action, { name: nameFinal, scope, def });
      if (next) {
        setSelected(nameFinal);
        setAddMode(false);
        setEditTarget(null);
        setActionMessage(
          isEdit
            ? t("mcp.msgUpdated", { name: nameFinal })
            : t("mcp.msgAdded", { name: nameFinal }),
        );
      }
    },
    [scope, editTarget, runAction, t],
  );

  const fetchServerDef = useCallback(
    async (name: string, serverScope: McpScope): Promise<Record<string, unknown> | null> => {
      if (!effectiveCwd) return null;
      try {
        const res = await fetch("/api/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: effectiveCwd, action: "get", name, scope: serverScope }),
        });
        const json = (await res.json()) as { def?: Record<string, unknown>; error?: string };
        if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
        return json.def ?? null;
      } catch {
        return null;
      }
    },
    [effectiveCwd],
  );

  const testServer = useCallback(
    async (server: McpServerInfo) => {
      setTesting(server.name);
      setActionError(null);
      setActionMessage(null);
      try {
        const res = await fetch("/api/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: effectiveCwd, action: "test", name: server.name, scope: server.scope }),
        });
        const json = (await res.json()) as { ok?: boolean; message?: string; error?: string };
        if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
        setActionMessage(t("mcp.msgTestResult", { name: server.name, result: json.message ?? "" }));
      } catch (err) {
        setActionError(
          t("mcp.msgTestError", {
            name: server.name,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      } finally {
        setTesting(null);
      }
    },
    [effectiveCwd, t],
  );

  const mcpBusy = busyKey !== null;

  // 顶部弹窗通用定位：宽度自适应（窄屏/小窗自动收窄），双向夹取到视口内——
  // 锚点太靠右导致越界时往对向（左）挪，保证面板始终完整展示不被遮挡。
  const MARGIN = 24;
  const vw = typeof window !== "undefined" ? document.documentElement.clientWidth : 0;
  const panelWidth = Math.min(780, vw - MARGIN * 2);
  const panelLeft = anchorRect
    ? Math.max(MARGIN, Math.min(anchorRect.left, vw - panelWidth - MARGIN))
    : vw - panelWidth - MARGIN;

  const panel: React.ReactNode = (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("mcp.sectionTitle")}
      style={{
        position: "fixed",
        zIndex: 130,
        top: (anchorRect?.bottom ?? anchorRect?.top ?? 46),
        left: panelLeft,
        width: panelWidth,
        maxHeight: "min(72vh, 600px)",
        display: "flex",
        flexDirection: "column",
        // L-panel 玻璃：MCP 配置面板（见 --panel-glass / --glass-blur-panel）
        background: "var(--panel-glass)",
        backdropFilter: "blur(var(--glass-blur-panel)) saturate(var(--glass-saturate))",
        WebkitBackdropFilter: "blur(var(--glass-blur-panel)) saturate(var(--glass-saturate))",
        transform: "translateZ(0)",
        border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
        borderTop: "none",
        borderRadius: "0 0 12px 12px",
        boxShadow: "0 1px 2px rgba(15,23,42,0.04), 0 4px 16px -8px rgba(15,23,42,0.10)",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "10px 16px",
          borderBottom: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
          flexShrink: 0,
          // 透明 header：让面板玻璃背景透出
          background: "transparent",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
          </svg>
          {t("mcp.sectionTitle")}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button onClick={() => void load()} disabled={loading || mcpBusy} style={buttonStyle(loading || mcpBusy)}>
            {t("i18n.refresh")}
          </button>
          <button onClick={onClose} style={buttonStyle(false)}>
            {t("i18n.close")}
          </button>
        </div>
      </div>

      {/* Body: list + detail */}
      <div style={{ display: "flex", flex: "1 1 auto", minHeight: 0 }}>
        {/* Left: server list */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            width: 168,
            flexShrink: 0,
            borderRight: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
            background: "transparent",
          }}
        >
          <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", paddingTop: 8 }}>
            <div
              style={{
                padding: "4px 8px 3px",
                fontSize: 10,
                fontWeight: 600,
                color: "var(--text-meta)",
                textTransform: "uppercase",
              }}
            >
              {t("mcp.sectionTitle")}
            </div>
            {loading ? (
              <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" }}>
                Loading...
              </div>
            ) : !data && actionError ? (
              <div style={{ padding: "10px 8px", fontSize: 11, color: "#ef4444" }}>{actionError}</div>
            ) : (data?.servers.length ?? 0) === 0 ? (
              <div style={{ padding: "10px 8px", fontSize: 11, color: "var(--text-meta)" }}>
                {t("mcp.emptyList")}
              </div>
            ) : (
              groupedServers.map((group) => (
                <div key={group.scope} style={{ marginBottom: 6 }}>
                  <div
                    style={{
                      padding: "4px 8px 3px",
                      fontSize: 10,
                      fontWeight: 600,
                      color: "var(--text-meta)",
                      textTransform: "uppercase",
                    }}
                  >
                    {group.scope}
                  </div>
                  {group.servers.map((server) => {
                    const isSelected = !addMode && selected === server.name;
                    return (
                      <div
                        key={server.name}
                        onClick={() => {
                          setSelected(server.name);
                          setAddMode(false);
                          setEditTarget(null);
                          setActionError(null);
                          setActionMessage(null);
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 7,
                          padding: "8px 8px",
                          borderRadius: 5,
                          cursor: "pointer",
                          background: isSelected ? "var(--bg-selected)" : "none",
                        }}
                        onMouseEnter={(e) => {
                          if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)";
                        }}
                        onMouseLeave={(e) => {
                          if (!isSelected) e.currentTarget.style.background = "none";
                        }}
                      >
                        <span
                          style={{
                            flexShrink: 0,
                            width: 7,
                            height: 7,
                            borderRadius: "50%",
                            background: server.disabled ? "var(--text-meta)" : "var(--accent)",
                          }}
                        />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: isSelected ? 600 : 400,
                              color: "var(--text)",
                              fontFamily: "var(--font-mono)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {server.name}
                          </div>
                          <div
                            style={{
                              fontSize: 10,
                              color: "var(--text-meta)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              marginTop: 2,
                            }}
                          >
                            {server.kind} · {server.disabled ? t("mcp.itemDisabled") : t("mcp.itemEnabled")}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              padding: "8px 6px",
              borderTop: "1px solid var(--border)",
              flexShrink: 0,
            }}
          >
            <button
              type="button"
              onClick={() => {
                setAddMode(true);
                setEditTarget(null);
                setScope("global");
                setActionError(null);
                setActionMessage(null);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "7px 8px",
                borderRadius: 5,
                border: "none",
                width: "100%",
                cursor: "pointer",
                background: addMode ? "var(--bg-selected)" : "none",
                color: addMode ? "var(--accent)" : "var(--text-meta)",
                fontSize: 12,
              }}
              onMouseEnter={(e) => {
                if (!addMode) e.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(e) => {
                if (!addMode) e.currentTarget.style.background = "none";
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              {t("mcp.addButton")}
            </button>
          </div>
        </div>

        {/* Right: detail / add form */}
        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          {addMode ? (
            <AddMcpServer
              cwd={effectiveCwd}
              scope={scope}
              projectResourcesLoaded={projectResourcesLoaded}
              busy={mcpBusy}
              actionError={actionError}
              initial={editTarget}
              onScopeChange={setScope}
              onSave={(name, def) => void saveServer(name, def)}
              onFetchDef={fetchServerDef}
              onCancel={() => {
                setAddMode(false);
                setEditTarget(null);
              }}
            />
          ) : selectedServer ? (
            <McpServerDetail
              key={selectedServer.name}
              server={selectedServer}
              cwd={effectiveCwd}
              busy={mcpBusy || testing === selectedServer.name}
              actionError={actionError}
              actionMessage={actionMessage}
              onToggle={() => void toggleServer(selectedServer)}
              onRemove={() => void removeServer(selectedServer)}
              onMove={() => void moveServer(selectedServer)}
              onTest={() => void testServer(selectedServer)}
              onEdit={() => {
                setEditTarget(selectedServer);
                setAddMode(true);
                setActionError(null);
                setActionMessage(null);
              }}
            />
          ) : (
            <div
              style={{
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--text-meta)",
                fontSize: 13,
              }}
            >
              {t("mcp.emptyDetail")}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  if (hidden) return null;
  return createPortal(panel, document.body);
}
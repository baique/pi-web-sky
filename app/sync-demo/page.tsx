"use client";

// ============================================================================
// 试点：tldraw sync 前端 demo 页面（独立于主看板，验证 CRDT 实时同步）
//   - useSync 连接 scripts/sync-demo-server.mjs（端口 30144）
//   - 验证：后台 room.updateStore 注入 shape → 本页画布实时出现（CRDT 合并）
//   - 验证：自定义 shape（session-card/task-card/sticky-note）两端注册
// 访问：http://127.0.0.1:30143/sync-demo（需先启动 sync-demo-server）
// ============================================================================
import { useEffect, useMemo, useRef, useState } from "react";
import "tldraw/tldraw.css";
import { Tldraw, defaultShapeUtils } from "tldraw";
import { useSync } from "@tldraw/sync";
import { inlineBase64AssetStore } from "@tldraw/editor";
import { SessionCardUtil } from "@/components/canvas/SessionCardShape";
import { StickyNoteUtil } from "@/components/canvas/StickyNoteShape";
import { TaskCardUtil } from "@/components/canvas/TaskCardShape";

// roomId 从 URL 参数读（?room=<boardId>），默认 demo
const roomId =
  typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("room") ?? "demo"
    : "demo";
const WS = `ws://127.0.0.1:30144/connect/${roomId}`;

export default function SyncDemoPage() {
  const store = useSync({
    uri: WS,
    assets: inlineBase64AssetStore,
    shapeUtils: useMemo(
      () => [...defaultShapeUtils, SessionCardUtil, StickyNoteUtil, TaskCardUtil],
      [],
    ),
  });

  const [status, setStatus] = useState<string>(store.status);
  const [shapeCount, setShapeCount] = useState(0);
  const [byType, setByType] = useState<Record<string, number>>({});
  const [lastEvent, setLastEvent] = useState<string>("-");

  useEffect(() => {
    setStatus(store.status);
    // 调试：暴露 store 到 window，便于 playwright evaluate 检查 CRDT 同步
    if (typeof window !== "undefined") {
      (window as unknown as { __demoStore: unknown }).__demoStore = store.store;
    }
  }, [store]);

  // 统计：不再用 interval 定时 setState（避免重渲染干扰 useSync 稳定性验证），
  // 改为手动 evaluate 读取（见验证步骤）。
  const storeRef = useRef<ReturnType<typeof useSync>["store"]>(null);
  storeRef.current = store.status === "synced-remote" ? store.store : storeRef.current;

  const inject = (shape: string) => {
    void fetch(`http://127.0.0.1:30144/inject/demo?shape=${shape}`, { method: "POST" })
      .then(() => setLastEvent(`POST /inject ${shape} @ ${new Date().toLocaleTimeString()}`))
      .catch((e) => setLastEvent(`inject failed: ${String(e)}`));
  };
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", fontFamily: "system-ui" }}>
      <div style={{ display: "flex", gap: 16, alignItems: "center", padding: "8px 16px", borderBottom: "1px solid #ddd", fontSize: 13 }}>
        <span><b>tldraw sync demo</b></span>
        <span style={{ color: store.status === "synced-remote" ? "#16a34a" : "#d97706" }}>
          status: {status}
        </span>
        <span>shapes: <b>{shapeCount}</b></span>
        <span style={{ color: "#666" }}>{Object.entries(byType).map(([t, n]) => `${t}:${n}`).join("  ")}</span>
        <span style={{ color: "#888" }}>{lastEvent}</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button onClick={() => inject("geo")} style={btn}>注入 geo</button>
          <button onClick={() => inject("session-card")} style={btn}>注入 会话卡</button>
          <button onClick={() => inject("task-card")} style={btn}>注入 任务卡</button>
        </span>
      </div>
      {store.status === "synced-remote" && store.store ? (
        <div style={{ flex: 1, minHeight: 0 }}>
          <Tldraw
            store={store.store}
            shapeUtils={[SessionCardUtil, StickyNoteUtil, TaskCardUtil]}
            onMount={(editor) => {
              // 调试：暴露 editor，便于模拟真实用户编辑（createShape）
              (window as unknown as { __demoEditor: unknown }).__demoEditor = editor;
            }}
          />
        </div>
      ) : (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#888", fontSize: 14 }}>
          {store.status === "loading" ? "连接房间中…" : `连接失败：${store.error ?? "unknown"}`}
        </div>
      )}
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: "4px 10px",
  borderRadius: 6,
  border: "1px solid #bbb",
  background: "#f5f5f5",
  cursor: "pointer",
  fontSize: 12,
};

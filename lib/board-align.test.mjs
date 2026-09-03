import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { computeSnap, computeResizeSnap } = await jiti.import("./board-align.ts");

/**
 * 构造节点：顶层 width/height = resize 后的新值（RF dimensions change 写顶层），
 * style.width/height = 旧值（resize 不动 style）——回归「对齐到改变前尺寸」bug。
 */
function makeNode(id, x, y, w, h, styleW, styleH) {
  return {
    id,
    position: { x, y },
    width: w,
    height: h,
    style: { width: styleW, height: styleH },
    data: { w, h },
    type: "task-card",
  };
}

test("bounds 尺寸优先读顶层 width/height（resize 后 style 旧值不干扰对齐）", () => {
  // A 卡：resize 后新尺寸 500x400 在顶层，但 style 还是旧 380x270
  const a = makeNode("a", 0, 0, 500, 400, 380, 270);
  const b = makeNode("b", 500, 0, 300, 200, 300, 200); // b 左缘正好在 a 新右缘 500

  // 拖动 b：b.right=800，与 a.right=500 不对齐；b.left=500 应与 a.right=500 对齐
  const snap = computeSnap("b", { x: 500, y: 0 }, [a, b]);
  assert.ok(snap.lines.length > 0, "应命中参考线");
  // 命中的应是 b.left == a.right(新 500)，而非旧 style 右缘 380
  const hit = snap.lines.find((l) => l.x1 === 500);
  assert.ok(hit, `应有 x=500 参考线（a 新右缘），实际 lines=${JSON.stringify(snap.lines)}`);
});

test("computeResizeSnap 对齐其他节点 resize 后的新尺寸", () => {
  // 参考节点 A 已 resize：顶层 600 宽，style 旧 380
  const a = makeNode("a", 0, 0, 600, 300, 380, 270);
  // 正在 resize 的 B：左缘 0，当前宽 595 → 右缘 595 距 A 右缘 600 仅 5px（<8阈值）应吸附
  const b = makeNode("b", 0, 400, 300, 200, 300, 200);
  const res = computeResizeSnap("b", { x: 0, y: 400 }, 595, 200, [a, b]);
  assert.equal(res.snapW, 600, `右缘应吸附到 A 的新右缘 600，实际 snapW=${res.snapW}`);
});

test("style 字符串尺寸（380px）也能解析", () => {
  const a = {
    id: "a", position: { x: 0, y: 0 },
    width: 380, height: 270,
    style: { width: "380px", height: "270px" },
    data: {},
  };
  const b = makeNode("b", 380, 0, 300, 200, 300, 200);
  const snap = computeSnap("b", { x: 380, y: 0 }, [a, b]);
  assert.ok(snap.lines.some((l) => l.x1 === 380), "应命中 a 右缘 380");
});

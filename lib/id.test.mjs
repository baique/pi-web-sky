import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { newId } = await jiti.import("./id.ts");

// 服务端 /api/agent/new 的会话 id 校验（SESSION_ID_RE）：兜底 id 必须也能当会话 id 用
const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

const realCrypto = globalThis.crypto;

test.afterEach(() => {
  Object.defineProperty(globalThis, "crypto", { value: realCrypto, configurable: true, writable: true });
});

test("prefers crypto.randomUUID when the secure-context API exists", () => {
  Object.defineProperty(globalThis, "crypto", { value: { randomUUID: () => "0b6f2f2e-1111-2222-3333-444455556666" }, configurable: true, writable: true });
  assert.equal(newId(), "0b6f2f2e-1111-2222-3333-444455556666");
});

test("falls back on insecure origins where randomUUID is missing", () => {
  // http://<LAN-IP>:30143 → crypto 在、randomUUID 不在（裸调会 TypeError）
  Object.defineProperty(globalThis, "crypto", { value: { getRandomValues: (a) => a }, configurable: true, writable: true });
  const id = newId();
  assert.match(id, SESSION_ID_RE, `fallback id must be a valid session id, got ${id}`);
});

test("falls back when crypto itself is unavailable", () => {
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
  assert.match(newId(), SESSION_ID_RE);
});

test("fallback ids stay unique across rapid calls", () => {
  Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true, writable: true });
  const ids = new Set(Array.from({ length: 200 }, () => newId()));
  assert.equal(ids.size, 200);
});

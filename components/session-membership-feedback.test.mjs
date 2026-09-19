// 归属失败提示的真行为测试。
//
// 为什么要有这个文件：SessionSidebar / BoardSection 的失败处理原先只有「源码里有
// await res.text()」这类字符串断言——字符串在、行为不一定对（body 已消费时 text()
// 会抛、空 body 会得到空串）。仓库无 jsdom/RTL 且不新增依赖，于是把这段逻辑抽成
// 纯函数 components/session-membership-feedback.ts，用 node 内置 Response 真跑。
import assert from "node:assert/strict";
import test from "node:test";

import { assignmentFailureDetail } from "./session-membership-feedback.ts";

test("服务端 error 文本非空 → 用它（409 + JSON error）", async () => {
    const res = new Response(JSON.stringify({ error: "会话的祖先属于其它任务" }), {
        status: 409,
        statusText: "Conflict",
    });
    assert.equal(await assignmentFailureDetail(res), '{"error":"会话的祖先属于其它任务"}');
});

test("纯文本 error → 原样返回（不解析、不加工）", async () => {
    const res = new Response("会话解析不出", { status: 404, statusText: "Not Found" });
    assert.equal(await assignmentFailureDetail(res), "会话解析不出");
});

test("body 已消费（text() 抛错）→ 回退 status + statusText，不抛", async () => {
    const res = new Response("x", { status: 409, statusText: "Conflict" });
    await res.text(); // 先消费掉：再读会抛「body used already」
    assert.equal(await assignmentFailureDetail(res), "409 Conflict");
});

test("body 流读到一半失败 → 回退 status + statusText，不抛", async () => {
    const broken = new ReadableStream({
        start(controller) {
            controller.error(new Error("socket 断了"));
        },
    });
    const res = new Response(broken, { status: 502, statusText: "Bad Gateway" });
    assert.equal(await assignmentFailureDetail(res), "502 Bad Gateway");
});

test("空 body → 不抛且给出可读文案（状态码）", async () => {
    assert.equal(
        await assignmentFailureDetail(new Response("", { status: 404, statusText: "Not Found" })),
        "404 Not Found",
    );
    // 只有空白字符也算「读不到内容」
    assert.equal(
        await assignmentFailureDetail(new Response("   \n", { status: 500, statusText: "Internal Server Error" })),
        "500 Internal Server Error",
    );
});

test("statusText 为空 → 只给可读的状态码（不出现尾随空格）", async () => {
    assert.equal(await assignmentFailureDetail(new Response("", { status: 409 })), "409");
});

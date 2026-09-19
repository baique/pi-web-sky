/** 归属 / 落卡请求失败时的「人话细节」：服务端 error 文本优先，取不到回退状态码。
 *
 *  为什么单独抽成一个模块：两个调用点（聊天区归属 SessionSidebar、看板落卡
 *  BoardSection）原先各自 `await res.text().catch(() => "")`，而「读不到 body 时
 *  怎么办」只被源码字符串断言盖着——仓库无 jsdom/RTL、也不新增依赖，抽成纯函数
 *  才能用 node:test 的内置 Response 把三种行为（有 error 文本 / body 已消费 /
 *  空 body）真跑一遍。
 *
 *  **任何情况下不抛**：调用点本身就在失败分支里，这里再抛一次会把真正的原因盖掉
 *  （日志只剩「读取失败响应出错」，用户还是不知道 409 是归属冲突）。
 */
export async function assignmentFailureDetail(res: Response): Promise<string> {
    try {
        const text = (await res.text()).trim();
        // 服务端的 error/detail 是给用户看的文案，非空就用它（json 片段也原样带上，
        // 便于排查；不尝试解析——正文格式不是这个函数的契约）。
        if (text) return text;
    } catch {
        // body 已被消费（bodyUsed）或读取失败 → 落到下面的状态码兜底
    }
    return `${res.status} ${res.statusText}`.trim();
}

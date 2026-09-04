/** 看板图片上传辅助：POST /api/board-assets → 返回图片 URL（服务端持久化） */

export async function uploadBoardImage(file: File): Promise<string | null> {
  const form = new FormData();
  form.append("file", file);
  try {
    const res = await fetch("/api/board-assets", { method: "POST", body: form });
    if (!res.ok) return null;
    const d = (await res.json()) as { url?: string };
    return d.url ?? null;
  } catch {
    return null;
  }
}

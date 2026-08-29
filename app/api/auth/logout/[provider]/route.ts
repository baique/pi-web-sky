import { invalidateModelsCache } from "@/lib/models-cache";
import { removeStoredCredentialIfType } from "@/lib/provider-credential-store";
import { createProviderServices } from "@/lib/provider-services";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  const cwd = new URL(req.url).searchParams.get("cwd") || undefined;
  // 与登录/列表接口同路径：裸 ModelRuntime.create() 跳过资源加载器，
  // 扩展注册的 provider（如 commandcode）会报 Unknown provider。
  const { services } = await createProviderServices(cwd);
  const modelRuntime = services.modelRuntime;
  if (!modelRuntime.getProvider(provider)?.auth.oauth) {
    return Response.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
  }
  const removal = await removeStoredCredentialIfType(provider, "oauth");
  if (removal.status === "type_mismatch") {
    return Response.json({ error: `${provider} is authenticated with an API key, not OAuth` }, { status: 409 });
  }
  invalidateModelsCache();
  return Response.json({ ok: true });
}

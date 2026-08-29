import { buildApiKeyProviderList } from "@/lib/provider-listing";
import { collectProviderListingInputs } from "@/lib/provider-listing-runtime";
import { createProviderServices, ProviderServicesError } from "@/lib/provider-services";

export const dynamic = "force-dynamic";

// Providers that accept an API key, including dual-auth ones such as anthropic —
// see lib/provider-listing.ts for why membership is capability-based (#309).
//
// Services are created through createAgentSessionServices (via
// createProviderServices) so extension-registered providers like commandcode
// appear here — a bare ModelRuntime.create() skips the resource loader and
// hides them (see lib/provider-services.ts).
export async function GET(req: Request) {
  const cwd = new URL(req.url).searchParams.get("cwd") || undefined;
  try {
    const { services } = await createProviderServices(cwd);
    const providers = buildApiKeyProviderList(
      await collectProviderListingInputs(services.modelRuntime),
    );
    return Response.json({ providers });
  } catch (error) {
    if (error instanceof ProviderServicesError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

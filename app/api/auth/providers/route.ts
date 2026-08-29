import { buildOAuthProviderList } from "@/lib/provider-listing";
import { collectProviderListingInputs } from "@/lib/provider-listing-runtime";
import { createProviderServices, ProviderServicesError } from "@/lib/provider-services";

export const dynamic = "force-dynamic";

// Providers that declare an OAuth login method, including anthropic
// (Claude Pro/Max) — see lib/provider-listing.ts (#309).
//
// Services are created through createAgentSessionServices (via
// createProviderServices) so extension-registered providers like commandcode
// appear here too (see lib/provider-services.ts).
export async function GET(req: Request) {
  const cwd = new URL(req.url).searchParams.get("cwd") || undefined;
  try {
    const { services } = await createProviderServices(cwd);
    const providers = buildOAuthProviderList(
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

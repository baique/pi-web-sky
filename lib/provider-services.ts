import { stat } from "fs/promises";
import { resolve } from "path";
import {
  createAgentSessionServices,
  getAgentDir,
  type AgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { projectTrustReloadOptions } from "@/lib/project-trust";

/** Error with an HTTP status, thrown by createProviderServices on bad input. */
export class ProviderServicesError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Create cwd-bound runtime services for the provider/auth listings.
 *
 * The Models panel must see exactly the providers the model selector sees.
 * Extension-registered providers (e.g. `pi-commandcode-provider`'s
 * "commandcode") are only loaded by `createAgentSessionServices()` — a bare
 * `ModelRuntime.create()` skips the resource loader, so extension providers
 * silently vanished from the auth lists while their models stayed visible.
 *
 * cwd is optional: when provided it must be an existing, allowed directory and
 * the services honor its project-trust state (same as the model list). When
 * omitted, services are created against the agent dir so globally-installed
 * extensions still load while project extensions stay out.
 */
export async function createProviderServices(
  cwd?: string,
): Promise<{ services: AgentSessionServices; cwd: string }> {
  const agentDir = getAgentDir();
  const resolvedCwd = cwd ? resolve(cwd) : agentDir;

  if (cwd) {
    try {
      const cwdStat = await stat(resolvedCwd);
      if (!cwdStat.isDirectory()) {
        throw new ProviderServicesError(400, `Directory does not exist: ${resolvedCwd}`);
      }
    } catch (error) {
      if (error instanceof ProviderServicesError) throw error;
      throw new ProviderServicesError(400, `Directory does not exist: ${resolvedCwd}`);
    }
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(resolvedCwd, allowedRoots)) {
      throw new ProviderServicesError(403, "Access denied");
    }
  }

  const trustOptions = projectTrustReloadOptions(resolvedCwd, agentDir);
  const services = await createAgentSessionServices({
    cwd: resolvedCwd,
    agentDir,
    ...(trustOptions ? { resourceLoaderReloadOptions: trustOptions } : {}),
  });
  return { services, cwd: resolvedCwd };
}

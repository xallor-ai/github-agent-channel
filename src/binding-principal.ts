import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import { z } from "zod";
import { installationEvidence } from "./binding-coverage.js";
import type { BindingRegistry } from "./binding-registry.js";
import { AccessDenied } from "./contracts.js";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ownerName = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const selectionSchema = z.strictObject({
  owner: ownerName,
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9_.-]{1,100}$/)
    .refine((name) => name !== "." && name !== ".."),
});
const pairedDevice = z.strictObject({
  deviceId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  githubUserId: id,
});
const repository = z.object({
  id,
  name: z.string(),
  owner: z.object({ login: ownerName }),
});
const tokenResponse = z.object({
  token: z.string().min(1),
  repository_selection: z.literal("selected"),
  permissions: z.strictObject({ metadata: z.literal("read") }),
  repositories: z.tuple([repository]),
});

export class AdministratorLost extends AccessDenied {
  constructor(
    readonly installationId: number,
    readonly repositoryId: number,
  ) {
    super("Paired user is not a verified repository administrator");
  }
}
/** Trusted integration point. The pairing service must authenticate the credential and check revocation. */
type AuthenticateDevice = (
  credential: string,
) => Promise<z.infer<typeof pairedDevice> | undefined>;

/** Internal only. Pairing, revocation and a registration HTTP endpoint are not implemented here. */
export class BindingPrincipalVerifier {
  readonly #app: App;
  readonly #Octokit: typeof Octokit;
  constructor(
    appId: string,
    privateKey: string,
    private readonly authenticate: AuthenticateDevice,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.#Octokit = Octokit.defaults({
      request: { fetch: fetchImpl, timeout: 30000, redirect: "error" },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    });
    this.#app = new App({ appId, privateKey, Octokit: this.#Octokit });
  }

  async verify(credential: string, input: unknown) {
    const target = selectionSchema.parse(input);
    const device = pairedDevice.safeParse(await this.authenticate(credential));
    if (!device.success) throw new AccessDenied("Device is not paired");
    return this.verifyPaired(device.data, target);
  }
  async verifyPaired(
    principal: z.infer<typeof pairedDevice>,
    input: unknown,
  ): Promise<{
    who: Parameters<BindingRegistry["apply"]>[0];
    installation: ReturnType<typeof installationEvidence>;
  }> {
    const { deviceId, githubUserId } = pairedDevice.parse(principal);
    const target = selectionSchema.parse(input);
    const app = this.#app.octokit;
    const { data: installed } = await app.request(
      "GET /repos/{owner}/{repo}/installation",
      target,
    );
    const installationId = id.safeParse(installed.id);
    if (installed.suspended_at !== null || !installationId.success)
      throw new AccessDenied("Installation is not active");

    const { data } = await app.request(
      "POST /app/installations/{installation_id}/access_tokens",
      {
        installation_id: installationId.data,
        repositories: [target.repo],
        permissions: { metadata: "read" },
      },
    );
    const scope = tokenResponse.safeParse(data);
    if (!scope.success)
      throw new AccessDenied("Single repository token scope was not confirmed");
    const [selected] = scope.data.repositories;
    const matches = (r: Pick<z.infer<typeof repository>, "name" | "owner">) =>
      r.name.toLowerCase() === target.repo.toLowerCase() &&
      r.owner.login.toLowerCase() === target.owner.toLowerCase();
    if (!matches(selected))
      throw new AccessDenied("Repository selection changed");
    const client = new this.#Octokit({ auth: scope.data.token });
    const { data: user } = await client.request("GET /user/{account_id}", {
      account_id: githubUserId,
    });
    if (user.id !== githubUserId || !ownerName.safeParse(user.login).success)
      throw new AccessDenied("Paired GitHub user identity changed");
    const { data: access } = await client.request(
      "GET /repos/{owner}/{repo}/collaborators/{username}/permission",
      {
        ...target,
        username: user.login,
      },
    );
    if (access.user?.id !== githubUserId || access.user.login !== user.login)
      throw new AccessDenied(
        "Paired user is not a verified repository administrator",
      );
    // Permission responses identify the user, not the repository; detect a rename or replacement.
    const { data: current } = await client.request(
      "GET /repos/{owner}/{repo}",
      target,
    );
    if (current.id !== selected.id || !matches(current))
      throw new AccessDenied("Repository identity changed");
    if (access.permission !== "admin") {
      if (
        ["write", "maintain", "triage", "read", "none"].includes(
          access.permission,
        )
      )
        throw new AdministratorLost(installationId.data, selected.id);
      throw new AccessDenied("Could not confirm administrator permission");
    }
    return {
      installation: installationEvidence(installed),
      who: {
        deviceId,
        owner: current.owner.login,
        repo: current.name,
        administratorId: githubUserId,
        installationId: installationId.data,
        repositoryId: selected.id,
      },
    };
  }
}

import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { runtimeProfileSchema } from "./runtime-profile.js";
import { bindingEvent } from "./binding-events.js";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const scopeSchema = z.strictObject({ installationId: id, repositoryId: id });
const principalSchema = scopeSchema.extend({
  deviceId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  administratorId: id,
  owner: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9_.-]{1,100}$/)
    .refine((v) => v !== "." && v !== ".."),
});
const declaration = z.strictObject({
  enabled: z.boolean(),
  autoTriage: z.boolean().optional(),
  autoReview: z.boolean().optional(),
  nativeReview: z.boolean().optional(),
  deepReview: z.boolean().optional(),
  events: z
    .array(bindingEvent)
    .max(bindingEvent.options.length)
    .transform((events) => [...new Set(events)].sort())
    .optional(),
  triggerLabel: z.string().trim().min(1).max(100).optional(),
});
const validFilter = (v: { events?: string[]; enabled: boolean }) =>
  v.events === undefined || v.enabled === v.events.length > 0;
export const desiredPolicySchema = declaration.refine(validFilter);
export const bindingDeclarationSchema = declaration
  .extend({
    responsibleAgent: runtimeProfileSchema.optional(),
  })
  .refine(validFilter)
  .refine(
    (v) => v.enabled === (v.responsibleAgent !== undefined),
    "An enabled binding must identify its responsible agent",
  )
  .refine(
    (v) =>
      !v.enabled ||
      v.responsibleAgent?.type !== "acp" ||
      (!v.autoTriage && !v.autoReview),
    "ACP coding agents cannot enable autoTriage or autoReview; choose an analysis agent for automatic analysis",
  );

type Declaration = z.infer<typeof bindingDeclarationSchema>;
export function effectiveEvents(d: Declaration) {
  return d.enabled ? (d.events ?? [...bindingEvent.options]) : [];
}
export function sameDeclaration(a: Declaration, b: Declaration) {
  return (
    a.enabled === b.enabled &&
    !!a.autoTriage === !!b.autoTriage &&
    !!a.autoReview === !!b.autoReview &&
    !!a.deepReview === !!b.deepReview &&
    !!a.nativeReview === !!b.nativeReview &&
    a.triggerLabel === b.triggerLabel &&
    JSON.stringify(a.responsibleAgent) === JSON.stringify(b.responsibleAgent) &&
    JSON.stringify(a.events) === JSON.stringify(b.events)
  );
}

export const bindingRecordSchema = bindingDeclarationSchema.safeExtend({
  ...principalSchema.shape,
  revision: id,
});

type Scope = z.infer<typeof scopeSchema>;
type Principal = z.infer<typeof principalSchema>;
type BindingRecord = Principal &
  z.infer<typeof bindingDeclarationSchema> & { revision: number };
const bindingColumns =
  "installationId,repositoryId,owner,repo,deviceId,administratorId,revision,declaration";

function decodeBinding(row: Record<string, unknown>): BindingRecord {
  const { revision, declaration, ...principal } = row;
  return {
    ...principalSchema.parse(principal),
    revision: id.parse(revision),
    ...bindingDeclarationSchema.parse(JSON.parse(String(declaration))),
  };
}

/** Internal persistence boundary. Caller supplies server-verified identity and scope, never request-body claims. */
export class BindingRegistry {
  constructor(private readonly db: DatabaseSync) {}

  // A revision ends before any new work can be admitted. Never replay or assume
  // a running harness stopped; a reserved publication may already be in flight.
  private fence(scope: Scope) {
    const args = [scope.installationId, scope.repositoryId];
    this.db
      .prepare(
        "UPDATE tasks SET status='rejected', deliveryStatus='skipped', error='Binding revision changed' WHERE installationId=? AND repositoryId=? AND status='queued'",
      )
      .run(...args);
    this.db
      .prepare(
        "UPDATE tasks SET status='unknown', error='Binding revision changed during execution' WHERE installationId=? AND repositoryId=? AND status='running'",
      )
      .run(...args);
    this.db
      .prepare(
        "UPDATE tasks SET deliveryStatus='skipped', error='Binding revision changed before publication' WHERE installationId=? AND repositoryId=? AND status='succeeded' AND deliveryStatus='pending'",
      )
      .run(...args);
  }

  revokeDevice(deviceId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT OR IGNORE INTO revokedDevices(deviceId) VALUES(?)")
        .run(deviceId);
      const rows = this.db
        .prepare(
          "SELECT installationId,repositoryId FROM bindings WHERE deviceId=?",
        )
        .all(deviceId);
      for (const row of rows) {
        const scope = scopeSchema.parse(row);
        const record = this.get(scope)!;
        if (record.enabled) {
          this.db
            .prepare(
              "UPDATE bindings SET revision=revision+1,declaration=? WHERE installationId=? AND repositoryId=?",
            )
            .run(
              JSON.stringify({ enabled: false, events: [] }),
              scope.installationId,
              scope.repositoryId,
            );
          this.fence(scope);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  ownedSelections(
    deviceId: string,
    administratorId: number,
    owner: string,
    repo: string,
  ): BindingRecord[] {
    // Names can survive repository replacement or App reinstallation.
    // Snapshot each exact scope; GitHub verification selects among them.
    return this.db
      .prepare(
        `SELECT ${bindingColumns} FROM bindings WHERE deviceId=? AND administratorId=? AND owner=? COLLATE NOCASE AND repo=? COLLATE NOCASE`,
      )
      .all(deviceId, administratorId, owner, repo)
      .map(decodeBinding);
  }
  disableIfCurrent(previous: BindingRecord) {
    const {
      installationId,
      repositoryId,
      deviceId,
      administratorId,
      owner,
      repo,
      revision,
    } = previous;
    const c = this.get({ installationId, repositoryId });
    if (
      c?.enabled &&
      c.deviceId === deviceId &&
      c.administratorId === administratorId &&
      c.owner === owner &&
      c.repo === repo &&
      c.revision === revision
    )
      this.apply(
        {
          installationId,
          repositoryId,
          deviceId,
          administratorId,
          owner,
          repo,
        },
        revision,
        { enabled: false, events: [] },
      );
  }
  get(scope: Scope): BindingRecord | undefined {
    const { installationId, repositoryId } = scopeSchema.parse(scope);
    const row = this.db
      .prepare(
        `SELECT ${bindingColumns} FROM bindings WHERE installationId=? AND repositoryId=?`,
      )
      .get(installationId, repositoryId);
    return row ? decodeBinding(row) : undefined;
  }

  apply(
    verified: Principal,
    expectedRevision: number,
    input: unknown,
  ): BindingRecord {
    const who = principalSchema.parse(verified);
    const { installationId, repositoryId, deviceId, administratorId } = who;
    z.number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1)
      .parse(expectedRevision);
    const next = bindingDeclarationSchema.parse(input);
    const declaration = JSON.stringify(next);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (
        this.db
          .prepare("SELECT 1 FROM revokedDevices WHERE deviceId=?")
          .get(deviceId)
      )
        throw Error("Device revoked");
      const current = this.get({ installationId, repositoryId });
      if (current && current.deviceId !== deviceId)
        throw Error("Binding belongs to another device");
      const rev = current?.revision ?? 0;
      const same =
        current &&
        current.administratorId === administratorId &&
        current.owner === who.owner &&
        current.repo === who.repo &&
        sameDeclaration(current, next);
      if (expectedRevision !== rev && !(same && expectedRevision === rev - 1))
        throw Error("Binding revision conflict");
      if (!current && !next.enabled) throw Error("No binding to disable");
      if (!same)
        this.db
          .prepare(
            `INSERT INTO bindings (installationId,repositoryId,deviceId,administratorId,revision,declaration,owner,repo)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (installationId,repositoryId) DO UPDATE SET
        owner=excluded.owner,repo=excluded.repo,administratorId=excluded.administratorId,revision=excluded.revision,declaration=excluded.declaration`,
          )
          .run(
            installationId,
            repositoryId,
            deviceId,
            administratorId,
            rev + 1,
            declaration,
            who.owner,
            who.repo,
          );
      if (current && !same) this.fence(current);
      this.db.exec("COMMIT");
      return same ? current : { ...who, revision: rev + 1, ...next };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

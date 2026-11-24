import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { bindingEvent } from "./binding-events.js";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const scopeSchema = z.strictObject({ installationId: id, repositoryId: id });
const principalSchema = scopeSchema.extend({
  deviceId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  administratorId: id,
});
const declarationSchema = z
  .strictObject({
    enabled: z.boolean(),
    events: z
      .array(bindingEvent)
      .max(bindingEvent.options.length)
      .transform((events) => [...new Set(events)].sort()),
    triggerLabel: z.string().trim().min(1).max(100).optional(),
  })
  .refine(
    (v) =>
      v.enabled === v.events.length > 0 &&
      v.events.includes("issues.labeled") === (v.triggerLabel !== undefined),
    "Enabled bindings need events; only labeled events take a label",
  );

type Scope = z.infer<typeof scopeSchema>;
type Principal = z.infer<typeof principalSchema>;
type BindingRecord = Principal &
  z.infer<typeof declarationSchema> & { revision: number };

/** Internal persistence boundary. Caller supplies server-verified identity and scope, never request-body claims. */
export class BindingRegistry {
  constructor(private readonly db: DatabaseSync) {
    // Dedicated registry DB; do not modify an unrelated database or a previous layout.
    db.exec("BEGIN IMMEDIATE");
    try {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
        )
        .all();
      const app = db.prepare("PRAGMA application_id").get()?.application_id;
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      if (!tables.length && app === 0 && version === 0) {
        db.exec(`CREATE TABLE bindings (
          installationId INTEGER NOT NULL, repositoryId INTEGER NOT NULL, deviceId TEXT NOT NULL,
          administratorId INTEGER NOT NULL, revision INTEGER NOT NULL, declaration TEXT NOT NULL,
          PRIMARY KEY (installationId, repositoryId)
        ) STRICT; PRAGMA application_id=1112097860; PRAGMA user_version=1;`);
      } else if (
        app !== 1112097860 ||
        version !== 1 ||
        tables.length !== 1 ||
        tables[0].name !== "bindings"
      ) {
        throw Error(
          "Expected a dedicated binding registry; existing data left intact",
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  get(scope: Scope): BindingRecord | undefined {
    const { installationId, repositoryId } = scopeSchema.parse(scope);
    const row = this.db
      .prepare(
        "SELECT deviceId,administratorId,revision,declaration FROM bindings WHERE installationId=? AND repositoryId=?",
      )
      .get(installationId, repositoryId);
    if (!row) return undefined;
    const who = principalSchema.parse({
      installationId,
      repositoryId,
      administratorId: row.administratorId,
      deviceId: row.deviceId,
    });
    return {
      ...who,
      revision: id.parse(row.revision),
      ...declarationSchema.parse(JSON.parse(String(row.declaration))),
    };
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
    const next = declarationSchema.parse(input);
    const declaration = JSON.stringify(next);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get({ installationId, repositoryId });
      if (current && current.deviceId !== deviceId)
        throw Error("Binding belongs to another device");
      const rev = current?.revision ?? 0;
      const same =
        current &&
        current.administratorId === administratorId &&
        current.enabled === next.enabled &&
        current.triggerLabel === next.triggerLabel &&
        JSON.stringify(current.events) === JSON.stringify(next.events);
      if (expectedRevision !== rev && !(same && expectedRevision === rev - 1))
        throw Error("Binding revision conflict");
      if (!current && !next.enabled) throw Error("No binding to disable");
      if (!same)
        this.db
          .prepare(
            `INSERT INTO bindings (installationId,repositoryId,deviceId,administratorId,revision,declaration)
        VALUES (?,?,?,?,?,?) ON CONFLICT (installationId,repositoryId) DO UPDATE SET
        administratorId=excluded.administratorId,revision=excluded.revision,declaration=excluded.declaration`,
          )
          .run(
            installationId,
            repositoryId,
            deviceId,
            administratorId,
            rev + 1,
            declaration,
          );
      this.db.exec("COMMIT");
      return same ? current : { ...who, revision: rev + 1, ...next };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

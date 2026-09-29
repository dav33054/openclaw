import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  assertTransactionUsable,
  runSqliteImmediateTransactionSync,
} from "../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../infra/sqlite-worker-contract.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { stripPluginModelCatalogCredentials } from "./plugin-model-catalog-repair.js";

export type PluginModelCatalogCredentialOperations = {
  "catalog.removeCredentials": { input: { credentials: string[] }; output: void };
};

/** The canonical executor lends the connection and owns transaction admission. */
export function bindSqliteWorkerBackend(
  _input: unknown,
  context: {
    database: DatabaseSync;
    admit(stage: "transaction" | "commit"): void;
  },
): SqliteWorkerBackend<PluginModelCatalogCredentialOperations> {
  return {
    execute(command) {
      const credentials = new Set(command.input.credentials);
      runSqliteImmediateTransactionSync(
        context.database,
        () => {
          context.admit("transaction");
          const kysely = getNodeSqliteKysely<Pick<OpenClawAgentKyselyDatabase, "cache_entries">>(
            context.database,
          );
          const rows = executeSqliteQuerySync(
            context.database,
            kysely
              .selectFrom("cache_entries")
              .select(["scope", "key", "value_json"])
              .where("scope", "in", [
                "plugin-model-catalog-v1",
                "plugin-model-catalog-migration-v1",
              ]),
          ).rows;
          for (const row of rows) {
            if (row.value_json === null) {
              continue;
            }
            const contents = stripPluginModelCatalogCredentials(row.value_json, credentials);
            if (contents === row.value_json) {
              continue;
            }
            if (contents === null) {
              executeSqliteQuerySync(
                context.database,
                kysely
                  .deleteFrom("cache_entries")
                  .where("scope", "=", row.scope)
                  .where("key", "=", row.key),
              );
            } else {
              executeSqliteQuerySync(
                context.database,
                kysely
                  .updateTable("cache_entries")
                  .set({ value_json: contents, updated_at: Date.now() })
                  .where("scope", "=", row.scope)
                  .where("key", "=", row.key),
              );
            }
          }
        },
        {
          withCommit(commit) {
            context.admit("commit");
            commit();
          },
        },
      );
    },
    assertSettled() {
      assertTransactionUsable(context.database);
      if (!context.database.isOpen || context.database.isTransaction) {
        throw new Error("Catalog cleanup left an unsettled agent transaction");
      }
    },
    close() {},
  };
}

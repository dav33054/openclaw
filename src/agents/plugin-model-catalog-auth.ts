import {
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
} from "./auth-profiles/path-resolve.js";
import { loadPersistedAuthProfileStoreAtDatabasePath } from "./auth-profiles/persisted.js";
import { resolveAuthProfileDatabasePath } from "./auth-profiles/sqlite.js";
import type { AuthProfileCredential } from "./auth-profiles/types.js";

export type PluginModelCatalogAuthSnapshot = Array<{
  databasePath: string;
  kind: "agent" | "shared-state";
  credentials: Record<string, string[]>;
}>;

function credentialValues(credential: AuthProfileCredential | undefined): string[] {
  if (!credential) {
    return [];
  }
  const values =
    credential.type === "api_key"
      ? [credential.key]
      : credential.type === "token"
        ? [credential.token]
        : [credential.access, credential.refresh];
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}

/** Capture only existing canonical owners; catalog-only credentials retain their recovery policy. */
export function capturePluginModelCatalogAuth(
  agentDir: string,
  env: NodeJS.ProcessEnv,
): PluginModelCatalogAuthSnapshot {
  const sharedPath = resolveSharedAuthStorePath(env);
  const localPath = resolveAuthProfileDatabasePath(agentDir);
  const owners: Array<{ databasePath: string; kind: "agent" | "shared-state" }> = [
    {
      databasePath: sharedPath,
      kind: resolveSharedAuthStoreOwnership(env).location === "state-db" ? "shared-state" : "agent",
    },
    ...(localPath === sharedPath ? [] : [{ databasePath: localPath, kind: "agent" as const }]),
  ];
  return owners.map((owner) => {
    const store = loadPersistedAuthProfileStoreAtDatabasePath(owner.databasePath, owner.kind);
    return {
      databasePath: owner.databasePath,
      kind: owner.kind,
      credentials: Object.fromEntries(
        Object.entries(store?.profiles ?? {}).map(([id, credential]) => [
          id,
          credentialValues(credential),
        ]),
      ),
    };
  });
}

/** Must run inside the catalog write transaction, never while asynchronous discovery is pending. */
export function findRemovedPluginModelCatalogCredentials(
  snapshot: PluginModelCatalogAuthSnapshot,
): ReadonlySet<string> {
  const captured = new Set<string>();
  const authorized = new Set<string>();
  for (const owner of snapshot) {
    const current = loadPersistedAuthProfileStoreAtDatabasePath(owner.databasePath, owner.kind);
    for (const [id, values] of Object.entries(owner.credentials)) {
      for (const value of values) {
        captured.add(value);
      }
      for (const value of credentialValues(current?.profiles[id])) {
        authorized.add(value);
      }
    }
  }
  for (const value of authorized) {
    captured.delete(value);
  }
  return captured;
}

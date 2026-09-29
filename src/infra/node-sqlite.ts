// Loads node:sqlite with OpenClaw warning handling.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";
import { ensureSqliteLibrarySelected } from "./bun-sqlite-library.js";
import { formatErrorMessage } from "./errors.js";
import { registerNodeSqliteDisposeCallback } from "./kysely-sync-cache-state.js";
import { compareValidSemver } from "./semver.js";
import { registerSqliteReaderConnection } from "./sqlite-reader-lifecycle.js";
import { isSqliteWalResetSafeVersion } from "./sqlite-runtime-version.js";
import { trackSqliteSchema } from "./sqlite-schema-facts.js";
import { installProcessWarningFilter } from "./warning-filter.js";

const require = createRequire(import.meta.url);
let validatedSqliteModule: typeof import("node:sqlite") | undefined;
let extensionLoadingSupported = false;
let jsonbSupported = false;
let closeFinalizationProbe: ReturnType<typeof probeSqliteCloseFinalization> | undefined;
// Shared-state native closes retain Bun worker-exit custody.
export let bunSqliteNativeCleanupPending = false;

type NodeSqliteDatabaseOptions = ConstructorParameters<
  typeof import("node:sqlite").DatabaseSync
>[1];

export function resolveSqliteFilesystemPath(pathname: string): string {
  if (process.platform !== "win32") {
    return pathname;
  }
  // Node's fs APIs normalize long paths, but node:sqlite passes filesystem
  // names directly to SQLite's Windows VFS.
  return path.toNamespacedPath(path.resolve(pathname));
}

export function resolveNodeSqliteLocation(location: string): string {
  if (location === "" || location === ":memory:" || location.startsWith("file:")) {
    return location;
  }
  return resolveSqliteFilesystemPath(location);
}

/** Preserve native Windows path prefixes before adding SQLite URI parameters. */
function resolveSqliteFileUriPath(pathname: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    const namespacedPath = path.win32.toNamespacedPath(path.win32.resolve(pathname));
    // SQLite separates the query before decoding the Windows namespace prefix.
    return `file:${encodeURIComponent(namespacedPath)}`;
  }
  return pathToFileURL(path.resolve(pathname)).href;
}

/** Open an existing writable database without SQLite's create-if-missing flag. */
export function resolveExistingSqliteFileUri(
  pathname: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return `${resolveSqliteFileUriPath(pathname, platform)}?mode=rw`;
}

/** Build an immutable SQLite URI without losing the Windows long-path namespace. */
export function resolveImmutableSqliteFileUri(
  pathname: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return `${resolveSqliteFileUriPath(pathname, platform)}?mode=ro&immutable=1`;
}

function assertSqliteWalResetSafeVersion(version: string, nodeVersion: string): void {
  if (isSqliteWalResetSafeVersion(version)) {
    return;
  }
  const variables = (process.config as { variables?: Record<string, unknown> } | undefined)
    ?.variables;
  const isShared =
    variables?.node_shared_sqlite === true || variables?.node_shared_sqlite === "true";
  const wording = isShared ? "uses shared system" : "embeds";
  const remediation = isShared
    ? "Upgrade the system SQLite library to one of those safe versions, or use a Node build embedding a safe version."
    : "Upgrade to Node 24.16.0+ or 26.1.0+ before retrying.";
  throw new Error(
    `OpenClaw requires SQLite 3.51.3+, 3.50.7+ within 3.50.x, or 3.44.6+ within 3.44.x for WAL safety; ` +
      `Node ${nodeVersion} ${wording} SQLite ${version}, which is affected by the upstream WAL-reset ` +
      `database corruption bug. ${remediation}`,
  );
}

function assertSafeSqliteRuntime(sqlite: typeof import("node:sqlite")): void {
  if (validatedSqliteModule === sqlite) {
    return;
  }
  // Shared-SQLite Node builds can load a different library than process.versions
  // reports, so query the loaded library before callers open real state databases.
  const database = new sqlite.DatabaseSync(":memory:");
  try {
    const row = database.prepare("SELECT sqlite_version() AS version").get() as
      | { version?: unknown }
      | undefined;
    const version = typeof row?.version === "string" ? row.version : "unknown";
    assertSqliteWalResetSafeVersion(version, process.versions.node);
    jsonbSupported = (compareValidSemver(version, "3.45.0") ?? -1) >= 0;
    const capabilities = database
      .prepare("SELECT sqlite_compileoption_used('OMIT_LOAD_EXTENSION') AS omitted")
      .get();
    extensionLoadingSupported = capabilities?.omitted === 0;
    validatedSqliteModule = sqlite;
  } finally {
    database.close();
  }
}

// node:sqlite is optional across Node versions, so callers get a clear runtime
// error instead of a low-level module resolution failure.
/** Load node:sqlite after installing the process warning filter. */
export function requireNodeSqlite(): typeof import("node:sqlite") {
  installProcessWarningFilter();
  try {
    ensureSqliteLibrarySelected();
    const sqlite = require("node:sqlite") as typeof import("node:sqlite");
    assertSafeSqliteRuntime(sqlite);
    return sqlite;
  } catch (err) {
    const message = formatErrorMessage(err);
    throw new Error(`SQLite support is unavailable or unsafe in this Node runtime. ${message}`, {
      cause: err,
    });
  }
}

/** Whether the loaded SQLite library supports native extensions. */
export function supportsNodeSqliteExtensionLoading(): boolean {
  requireNodeSqlite();
  return extensionLoadingSupported;
}

/** JSONB is absent from the supported SQLite 3.44 maintenance line. */
export function supportsNodeSqliteJsonb(): boolean {
  requireNodeSqlite();
  return jsonbSupported;
}

/** Only the executing database worker may establish its native cleanup capability. */
export function supportsNodeSqliteCloseFinalization(): boolean {
  if (isMainThread) {
    return false;
  }
  try {
    closeFinalizationProbe ??= probeSqliteCloseFinalization(
      requireNodeSqlite().DatabaseSync,
      randomUUID(),
    );
  } catch {
    closeFinalizationProbe = { supported: false, databases: [], statements: [] };
  }
  return closeFinalizationProbe.supported;
}

/** Open node:sqlite through OpenClaw's runtime and filesystem-location boundary. */
export function openNodeSqliteDatabase(
  location: string,
  options?: NodeSqliteDatabaseOptions,
): import("node:sqlite").DatabaseSync {
  const sqlite = requireNodeSqlite();
  // Callers may pass file: URIs or already-namespaced paths from specialized
  // resolvers; location normalization must remain idempotent for those forms.
  const resolvedLocation = resolveNodeSqliteLocation(location);
  const database = new sqlite.DatabaseSync(resolvedLocation, options ?? {});
  // Schema tracking must precede the statement-cache authorizer wrapper.
  trackSqliteSchema(database, sqlite);
  if (process.versions.bun) {
    registerNodeSqliteDisposeCallback(database, () => {
      bunSqliteNativeCleanupPending = true;
    });
  }
  registerSqliteReaderConnection(database);
  return database;
}

/** Compare versions only across reads on the same connection. */
export function readSqliteDataVersion(database: import("node:sqlite").DatabaseSync): number {
  // SAFETY: SQLite names this PRAGMA's column data_version; its numeric value is checked below.
  const row = database.prepare("PRAGMA data_version").get() as { data_version?: unknown };
  if (typeof row.data_version !== "number") {
    throw new Error("SQLite did not return a numeric PRAGMA data_version");
  }
  return row.data_version;
}

type SqliteCloseFinalizationProbe = {
  supported: boolean;
  databases: DatabaseSync[];
  statements: StatementSync[];
  iterator?: ReturnType<StatementSync["iterate"]>;
};

/** Retain failed probe resources until the executing worker's existing exit boundary. */
function probeSqliteCloseFinalization(
  Database: typeof DatabaseSync,
  name: string,
): SqliteCloseFinalizationProbe {
  const probe: SqliteCloseFinalizationProbe = { supported: false, databases: [], statements: [] };
  try {
    const uri = `file:openclaw-close-${name}?mode=memory&cache=shared`;
    const open = () => {
      // Ignored URI parameters cannot create a disk file with READONLY admission.
      const database = new Database(uri, { readOnly: true });
      probe.databases.push(database);
      if (database.location() !== null) {
        throw new Error("SQLite close probe requires an in-memory database");
      }
      return database;
    };
    const database = open();
    database.exec("CREATE TABLE close_probe(value INTEGER); INSERT INTO close_probe VALUES(1),(2)");
    for (let index = 0; index < 3; index++) {
      probe.statements.push(database.prepare("SELECT value FROM close_probe ORDER BY value"));
    }
    if (probe.statements[1]!.get()?.value !== 1) {
      return probe;
    }
    probe.iterator = probe.statements[2]!.iterate();
    if (probe.iterator.next().value?.value !== 1) {
      return probe;
    }
    const witness = open();
    witness.exec("SELECT value FROM close_probe");
    witness.close();
    database.close();
    const replacement = open();
    const observation = replacement.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'close_probe'",
    );
    probe.statements.push(observation);
    probe.supported = !database.isOpen && observation.get()?.count === 0;
  } catch {
    // Unsupported sharing or uncertain cleanup keeps the existing worker-exit boundary.
    probe.supported = false;
  } finally {
    for (const database of probe.databases.toReversed()) {
      try {
        if (database.isOpen) {
          database.close();
        }
      } catch {
        probe.supported = false;
      }
    }
    if (probe.supported) {
      probe.databases.length = 0;
      probe.statements.length = 0;
      probe.iterator = undefined;
    }
  }
  return probe;
}

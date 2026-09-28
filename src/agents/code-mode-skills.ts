import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  FsSafeError,
  root as createFsSafeRoot,
  type FsSafeErrorCode,
  type Root,
} from "../infra/fs-safe.js";
import { decodeSkillXml, type Skill } from "../skills/loading/skill-contract.js";

const SKILL_COMPANION_MAX_BYTES = 256_000;

type PinnedSkillRoot = Promise<{ ok: true; root: Root } | { ok: false; error: unknown }>;

export type CodeModeSkill = {
  name: string;
  description: string;
  location: string;
  source: Pick<Skill, "filePath" | "fileHost" | "readContent"> & {
    pinnedRoot?: PinnedSkillRoot;
  };
  reader?: CodeModeSkillReader;
};

export type CodeModeSkillReader = (params: {
  location: string;
  signal?: AbortSignal;
}) => Promise<string>;

const SKILL_NAME_PATTERN = /^[ ]{4}<name>(.*)<\/name>$/mu;
const SKILL_LOCATION_PATTERN = /^[ ]{4}<location>(.*)<\/location>$/mu;

function readSkillField(block: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(block)?.[1];
  return match === undefined ? undefined : decodeSkillXml(match);
}

function isNodeHostedSkillLocator(value: string): boolean {
  return value.startsWith("node://");
}

function pinFilesystemSkillRoot(skillFilePath: string): PinnedSkillRoot | undefined {
  if (isNodeHostedSkillLocator(skillFilePath)) {
    return undefined;
  }
  // root() captures the canonical directory identity before yielding. Keeping
  // this handle ties later companion reads to the selected/materialized root.
  return createFsSafeRoot(path.dirname(path.resolve(skillFilePath))).then(
    (pinnedRoot) => ({ ok: true as const, root: pinnedRoot }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

function normalizeSkillRelativePath(relativePath: string): string {
  const trimmed = relativePath.trim().replaceAll("\\", "/");
  if (
    !trimmed ||
    path.isAbsolute(trimmed) ||
    trimmed.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`invalid skill relative path ${JSON.stringify(relativePath)}`);
  }
  return trimmed;
}

function skillRelativeEscapeError(relativePath: string, cause: unknown): Error {
  return new Error(`skill relative path escapes skill root: ${JSON.stringify(relativePath)}`, {
    cause,
  });
}

// The locked fs-safe classifier marks not-file and too-large as policy.
// Companion reads keep this narrower containment allowlist so those stay
// size/operational failures instead of looking like root escapes.
function isSkillRelativeContainmentError(code: FsSafeErrorCode): boolean {
  return (
    code === "outside-workspace" ||
    code === "path-mismatch" ||
    code === "path-alias" ||
    code === "invalid-path" ||
    code === "symlink" ||
    code === "hardlink"
  );
}

/** Select Code Mode skills from the exact catalog rendered into this run's prompt. */
export function resolveCodeModeSkills(params: {
  skillsPrompt: string;
  candidates: readonly Skill[];
  reader?: CodeModeSkillReader;
}): CodeModeSkill[] {
  const catalog = /<available_skills>\n([\s\S]*?)\n<\/available_skills>/u.exec(
    params.skillsPrompt,
  )?.[1];
  if (!catalog) {
    return [];
  }
  const candidatesByName = new Map(params.candidates.map((skill) => [skill.name, skill]));
  const result: CodeModeSkill[] = [];
  for (const match of catalog.matchAll(/^[ ]{2}<skill>\n([\s\S]*?)\n[ ]{2}<\/skill>$/gmu)) {
    const block = match[1] ?? "";
    const name = readSkillField(block, SKILL_NAME_PATTERN);
    const location = readSkillField(block, SKILL_LOCATION_PATTERN);
    const source = name ? candidatesByName.get(name) : undefined;
    if (!name || !location || !source) {
      continue;
    }
    const sourceFilePath = source.hostFilePath ?? source.filePath;
    result.push({
      name,
      description: [source.description, source.locationNote].filter(Boolean).join("\n"),
      location,
      source: {
        filePath: sourceFilePath,
        fileHost: source.fileHost,
        readContent: source.readContent,
        pinnedRoot: pinFilesystemSkillRoot(sourceFilePath),
      },
      reader: params.reader,
    });
  }
  return result;
}

async function readFilesystemSkillRelative(
  pinnedRoot: PinnedSkillRoot | undefined,
  relativePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const relative = normalizeSkillRelativePath(relativePath);
  try {
    signal?.throwIfAborted();
    if (!pinnedRoot) {
      throw new FsSafeError("path-mismatch", "selected skill root identity is unavailable");
    }
    const resolvedRoot = await pinnedRoot;
    signal?.throwIfAborted();
    if (!resolvedRoot.ok) {
      throw resolvedRoot.error;
    }
    // The selected root handle verifies its captured directory identity. Its
    // defaults reject symlinks/hardlinks and enforce the eager size bound.
    const result = await resolvedRoot.root.read(relative, {
      hardlinks: "reject",
      maxBytes: SKILL_COMPANION_MAX_BYTES,
      symlinks: "reject",
    });
    signal?.throwIfAborted();
    return result.buffer.toString("utf8");
  } catch (error) {
    if (error instanceof FsSafeError) {
      if (error.code === "too-large") {
        throw new Error(
          `skill relative file exceeds ${SKILL_COMPANION_MAX_BYTES} bytes: ${JSON.stringify(relativePath)}`,
          { cause: error },
        );
      }
      if (isSkillRelativeContainmentError(error.code)) {
        throw skillRelativeEscapeError(relativePath, error);
      }
      throw new Error(`skill relative file ${error.code}: ${JSON.stringify(relativePath)}`, {
        cause: error,
      });
    }
    throw error;
  }
}

export async function readCodeModeSkill(
  skill: CodeModeSkill,
  signal?: AbortSignal,
  relativePath?: string,
): Promise<string> {
  const relative = typeof relativePath === "string" ? relativePath.trim() : "";
  if (!relative) {
    if (typeof skill.source.readContent === "string") {
      return skill.source.readContent;
    }
    if (skill.reader) {
      return await skill.reader({ location: skill.location, signal });
    }
    return await readFile(skill.source.filePath, { encoding: "utf8", signal });
  }

  const locator = isNodeHostedSkillLocator(skill.location) ? skill.location : skill.source.filePath;
  if (isNodeHostedSkillLocator(locator) || isNodeHostedSkillLocator(skill.source.filePath)) {
    throw new Error(
      `node-hosted skill companion reads are unavailable: ${JSON.stringify(relative)}`,
    );
  }

  if (skill.source.fileHost === "workspace") {
    throw new Error(`workspace skill companion reads are unavailable: ${JSON.stringify(relative)}`);
  }

  // Companion files stay on the selected skill root. The sandbox reader is
  // collection-scoped and would follow a symlink into a sibling skill.
  return await readFilesystemSkillRelative(skill.source.pinnedRoot, relative, signal);
}

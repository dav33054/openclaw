/** Tests Code Mode skills and read tools. */

import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "../skills/loading/skill-contract.js";
import { resolveSkillsPrompt } from "../skills/loading/workspace-skill-prompt.js";
import { createFixtureSkillEntry } from "../skills/test-support/test-helpers.js";
import { createOpenClawReadTool } from "./agent-tools.read.js";
import {
  readCodeModeSkill,
  resolveCodeModeSkills,
  type CodeModeSkill,
} from "./code-mode-skills.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  resetCodeModeTestState,
  pluginTool,
  createCodeModeHarness,
  runUntilCompleted,
} from "./code-mode.test-support.js";
import { createReadTool } from "./sessions/index.js";

function skillCandidate(params: {
  name: string;
  description: string;
  filePath: string;
  readContent?: string;
  hostFilePath?: string;
}): Skill {
  return {
    ...params,
    baseDir: params.filePath.replace(/\/[^/]+$/u, ""),
    sourceInfo: {
      path: params.filePath,
      source: "test",
      scope: "temporary",
      origin: "top-level",
    },
    disableModelInvocation: false,
    source: "test",
  };
}

function catalogPrompt(location: string): string {
  return [
    "<available_skills>",
    "  <skill>",
    "    <name>demo</name>",
    "    <description>Demo</description>",
    `    <location>${location}</location>`,
    "  </skill>",
    "</available_skills>",
  ].join("\n");
}

function resolveFilesystemCodeModeSkill(filePath: string): CodeModeSkill {
  return expectDefined(
    resolveCodeModeSkills({
      skillsPrompt: catalogPrompt(filePath),
      candidates: [skillCandidate({ name: "demo", description: "Demo skill", filePath })],
    })[0],
    "filesystem Code Mode skill test invariant",
  );
}

function execDescription(codeModeSkills: CodeModeSkill[]): string {
  const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness({ codeModeSkills });
  applyCodeModeCatalog({
    tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
    config,
    sessionId: "session-code-mode",
    sessionKey: "agent:main:main",
    runId: "run-code-mode",
    catalogRef,
    codeModeSkills,
  });
  return codeModeTools[0]?.description ?? "";
}

describe("Code Mode skills and read tools", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await resetCodeModeTestState();
  });

  it("keeps Code Mode skill parsing aligned with the production prompt renderer", async () => {
    const entries = [createFixtureSkillEntry("alpha"), createFixtureSkillEntry("beta")];
    const skillsPrompt = await resolveSkillsPrompt({
      entries,
      workspaceDir: "/workspace",
    });

    expect(
      resolveCodeModeSkills({
        skillsPrompt,
        candidates: entries.map((entry) => entry.skill),
      }).map(({ name, location }) => ({ name, location })),
    ).toEqual([
      { name: "alpha", location: "/skills/alpha/SKILL.md" },
      { name: "beta", location: "/skills/beta/SKILL.md" },
    ]);
  });

  it("lists and reads only prompt-eligible skills through the worker bridge", async () => {
    const demo = skillCandidate({
      name: "demo",
      description: "Full demo description",
      filePath: "/host/skills/demo/SKILL.md",
    });
    const hidden = skillCandidate({
      name: "hidden",
      description: "Hidden skill",
      filePath: "/host/skills/hidden/SKILL.md",
    });
    const reader = vi.fn(async ({ location }: { location: string }) =>
      location === "/guest/skills/demo/SKILL.md"
        ? "---\nname: demo\n---\n\n# Complete demo instructions\n"
        : "# Hidden\n",
    );
    const codeModeSkills = resolveCodeModeSkills({
      skillsPrompt: [
        "<available_skills>",
        "  <skill>",
        "    <name>demo</name>",
        "    <description>Short prompt description</description>",
        "    <location>/guest/skills/demo/SKILL.md</location>",
        "  </skill>",
        "</available_skills>",
      ].join("\n"),
      candidates: [demo, hidden],
      reader,
    });
    const {
      config,
      catalogRef,
      tools: codeModeTools,
    } = createCodeModeHarness({
      codeModeSkills,
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
      codeModeSkills,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: `
        const listed = await skills.list();
        const body = await skills.read("demo");
        let unknown;
        try {
          await skills.read("missing");
        } catch (error) {
          unknown = error.message;
        }
        return { listed, body, unknown };
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toEqual({
      listed: [
        {
          name: "demo",
          description: "Full demo description",
          location: "/guest/skills/demo/SKILL.md",
        },
      ],
      body: "---\nname: demo\n---\n\n# Complete demo instructions\n",
      unknown: 'Unknown skill "missing". Available skills: demo',
    });
    expect(codeModeTools[0]?.description).toContain("`await skills.read(name)`");
    expect(reader).toHaveBeenCalledOnce();
    expect(reader).toHaveBeenCalledWith({
      location: "/guest/skills/demo/SKILL.md",
      signal: expect.any(AbortSignal),
    });
  });

  it("reads a pinned companion and keeps operational failures distinct", async () => {
    const tmpParent = await fs.realpath(
      await fs.mkdtemp(nodePath.join(os.tmpdir(), "oc-skill-root-")),
    );
    try {
      const skillRoot = nodePath.join(tmpParent, "demo");
      const outside = nodePath.join(tmpParent, "outside.txt");
      await fs.mkdir(nodePath.join(skillRoot, "modules"), { recursive: true });
      await fs.writeFile(nodePath.join(skillRoot, "SKILL.md"), "# skill\n", "utf8");
      await fs.writeFile(
        nodePath.join(skillRoot, "modules", "during-dining.md"),
        "# dining\n",
        "utf8",
      );
      await fs.writeFile(nodePath.join(skillRoot, "huge.md"), "x".repeat(256_001), "utf8");
      await fs.writeFile(outside, "secret\n", "utf8");
      if (process.platform !== "win32") {
        await fs.symlink(outside, nodePath.join(skillRoot, "modules", "link.md"));
        await fs.link(outside, nodePath.join(skillRoot, "modules", "alias.md"));
      }
      const skill = resolveFilesystemCodeModeSkill(nodePath.join(skillRoot, "SKILL.md"));
      expect(execDescription([skill])).toContain("skills.read(name,");
      await expect(readCodeModeSkill(skill, undefined, "modules/during-dining.md")).resolves.toBe(
        "# dining\n",
      );
      await expect(readCodeModeSkill(skill, undefined, "../secret.md")).rejects.toThrow(
        /invalid skill relative path/,
      );
      await expect(readCodeModeSkill(skill, undefined, "missing.md")).rejects.toThrow(
        'skill relative file not-found: "missing.md"',
      );
      await expect(readCodeModeSkill(skill, undefined, "modules")).rejects.toThrow(
        'skill relative file not-file: "modules"',
      );
      await expect(readCodeModeSkill(skill, undefined, "huge.md")).rejects.toThrow(
        'skill relative file exceeds 256000 bytes: "huge.md"',
      );
      if (process.platform !== "win32") {
        await expect(readCodeModeSkill(skill, undefined, "modules/link.md")).rejects.toThrow(
          /escapes skill root/,
        );
        await expect(readCodeModeSkill(skill, undefined, "modules/alias.md")).rejects.toThrow(
          /escapes skill root/,
        );
      }
      const aborted = new AbortController();
      aborted.abort();
      await expect(
        readCodeModeSkill(skill, aborted.signal, "modules/during-dining.md"),
      ).rejects.toMatchObject({ name: "AbortError" });

      const {
        config,
        catalogRef,
        tools: codeModeTools,
      } = createCodeModeHarness({
        codeModeSkills: [skill],
      });
      applyCodeModeCatalog({
        tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
        config,
        sessionId: "session-code-mode",
        sessionKey: "agent:main:main",
        runId: "run-code-mode",
        catalogRef,
        codeModeSkills: [skill],
      });
      const details = await runUntilCompleted({
        execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
        waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
        code: `
          const moduleBody = await skills.read("demo", "modules/during-dining.md");
          let missing;
          try { await skills.read("demo", "missing.md"); } catch (error) { missing = error.message; }
          let escaped;
          try { await skills.read("demo", "../secret.md"); } catch (error) { escaped = error.message; }
          return { moduleBody, missing, escaped };
        `,
      });
      expect(details.status).toBe("completed");
      const value = details.value as { moduleBody: string; missing: string; escaped: string };
      expect(value.moduleBody).toBe("# dining\n");
      expect(value.missing).toMatch(/^skill relative file not-found: "missing.md"/);
      expect(value.missing).not.toMatch(/escapes skill root/);
      expect(value.escaped).toBe('invalid skill relative path "../secret.md"');

      if (process.platform !== "win32") {
        const replacementRoot = nodePath.join(tmpParent, "replacement");
        const selectedRoot = nodePath.join(tmpParent, "selected-demo");
        await fs.mkdir(nodePath.join(replacementRoot, "modules"), { recursive: true });
        await fs.writeFile(
          nodePath.join(replacementRoot, "modules", "during-dining.md"),
          "REPLACED_BYTES",
          "utf8",
        );
        await fs.rename(skillRoot, selectedRoot);
        await fs.symlink(replacementRoot, skillRoot, "dir");
        const replaced = await runUntilCompleted({
          execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
          waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
          code: `
            try { return { body: await skills.read("demo", "modules/during-dining.md") }; }
            catch (error) { return { rejected: true, message: error.message }; }
          `,
        });
        expect(JSON.stringify(replaced)).not.toContain("REPLACED_BYTES");
        expect(replaced.status).toBe("completed");
        expect((replaced.value as { rejected?: boolean; message?: string }).rejected).toBe(true);
        expect((replaced.value as { message?: string }).message).toMatch(/escapes skill root/);
      }
    } finally {
      await fs.rm(tmpParent, { recursive: true, force: true });
    }
  });

  it("reads a sandbox companion from the materialized host root", async () => {
    const tmpParent = await fs.realpath(
      await fs.mkdtemp(nodePath.join(os.tmpdir(), "oc-skill-sandbox-root-")),
    );
    try {
      const hostRoot = nodePath.join(tmpParent, "materialized");
      const unrelatedRoot = nodePath.join(tmpParent, "unrelated");
      await fs.mkdir(nodePath.join(hostRoot, "modules"), { recursive: true });
      await fs.mkdir(nodePath.join(unrelatedRoot, "modules"), { recursive: true });
      await fs.writeFile(nodePath.join(hostRoot, "SKILL.md"), "# skill\n", "utf8");
      await fs.writeFile(nodePath.join(hostRoot, "modules", "during-dining.md"), "HOST_OK", "utf8");
      await fs.writeFile(
        nodePath.join(unrelatedRoot, "modules", "during-dining.md"),
        "UNRELATED",
        "utf8",
      );
      const codeModeSkills = resolveCodeModeSkills({
        skillsPrompt: catalogPrompt(nodePath.join(unrelatedRoot, "SKILL.md")),
        candidates: [
          skillCandidate({
            name: "demo",
            description: "Demo skill",
            filePath: nodePath.join(unrelatedRoot, "SKILL.md"),
            hostFilePath: nodePath.join(hostRoot, "SKILL.md"),
          }),
        ],
      });
      expect(codeModeSkills[0]?.source.filePath).toBe(nodePath.join(hostRoot, "SKILL.md"));
      await expect(
        readCodeModeSkill(codeModeSkills[0]!, undefined, "modules/during-dining.md"),
      ).resolves.toBe("HOST_OK");
    } finally {
      await fs.rm(tmpParent, { recursive: true, force: true });
    }
  });

  it("does not advertise or serve companion reads for node or workspace skills", async () => {
    const nodeSkill: CodeModeSkill = {
      name: "demo",
      description: "demo",
      location: "node://node-1/skills/demo/SKILL.md",
      source: { filePath: "node://node-1/skills/demo/SKILL.md", readContent: "# skill\n" },
      reader: vi.fn(async () => "# dining\n"),
    };
    const nodeDescription = execDescription([nodeSkill]);
    expect(nodeDescription).toContain("`await skills.read(name)`");
    expect(nodeDescription).not.toContain("skills.read(name,");
    for (const relativePath of ["modules/x.md", "%2e%2e/other/SKILL.md", "%252e%252e/secret.md"]) {
      await expect(readCodeModeSkill(nodeSkill, undefined, relativePath)).rejects.toThrow(
        /node-hosted skill companion reads are unavailable/,
      );
    }
    expect(nodeSkill.reader).not.toHaveBeenCalled();

    const workspaceSkill: CodeModeSkill = {
      name: "demo",
      description: "demo",
      location: "/workspace/skills/demo/SKILL.md",
      source: {
        filePath: "/remote/skills/demo/SKILL.md",
        fileHost: "workspace",
        readContent: "# skill\n",
      },
    };
    const workspaceDescription = execDescription([workspaceSkill]);
    expect(workspaceDescription).not.toContain("skills.read(name,");
    await expect(readCodeModeSkill(workspaceSkill, undefined, "modules/foo.md")).rejects.toThrow(
      /workspace skill companion reads are unavailable/,
    );
    await expect(readCodeModeSkill(workspaceSkill)).resolves.toBe("# skill\n");
  });

  it.each([
    {
      name: "existing ordinary file",
      path: "notes.txt",
      content: "ordinary file content",
      expected: { kind: "text", content: "ordinary file content" },
    },
    {
      name: "missing implicitly optional daily memory",
      path: "memory/2026-05-15.md",
      expected: {
        kind: "not_found",
        status: "not_found",
        path: "memory/2026-05-15.md",
        optional: true,
      },
    },
  ])(
    "returns $name through the wrapped Code Mode boundary",
    async ({ path, content, expected }) => {
      const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
      const read = createOpenClawReadTool(
        createReadTool("/workspace", {
          operations: {
            access: async () => {
              if (content === undefined) {
                throw Object.assign(new Error("missing"), { code: "ENOENT" });
              }
            },
            readFile: async () => Buffer.from(content ?? "unreachable"),
          },
        }) as unknown as Parameters<typeof createOpenClawReadTool>[0],
      );
      applyCodeModeCatalog({
        tools: [...codeModeTools, read],
        config,
        sessionId: "session-code-mode",
        sessionKey: "agent:main:main",
        runId: "run-code-mode",
        catalogRef,
      });

      const details = await runUntilCompleted({
        execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
        waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
        code: `return await read(${JSON.stringify({ path })});`,
      });

      expect(details).toMatchObject({ status: "completed", value: expected });
    },
  );
});

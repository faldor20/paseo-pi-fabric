import { describe, expect, it } from "vitest";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { transformFabricExec } from "./client/transform-fabric";
import { collectFabricMirrorCandidates, mirrorFabricChildren } from "./server/fabric-sync";
import {
  extractFabricContent,
  summarizeFabricCode,
  summarizeFabricResult,
} from "./shared/fabric";

function fabricToolCall(input: unknown, output: unknown, status: "running" | "completed" | "failed" | "canceled" = "completed") {
  return {
    type: "tool_call" as const,
    callId: "fabric-1",
    name: "fabric_exec",
    status,
    error: null,
    detail: { type: "unknown" as const, input, output },
  };
}

const PROGRAM = `const [manifest, sources] = await Promise.all([
  pi.read({ path: "package.json" }),
  pi.find({ pattern: "**/*.ts", path: "src" }),
]);
const review = await agents.run({ task: "Review the diff.", tools: ["read", "grep"] });
return { review };`;

describe("summarizeFabricCode", () => {
  it("counts dotted host-call refs", () => {
    const summary = summarizeFabricCode(PROGRAM);
    expect(summary.lineCount).toBe(6);
    expect(summary.nestedCalls).toContainEqual({ ref: "pi.read", count: 1 });
    expect(summary.nestedCalls).toContainEqual({ ref: "pi.find", count: 1 });
    expect(summary.nestedCalls).toContainEqual({ ref: "agents.run", count: 1 });
  });

  it("truncates long programs", () => {
    const summary = summarizeFabricCode(`return 1;\n`.repeat(500));
    expect(summary.codePreview.endsWith("…")).toBe(true);
  });
});

describe("transformFabricExec", () => {
  it("claims fabric_exec and builds a card", () => {
    const result = transformFabricExec({
      phase: "complete",
      item: fabricToolCall({ code: PROGRAM }, { ok: true }),
    });
    expect(result?.items[0]).toMatchObject({
      type: "plugin",
      kind: "fabric-exec",
      version: 1,
    });
    const data = result?.items[0] as unknown as { data: { nestedCalls: unknown[] } };
    expect(data.data.nestedCalls.length).toBeGreaterThan(0);
  });

  it("keeps rows without program source unchanged", () => {
    expect(
      transformFabricExec({ phase: "complete", item: fabricToolCall({ timeoutMs: 1 }, {}) }),
    ).toBeUndefined();
  });

  it("ignores other tools", () => {
    const item = { ...fabricToolCall({ code: PROGRAM }, {}), name: "bash" };
    expect(transformFabricExec({ phase: "complete", item })).toBeUndefined();
  });

  it("marks running calls as running", () => {
    const result = transformFabricExec({
      phase: "streaming",
      item: fabricToolCall({ code: PROGRAM }, null, "running"),
    });
    const data = result?.items[0] as unknown as { data: { status: string } };
    expect(data.data.status).toBe("running");
  });
});

describe("summarizeFabricResult", () => {
  it("extracts top-level agent arrays and previews the rest", () => {
    const summary = summarizeFabricResult({
      agents: [{ name: "review", status: "completed", model: "anthropic/claude-haiku-4-5" }],
    });
    expect(summary.agents).toEqual([
      { name: "review", status: "completed", model: "anthropic/claude-haiku-4-5" },
    ]);
    expect(summary.resultPreview).toContain("review");
  });

  it("returns no entries for unfamiliar envelopes", () => {
    const summary = summarizeFabricResult({ something: "else" });
    expect(summary.agents).toEqual([]);
    expect(summary.resultPreview).toContain("something");
  });
});

describe("collectFabricMirrorCandidates", () => {
  it("collects terminal children and skips running ones", () => {
    const candidates = collectFabricMirrorCandidates([
      fabricToolCall(
        { code: PROGRAM },
        {
          agents: [
            { name: "review", status: "completed" },
            { name: "audit", status: "running" },
          ],
        },
      ),
    ]);
    expect(candidates.map((candidate) => candidate.name)).toEqual(["review"]);
    expect(candidates[0]?.data.status).toBe("completed");
    expect(candidates[0]?.data.agents).toHaveLength(1);
  });

  it("ignores non-fabric rows", () => {
    expect(collectFabricMirrorCandidates([])).toEqual([]);
  });
});

describe("mirror status mapping", () => {
  it.each([
    ["completed", "completed"],
    ["failed", "failed"],
    ["stopped", "canceled"],
    ["timed_out", "failed"],
  ])("maps fabric %s to card %s and preserves the original", (fabricStatus, cardStatus) => {
    const [candidate] = collectFabricMirrorCandidates([
      fabricToolCall({ code: PROGRAM }, { agents: [{ name: "worker", status: fabricStatus }] }),
    ]);
    expect(candidate?.data.status).toBe(cardStatus);
    expect(candidate?.data.originalStatus).toBe(fabricStatus);
  });
});

interface StubMirrorRecord {
  parentAgentId: string | null;
  labels: Record<string, string>;
}

interface StubParentSnapshot {
  provider: string;
  model: string | null;
}

function stubPaseo(
  existing: StubMirrorRecord[] = [],
  parentSnapshot: StubParentSnapshot | null = { provider: "pi", model: "openai-codex/gpt-5.6-luna" },
) {
  const created: Array<{
    labels: Record<string, string>;
    title?: string;
    cwd?: string;
    config?: { provider?: string };
  }> = [];
  const appended: unknown[] = [];
  const paseo = {
    agents: {
      list: async () => ({
        entries: existing.map((record) => ({
          agent: { parentAgentId: record.parentAgentId, labels: record.labels },
        })),
        pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
      }),
      ref: () => ({
        current: () =>
          parentSnapshot === null
            ? null
            : { provider: parentSnapshot.provider, model: parentSnapshot.model },
        refresh: async () =>
          parentSnapshot === null
            ? null
            : {
                agent: { provider: parentSnapshot.provider, model: parentSnapshot.model },
              },
      }),
      create: async (options: {
        labels?: Record<string, string>;
        title?: string;
        cwd?: string;
        config?: { provider?: string };
      }) => {
        created.push({
          labels: options.labels ?? {},
          title: options.title,
          cwd: options.cwd,
          config: options.config,
        });
        return {
          timeline: {
            append: async (item: unknown) => {
              appended.push(item);
            },
          },
        };
      },
    },
  } as unknown as PluginHandlerContext["paseo"];
  return { paseo, created, appended };
}

const TWO_CHILD_CALL = fabricToolCall({ code: PROGRAM }, {
  agents: [
    { name: "review", status: "completed" },
    { name: "audit", status: "failed" },
  ],
});

describe("mirrorFabricChildren", () => {
  it("mirrors every terminal child of one call, not just the first", async () => {
    const { paseo, created, appended } = stubPaseo();
    const result = await mirrorFabricChildren({
      paseo,
      parentAgentId: "parent-1",
      cwd: "/tmp/work",
      timeline: [TWO_CHILD_CALL],
    });
    expect(result).toEqual({ mirrored: 2 });
    expect(created.map((agent) => agent.labels["pi-fabric.child-index"])).toEqual(["0", "1"]);
    expect(created.every((agent) => agent.labels["pi-fabric.call-id"] === "fabric-1")).toBe(true);
    expect(created.every((agent) => agent.labels["pi-fabric.parent"] === "parent-1")).toBe(true);
    expect(appended).toHaveLength(2);
  });

  it("creates nothing on re-run once mirrors exist", async () => {
    const first = stubPaseo();
    await mirrorFabricChildren({
      paseo: first.paseo,
      parentAgentId: "parent-1",
      cwd: "/tmp/work",
      timeline: [TWO_CHILD_CALL],
    });
    const existing = first.created.map((agent) => ({
      parentAgentId: "parent-1",
      labels: agent.labels,
    }));
    const second = stubPaseo(existing);
    const result = await mirrorFabricChildren({
      paseo: second.paseo,
      parentAgentId: "parent-1",
      cwd: "/tmp/work",
      timeline: [TWO_CHILD_CALL],
    });
    expect(result).toEqual({ mirrored: 0 });
    expect(second.created).toHaveLength(0);
  });

  it("treats legacy mirrors without a child-index label as the first child", async () => {
    const { paseo, created } = stubPaseo([
      {
        parentAgentId: "parent-1",
        labels: { "pi-fabric.mirror": "true", "pi-fabric.call-id": "fabric-1" },
      },
    ]);
    const result = await mirrorFabricChildren({
      paseo,
      parentAgentId: "parent-1",
      cwd: "/tmp/work",
      timeline: [TWO_CHILD_CALL],
    });
    expect(result).toEqual({ mirrored: 1 });
    expect(created[0]?.labels["pi-fabric.child-index"]).toBe("1");
  });

  it("dedupes the same call even when first mirrored under another parent", async () => {
    // Fabric tool-call IDs are unique per originating Pi session, so the key
    // is global: an import/resume double-mirror must not duplicate either.
    const { paseo, created } = stubPaseo([
      {
        parentAgentId: "parent-other",
        labels: {
          "pi-fabric.mirror": "true",
          "pi-fabric.call-id": "fabric-1",
          "pi-fabric.child-index": "0",
        },
      },
    ]);
    const result = await mirrorFabricChildren({
      paseo,
      parentAgentId: "parent-1",
      cwd: "/tmp/work",
      timeline: [TWO_CHILD_CALL],
    });
    expect(result).toEqual({ mirrored: 1 });
    expect(created).toHaveLength(1);
    expect(created[0]?.labels["pi-fabric.child-index"]).toBe("1");
  });

  it("creates the mirror as pi/<audit model>", async () => {
    const { paseo, created } = stubPaseo();
    const call = fabricToolCall(
      { code: PROGRAM },
      {
        details: {
          kernel: "typescript",
          audits: [
            {
              ref: "agents.run",
              tool: "run",
              provider: "agents",
              success: true,
              args: { task: "Review." },
              result: {
                id: "agent-9",
                name: "review",
                status: "completed",
                runner: "pi",
                model: "anthropic/claude-haiku-4-5",
                text: "done",
              },
            },
          ],
        },
      },
    );
    const result = await mirrorFabricChildren({
      paseo,
      parentAgentId: "parent-1",
      cwd: "/tmp/work",
      timeline: [call],
    });
    expect(result).toEqual({ mirrored: 1 });
    expect(created[0]?.config?.provider).toBe("pi/anthropic/claude-haiku-4-5");
  });

  it("falls back to the parent provider/model when the audit reports none", async () => {
    const { paseo, created } = stubPaseo();
    const result = await mirrorFabricChildren({
      paseo,
      parentAgentId: "parent-1",
      cwd: "/tmp/work",
      timeline: [TWO_CHILD_CALL],
    });
    expect(result).toEqual({ mirrored: 2 });
    expect(created.map((agent) => agent.config?.provider)).toEqual([
      "pi/openai-codex/gpt-5.6-luna",
      "pi/openai-codex/gpt-5.6-luna",
    ]);
  });

  it("skips children when neither audit nor parent supplies a model", async () => {
    const { paseo, created } = stubPaseo([], null);
    const result = await mirrorFabricChildren({
      paseo,
      parentAgentId: "parent-1",
      cwd: "/tmp/work",
      timeline: [TWO_CHILD_CALL],
    });
    expect(result.mirrored).toBe(0);
    expect(result.note).toContain("skipped");
    expect(created).toHaveLength(0);
  });

  it("skips non-pi runners; their outcome stays on the parent card", async () => {
    const candidates = collectFabricMirrorCandidates([
      fabricToolCall(
        { code: PROGRAM },
        {
          details: {
            audits: [
              {
                ref: "agents.run",
                tool: "run",
                provider: "agents",
                success: true,
                args: {},
                result: { name: "review", status: "completed", runner: "claude", text: "done" },
              },
            ],
          },
        },
      ),
    ]);
    expect(candidates).toEqual([]);
  });

  it("defers instead of duplicating when the agent list fails", async () => {
    let creates = 0;
    const paseo = {
      agents: {
        list: async () => {
          throw new Error("list unavailable");
        },
        create: async () => {
          creates += 1;
          throw new Error("must not create while dedupe is blind");
        },
      },
    } as unknown as PluginHandlerContext["paseo"];
    const result = await mirrorFabricChildren({
      paseo,
      parentAgentId: "parent-1",
      cwd: "/tmp/work",
      timeline: [TWO_CHILD_CALL],
    });
    expect(result.mirrored).toBe(0);
    expect(result.note).toMatch(/deferred/);
    expect(creates).toBe(0);
  });

  it("caps mirrors per sync and reports the overflow", async () => {
    const many = fabricToolCall(
      { code: PROGRAM },
      {
        agents: Array.from({ length: 12 }, (_, index) => ({
          name: `agent-${index}`,
          status: "completed",
        })),
      },
    );
    const { paseo, created } = stubPaseo();
    const result = await mirrorFabricChildren({
      paseo,
      parentAgentId: "parent-1",
      cwd: "/tmp/work",
      timeline: [many],
    });
    expect(created).toHaveLength(10);
    expect(result.mirrored).toBe(10);
    expect(result.note).toMatch(/2 further children deferred/);
  });
});

// Trimmed REDACTED capture of a completed fabric_exec (Pi 0.85.1,
// pi-fabric 0.92.10): child results live in details.audits, not in a
// top-level `agents` array.
const ENVELOPE_INPUT = {
  code: PROGRAM,
  resultFormat: "auto",
  display: { name: "review" },
};

const ENVELOPE_OUTPUT = {
  content: [{ type: "text", text: "Review complete: 2 findings." }],
  details: {
    success: true,
    kernel: "typescript",
    trace: {
      kind: "pi-fabric.execution",
      version: 1,
      outcome: "succeeded",
      phases: [],
      operations: [
        {
          type: "call",
          sequence: 1,
          ref: "agents.run",
          provider: "agents",
          action: "run",
          args: {},
          outcome: "succeeded",
        },
        {
          type: "call",
          sequence: 2,
          ref: "pi.read",
          provider: "pi",
          action: "read",
          args: {},
          outcome: "succeeded",
        },
      ],
      counts: {},
    },
    audits: [
      {
        ref: "agents.run",
        tool: "run",
        provider: "agents",
        success: true,
        args: { task: "Review the diff.", tools: ["read", "grep"] },
        result: {
          id: "agent-1",
          name: "review",
          task: "Review the diff.",
          status: "completed",
          runner: "pi",
          kernel: "typescript",
          cwd: "/tmp/child-work",
          model: "anthropic/claude-haiku-4-5",
          turns: 3,
          toolCalls: 5,
          text: "Review complete: 2 findings.",
        },
        resultTruncated: false,
        preview: { kind: "fabric-agent-tools", id: "agent-1", name: "review" },
      },
    ],
    phases: [],
  },
};

describe("extractFabricContent", () => {
  it("extracts the audit agent with task, text, model, and cwd", () => {
    const content = extractFabricContent(ENVELOPE_OUTPUT);
    expect(content.agents).toHaveLength(1);
    expect(content.agents[0]).toMatchObject({
      name: "review",
      status: "completed",
      model: "anthropic/claude-haiku-4-5",
      taskPreview: "Review the diff.",
      resultPreview: "Review complete: 2 findings.",
      id: "agent-1",
      cwd: "/tmp/child-work",
    });
    expect(content.kernel).toBe("typescript");
  });

  it("counts trace operations by ref", () => {
    const content = extractFabricContent(ENVELOPE_OUTPUT);
    expect(content.operations).toContainEqual({ ref: "agents.run", count: 1 });
    expect(content.operations).toContainEqual({ ref: "pi.read", count: 1 });
  });

  it("returns nothing for envelopes without details", () => {
    expect(extractFabricContent({ something: "else" })).toMatchObject({
      agents: [],
      actors: [],
      operations: [],
    });
  });
});

describe("trace/audit envelope end to end", () => {
  const call = fabricToolCall(ENVELOPE_INPUT, ENVELOPE_OUTPUT);

  it("transformer claims the call with trace-derived rows", () => {
    const result = transformFabricExec({ phase: "complete", item: call });
    const data = result?.items[0] as unknown as {
      data: {
        kernel?: string;
        agents: Array<{ name?: string }>;
        nestedCalls: Array<{ ref: string }>;
        resultPreview?: string;
      };
    };
    expect(data.data.kernel).toBe("typescript");
    expect(data.data.agents.map((agent) => agent.name)).toEqual(["review"]);
    expect(data.data.nestedCalls.map((nested) => nested.ref)).toContain("agents.run");
    expect(data.data.resultPreview).toContain("2 findings");
  });

  it("produces one mirror candidate carrying the audit cwd", () => {
    const candidates = collectFabricMirrorCandidates([call]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.name).toBe("review");
    expect(candidates[0]?.cwd).toBe("/tmp/child-work");
  });

  it("creates the mirror in the audit cwd, falling back to the parent cwd", async () => {
    const withCwd = stubPaseo();
    await mirrorFabricChildren({
      paseo: withCwd.paseo,
      parentAgentId: "parent-1",
      cwd: "/tmp/parent-work",
      timeline: [call],
    });
    expect(withCwd.created).toHaveLength(1);
    expect(withCwd.created[0]?.cwd).toBe("/tmp/child-work");

    const noAuditCwd = fabricToolCall(ENVELOPE_INPUT, {
      details: {
        kernel: "typescript",
        trace: { operations: [] },
        audits: [
          {
            ref: "agents.run",
            provider: "agents",
            args: { task: "Review the diff." },
            result: { name: "review", status: "completed" },
          },
        ],
      },
    });
    const fallback = stubPaseo();
    await mirrorFabricChildren({
      paseo: fallback.paseo,
      parentAgentId: "parent-1",
      cwd: "/tmp/parent-work",
      timeline: [noAuditCwd],
    });
    expect(fallback.created).toHaveLength(1);
    expect(fallback.created[0]?.cwd).toBe("/tmp/parent-work");
  });
});

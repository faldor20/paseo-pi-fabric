import { describe, expect, it } from "vitest";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { transformFabricExec } from "./client/transform-fabric";
import {
  appendMirrorCardOnce,
  collectFabricMirrorCandidates,
  ensureFabricMirror,
  mirrorFabricChildren,
} from "./server/fabric-sync";
import { startFabricLiveSync, stopFabricLiveSync } from "./server/live-sync";
import {
  extractFabricCalls,
  extractFabricContent,
  fabricChildKey,
  readFabricDisplay,
  summarizeFabricCode,
  summarizeFabricResult,
  titleHintForCode,
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
  id?: string;
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
  mirrorItems: Record<string, unknown[]> = {},
) {
  const created: Array<{
    id: string;
    labels: Record<string, string>;
    title?: string;
    cwd?: string;
    config?: { provider?: string };
  }> = [];
  const appended: unknown[] = [];
  const timelines = new Map<string, unknown[]>(Object.entries(mirrorItems));
  const seed = existing.map((record, index) => {
    const id = record.id ?? `existing-${index}`;
    if (!timelines.has(id)) timelines.set(id, []);
    return { ...record, id };
  });
  let nextMirror = 0;
  const paseo = {
    agents: {
      list: async (options?: { filter?: { labels?: Record<string, string> } }) => {
        const wanted = options?.filter?.labels ?? {};
        const matches = (labels: Record<string, string>) =>
          Object.entries(wanted).every(([key, value]) => labels[key] === value);
        const entries = seed
          .filter((record) => matches(record.labels))
          .map((record) => ({
            agent: { id: record.id, parentAgentId: record.parentAgentId, labels: record.labels },
          }));
        return {
          entries,
          pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
        };
      },
      ref: (id: string) => ({
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
        timeline: {
          refetch: async () => ({
            entries: (timelines.get(id) ?? []).map((item) => ({ item })),
            startCursor: null,
            hasOlder: false,
          }),
          append: async (item: unknown) => {
            appended.push(item);
            const items = timelines.get(id);
            if (items) items.push(item);
            else timelines.set(id, [item]);
          },
        },
      }),
      create: async (options: {
        labels?: Record<string, string>;
        title?: string;
        cwd?: string;
        config?: { provider?: string };
      }) => {
        const id = `mirror-${nextMirror++}`;
        created.push({
          id,
          labels: options.labels ?? {},
          title: options.title,
          cwd: options.cwd,
          config: options.config,
        });
        timelines.set(id, []);
        return {
          id,
          timeline: {
            append: async (item: unknown) => {
              appended.push(item);
              timelines.get(id)?.push(item);
            },
          },
        };
      },
    },
  } as unknown as PluginHandlerContext["paseo"];
  return { paseo, created, appended, timelines };
}

const TWO_CHILD_CALL = fabricToolCall({ code: PROGRAM }, {
  agents: [
    { name: "review", status: "completed" },
    { name: "audit", status: "failed" },
  ],
});

const ONE_CHILD_CALL = fabricToolCall({ code: PROGRAM }, {
  agents: [{ name: "review", status: "completed" }],
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
      id: agent.id,
      parentAgentId: "parent-1",
      labels: agent.labels,
    }));
    // The second sync sees the same daemon state, cards included: nothing to do.
    const second = stubPaseo(existing, undefined, Object.fromEntries(first.timelines));
    const result = await mirrorFabricChildren({
      paseo: second.paseo,
      parentAgentId: "parent-1",
      cwd: "/tmp/work",
      timeline: [TWO_CHILD_CALL],
    });
    expect(result).toEqual({ mirrored: 0 });
    expect(second.created).toHaveLength(0);
    expect(second.appended).toHaveLength(0);
  });

  it("treats legacy mirrors without a child-index label as the first child", async () => {
    const { paseo, created } = stubPaseo(
      [
        {
          parentAgentId: "parent-1",
          labels: { "pi-fabric.mirror": "true", "pi-fabric.call-id": "fabric-1" },
        },
      ],
      undefined,
      // The legacy mirror already carries its card; only the second child is due.
      { "existing-0": [{ type: "plugin", id: "fabric-mirror-fabric-1-0" }] },
    );
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
    const { paseo, created } = stubPaseo(
      [
        {
          parentAgentId: "parent-other",
          labels: {
            "pi-fabric.mirror": "true",
            "pi-fabric.call-id": "fabric-1",
            "pi-fabric.child-index": "0",
          },
        },
      ],
      undefined,
      // The other-parent mirror already carries its card; only the second child is due.
      { "existing-0": [{ type: "plugin", id: "fabric-mirror-fabric-1-0" }] },
    );
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

  it("reconciles the final card onto an existing cardless live mirror", async () => {
    const { paseo, created, appended } = stubPaseo([
      {
        id: "mirror-0",
        parentAgentId: "parent-1",
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
      timeline: [ONE_CHILD_CALL],
    });
    expect(result).toEqual({ mirrored: 1 });
    expect(created).toHaveLength(0);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ id: "fabric-mirror-fabric-1-0" });
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

describe("fabricChildKey", () => {
  it("prefers nestedToolCallId when present", () => {
    expect(fabricChildKey("call-1", 0, "nested-9")).toBe("call-1~nested-9");
  });

  it("falls back to callId#index", () => {
    expect(fabricChildKey("call-1", 2)).toBe("call-1#2");
    expect(fabricChildKey("call-1", 0, "")).toBe("call-1#0");
    expect(fabricChildKey("call-1", 1, undefined)).toBe("call-1#1");
  });

  it("flows from audits onto candidates, never into the card row", () => {
    const [candidate] = collectFabricMirrorCandidates(
      [
        fabricToolCall(
          { code: PROGRAM },
          {
            details: {
              audits: [
                {
                  ref: "agents.run",
                  provider: "agents",
                  nestedToolCallId: "nested-9",
                  args: { task: "Do it." },
                },
              ],
            },
          },
          "running",
        ),
      ],
      { includeRunning: true },
    );
    expect(candidate?.nestedToolCallId).toBe("nested-9");
    expect(candidate?.data.agents[0]).not.toHaveProperty("nestedToolCallId");
  });
});

describe("live (includeRunning) collection", () => {
  // In-flight shape: the running fabric_exec row carries args/startedAt but
  // no success/result/endedAt yet.
  const INFLIGHT_CALL = fabricToolCall(
    { code: PROGRAM },
    {
      details: {
        kernel: "typescript",
        audits: [
          {
            ref: "agents.run",
            tool: "run",
            provider: "agents",
            args: { task: "Review the diff.", tools: ["read"] },
            startedAt: "2026-09-17T00:00:00.000Z",
          },
        ],
      },
    },
    "running",
  );

  it("excludes running children by default", () => {
    expect(collectFabricMirrorCandidates([INFLIGHT_CALL])).toEqual([]);
  });

  it("shells in-flight audits as running mirrors in includeRunning mode", () => {
    const [candidate] = collectFabricMirrorCandidates([INFLIGHT_CALL], { includeRunning: true });
    expect(candidate?.data.originalStatus).toBe("running");
    expect(candidate?.name).toBe("fabric-agent-1");
    expect(candidate?.data.codePreview).toContain("Review the diff.");
    // No model is reported mid-flight; the parent fallback applies at ensure.
    expect(candidate?.provider).toBeNull();
  });

  it("maps success-undefined audits to status running", () => {
    const summary = summarizeFabricResult({
      details: {
        audits: [{ ref: "agents.run", provider: "agents", args: { task: "Do it." } }],
      },
    });
    expect(summary.agents).toHaveLength(1);
    expect(summary.agents[0]?.status).toBe("running");
  });

  it("includes unknown-status children only in includeRunning mode", () => {
    const timeline = [
      fabricToolCall({ code: PROGRAM }, { agents: [{ name: "odd", status: "mystery" }] }),
    ];
    expect(collectFabricMirrorCandidates(timeline)).toEqual([]);
    const [candidate] = collectFabricMirrorCandidates(timeline, { includeRunning: true });
    expect(candidate?.name).toBe("odd");
    expect(candidate?.data.originalStatus).toBe("unknown");
  });
});

describe("persistent actor ops are never mirrored", () => {
  // Regression: create/ask/tell share provider "agents" with run/spawn but
  // message an existing actor by id. Each used to shell a new orphan paseo
  // subagent per message (live loop, unknown status, per-call keys).
  const ASK_AUDIT = {
    ref: "agents.ask",
    provider: "agents",
    success: true,
    args: { id: "actor-1", message: "Do the thing." },
    result: { id: "m-1", actorId: "actor-1", actorName: "worker", text: "Done." },
  };
  const TELL_AUDIT = {
    ref: "agents.tell",
    provider: "agents",
    success: true,
    args: { id: "actor-1", message: "Ping." },
    result: { queued: true, messageId: "m-2", routed: "local" },
  };
  const CREATE_AUDIT = {
    ref: "agents.create",
    provider: "agents",
    success: true,
    args: { name: "worker" },
    result: { id: "actor-1", name: "worker", status: "idle" },
  };

  it.each([[ASK_AUDIT], [TELL_AUDIT], [CREATE_AUDIT]])(
    "collects no candidates for %o in either mode",
    (audit) => {
      const output = { details: { audits: [audit] } };
      expect(collectFabricMirrorCandidates([fabricToolCall({ code: PROGRAM }, output)])).toEqual([]);
      expect(
        collectFabricMirrorCandidates([fabricToolCall({ code: PROGRAM }, output)], {
          includeRunning: true,
        }),
      ).toEqual([]);
    },
  );

  it("ignores in-flight actor messages in the live loop", () => {
    const output = {
      details: { audits: [{ ref: "agents.ask", provider: "agents", args: { id: "actor-1" } }] },
    };
    expect(
      collectFabricMirrorCandidates([fabricToolCall({ code: PROGRAM }, output, "running")], {
        includeRunning: true,
      }),
    ).toEqual([]);
  });

  it("keeps actor ops off the card while a sibling run still mirrors", () => {
    const output = {
      details: {
        audits: [
          ASK_AUDIT,
          TELL_AUDIT,
          {
            ref: "agents.run",
            provider: "agents",
            success: true,
            args: { task: "Review." },
            result: { id: "agent-1", name: "review", status: "completed", text: "ok" },
          },
        ],
      },
    };
    expect(summarizeFabricResult(output).agents.map((agent) => agent.name)).toEqual(["review"]);
    const candidates = collectFabricMirrorCandidates([fabricToolCall({ code: PROGRAM }, output)]);
    expect(candidates.map((candidate) => candidate.name)).toEqual(["review"]);
  });
});

describe("ensureFabricMirror + appendMirrorCardOnce", () => {
  it("ensure creates the mirror without appending any card", async () => {
    const { paseo, created, appended } = stubPaseo();
    const [candidate] = collectFabricMirrorCandidates([ONE_CHILD_CALL]);
    const ensured = await ensureFabricMirror(paseo, "parent-1", "/tmp/work", candidate!);
    expect(ensured?.created).toBe(true);
    expect(typeof ensured?.mirrorAgentId).toBe("string");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      title: "fabric: review",
      cwd: "/tmp/work",
      config: { provider: "pi/openai-codex/gpt-5.6-luna" },
    });
    expect(appended).toHaveLength(0);
  });

  it("ensure returns the existing mirror instead of creating", async () => {
    const { paseo, created } = stubPaseo([
      {
        id: "mirror-0",
        parentAgentId: "parent-1",
        labels: {
          "pi-fabric.mirror": "true",
          "pi-fabric.call-id": "fabric-1",
          "pi-fabric.child-index": "0",
        },
      },
    ]);
    const [candidate] = collectFabricMirrorCandidates([ONE_CHILD_CALL]);
    const ensured = await ensureFabricMirror(paseo, "parent-1", "/tmp/work", candidate!);
    expect(ensured).toEqual({ mirrorAgentId: "mirror-0", created: false });
    expect(created).toHaveLength(0);
  });

  it("appends the card when absent, skips when present", async () => {
    const { paseo, appended } = stubPaseo();
    const [candidate] = collectFabricMirrorCandidates([ONE_CHILD_CALL]);
    expect(
      await appendMirrorCardOnce(paseo, "mirror-9", "fabric-1", 0, candidate!.data),
    ).toBe(true);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ id: "fabric-mirror-fabric-1-0", kind: "fabric-exec" });
    expect(
      await appendMirrorCardOnce(paseo, "mirror-9", "fabric-1", 0, candidate!.data),
    ).toBe(false);
    expect(appended).toHaveLength(1);
  });
});

describe("fabric live sync", () => {
  it("shells running children without appending cards", async () => {
    const runningCall = fabricToolCall(
      { code: PROGRAM },
      {
        details: {
          audits: [{ ref: "agents.run", provider: "agents", args: { task: "Review." } }],
        },
      },
      "running",
    );
    const { paseo, created, appended } = stubPaseo([], undefined, { "parent-1": [runningCall] });
    startFabricLiveSync(paseo, { id: "parent-1", cwd: "/tmp/work" }, "turn-1");
    await new Promise((resolve) => setTimeout(resolve, 50));
    stopFabricLiveSync("parent-1");
    expect(created).toHaveLength(1);
    expect(created[0]?.title).toBe("fabric: fabric-agent-1");
    expect(appended).toHaveLength(0);
  });
});

describe("readFabricDisplay", () => {
  it("reads the object form", () => {
    expect(readFabricDisplay({ name: "review", description: "Check the diff" })).toEqual({
      name: "review",
      description: "Check the diff",
    });
  });

  it("repairs a bare string to a name", () => {
    expect(readFabricDisplay("review")).toEqual({ name: "review" });
  });

  it("parses a JSON-object string", () => {
    expect(readFabricDisplay(`{"name": "review"}`)).toEqual({ name: "review" });
  });

  it("yields nothing for blank or unfamiliar shapes", () => {
    expect(readFabricDisplay("   ")).toEqual({});
    expect(readFabricDisplay({ label: "review" })).toEqual({});
    expect(readFabricDisplay(null)).toEqual({});
  });
});

describe("titleHintForCode", () => {
  it("joins dominant verbs", () => {
    expect(titleHintForCode(PROGRAM)).toBe("Read + Run");
  });

  it("marks repetition", () => {
    const code = `await pi.bash({ cmd: "a" });\nawait pi.bash({ cmd: "b" });`;
    expect(titleHintForCode(code)).toBe("Shell ×2");
  });

  it("returns undefined when no host calls are found", () => {
    expect(titleHintForCode("return 42;")).toBeUndefined();
  });
});

describe("extractFabricCalls", () => {
  const details = {
    audits: [
      {
        ref: "agents.run",
        provider: "agents",
        success: true,
        args: { task: "List the files in the current directory and report back." },
        result: { name: "lister", status: "completed" },
      },
      {
        ref: "pi.bash",
        provider: "pi",
        success: false,
        args: { command: "ls -la /tmp\nsecond line" },
        result: { ok: false },
      },
      {
        ref: "pi.read",
        provider: "pi",
        success: true,
        args: { path: "package.json" },
        result: "contents",
      },
    ],
  };

  it("builds one row per audit with Pi-style detail", () => {
    expect(extractFabricCalls(details)).toEqual([
      { ref: "agents.run", tool: "run", detail: "List the files in the current directory and report back.", success: true },
      { ref: "pi.bash", tool: "bash", detail: "$ ls -la /tmp", success: false },
      { ref: "pi.read", tool: "read", detail: "package.json", success: true },
    ]);
  });

  it("falls back to the task text when agents.run has no name", () => {
    const [call] = extractFabricCalls({
      audits: [
        {
          ref: "agents.run",
          provider: "agents",
          success: true,
          args: { task: "Do the thing." },
          result: { status: "completed" },
        },
      ],
    });
    expect(call).toMatchObject({ tool: "run", detail: "Do the thing." });
  });

  it("returns nothing without an audits array", () => {
    expect(extractFabricCalls({})).toEqual([]);
  });
});

describe("Pi-compact card data", () => {
  it("prefers display.name over the code hint for the title", () => {
    const result = transformFabricExec({
      phase: "complete",
      item: fabricToolCall(ENVELOPE_INPUT, ENVELOPE_OUTPUT),
    });
    const data = result?.items[0] as unknown as {
      data: { displayName?: string; titleHint?: string; calls: Array<{ tool: string }> };
    };
    expect(data.data.displayName).toBe("review");
    expect(data.data.titleHint).toBe("Read + Run");
    expect(data.data.calls.map((call) => call.tool)).toEqual(["run"]);
  });

  it("falls back to the hint when no display name is declared", () => {
    const result = transformFabricExec({
      phase: "complete",
      item: fabricToolCall({ code: PROGRAM }, ENVELOPE_OUTPUT),
    });
    const data = result?.items[0] as unknown as {
      data: { displayName?: string; titleHint?: string };
    };
    expect(data.data.displayName).toBeUndefined();
    expect(data.data.titleHint).toBe("Read + Run");
  });

  it("carries calls and the title hint onto mirror cards", () => {
    const [candidate] = collectFabricMirrorCandidates([
      fabricToolCall(ENVELOPE_INPUT, ENVELOPE_OUTPUT),
    ]);
    expect(candidate?.data.titleHint).toBe("Read + Run");
    expect(candidate?.data.calls.map((call) => call.tool)).toEqual(["run"]);
  });
});

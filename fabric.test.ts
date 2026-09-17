import { describe, expect, it } from "vitest";
import { transformFabricExec } from "./client/transform-fabric";
import { collectFabricMirrorCandidates } from "./server/fabric-sync";
import { summarizeFabricCode, summarizeFabricResult } from "./shared/fabric";

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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

// Best-effort readers for pi-fabric's durable mesh directory. Layout follows
// pi-fabric `docs/configuration.md` (`<project>/.pi/fabric/mesh`), but file
// shapes are version-dependent, so every reader validates before trusting and
// degrades to "not found" instead of throwing. See `docs/fabric-wire.md`.

export interface MeshActorEntry {
  name: string;
  status: string;
  detail?: string;
}

function findMeshRoot(cwd: string): string | null {
  let dir = cwd;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, ".pi", "fabric", "mesh");
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    } catch {
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function readJsonFile(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Project-scope registry (`mesh/actors/`) plus session-scope registries
// (`mesh/actors/<sessionId>/`). Entry filenames are not contracted, so every
// JSON file directly under those directories is probed.
export function listMeshActors(cwd: string): { root: string | null; actors: MeshActorEntry[] } {
  const root = findMeshRoot(cwd);
  if (!root) return { root, actors: [] };
  const actorsDir = join(root, "actors");
  const actors: MeshActorEntry[] = [];
  let scopes: string[];
  try {
    scopes = readdirSync(actorsDir);
  } catch {
    return { root, actors };
  }
  const dirs = ["", ...scopes.filter((name) => {
    try {
      return statSync(join(actorsDir, name)).isDirectory();
    } catch {
      return false;
    }
  })];
  for (const scope of dirs) {
    const dir = scope === "" ? actorsDir : join(actorsDir, scope);
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const parsed = readJsonFile(join(dir, file));
      if (!isRecord(parsed)) continue;
      // Single-actor definition or a map of name -> definition.
      const candidates = typeof parsed.name === "string" ? [parsed] : Object.values(parsed);
      for (const candidate of candidates) {
        if (!isRecord(candidate) || typeof candidate.name !== "string") continue;
        actors.push({
          name: candidate.name,
          status: typeof candidate.status === "string" ? candidate.status : "unknown",
          ...(typeof candidate.instructions === "string"
            ? { detail: candidate.instructions.slice(0, 160) }
            : {}),
        });
      }
    }
  }
  const seen = new Set<string>();
  return {
    root,
    actors: actors.filter((actor) => {
      if (seen.has(actor.name)) return false;
      seen.add(actor.name);
      return true;
    }),
  };
}

// Newest-first tail of an actor's mailbox/log. Fabric keeps the runner
// transcript as `session.jsonl` next to the actor record; when the layout is
// unrecognized an empty list is returned with the mesh root for debugging.
export function readMeshActorLog(
  cwd: string,
  actorName: string,
  limit: number,
): { entries: string[]; note?: string; root: string | null } {
  const { root } = listMeshActors(cwd);
  if (!root) return { entries: [], root, note: "No fabric mesh directory found above the agent cwd." };
  const hits: Array<{ mtime: number; line: string }> = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(dir, name);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (name !== "session.jsonl" && name !== "mailbox.jsonl") continue;
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      if (!text.includes(actorName)) continue;
      for (const line of text.split("\n").slice(-limit)) {
        const trimmed = line.trim();
        if (trimmed) hits.push({ mtime: stat.mtimeMs, line: trimmed.slice(0, 500) });
      }
    }
  };
  walk(join(root, "actors"), 0);
  hits.sort((a, b) => a.mtime - b.mtime);
  const entries = hits.slice(-limit).map((hit) => hit.line);
  return {
    entries,
    root,
    ...(entries.length === 0
      ? { note: `No log lines mentioning "${actorName}" under the actor registry.` }
      : {}),
  };
}

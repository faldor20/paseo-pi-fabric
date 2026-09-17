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

export function findMeshRoot(cwd: string): string | null {
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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// Project-scope registry (`mesh/actors/`) plus session-scope registries
// (`mesh/actors/<sessionId>/`). Only that one level is read: deeper subtrees
// (topics, shared state) are not actor records. Entry filenames are not
// contracted, so every JSON file directly under those directories is probed,
// but only single-actor definitions (`{ name, ... }`) are honored.
function actorScopeDirs(actorsDir: string): string[] {
  let scopes: string[];
  try {
    scopes = readdirSync(actorsDir);
  } catch {
    return [];
  }
  return [actorsDir, ...scopes.filter((name) => isDirectory(join(actorsDir, name)))];
}

export function listMeshActors(cwd: string): { root: string | null; actors: MeshActorEntry[] } {
  const root = findMeshRoot(cwd);
  if (!root) return { root, actors: [] };
  const actors: MeshActorEntry[] = [];
  for (const dir of actorScopeDirs(join(root, "actors"))) {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const parsed = readJsonFile(join(dir, file));
      if (!isRecord(parsed) || typeof parsed.name !== "string") continue;
      actors.push({
        name: parsed.name,
        status: typeof parsed.status === "string" ? parsed.status : "unknown",
        ...(typeof parsed.instructions === "string"
          ? { detail: parsed.instructions.slice(0, 160) }
          : {}),
      });
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
// transcript as `session.jsonl` next to the actor record, so only those two
// filenames directly under the actor scope directories are read — never a
// recursive walk. Lines are matched by actor-name mention because record
// shapes are still uncontracted (see `docs/fabric-wire.md`); when the layout
// is unrecognized an empty list is returned with a note for debugging.
export function readMeshActorLog(
  cwd: string,
  actorName: string,
  limit: number,
): { entries: string[]; note?: string; root: string | null } {
  const root = findMeshRoot(cwd);
  if (!root) return { entries: [], root, note: "No fabric mesh directory found above the agent cwd." };
  const hits: Array<{ mtime: number; line: string }> = [];
  for (const dir of actorScopeDirs(join(root, "actors"))) {
    for (const name of ["session.jsonl", "mailbox.jsonl"]) {
      const path = join(dir, name);
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      if (!text.includes(actorName)) continue;
      let mtime = 0;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      for (const line of text.split("\n").slice(-limit)) {
        const trimmed = line.trim();
        if (trimmed) hits.push({ mtime, line: trimmed.slice(0, 500) });
      }
    }
  }
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

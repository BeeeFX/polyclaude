import { promises as fs } from "node:fs";
import path from "node:path";
import { CLAUDE_DIR } from "./paths.js";

/**
 * Browse Claude Code's locally stored conversations
 * (~/.claude/projects/<project>/<sessionId>.jsonl). Each file is a resumable
 * session; we pull a title (first real user message), the working directory,
 * a message count and last-activity time so the user can pick one to continue.
 */

const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");

export interface Conversation {
  sessionId: string;
  file: string;
  cwd?: string;
  project: string;
  title: string;
  mtime: number;
  messages: number;
}

async function listFiles(): Promise<Array<{ file: string; mtime: number; project: string }>> {
  let projects;
  try {
    projects = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ file: string; mtime: number; project: string }> = [];
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, p.name);
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const full = path.join(dir, f);
      try {
        const st = await fs.stat(full);
        out.push({ file: full, mtime: st.mtimeMs, project: p.name });
      } catch {
        /* ignore */
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === "object" && (b as { type?: string }).type === "text") {
        const t = (b as { text?: string }).text;
        if (typeof t === "string") return t;
      }
    }
  }
  return undefined;
}

async function parseOne(
  file: string,
  mtime: number,
  project: string
): Promise<Conversation | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  const sessionId = path.basename(file, ".jsonl");
  let title = "";
  let cwd: string | undefined;
  let messages = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let d: {
      type?: string;
      isSidechain?: boolean;
      cwd?: string;
      message?: { role?: string; content?: unknown };
    };
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.cwd && !cwd) cwd = d.cwd;
    if ((d.type === "user" || d.type === "assistant") && d.message && !d.isSidechain) {
      messages++;
      if (!title && d.type === "user") {
        const t = extractText(d.message.content);
        // Skip tool results / system-style messages; keep the first real prompt.
        if (t && !t.startsWith("<") && t.trim()) {
          title = t.trim().replace(/\s+/g, " ").slice(0, 72);
        }
      }
    }
  }

  if (messages === 0) return null;
  if (!title) title = "(no preview)";
  return { sessionId, file, cwd, project, title, mtime, messages };
}

/** Most recent conversations, newest first. */
export async function list(limit = 40): Promise<Conversation[]> {
  const files = await listFiles();
  const out: Conversation[] = [];
  for (const f of files.slice(0, limit)) {
    const c = await parseOne(f.file, f.mtime, f.project);
    if (c) out.push(c);
  }
  return out;
}

import { createReadStream, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { STATE_DIR } from "./config.mjs";

const JIRA = /^[A-Z][A-Z0-9]+-\d+$/;
const UUIDISH = /^[0-9a-z][0-9a-z-]{7,}$/i;
const MAX_LINE = 2_000_000;

function defaults() {
  return {
    claudeProjectsDir: join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects"),
    codexSessionsDir: join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions"),
    tasksFile: join(STATE_DIR, "tasks.jsonl"),
  };
}

async function listJsonl(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listJsonl(full));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function taskRows(file) {
  let raw = "";
  try { raw = readFileSync(file, "utf8"); } catch { return []; }
  const latest = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!row?.sessionId) continue;
      const provider = row.provider === "codex" ? "codex" : "claude";
      const key = `${provider}:${row.sessionId}`;
      if (!latest.has(key) || String(row.ts || "") >= String(latest.get(key).ts || "")) {
        latest.set(key, { ...row, provider });
      }
    } catch { /* ignore malformed history */ }
  }
  return [...latest.values()];
}

function selectorParts(selector) {
  const trimmed = String(selector || "").trim();
  const prefixed = /^(claude|codex):(.*)$/i.exec(trimmed);
  if (prefixed) return { provider: prefixed[1].toLowerCase(), value: prefixed[2] };
  return { provider: null, value: trimmed };
}

async function firstSessionMeta(file, provider) {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let seen = 0;
  for await (const line of lines) {
    seen += 1;
    if (line.length > MAX_LINE) continue;
    try {
      const row = JSON.parse(line);
      if (provider === "codex" && row.type === "session_meta" && row.payload?.id) {
        lines.close(); input.destroy();
        return {
          sessionId: String(row.payload.id),
          cwd: typeof row.payload.cwd === "string" ? row.payload.cwd : null,
          timestamp: row.timestamp || row.payload.timestamp || "",
        };
      }
      if (provider === "claude" && row.sessionId) {
        lines.close(); input.destroy();
        return {
          sessionId: String(row.sessionId),
          cwd: typeof row.cwd === "string" ? row.cwd : null,
          timestamp: row.timestamp || "",
        };
      }
    } catch { /* continue */ }
    if (seen >= 200) break;
  }
  input.destroy();
  return null;
}

async function buildIndex(options) {
  const opts = { ...defaults(), ...options };
  const [claudeFiles, codexFiles] = await Promise.all([
    listJsonl(opts.claudeProjectsDir),
    listJsonl(opts.codexSessionsDir),
  ]);
  const rows = [];
  for (const [provider, files] of [["claude", claudeFiles], ["codex", codexFiles]]) {
    for (const file of files) {
      const meta = await firstSessionMeta(file, provider);
      if (meta) rows.push({ provider, file, ...meta });
    }
  }
  const tasks = taskRows(opts.tasksFile);
  const taskBySession = new Map(tasks.map((row) => [`${row.provider}:${row.sessionId}`, row]));
  const enriched = rows.map((row) => ({
    ...row,
    jira: taskBySession.get(`${row.provider}:${row.sessionId}`)?.jira || null,
    timestamp: taskBySession.get(`${row.provider}:${row.sessionId}`)?.ts || row.timestamp,
  }));
  const unique = new Map();
  for (const row of enriched) {
    const key = `${row.provider}:${row.sessionId}`;
    const current = unique.get(key);
    const exactFile = basename(row.file, ".jsonl").includes(row.sessionId);
    const currentExact = current && basename(current.file, ".jsonl").includes(row.sessionId);
    if (!current || (exactFile && !currentExact)) unique.set(key, row);
  }
  return [...unique.values()];
}

export async function findSessions(selector, options = {}) {
  const { provider, value } = selectorParts(selector);
  if (!value) throw new Error("session selector is required");
  const upper = value.toUpperCase();
  const isSessionId = UUIDISH.test(value) && value.includes("-");
  const jira = !isSessionId && JIRA.test(upper) ? upper : null;
  const index = await buildIndex(options);
  const filtered = index.filter((row) => {
    if (provider && row.provider !== provider) return false;
    if (jira) return row.jira === jira;
    if (isSessionId) return row.sessionId === value;
    return basename(row.cwd || "").toLowerCase() === value.toLowerCase();
  });
  return filtered.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && ["text", "input_text", "output_text"].includes(block.type))
    .map((block) => typeof block.text === "string" ? block.text : "")
    .filter(Boolean)
    .join("\n");
}

async function readMessages(session) {
  const messages = [];
  const input = createReadStream(session.file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line || line.length > MAX_LINE) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (session.provider === "claude") {
      if (row.sessionId !== session.sessionId || !["user", "assistant"].includes(row.type)) continue;
      const blocks = row.message?.content;
      if (row.type === "user" && Array.isArray(blocks)
          && blocks.some((block) => block?.type === "tool_result")) continue;
      const text = contentText(blocks);
      if (text) messages.push({ timestamp: row.timestamp || "", role: row.type, text });
      continue;
    }
    if (row.type !== "response_item" || row.payload?.type !== "message") continue;
    if (!["user", "assistant"].includes(row.payload.role)) continue;
    const text = contentText(row.payload.content);
    if (text) messages.push({ timestamp: row.timestamp || "", role: row.payload.role, text });
  }
  return messages;
}

function fitSections(sections, maxChars) {
  const joined = sections.join("\n\n");
  if (joined.length <= maxChars) return joined;
  const headSize = Math.floor(maxChars * 0.2);
  const tailSize = maxChars - headSize - 80;
  return `${joined.slice(0, headSize)}\n\n[...local context truncated...]\n\n${joined.slice(-tailSize)}`;
}

export async function renderContext(selector, options = {}) {
  const maxChars = Number.isFinite(options.maxChars) ? Math.max(2_000, options.maxChars) : 100_000;
  const sessions = await findSessions(selector, options);
  if (!sessions.length) throw new Error(`no local session found for ${selector}`);
  const sections = [
    "# CC Usage local context",
    `Selector: ${selector}`,
    "Privacy: read locally; prompt/response content is not uploaded by CC Usage.",
  ];
  for (const session of sessions) {
    sections.push(
      `## ${session.provider}:${session.sessionId}\n`
      + `Task: ${session.jira || "unassigned"}\nProject: ${session.cwd || "unknown"}`,
    );
    for (const message of await readMessages(session)) {
      sections.push(`[${message.timestamp}] ${message.role}:\n${message.text}`);
    }
  }
  return fitSections(sections, maxChars);
}

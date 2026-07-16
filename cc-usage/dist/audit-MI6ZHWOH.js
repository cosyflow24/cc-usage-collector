#!/usr/bin/env node
import { createRequire as __ccuCreateRequire } from 'module';
const require = __ccuCreateRequire(import.meta.url);
import "./chunk-HOACXCDS.js";

// src/audit.ts
import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
var KEY_RE = /^[A-Z][A-Z0-9]+-[0-9]+$/;
var MAX_FUTURE_MS = 24 * 36e5;
function isValidAuditTs(ts) {
  const ms = Date.parse(ts);
  return !Number.isNaN(ms) && ms <= Date.now() + MAX_FUTURE_MS;
}
function cjBase() {
  const base = process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");
  return path.join(base, "cc-jira");
}
function auditPath() {
  return path.join(cjBase(), "jira-audit.jsonl");
}
function auditHwmPath() {
  return path.join(cjBase(), "audit-sync.json");
}
function loadJiraAudit(sinceTs = "", file = auditPath()) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row.ts !== "string" || !isValidAuditTs(row.ts)) continue;
    if (typeof row.key !== "string" || !KEY_RE.test(row.key)) continue;
    if (typeof row.to !== "string" || !row.to) continue;
    if (typeof row.by !== "string" || !row.by) continue;
    if (row.ts < sinceTs) continue;
    rows.push({
      ts: row.ts,
      key: row.key,
      to: row.to,
      by: row.by,
      reason: typeof row.reason === "string" ? row.reason : null,
      verified: row.verified === true
    });
  }
  return rows;
}
function maxAuditTs(rows) {
  return rows.reduce((m, r) => isValidAuditTs(r.ts) && r.ts > m ? r.ts : m, "");
}
function readAuditHwm(file = auditHwmPath()) {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return typeof j.lastTs === "string" ? j.lastTs : "";
  } catch {
    return "";
  }
}
function writeAuditHwm(lastTs, file = auditHwmPath()) {
  writeFileSync(file, `${JSON.stringify({ lastTs })}
`);
}
export {
  auditHwmPath,
  auditPath,
  loadJiraAudit,
  maxAuditTs,
  readAuditHwm,
  writeAuditHwm
};

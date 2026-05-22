import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { StateportError, assertValidEventId, assertValidPortId } from "./store.js";

export const SUPPORTED_TARGETS = ["generic", "codex", "claude"];

function heading(title) {
  return `## ${title}\n`;
}

function eventRef(event) {
  return `${event.event_id} ${event.type} ${event.created_at}`;
}

function singleLine(text, maxLength = 88) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(empty)";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function listEvents(events, emptyText) {
  if (events.length === 0) {
    return `- [unknown] ${emptyText}\n`;
  }

  return events
    .map((event) => `- [${event.claim}] ${event.text} (timeline: ${eventRef(event)})`)
    .join("\n")
    .concat("\n");
}

function quoteText(text) {
  return text
    .split("\n")
    .map((line) => `  > ${line}`)
    .join("\n");
}

function gitSummary(port) {
  const git = port.git || {};
  if (!git.git_root) {
    return "- [unknown] No git repository was detected for this workspace.\n";
  }

  return [
    `- [confirmed] Git root: ${git.git_root}`,
    `- [confirmed] Branch: ${git.branch || "unknown"}`,
    `- [confirmed] HEAD: ${git.head || "unknown"}`
  ].join("\n").concat("\n");
}

function changedFiles(port, options = {}) {
  if (options.historical) {
    return "- [unknown] Changed files were not captured for the selected historical continuation point.\n";
  }

  if (!port.git?.git_root) {
    return "- [unknown] No git repository was available, so changed files were not captured.\n";
  }

  const files = port.git?.changed_files || [];
  if (files.length === 0) {
    return "- [confirmed] No changed files were detected by git status at the last snapshot.\n";
  }

  return files.map((file) => `- [confirmed] ${file}`).join("\n").concat("\n");
}

function latestEventsByType(port, type) {
  return port.timeline.filter((event) => event.type === type);
}

function timelineThroughEvent(port, eventId) {
  if (!eventId) {
    return {
      continuationPoint: null,
      timeline: port.timeline
    };
  }

  assertValidEventId(eventId);
  const eventIndex = port.timeline.findIndex((event) => event.event_id === eventId);
  if (eventIndex === -1) {
    throw new StateportError(`Unknown Semantic Timeline event: ${eventId}`);
  }

  return {
    continuationPoint: port.timeline[eventIndex],
    timeline: port.timeline.slice(0, eventIndex + 1)
  };
}

function targetIntro(target) {
  if (target === "codex") {
    return "You are Codex continuing work in this repo.";
  }

  if (target === "claude") {
    return "You are Claude Code continuing work in this repo.";
  }

  return "You are a coding agent continuing work in this repo.";
}

function renderContinuationPoint(view) {
  if (!view.continuationPoint) {
    return "- [confirmed] Continue from the latest captured context.";
  }

  return [
    `- [confirmed] Event: ${eventRef(view.continuationPoint)}`,
    `- [${view.continuationPoint.claim}] Event text:`,
    quoteText(view.continuationPoint.text)
  ].join("\n");
}

export function renderTimeline(port, options = {}) {
  assertValidPortId(port.port_id);
  const selector = options.selector || port.port_id;
  const rows = port.timeline.map((event) => {
    const timestamp = event.created_at.slice(0, 19);
    return `${event.event_id}  ${timestamp}  ${event.type.padEnd(8)}  ${event.claim.padEnd(13)}  ${singleLine(event.text)}`;
  });

  return [
    `Stateport Semantic Timeline: ${port.title}`,
    `Port: ${port.port_id}`,
    `Workspace: ${port.workspace_path}`,
    "",
    rows.length === 0 ? "No Semantic Timeline events captured." : rows.join("\n"),
    "",
    "Continue from a moment:",
    `  stateport continue ${selector} --from <event-id>`,
    `  stateport capsule ${selector} --for codex --from <event-id>`,
    ""
  ].join("\n");
}

export function renderCapsule(port, target = "generic", options = {}) {
  assertValidPortId(port.port_id);

  if (!SUPPORTED_TARGETS.includes(target)) {
    throw new StateportError(`Unknown capsule target "${target}". Supported targets: ${SUPPORTED_TARGETS.join(", ")}`);
  }

  const view = timelineThroughEvent(port, options.from);
  const scopedPort = {
    ...port,
    git: view.continuationPoint
      ? {
          ...view.continuationPoint.git,
          changed_files: []
        }
      : port.git,
    timeline: view.timeline
  };
  const decisions = latestEventsByType(scopedPort, "decision");
  const marks = scopedPort.timeline.filter((event) => ["intent", "mark", "change", "next", "closed"].includes(event.type));
  const verified = latestEventsByType(scopedPort, "verified");
  const failed = latestEventsByType(scopedPort, "failed");
  const nextActions = latestEventsByType(scopedPort, "next");
  const nextAction = nextActions.at(-1)?.text || null;

  return [
    `# Stateport Agent Capsule (${target})`,
    "",
    targetIntro(target),
    "",
    heading("Current Goal"),
    `- [user-authored] ${port.title} (source: ${port.port_id})`,
    "",
    heading("Continuation Point"),
    renderContinuationPoint(view),
    "",
    heading("Confirmed Facts"),
    `- [confirmed] Workspace: ${port.workspace_path}`,
    `- [confirmed] Source port: .stateport/ports/${port.port_id}.json`,
    gitSummary(scopedPort).trimEnd(),
    "",
    heading("Confirmed Decisions"),
    listEvents(decisions, "No decision has been captured in this port.").trimEnd(),
    "",
    heading("Constraints And Non-Goals"),
    "- [confirmed] V0 capsules do not claim transcript-derived facts unless transcript ingestion exists.",
    "- [confirmed] V0 prepares continuation context; it does not auto-launch Codex, Claude, or another agent.",
    "",
    heading("Do Not Repeat"),
    "- [unknown] No rejected path has been captured in this port.",
    "",
    heading("Files To Inspect First"),
    changedFiles(scopedPort, { historical: Boolean(view.continuationPoint) }).trimEnd(),
    "",
    heading("Last Known Failing Command"),
    failed.length === 0
      ? "- [unknown] No failing command has been captured in this port."
      : listEvents(failed, "No failing command has been captured in this port.").trimEnd(),
    "",
    heading("Verification Status"),
    verified.length === 0
      ? "- [unknown] No verification command has been captured in this port."
      : listEvents(verified, "No verification command has been captured in this port.").trimEnd(),
    "",
    heading("Next Safest Action"),
    nextAction
      ? `- [user-authored] ${nextAction}`
      : "- [unknown] No next action was captured at or before the selected continuation point.",
    "",
    heading("User-Authored Timeline"),
    listEvents(marks, "No user-authored timeline events were captured.").trimEnd(),
    "",
    heading("Evidence References"),
    `- [confirmed] Port JSON: .stateport/ports/${port.port_id}.json`,
    `- [confirmed] Replay Room: .stateport/rooms/${port.port_id}/`,
    view.continuationPoint
      ? `- [confirmed] Continuation event: ${eventRef(view.continuationPoint)}`
      : "- [confirmed] Continuation event: latest captured context",
    changedFiles(scopedPort, { historical: Boolean(view.continuationPoint) }).trimEnd(),
    "",
    heading("Unknowns"),
    "- [unknown] Transcript content is unavailable in V0.",
    "- [unknown] Command output is unavailable unless captured by a future command-capture layer.",
    ""
  ].join("\n");
}

export function renderReplay(port) {
  assertValidPortId(port.port_id);

  const timeline = port.timeline
    .map((event) => `- ${event.created_at} ${event.type}: ${event.text} (${event.claim}; ${event.event_id})`)
    .join("\n");

  return [
    `# Stateport Replay Room: ${port.title}`,
    "",
    "This Replay Room reconstructs a Session Port from local Stateport evidence.",
    "",
    heading("Port"),
    `- ID: ${port.port_id}`,
    `- Status: ${port.status}`,
    `- Workspace: ${port.workspace_path}`,
    `- Created: ${port.created_at}`,
    `- Updated: ${port.updated_at}`,
    "",
    heading("Git Snapshot"),
    gitSummary(port).trimEnd(),
    "",
    heading("Semantic Timeline"),
    timeline || "- No timeline events captured.",
    "",
    heading("Next Safest Action"),
    port.next_action || "Unknown.",
    "",
    heading("Generated Artifacts"),
    "- capsule.generic.md",
    "- capsule.codex.md",
    "- capsule.claude.md",
    "- files.changed",
    "- decisions.md",
    "- commands.log",
    "- continue.sh",
    ""
  ].join("\n");
}

export function renderDecisions(port) {
  assertValidPortId(port.port_id);

  const decisions = latestEventsByType(port, "decision");
  if (decisions.length === 0) {
    return "# Decisions\n\nNo decisions captured.\n";
  }

  return [
    "# Decisions",
    "",
    ...decisions.map((event) => `- ${event.text} (timeline: ${eventRef(event)})`),
    ""
  ].join("\n");
}

export function renderChangedFiles(port) {
  assertValidPortId(port.port_id);

  const files = port.git?.changed_files || [];
  if (files.length === 0) {
    return "No changed files detected.\n";
  }

  return files.join("\n").concat("\n");
}

export function renderCommandsLog() {
  return "Command output capture is not implemented in V0. No command outputs were captured by Stateport.\n";
}

export function renderContinueScript(port) {
  assertValidPortId(port.port_id);

  return [
    "#!/usr/bin/env sh",
    "set -eu",
    `stateport continue '${port.port_id}'`,
    ""
  ].join("\n");
}

function hashBody(body) {
  return createHash("sha256").update(body).digest("hex");
}

function withMarker(file, body) {
  const hash = hashBody(body);
  if (file.endsWith(".sh")) {
    const [firstLine, ...rest] = body.split("\n");
    return `${firstLine}\n# Stateport generated: sha256=${hash}\n${rest.join("\n")}`;
  }

  return `<!-- Stateport generated: sha256=${hash} -->\n${body}`;
}

function parseGeneratedContent(file, content) {
  if (file.endsWith(".sh")) {
    const lines = content.split("\n");
    const marker = lines[1] || "";
    const match = marker.match(/^# Stateport generated: sha256=([a-f0-9]+)$/);
    if (!match) {
      return null;
    }

    return {
      hash: match[1],
      body: [lines[0], ...lines.slice(2)].join("\n")
    };
  }

  const [marker, ...rest] = content.split("\n");
  const match = marker.match(/^<!-- Stateport generated: sha256=([a-f0-9]+) -->$/);
  if (!match) {
    return null;
  }

  return {
    hash: match[1],
    body: rest.join("\n")
  };
}

async function writeGeneratedFile(file, body) {
  let existing = null;

  try {
    const stats = await lstat(file);
    if (stats.isSymbolicLink()) {
      throw new StateportError(`Refusing to overwrite symlinked generated artifact: ${file}`);
    }
    existing = await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT" || error instanceof StateportError) {
      throw error;
    }
  }

  if (existing !== null) {
    const parsed = parseGeneratedContent(file, existing);
    if (!parsed || hashBody(parsed.body) !== parsed.hash) {
      throw new StateportError(`Refusing to overwrite manually edited generated artifact: ${file}`);
    }
  }

  const tempFile = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tempFile, withMarker(file, body), {
    encoding: "utf8",
    flag: "wx"
  });
  await rename(tempFile, file);

  if (file.endsWith(".sh")) {
    await chmod(file, 0o755);
  }
}

async function ensureDirectory(pathToEnsure) {
  try {
    const stats = await lstat(pathToEnsure);
    if (stats.isSymbolicLink()) {
      throw new StateportError(`Refusing to use symlinked Stateport path: ${pathToEnsure}`);
    }
    if (!stats.isDirectory()) {
      throw new StateportError(`Stateport path is not a directory: ${pathToEnsure}`);
    }
  } catch (error) {
    if (error.code !== "ENOENT" || error instanceof StateportError) {
      throw error;
    }
    await mkdir(pathToEnsure, { recursive: true });
  }
}

export async function writeReplayRoom(port, stateportRoot) {
  assertValidPortId(port.port_id);

  await ensureDirectory(stateportRoot);
  const roomsRoot = path.join(stateportRoot, "rooms");
  await ensureDirectory(roomsRoot);
  const roomPath = path.join(stateportRoot, "rooms", port.port_id);
  await ensureDirectory(roomPath);

  const files = new Map([
    ["replay.md", renderReplay(port)],
    ["capsule.generic.md", renderCapsule(port, "generic")],
    ["capsule.codex.md", renderCapsule(port, "codex")],
    ["capsule.claude.md", renderCapsule(port, "claude")],
    ["files.changed", renderChangedFiles(port)],
    ["decisions.md", renderDecisions(port)],
    ["commands.log", renderCommandsLog()],
    ["continue.sh", renderContinueScript(port)]
  ]);

  for (const [name, body] of files) {
    await writeGeneratedFile(path.join(roomPath, name), body);
  }

  return roomPath;
}

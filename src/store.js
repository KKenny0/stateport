import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getGitSnapshot } from "./git.js";

export class StateportError extends Error {
  constructor(message) {
    super(message);
    this.name = "StateportError";
  }
}

export function slugify(input) {
  const slug = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  return slug || "port";
}

export function assertValidPortId(portId) {
  if (typeof portId !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(portId)) {
    throw new StateportError(`Invalid Session Port ID: ${portId}`);
  }
}

export function assertValidEventId(eventId) {
  if (typeof eventId !== "string" || !/^evt-\d{4,}$/.test(eventId)) {
    throw new StateportError(`Invalid Semantic Timeline event ID: ${eventId}`);
  }
}

export function stateportRoot(workspaceRoot) {
  return path.join(workspaceRoot, ".stateport");
}

function portsDir(root) {
  return path.join(stateportRoot(root), "ports");
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
    if (error.code !== "ENOENT") {
      throw error;
    }
    await mkdir(pathToEnsure, { recursive: true });
  }
}

async function ensureStore(root) {
  const rootPath = stateportRoot(root);
  await ensureDirectory(rootPath);
  await ensureDirectory(portsDir(root));
  await ensureDirectory(path.join(rootPath, "rooms"));
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== null) {
      return fallback;
    }

    if (error instanceof SyntaxError) {
      throw new StateportError(`Malformed JSON: ${file}`);
    }

    throw error;
  }
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertNullablePortId(value, field, file) {
  if (value === null) {
    return;
  }
  try {
    assertValidPortId(value);
  } catch {
    throw new StateportError(`Malformed Stateport state JSON: ${file} (${field})`);
  }
}

function validateStateShape(state, file) {
  if (!isObject(state) || state.schema_version !== 1) {
    throw new StateportError(`Malformed Stateport state JSON: ${file}`);
  }

  assertNullablePortId(state.active_port_id, "active_port_id", file);
  assertNullablePortId(state.latest_port_id, "latest_port_id", file);
  if (state.updated_at !== null && typeof state.updated_at !== "string") {
    throw new StateportError(`Malformed Stateport state JSON: ${file} (updated_at)`);
  }

  return state;
}

function validateGitShape(git, file) {
  if (!isObject(git) || !Array.isArray(git.changed_files)) {
    throw new StateportError(`Malformed Session Port JSON: ${file} (git)`);
  }

  for (const key of ["git_root", "branch", "head"]) {
    if (git[key] !== null && typeof git[key] !== "string") {
      throw new StateportError(`Malformed Session Port JSON: ${file} (git.${key})`);
    }
  }

  if (!git.changed_files.every((changedFile) => typeof changedFile === "string")) {
    throw new StateportError(`Malformed Session Port JSON: ${file} (git.changed_files)`);
  }
}

function validateTimelineEvent(event, file) {
  if (!isObject(event)) {
    throw new StateportError(`Malformed Session Port JSON: ${file} (timeline)`);
  }

  for (const key of ["event_id", "type", "text", "claim", "created_at", "cwd"]) {
    if (typeof event[key] !== "string") {
      throw new StateportError(`Malformed Session Port JSON: ${file} (timeline.${key})`);
    }
  }

  try {
    assertValidEventId(event.event_id);
  } catch {
    throw new StateportError(`Malformed Session Port JSON: ${file} (timeline.event_id)`);
  }

  const allowedTypes = new Set(["intent", "mark", "decision", "change", "failed", "verified", "handoff", "closed", "next"]);
  if (!allowedTypes.has(event.type)) {
    throw new StateportError(`Malformed Session Port JSON: ${file} (timeline.type)`);
  }

  const allowedClaims = new Set(["confirmed", "user-authored", "inferred", "unknown"]);
  if (!allowedClaims.has(event.claim)) {
    throw new StateportError(`Malformed Session Port JSON: ${file} (timeline.claim)`);
  }

  validateGitShape(
    {
      ...event.git,
      changed_files: []
    },
    file
  );
}

function validatePortShape(port, file) {
  if (!isObject(port) || port.schema_version !== 1) {
    throw new StateportError(`Malformed Session Port JSON: ${file}`);
  }

  try {
    assertValidPortId(port.port_id);
  } catch {
    throw new StateportError(`Malformed Session Port JSON: ${file} (port_id)`);
  }

  for (const key of ["title", "workspace_path", "created_at", "updated_at", "status"]) {
    if (typeof port[key] !== "string") {
      throw new StateportError(`Malformed Session Port JSON: ${file} (${key})`);
    }
  }

  if (!["active", "paused"].includes(port.status)) {
    throw new StateportError(`Malformed Session Port JSON: ${file} (status)`);
  }

  if (port.git_root !== null && typeof port.git_root !== "string") {
    throw new StateportError(`Malformed Session Port JSON: ${file} (git_root)`);
  }

  validateGitShape(port.git, file);

  if (!Array.isArray(port.timeline)) {
    throw new StateportError(`Malformed Session Port JSON: ${file} (timeline)`);
  }

  const eventIds = new Set();
  for (const [index, event] of port.timeline.entries()) {
    validateTimelineEvent(event, file);
    const expectedEventId = `evt-${String(index + 1).padStart(4, "0")}`;
    if (event.event_id !== expectedEventId || eventIds.has(event.event_id)) {
      throw new StateportError(`Malformed Session Port JSON: ${file} (timeline.event_id)`);
    }
    eventIds.add(event.event_id);
  }

  if (!Array.isArray(port.evidence) || !Array.isArray(port.agent_sessions)) {
    throw new StateportError(`Malformed Session Port JSON: ${file} (evidence/agent_sessions)`);
  }

  if (port.next_action !== null && typeof port.next_action !== "string") {
    throw new StateportError(`Malformed Session Port JSON: ${file} (next_action)`);
  }

  return port;
}

export function resolveWorkspace(cwd = process.cwd()) {
  const git = getGitSnapshot(cwd);
  const root = git.git_root || path.resolve(cwd);

  return {
    root,
    git
  };
}

function statePath(root) {
  return path.join(stateportRoot(root), "state.json");
}

function portPath(root, portId) {
  assertValidPortId(portId);
  return path.join(portsDir(root), `${portId}.json`);
}

async function loadState(root) {
  const file = statePath(root);
  const state = await readJson(file, {
    schema_version: 1,
    active_port_id: null,
    latest_port_id: null,
    updated_at: null
  });
  return validateStateShape(state, file);
}

async function saveState(root, state) {
  await writeJson(statePath(root), state);
}

export async function readPort(root, portId) {
  const file = portPath(root, portId);
  const port = validatePortShape(await readJson(file), file);
  if (port.port_id !== portId) {
    throw new StateportError(`Session Port ID mismatch: expected ${portId}, found ${port.port_id}`);
  }
  return port;
}

async function savePort(root, port) {
  await writeJson(portPath(root, port.port_id), port);
}

async function exists(file) {
  try {
    await readFile(file, "utf8");
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function nextPortId(root, title, now) {
  const datePart = now.toISOString().slice(0, 10);
  const base = `${datePart}-${slugify(title)}`;
  let candidate = base;
  let suffix = 2;

  while (await exists(portPath(root, candidate))) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

function makeEvent(port, type, text, cwd, git, claim = "user-authored", now = new Date()) {
  const nextIndex = port.timeline.length + 1;
  return {
    event_id: `evt-${String(nextIndex).padStart(4, "0")}`,
    type,
    text,
    claim,
    created_at: now.toISOString(),
    cwd: path.resolve(cwd),
    git: {
      git_root: git.git_root,
      branch: git.branch,
      head: git.head
    }
  };
}

export async function createPort(title, options = {}) {
  if (!title || !title.trim()) {
    throw new StateportError("Usage: stateport start <title>");
  }

  const cwd = options.cwd || process.cwd();
  const now = options.now || new Date();
  const { root, git } = resolveWorkspace(cwd);
  await ensureStore(root);
  const state = await loadState(root);

  if (state.active_port_id) {
    throw new StateportError(`A Session Port is already active: ${state.active_port_id}. Run stateport end first.`);
  }

  const portId = await nextPortId(root, title, now);
  const port = {
    schema_version: 1,
    port_id: portId,
    title: title.trim(),
    workspace_path: root,
    git_root: git.git_root,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    status: "active",
    git,
    timeline: [],
    evidence: [
      {
        type: "workspace",
        claim: "confirmed",
        path: root
      }
    ],
    agent_sessions: [],
    next_action: null
  };

  port.timeline.push(makeEvent(port, "intent", title.trim(), cwd, git, "user-authored", now));

  await savePort(root, port);
  await saveState(root, {
    schema_version: 1,
    active_port_id: portId,
    latest_port_id: portId,
    updated_at: now.toISOString()
  });

  return { root, port };
}

export async function resolvePortId(root, requestedId = "latest") {
  if (requestedId && requestedId !== "latest") {
    return requestedId;
  }

  const state = await loadState(root);
  if (!state.latest_port_id) {
    throw new StateportError("No latest Session Port. Run stateport start <title> first.");
  }

  return state.latest_port_id;
}

async function activePortId(root) {
  const state = await loadState(root);
  if (!state.active_port_id) {
    throw new StateportError("No active Session Port. Run stateport start <title> first.");
  }
  return state.active_port_id;
}

export async function loadRequestedPort(requestedId = "latest", options = {}) {
  const cwd = options.cwd || process.cwd();
  const { root } = resolveWorkspace(cwd);
  const portId = await resolvePortId(root, requestedId);
  const port = await readPort(root, portId);

  return { root, port };
}

export async function appendMark(text, options = {}) {
  if (!text || !text.trim()) {
    throw new StateportError("Usage: stateport mark <text>");
  }

  const cwd = options.cwd || process.cwd();
  const now = options.now || new Date();
  const { root, git } = resolveWorkspace(cwd);
  await ensureStore(root);

  const portId = await activePortId(root);
  const port = await readPort(root, portId);
  if (port.status !== "active") {
    throw new StateportError(`Session Port is not active: ${port.port_id}`);
  }
  port.git = git;
  port.timeline.push(makeEvent(port, "mark", text.trim(), cwd, git, "user-authored", now));
  port.updated_at = now.toISOString();

  await savePort(root, port);
  await saveState(root, {
    ...(await loadState(root)),
    active_port_id: port.port_id,
    latest_port_id: port.port_id,
    updated_at: now.toISOString()
  });

  return { root, port };
}

export async function endPort(closeout, options = {}) {
  const cwd = options.cwd || process.cwd();
  const now = options.now || new Date();
  const { root, git } = resolveWorkspace(cwd);
  await ensureStore(root);

  const portId = await activePortId(root);
  const port = await readPort(root, portId);
  const changed = closeout.changed?.trim();
  const decision = closeout.decision?.trim();
  const next = closeout.next?.trim();

  if (!changed || !decision || !next) {
    throw new StateportError("stateport end requires closeout answers for changed, decision, and next.");
  }

  port.git = git;

  if (changed) {
    port.timeline.push(makeEvent(port, "change", changed, cwd, git, "user-authored", now));
  }

  if (decision) {
    port.timeline.push(makeEvent(port, "decision", decision, cwd, git, "user-authored", now));
  }

  if (next) {
    port.timeline.push(makeEvent(port, "next", next, cwd, git, "user-authored", now));
    port.next_action = next;
  }

  port.timeline.push(makeEvent(port, "closed", "End ritual completed.", cwd, git, "confirmed", now));
  port.status = "paused";
  port.updated_at = now.toISOString();

  await savePort(root, port);
  await saveState(root, {
    ...(await loadState(root)),
    active_port_id: null,
    latest_port_id: port.port_id,
    updated_at: now.toISOString()
  });

  return { root, port };
}

export async function recordHandoff(portId, options = {}) {
  const cwd = options.cwd || process.cwd();
  const now = options.now || new Date();
  const { root, git } = resolveWorkspace(cwd);
  await ensureStore(root);

  const port = await readPort(root, portId);
  port.git = git;
  port.timeline.push(makeEvent(port, "handoff", "Replay Room and Agent Capsules generated.", cwd, git, "confirmed", now));
  port.updated_at = now.toISOString();

  await savePort(root, port);
  await saveState(root, {
    ...(await loadState(root)),
    latest_port_id: port.port_id,
    updated_at: now.toISOString()
  });

  return { root, port };
}

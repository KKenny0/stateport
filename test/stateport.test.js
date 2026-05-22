import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { renderCapsule } from "../src/render.js";
import { appendMark, createPort, endPort, loadRequestedPort, stateportRoot } from "../src/store.js";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const cliPath = path.join(repoRoot, "src", "cli.js");

async function tempWorkspace(t) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "stateport-test-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return workspace;
}

function capsuleSection(body, title) {
  const match = body.match(new RegExp(`## ${title}\\n\\n([\\s\\S]*?)(?:\\n\\n## |$)`));
  assert.ok(match, `missing capsule section: ${title}`);
  return match[1];
}

test("creates a Session Port with stable source-of-truth JSON", async (t) => {
  const cwd = await tempWorkspace(t);
  const now = new Date("2026-05-21T00:00:00.000Z");
  const { port } = await createPort("Demo Continuation", { cwd, now });

  assert.equal(port.port_id, "2026-05-21-demo-continuation");
  assert.equal(port.status, "active");
  assert.equal(port.timeline.length, 1);
  assert.equal(port.timeline[0].type, "intent");

  const stored = JSON.parse(await readFile(path.join(cwd, ".stateport", "ports", `${port.port_id}.json`), "utf8"));
  assert.equal(stored.port_id, port.port_id);
});

test("mark appends timeline events without overwriting previous events", async (t) => {
  const cwd = await tempWorkspace(t);
  await createPort("Append Test", { cwd, now: new Date("2026-05-21T00:00:00.000Z") });

  const first = await appendMark("first direction change", { cwd, now: new Date("2026-05-21T00:01:00.000Z") });
  const second = await appendMark("second direction change", { cwd, now: new Date("2026-05-21T00:02:00.000Z") });

  assert.equal(first.port.timeline.length, 2);
  assert.equal(second.port.timeline.length, 3);
  assert.deepEqual(second.port.timeline.map((event) => event.event_id), ["evt-0001", "evt-0002", "evt-0003"]);
  assert.equal(second.port.timeline[1].text, "first direction change");
  assert.equal(second.port.timeline[2].text, "second direction change");
});

test("typed marks record user-authored Semantic Timeline events for capsule trust", async (t) => {
  const cwd = await tempWorkspace(t);
  assert.equal(spawnSync(process.execPath, [cliPath, "start", "typed trust"], { cwd }).status, 0);
  assert.equal(spawnSync(process.execPath, [cliPath, "mark", "--type", "decision", "manual evidence before automation"], { cwd }).status, 0);
  assert.equal(spawnSync(process.execPath, [cliPath, "mark", "-t", "failed", "npm test failed before fix"], { cwd }).status, 0);
  assert.equal(spawnSync(process.execPath, [cliPath, "mark", "--type", "verified", "npm test passed after fix"], { cwd }).status, 0);
  assert.equal(spawnSync(process.execPath, [cliPath, "mark", "--type", "next", "inspect scoped capsule"], { cwd }).status, 0);

  const timeline = spawnSync(process.execPath, [cliPath, "timeline", "latest"], { cwd, encoding: "utf8" });
  assert.equal(timeline.status, 0, timeline.stderr);
  assert.match(timeline.stdout, /evt-0002\s+.*decision\s+user-authored\s+manual evidence before automation/);
  assert.match(timeline.stdout, /evt-0003\s+.*failed\s+user-authored\s+npm test failed before fix/);
  assert.match(timeline.stdout, /evt-0004\s+.*verified\s+user-authored\s+npm test passed after fix/);
  assert.match(timeline.stdout, /evt-0005\s+.*next\s+user-authored\s+inspect scoped capsule/);

  const capsule = spawnSync(process.execPath, [cliPath, "capsule", "latest", "--for", "codex"], { cwd, encoding: "utf8" });
  assert.equal(capsule.status, 0, capsule.stderr);
  assert.match(capsuleSection(capsule.stdout, "Confirmed Decisions"), /manual evidence before automation/);
  assert.match(capsuleSection(capsule.stdout, "Do Not Repeat"), /No rejected path has been captured/);
  assert.match(capsuleSection(capsule.stdout, "Known Failed Attempts"), /npm test failed before fix/);
  assert.match(capsuleSection(capsule.stdout, "Verification Status"), /npm test passed after fix/);
  assert.match(capsuleSection(capsule.stdout, "Next Safest Action"), /\[user-authored\] inspect scoped capsule/);
});

test("typed mark validates event types before writing", async (t) => {
  const cwd = await tempWorkspace(t);
  await createPort("Type Guard", { cwd, now: new Date("2026-05-21T00:00:00.000Z") });

  const invalid = spawnSync(process.execPath, [cliPath, "mark", "--type", "handoff", "not user-authored"], { cwd, encoding: "utf8" });

  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Unknown Semantic Timeline mark type "handoff"/);

  const missingValue = spawnSync(process.execPath, [cliPath, "mark", "--type"], { cwd, encoding: "utf8" });
  assert.notEqual(missingValue.status, 0);
  assert.match(missingValue.stderr, /argument missing/);

  const { port } = await loadRequestedPort("latest", { cwd });
  assert.equal(port.timeline.length, 1);
});

test("typed next marks are scoped by selected continuation event", async (t) => {
  const cwd = await tempWorkspace(t);
  assert.equal(spawnSync(process.execPath, [cliPath, "start", "typed next scope"], { cwd }).status, 0);
  assert.equal(spawnSync(process.execPath, [cliPath, "mark", "--type", "decision", "choose manual trust"], { cwd }).status, 0);
  assert.equal(spawnSync(process.execPath, [cliPath, "mark", "--type", "next", "inspect typed next"], { cwd }).status, 0);
  assert.equal(
    spawnSync(
      process.execPath,
      [
        cliPath,
        "end",
        "--changed",
        "closed later",
        "--decision",
        "closeout decision",
        "--next",
        "inspect closeout next"
      ],
      { cwd }
    ).status,
    0
  );

  const scoped = spawnSync(process.execPath, [cliPath, "continue", "latest", "--from", "evt-0003"], {
    cwd,
    encoding: "utf8"
  });

  assert.equal(scoped.status, 0, scoped.stderr);
  assert.match(capsuleSection(scoped.stdout, "Next Safest Action"), /inspect typed next/);
  assert.doesNotMatch(capsuleSection(scoped.stdout, "Next Safest Action"), /inspect closeout next/);
});

test("end records closeout answers and capsule labels evidence strength", async (t) => {
  const cwd = await tempWorkspace(t);
  await createPort("Closeout Test", { cwd, now: new Date("2026-05-21T00:00:00.000Z") });
  const { port } = await endPort(
    {
      changed: "implemented the first lifecycle",
      decision: "prove CLI before TUI",
      next: "inspect generated capsule"
    },
    { cwd, now: new Date("2026-05-21T00:03:00.000Z") }
  );

  assert.equal(port.status, "paused");
  assert.equal(port.next_action, "inspect generated capsule");
  assert.ok(port.timeline.some((event) => event.type === "decision" && event.text === "prove CLI before TUI"));

  const capsule = renderCapsule(port, "codex");
  assert.match(capsule, /# Stateport Agent Capsule \(codex\)/);
  assert.match(capsule, /\[user-authored\] inspect generated capsule/);
  assert.match(capsule, /\[unknown\] Transcript content is unavailable in V0/);
});

test("end requires complete closeout answers at the data layer", async (t) => {
  const cwd = await tempWorkspace(t);
  await createPort("Incomplete Closeout", { cwd, now: new Date("2026-05-21T00:00:00.000Z") });

  await assert.rejects(
    () => endPort({ changed: "changed", decision: "", next: "next" }, { cwd }),
    /requires closeout answers/
  );
});

test("start rejects when another Session Port is active", async (t) => {
  const cwd = await tempWorkspace(t);
  await createPort("First Port", { cwd, now: new Date("2026-05-21T00:00:00.000Z") });

  await assert.rejects(
    () => createPort("Second Port", { cwd, now: new Date("2026-05-21T00:01:00.000Z") }),
    /already active/
  );
});

test("mark after end is rejected because the port is no longer active", async (t) => {
  const cwd = await tempWorkspace(t);
  await createPort("End Active", { cwd, now: new Date("2026-05-21T00:00:00.000Z") });
  await endPort(
    {
      changed: "closed the port",
      decision: "paused ports are not active",
      next: "continue from capsule"
    },
    { cwd, now: new Date("2026-05-21T00:01:00.000Z") }
  );

  const mark = spawnSync(process.execPath, [cliPath, "mark", "too late"], { cwd, encoding: "utf8" });

  assert.notEqual(mark.status, 0);
  assert.match(mark.stderr, /Run stateport start <title> first/);
});

test("captures branch and changed files in an unborn git repo", async (t) => {
  const cwd = await tempWorkspace(t);
  const init = spawnSync("git", ["init", "-b", "main"], { cwd, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  await writeFile(path.join(cwd, "work.md"), "changed\n", "utf8");
  const gitRoot = await realpath(cwd);

  const { port } = await createPort("Git Snapshot", { cwd, now: new Date("2026-05-21T00:00:00.000Z") });

  assert.equal(port.git.git_root, gitRoot);
  assert.equal(port.git.branch, "main");
  assert.equal(port.git.head, null);
  assert.deepEqual(port.git.changed_files, ["work.md"]);
});

test("works in a workspace with no git repository", async (t) => {
  const cwd = await tempWorkspace(t);
  const { port } = await createPort("No Git", { cwd, now: new Date("2026-05-21T00:00:00.000Z") });

  assert.equal(port.workspace_path, cwd);
  assert.equal(port.git_root, null);
  assert.equal(port.git.branch, null);
  assert.equal(port.git.head, null);
  assert.deepEqual(port.git.changed_files, []);

  assert.match(renderCapsule(port, "generic"), /\[unknown\] No git repository was available, so changed files were not captured/);
});

test("CLI smoke flow creates replay room artifacts and supports latest", async (t) => {
  const cwd = await tempWorkspace(t);
  const start = spawnSync(process.execPath, [cliPath, "start", "demo continuation"], { cwd, encoding: "utf8" });
  assert.equal(start.status, 0, start.stderr);

  const mark = spawnSync(process.execPath, [cliPath, "mark", "first meaningful direction change"], { cwd, encoding: "utf8" });
  assert.equal(mark.status, 0, mark.stderr);

  const end = spawnSync(
    process.execPath,
    [
      cliPath,
      "end",
      "--changed",
      "created V0",
      "--decision",
      "prove lifecycle first",
      "--next",
      "inspect capsule"
    ],
    { cwd, encoding: "utf8" }
  );
  assert.equal(end.status, 0, end.stderr);

  const capsule = spawnSync(process.execPath, [cliPath, "capsule", "latest", "--for", "codex"], { cwd, encoding: "utf8" });
  assert.equal(capsule.status, 0, capsule.stderr);
  assert.match(capsule.stdout, /Stateport Agent Capsule \(codex\)/);
  assert.match(capsule.stdout, /prove lifecycle first/);

  const preview = spawnSync(process.execPath, [cliPath, "continue", "latest"], { cwd, encoding: "utf8" });
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Stateport continuation preview/);

  const { port } = await loadRequestedPort("latest", { cwd });
  const room = path.join(stateportRoot(cwd), "rooms", port.port_id);
  assert.match(await readFile(path.join(room, "replay.md"), "utf8"), /Stateport generated: sha256=/);
  assert.match(await readFile(path.join(room, "capsule.generic.md"), "utf8"), /Stateport Agent Capsule \(generic\)/);
  assert.match(await readFile(path.join(room, "capsule.codex.md"), "utf8"), /Stateport Agent Capsule \(codex\)/);
  assert.match(await readFile(path.join(room, "capsule.claude.md"), "utf8"), /Stateport Agent Capsule \(claude\)/);
});

test("timeline lists Semantic Timeline event ids without generating Replay Room artifacts", async (t) => {
  const cwd = await tempWorkspace(t);
  assert.equal(spawnSync(process.execPath, [cliPath, "start", "timeline discovery"], { cwd }).status, 0);
  assert.equal(spawnSync(process.execPath, [cliPath, "mark", "multi\nline semantic mark"], { cwd }).status, 0);

  const timeline = spawnSync(process.execPath, [cliPath, "timeline", "latest"], { cwd, encoding: "utf8" });

  assert.equal(timeline.status, 0, timeline.stderr);
  assert.match(timeline.stdout, /Stateport Semantic Timeline: timeline discovery/);
  assert.match(timeline.stdout, /evt-0001\s+.*intent\s+user-authored\s+timeline discovery/);
  assert.match(timeline.stdout, /evt-0002\s+.*mark\s+user-authored\s+multi line semantic mark/);
  assert.match(timeline.stdout, /stateport continue latest --from <event-id>/);
  assert.match(timeline.stdout, /stateport capsule latest --for codex --from <event-id>/);

  const { port } = await loadRequestedPort("latest", { cwd });
  await assert.rejects(
    () => readFile(path.join(stateportRoot(cwd), "rooms", port.port_id, "replay.md"), "utf8"),
    /ENOENT/
  );
});

test("timeline supports explicit port ids", async (t) => {
  const cwd = await tempWorkspace(t);
  const { port } = await createPort("Explicit Timeline", { cwd, now: new Date("2026-05-21T00:00:00.000Z") });

  const timeline = spawnSync(process.execPath, [cliPath, "timeline", port.port_id], { cwd, encoding: "utf8" });

  assert.equal(timeline.status, 0, timeline.stderr);
  assert.match(timeline.stdout, new RegExp(`Port: ${port.port_id}`));
  assert.match(timeline.stdout, new RegExp(`stateport continue ${port.port_id} --from <event-id>`));
});

test("capsule can focus continuation from a specific Semantic Timeline event", async (t) => {
  const cwd = await tempWorkspace(t);
  assert.equal(spawnSync(process.execPath, [cliPath, "start", "focused continuation"], { cwd }).status, 0);
  assert.equal(spawnSync(process.execPath, [cliPath, "mark", "first semantic mark"], { cwd }).status, 0);
  assert.equal(
    spawnSync(
      process.execPath,
      [
        cliPath,
        "end",
        "--changed",
        "changed after mark",
        "--decision",
        "decision after mark",
        "--next",
        "next after mark"
      ],
      { cwd }
    ).status,
    0
  );

  const capsule = spawnSync(process.execPath, [cliPath, "capsule", "latest", "--for", "codex", "--from", "evt-0002"], {
    cwd,
    encoding: "utf8"
  });

  assert.equal(capsule.status, 0, capsule.stderr);
  assert.match(capsule.stdout, /## Continuation Point/);
  assert.match(capsule.stdout, /Event: evt-0002 mark/);
  assert.match(capsule.stdout, /\[user-authored\] Event text:/);
  assert.match(capsule.stdout, /first semantic mark/);
  assert.doesNotMatch(capsule.stdout, /decision after mark/);
  assert.match(capsule.stdout, /Changed files were not captured for the selected historical continuation point/);
  assert.match(capsule.stdout, /No next action was captured at or before the selected continuation point/);
});

test("continue can focus continuation from an event with the latest next action in scope", async (t) => {
  const cwd = await tempWorkspace(t);
  assert.equal(spawnSync(process.execPath, [cliPath, "start", "next scope"], { cwd }).status, 0);
  assert.equal(spawnSync(process.execPath, [cliPath, "mark", "direction"], { cwd }).status, 0);
  assert.equal(
    spawnSync(
      process.execPath,
      [
        cliPath,
        "end",
        "--changed",
        "changed",
        "--decision",
        "decision",
        "--next",
        "continue from scoped next"
      ],
      { cwd }
    ).status,
    0
  );

  const preview = spawnSync(process.execPath, [cliPath, "continue", "latest", "--from", "evt-0005"], {
    cwd,
    encoding: "utf8"
  });

  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Stateport continuation preview/);
  assert.match(preview.stdout, /Event: evt-0005 next/);
  assert.match(preview.stdout, /\[user-authored\] continue from scoped next/);
});

test("unknown or invalid continuation events are rejected", async (t) => {
  const cwd = await tempWorkspace(t);
  const { port } = await createPort("Unknown Event", { cwd, now: new Date("2026-05-21T00:00:00.000Z") });

  const unknown = spawnSync(process.execPath, [cliPath, "capsule", "latest", "--from", "evt-9999"], { cwd, encoding: "utf8" });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Unknown Semantic Timeline event: evt-9999/);
  await assert.rejects(
    () => readFile(path.join(stateportRoot(cwd), "rooms", port.port_id, "capsule.generic.md"), "utf8"),
    /ENOENT/
  );

  const invalid = spawnSync(process.execPath, [cliPath, "continue", "latest", "--from", "../evt-0001"], { cwd, encoding: "utf8" });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Invalid Semantic Timeline event ID/);
});

test("generated artifacts are not overwritten after manual edits", async (t) => {
  const cwd = await tempWorkspace(t);
  await createPort("Overwrite Guard", { cwd, now: new Date("2026-05-21T00:00:00.000Z") });

  const end = spawnSync(
    process.execPath,
    [cliPath, "end", "--changed", "done", "--decision", "guard generated files", "--next", "rerun capsule"],
    { cwd, encoding: "utf8" }
  );
  assert.equal(end.status, 0, end.stderr);

  const { port } = await loadRequestedPort("latest", { cwd });
  const replayPath = path.join(stateportRoot(cwd), "rooms", port.port_id, "replay.md");
  await writeFile(replayPath, `${await readFile(replayPath, "utf8")}\nmanual edit\n`, "utf8");

  const capsule = spawnSync(process.execPath, [cliPath, "capsule", "latest", "--for", "generic"], { cwd, encoding: "utf8" });
  assert.notEqual(capsule.status, 0);
  assert.match(capsule.stderr, /Refusing to overwrite manually edited generated artifact/);
});

test("generated artifacts are not written through symlinks", async (t) => {
  const cwd = await tempWorkspace(t);
  const external = path.join(cwd, "external.md");
  await createPort("Symlink Guard", { cwd, now: new Date("2026-05-21T00:00:00.000Z") });

  const end = spawnSync(
    process.execPath,
    [cliPath, "end", "--changed", "done", "--decision", "reject symlinks", "--next", "rerun capsule"],
    { cwd, encoding: "utf8" }
  );
  assert.equal(end.status, 0, end.stderr);

  const { port } = await loadRequestedPort("latest", { cwd });
  const replayPath = path.join(stateportRoot(cwd), "rooms", port.port_id, "replay.md");
  await rm(replayPath);
  await symlink(external, replayPath);

  const capsule = spawnSync(process.execPath, [cliPath, "capsule", "latest", "--for", "generic"], { cwd, encoding: "utf8" });

  assert.notEqual(capsule.status, 0);
  assert.match(capsule.stderr, /Refusing to overwrite symlinked generated artifact/);
});

test("missing active port gives direct recovery instruction", async (t) => {
  const cwd = await tempWorkspace(t);
  const mark = spawnSync(process.execPath, [cliPath, "mark", "cannot mark yet"], { cwd, encoding: "utf8" });

  assert.notEqual(mark.status, 0);
  assert.match(mark.stderr, /Run stateport start <title> first/);
});

test("malformed port JSON blocks mutation and names the file", async (t) => {
  const cwd = await tempWorkspace(t);
  const { port } = await createPort("Malformed JSON", { cwd, now: new Date("2026-05-21T00:00:00.000Z") });
  const portPath = path.join(cwd, ".stateport", "ports", `${port.port_id}.json`);
  await writeFile(portPath, "{not-json", "utf8");

  const mark = spawnSync(process.execPath, [cliPath, "mark", "must fail"], { cwd, encoding: "utf8" });

  assert.notEqual(mark.status, 0);
  assert.match(mark.stderr, /Malformed JSON:/);
  assert.match(mark.stderr, new RegExp(port.port_id));
});

test("schema-invalid port JSON blocks mutation with a Stateport error", async (t) => {
  const cwd = await tempWorkspace(t);
  const { port } = await createPort("Schema Guard", { cwd, now: new Date("2026-05-21T00:00:00.000Z") });
  const portPath = path.join(cwd, ".stateport", "ports", `${port.port_id}.json`);
  await writeFile(portPath, `${JSON.stringify({ ...port, timeline: {} }, null, 2)}\n`, "utf8");

  const mark = spawnSync(process.execPath, [cliPath, "mark", "must fail"], { cwd, encoding: "utf8" });

  assert.notEqual(mark.status, 0);
  assert.match(mark.stderr, /Malformed Session Port JSON:/);
  assert.match(mark.stderr, /timeline/);
});

test("schema-invalid timeline event IDs and claims are rejected", async (t) => {
  const cwd = await tempWorkspace(t);
  const { port } = await createPort("Timeline Schema Guard", { cwd, now: new Date("2026-05-21T00:00:00.000Z") });
  const portPath = path.join(cwd, ".stateport", "ports", `${port.port_id}.json`);
  const tampered = {
    ...port,
    timeline: [
      {
        ...port.timeline[0],
        event_id: "evt-9999",
        claim: "trusted-by-default"
      }
    ]
  };
  await writeFile(portPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

  const capsule = spawnSync(process.execPath, [cliPath, "capsule", "latest", "--from", "evt-9999"], { cwd, encoding: "utf8" });

  assert.notEqual(capsule.status, 0);
  assert.match(capsule.stderr, /Malformed Session Port JSON:/);
  assert.match(capsule.stderr, /timeline/);
});

test("invalid requested port IDs cannot escape the local store", async (t) => {
  const cwd = await tempWorkspace(t);
  await createPort("Traversal Guard", { cwd, now: new Date("2026-05-21T00:00:00.000Z") });

  const capsule = spawnSync(process.execPath, [cliPath, "capsule", "../outside", "--for", "generic"], { cwd, encoding: "utf8" });

  assert.notEqual(capsule.status, 0);
  assert.match(capsule.stderr, /Invalid Session Port ID/);
});

test("tampered source JSON port IDs cannot write derived artifacts outside rooms", async (t) => {
  const cwd = await tempWorkspace(t);
  const { port } = await createPort("Tamper Guard", { cwd, now: new Date("2026-05-21T00:00:00.000Z") });
  const portPath = path.join(cwd, ".stateport", "ports", `${port.port_id}.json`);
  const tampered = {
    ...port,
    port_id: "../outside"
  };
  await writeFile(portPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

  const capsule = spawnSync(process.execPath, [cliPath, "capsule", port.port_id, "--for", "generic"], { cwd, encoding: "utf8" });

  assert.notEqual(capsule.status, 0);
  assert.match(capsule.stderr, /Malformed Session Port JSON|Invalid Session Port ID|Session Port ID mismatch/);
});

test("unknown capsule targets are rejected with supported targets", async (t) => {
  const cwd = await tempWorkspace(t);
  await createPort("Target Test", { cwd, now: new Date("2026-05-21T00:00:00.000Z") });

  const capsule = spawnSync(process.execPath, [cliPath, "capsule", "latest", "--for", "cursor"], { cwd, encoding: "utf8" });

  assert.notEqual(capsule.status, 0);
  assert.match(capsule.stderr, /Unknown capsule target "cursor"/);
  assert.match(capsule.stderr, /generic, codex, claude/);
});

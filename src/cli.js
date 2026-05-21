#!/usr/bin/env node

import { parseArgs } from "node:util";
import process from "node:process";
import readline from "node:readline/promises";

import { renderCapsule, writeReplayRoom, SUPPORTED_TARGETS } from "./render.js";
import { StateportError, appendMark, createPort, endPort, loadRequestedPort, recordHandoff, stateportRoot } from "./store.js";

function usage() {
  return `Stateport

Usage:
  stateport start <title>
  stateport mark <text>
  stateport end [--changed <text>] [--decision <text>] [--next <text>]
  stateport capsule <port-id|latest> --for <generic|codex|claude> [--from <event-id>]
  stateport continue <port-id|latest> [--for <generic|codex|claude>] [--from <event-id>]
`;
}

function textArg(args, usageLine) {
  const text = args.join(" ").trim();
  if (!text) {
    throw new StateportError(usageLine);
  }
  return text;
}

async function promptCloseout(partial) {
  const closeout = { ...partial };
  const missing = ["changed", "decision", "next"].filter((key) => !closeout[key]);

  if (missing.length === 0) {
    return closeout;
  }

  if (!process.stdin.isTTY) {
    throw new StateportError("stateport end requires --changed, --decision, and --next when stdin is not interactive.");
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    if (!closeout.changed) {
      closeout.changed = await rl.question("What changed? ");
    }
    if (!closeout.decision) {
      closeout.decision = await rl.question("What decision matters? ");
    }
    if (!closeout.next) {
      closeout.next = await rl.question("What should the next agent do first? ");
    }
  } finally {
    rl.close();
  }

  return closeout;
}

function parseTarget(args, defaultTarget = "generic") {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      for: {
        type: "string",
        short: "f",
        default: defaultTarget
      },
      from: {
        type: "string"
      }
    }
  });

  const target = parsed.values.for;
  if (!SUPPORTED_TARGETS.includes(target)) {
    throw new StateportError(`Unknown capsule target "${target}". Supported targets: ${SUPPORTED_TARGETS.join(", ")}`);
  }

  return {
    id: parsed.positionals[0] || "latest",
    target,
    from: parsed.values.from
  };
}

async function run(argv) {
  const [command, ...args] = argv;

  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return;
  }

  if (command === "start") {
    const title = textArg(args, "Usage: stateport start <title>");
    const { root, port } = await createPort(title);
    process.stdout.write(`Stateport opened: ${port.port_id}\n`);
    process.stdout.write(`Workspace: ${root}\n`);
    process.stdout.write('Next: stateport mark "..." when the work changes direction\n');
    return;
  }

  if (command === "mark") {
    const text = textArg(args, "Usage: stateport mark <text>");
    const { port } = await appendMark(text);
    process.stdout.write(`Marked ${port.port_id}: ${text}\n`);
    return;
  }

  if (command === "end") {
    const parsed = parseArgs({
      args,
      options: {
        changed: { type: "string" },
        decision: { type: "string" },
        next: { type: "string" }
      }
    });
    const closeout = await promptCloseout(parsed.values);
    const { root, port } = await endPort(closeout);
    await writeReplayRoom(port, stateportRoot(root));
    const handoff = await recordHandoff(port.port_id);
    const roomPath = await writeReplayRoom(handoff.port, stateportRoot(root));
    process.stdout.write(`Stateport paused: ${handoff.port.port_id}\n`);
    process.stdout.write(`Replay Room: ${roomPath}\n`);
    process.stdout.write(`Next: stateport continue ${handoff.port.port_id}\n`);
    return;
  }

  if (command === "capsule") {
    const { id, target, from } = parseTarget(args);
    const { root, port } = await loadRequestedPort(id);
    const capsule = renderCapsule(port, target, { from });
    await writeReplayRoom(port, stateportRoot(root));
    process.stdout.write(capsule);
    return;
  }

  if (command === "continue") {
    const { id, target, from } = parseTarget(args);
    const { root, port } = await loadRequestedPort(id);
    const capsule = renderCapsule(port, target, { from });
    await writeReplayRoom(port, stateportRoot(root));
    process.stdout.write(`Stateport continuation preview: ${port.port_id}\n`);
    process.stdout.write(`Capsule target: ${target}\n\n`);
    process.stdout.write(capsule);
    return;
  }

  throw new StateportError(`Unknown command "${command}".\n\n${usage()}`);
}

run(process.argv.slice(2)).catch((error) => {
  if (error instanceof StateportError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  throw error;
});

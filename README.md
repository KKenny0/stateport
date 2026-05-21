# Stateport

Stateport is a local continuity layer for agentic software work.

It turns interrupted work into replayable continuation points: open a Session Port, mark Semantic Timeline moments, end with a Replay Room, then hand an Agent Capsule to a future coding agent.

## V0 CLI

```bash
npm run stateport -- start "demo continuation"
npm run stateport -- mark "first meaningful direction change"
npm run stateport -- end
npm run stateport -- capsule latest --for codex
npm run stateport -- continue latest
```

For non-interactive use, pass closeout answers directly:

```bash
npm run stateport -- end \
  --changed "created the first lifecycle slice" \
  --decision "prove the CLI/data contract before TUI work" \
  --next "inspect the generated capsule"
```

## Storage

Stateport writes project-local runtime state under `.stateport/`.

- `.stateport/ports/<port-id>.json` is the source of truth.
- `.stateport/state.json` stores active and latest pointers.
- `.stateport/rooms/<port-id>/` contains generated Replay Room artifacts.

Replay rooms and capsules are derived artifacts. Generated files include a Stateport marker; if a generated artifact is manually edited, Stateport refuses to overwrite it.

## Boundaries

V0 is only the manual lifecycle loop. It does not include transcript ingestion, MCP, background daemons, cloud sync, native Codex/Claude launching, vector search, or a broad TUI.

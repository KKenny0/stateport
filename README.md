# Stateport

Stateport is a local continuity layer for agentic software work.

It turns interrupted work into replayable continuation points: open a Session Port, mark Semantic Timeline moments, end with a Replay Room, then hand an Agent Capsule to a future coding agent.

## V0 CLI

```bash
npm run stateport -- start "demo continuation"
npm run stateport -- mark "first meaningful direction change"
npm run stateport -- mark --type decision "prove the CLI/data contract before TUI work"
npm run stateport -- mark --type verified "npm test passed"
npm run stateport -- end
npm run stateport -- timeline latest
npm run stateport -- capsule latest --for codex
npm run stateport -- continue latest
```

Typed marks make the Semantic Timeline more useful before the end ritual:

```bash
npm run stateport -- mark --type decision "accepted a product or technical direction"
npm run stateport -- mark --type failed "a command, attempt, or path failed"
npm run stateport -- mark --type verified "a check or manual acceptance passed"
npm run stateport -- mark --type next "the next safest action changed"
```

When `--type` is omitted, `mark` records a regular user-authored timeline mark.

To continue from a specific Semantic Timeline moment, pass its event id:

```bash
npm run stateport -- capsule latest --for codex --from evt-0002
npm run stateport -- continue latest --from evt-0002
```

Use `timeline` to find available event ids:

```bash
npm run stateport -- timeline latest
```

`--from` filters the rendered capsule at output time. It does not mutate the source port JSON and does not create separate partial Replay Room files.

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

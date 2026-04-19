---
name: socratic-ping
description: Hello-world probe for the Socratiskill plugin. Invoked by the user as /socratic-ping to verify the plugin is installed and can read the user's socratic profile.
argument-hint: (no arguments)
allowed-tools: [Read]
---

# Socratic Ping

Hello-world probe that confirms the Socratiskill plugin is installed
and that the harness can read the user's profile file.

## Path convention (`<plugin-root>`)

This file lives at `<plugin-root>/skills/socratic-ping/SKILL.md`. When
the instructions below mention reading a file relative to the plugin
(e.g. the plugin manifest), `<plugin-root>` resolves to two directories
above this SKILL.md.

## Instructions

When the user invokes `/socratic-ping`:

1. Read `<plugin-root>/.claude-plugin/plugin.json` with the Read tool
   to obtain the `name` and `version` fields (single source of truth
   for the plugin version — do NOT hardcode).
2. Try to read `~/.claude/socratic/profile.json` with the Read tool.
3. Respond in exactly this format (one line per item):

```
pong
plugin:  <name from manifest> v<version from manifest>
profile: <global_level from JSON> | <mode> | calibrated=<true|false>
path:    ~/.claude/socratic/profile.json
```

4. If the profile file does not exist or cannot be read, respond:

```
pong
plugin:  <name from manifest> v<version from manifest>
profile: (not found — run /socratiskill:socratic calibrate)
path:    ~/.claude/socratic/profile.json
```

Do not add explanations. This skill is only a probe — it must NOT
activate any pedagogical logic.

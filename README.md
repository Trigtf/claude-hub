# Agent Hub

A small desktop app (Electron) that lists your projects and opens a coding-agent
terminal for each one, in tabs: [Claude Code](https://claude.com/claude-code) or
[opencode](https://opencode.ai). Pick a project, and the agent continues the last
conversation there.

**Windows only for now.**

## What you need

1. **Windows 10/11**
2. **Claude Code**, installed and logged in. Check that `claude` runs in a normal terminal first.
3. **opencode** (optional), if you prefer it. Install it from [opencode.ai](https://opencode.ai) and choose it in Settings.
4. **Node.js** (LTS) and **git**, only if you run it from source (see below).

No Python or other tools are required.

## Download (easiest)

Get `Agent-Hub-<version>-portable.exe` from the
[Releases page](https://github.com/Trigtf/claude-hub/releases/latest) and double-click it.
No installation, no Node.js needed. You still need Claude Code (see above).

> **Windows SmartScreen:** the exe is not code-signed yet, so Windows may show
> "Windows protected your PC". Click **More info**, then **Run anyway**. You can inspect the
> source here and build it yourself with `npm run dist`.

## Run from source

```
git clone https://github.com/Trigtf/claude-hub.git agent-hub
cd agent-hub
npm install
npm start
```

After the first run you can also just double-click `AgentHub.bat`.

## How it works

- **Project list.** Built from your pinned projects, the folders under your
  projects folder, common code folders (Desktop, Documents, `repos`, `src`, ...)
  and every folder where you have used Claude Code before. Right-click a project to pin it,
  reorder it or open its folder.
- **Resume.** Opening a project that has a previous conversation continues it
  (`claude --continue`). Turn this off in *Settings > General*.
- **Tabs.** Each project gets its own terminal tab. Open tabs are restored on the next start.
- **Files.** Drop files or paste an image/text onto the right-hand panel. They are saved to a
  local inbox and the path is typed into the Claude prompt. Files that Claude creates in the
  project show up in the panel below, ready to save.

## Keyboard

| Keys | Action |
| --- | --- |
| `Ctrl+V` / `Ctrl+Shift+V` | Paste text, or an image (saved to the inbox, path inserted) |
| `Ctrl+C` | Copy the selection (sends Ctrl+C to Claude when nothing is selected) |
| `Ctrl` + `+` / `-` / `0` | Zoom the terminal text in / out / reset |
| `Ctrl` + mouse wheel | Zoom the terminal text |
| Right-click in the terminal | Copy the selection, or paste |

## Settings

Click the gear icon. You can change the theme (dark/light), the terminal font and size,
the folder for new projects, whether to resume the last conversation, the agent that opens in the
project terminals (Claude Code or opencode), and common Claude Code options (model, permission mode, allow/deny rules, environment variables).
Claude settings are written to `~/.claude/settings.json`.

The **Auth** button runs `gcloud auth application-default login`. You only need it if you use
Claude through Google Vertex AI.

## Privacy

Everything stays on your computer. Agent Hub reads the folder names in `~/.claude/projects`
to find your projects and their last activity, and stores pins and settings in
`~/.claude/project-launcher/config.json`. Pasted or dropped files are copied to
`~/.claude/hub-inbox`. They are not deleted automatically, so clear that folder if it contains
anything sensitive.

## Troubleshooting

- **"Claude Code was not found"**: install Claude Code, then restart Agent Hub so it sees the new PATH.
- **Empty project list**: open the gear icon and set the projects folder, or just open a folder
  with `+ Create New Project`.

## License

MIT, see [LICENSE](LICENSE).

<p align="center">
  <img src="https://raw.githubusercontent.com/nikhilgupta15/mcp-repo-auditor/main/assets/logo.svg" alt="mcp-repo-auditor logo" width="120" height="120">
</p>

# mcp-repo-auditor

Check your code changes against the rules your repository already gives AI agents: `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, Copilot instructions, Kiro steering, skills and more.

It is a local [Model Context Protocol](https://modelcontextprotocol.io) server. You ask your AI assistant to "audit my changes" and get back a compliance table in the chat, or an HTML report you open in a browser.

- **Local.** No API key, no account, no network calls. It reads your git diff and your rule files, nothing else.
- **Any repository, any language.** Nothing to configure per repo; the rules come from the files already in it.
- **Only relevant rules.** A Python rule is not checked against a TypeScript file, and a testing rule is not checked against a migration.

## Demo

<!-- Demo video: drag mcp-repo-auditor-demo.mp4 onto the line below in the GitHub editor. -->
https://github.com/user-attachments/assets/3414f3aa-ac69-45a1-a277-c8e9797ff5da

The HTML report for a sample audit:

![HTML compliance report showing the verdict, counts and suggested code changes](https://raw.githubusercontent.com/nikhilgupta15/mcp-repo-auditor/main/assets/report.png)


## Requirements

- [Node.js](https://nodejs.org) 18.17 or newer
- [Git](https://git-scm.com) on your `PATH`
- An MCP client: Claude Code, Claude Desktop, Cursor, VS Code, Kiro, Windsurf or any other

## Install

There is nothing to download by hand. Your MCP client starts the server with `npx`, which fetches the package the first time.

### Claude Code

```bash
claude mcp add repo-auditor --scope user -- npx -y mcp-repo-auditor
```

On Windows (not WSL), `npx` has to be started through `cmd`:

```bash
claude mcp add repo-auditor --scope user -- cmd /c npx -y mcp-repo-auditor
```

`--scope user` makes it available in every project. Start a new Claude Code session, then run `/mcp` to confirm `repo-auditor` is connected.

### Cursor

Add to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "repo-auditor": {
      "command": "npx",
      "args": ["-y", "mcp-repo-auditor"]
    }
  }
}
```

### VS Code (GitHub Copilot)

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "repo-auditor": {
      "command": "npx",
      "args": ["-y", "mcp-repo-auditor"]
    }
  }
}
```

### Kiro

Add to `.kiro/settings/mcp.json` (workspace) or `~/.kiro/settings/mcp.json` (all workspaces):

```json
{
  "mcpServers": {
    "repo-auditor": {
      "command": "npx",
      "args": ["-y", "mcp-repo-auditor"],
      "autoApprove": ["audit_repo_compliance", "render_compliance_report"]
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`, using the same block as Cursor.

### Claude Desktop

Config file: `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS).

Claude Desktop does not run inside your repository, so tell the server where it is:

```json
{
  "mcpServers": {
    "repo-auditor": {
      "command": "npx",
      "args": ["-y", "mcp-repo-auditor"],
      "env": { "MCP_REPO_AUDITOR_ROOT": "/path/to/your/repo" }
    }
  }
}
```

You can also leave `env` out and name the repository in your request: "audit the working changes in /path/to/your/repo".

### Windows note for JSON configs

If the server fails to start on Windows with `npx` as the command, launch it through `cmd`:

```json
{ "command": "cmd", "args": ["/c", "npx", "-y", "mcp-repo-auditor"] }
```

## Use

Open your repository in the client and ask in plain words:

| You say | What is audited |
|---|---|
| "Audit my staged changes" | What `git add` has staged (the default) |
| "Audit my working changes" | Staged, unstaged and new untracked files |
| "Audit this branch" | Every commit on your branch since it left the default branch |
| "Audit this branch against develop" | The same, against a base branch you name |

### First run: four questions

The first time you audit a repository, you are asked:

1. **Results format:** Markdown table in the chat, or an HTML report file.
2. **Report folder** (HTML only): an absolute path, or a word like `downloads`, `desktop` or `documents`. Blank uses the system temp folder.
3. **Extra rule files:** files or folders to audit against besides the ones found automatically. Blank means none.
4. **Base branch** for branch audits. Blank means the repository's default branch (`main`, `master`, ...), which is found automatically.

Clients that support MCP forms (Claude Code does) show these as a form. In other clients the assistant asks them in the chat.

Your answers are saved per repository in `~/.mcp-repo-auditor/preferences.json`, never inside the repository. To change them, say "reconfigure the repo auditor". To override the format once, say it in the request: "audit my working changes as an HTML report".

### What you get

**Markdown** (in the chat):

- **Compliance Matrix:** one row per file and rule that passed, failed or could not be judged.
- **Violations:** each failure with the line, the reason and a fix.
- **Rules Considered:** what each rule key (`R1`, `R2`, ...) means and which file it came from.
- **Result:** counts and a verdict.

**HTML** (a single self-contained file; the assistant replies with its path):

- A verdict and pass / fail / skipped / not-applicable counts.
- A **Findings** tab: results per file, the offending lines, and suggested fixes shown as a code diff.
- A **Rules** tab: every rule key with its full text and source.
- Filters by status and by text; light and dark mode.

## Where rules come from

These are found automatically. A rule file you keep out of git (a personal `CLAUDE.md`, an ignored `.cursor/` folder) is still used. Only `AGENTS.md` / `CLAUDE.md` files found inside ignored subfolders, such as a virtualenv or vendored package, are skipped.

| Tool | Files |
|---|---|
| Agents (generic) | `AGENTS.md` (any folder), `.agent/` or `.agents/` → `rules/`, `guidelines/`, `workflows/`, `steering/`, and `SKILL.md` files |
| Claude | `CLAUDE.md` (any folder), `.claude/rules/**/*.md`, `.claude/skills/*/SKILL.md` |
| Cursor | `.cursorrules`, `.cursor/rules/**/*.{md,mdc}` |
| GitHub Copilot | `.github/copilot-instructions.md`, `.github/instructions/**/*.instructions.md` |
| Kiro | `.kiro/steering/**/*.{md,json}`, other `.kiro/**/*.md` |
| Cline | `.clinerules` (file or folder) |
| Windsurf | `.windsurfrules`, `.windsurf/rules/**/*.md` |
| Project docs | `CONTRIBUTING.md`, `ARCHITECTURE.md` (root, `docs/` or `.github/`) |

Also:

- An `AGENTS.md` or `CLAUDE.md` inside a subfolder applies only to files in that subfolder.
- If a rule file points at another one ("follow the guidelines in `docs/standards/`"), that target is read too.
- Scoping written in the files is respected: Cursor `globs` / `alwaysApply`, Copilot `applyTo`, Kiro `inclusion` / `fileMatchPattern`, Windsurf `trigger` / `globs`.
- Rules kept somewhere else? Name them in setup question 3, or in the request: "audit my changes, also use `docs/engineering-rules.md`".

## How it works

1. Reads the git diff for the scope you chose.
2. Finds the rule files and splits them into single rules.
3. Maps each changed file to the rules that apply to it, by language, path, glob and the content of the changed lines.
4. Hands the diff, the rules and the mapping to your AI assistant, with instructions to judge every pair strictly.
5. For HTML, the assistant sends its verdicts back and the server writes the report.

Steps 1 to 3 and the report are plain code and take well under a second. The judging in step 4 is done by your assistant's model, so its speed and quality depend on the model you use.

## Tools

| Tool | Purpose |
|---|---|
| `audit_repo_compliance` | Runs the audit. Inputs: `scope` (`staged`, `working`, `branch`), `branch`, `customRulePaths`, `repoPath`, `report` (`markdown`, `html`), `reconfigure` |
| `render_compliance_report` | Writes the HTML report from the assistant's findings |
| `configure_audit` | Saves or changes the preferences for a repository |

You do not normally call these yourself; the assistant picks them.

## Settings

Optional environment variables, set in the `env` block of your MCP config.

| Variable | Default | Meaning |
|---|---|---|
| `MCP_REPO_AUDITOR_ROOT` | the client's workspace | Repository to audit when the request does not name one |
| `MCP_REPO_AUDITOR_SETUP` | on | `off` skips the first-run questions and uses the defaults below |
| `MCP_REPO_AUDITOR_REPORT` | `markdown` | Default format: `markdown` or `html` |
| `MCP_REPO_AUDITOR_REPORT_DIR` | system temp folder | Default folder for HTML reports |
| `MCP_REPO_AUDITOR_CONFIG_DIR` | `~/.mcp-repo-auditor` | Where preferences are stored |
| `MCP_REPO_AUDITOR_MAX_CHARS` | `64000` | Target size of one audit result, in characters. Larger changes are cut to fit: small files stay whole and large ones share the rest |
| `MCP_REPO_AUDITOR_MAX_FILES` | `300` | Most changed files included |
| `MCP_REPO_AUDITOR_MAX_LINES_PER_FILE` | `1500` | Most diff lines per file |
| `MCP_REPO_AUDITOR_MAX_TOTAL_LINES` | `6000` | Most diff lines overall |
| `MCP_REPO_AUDITOR_MAX_RULES_PER_FILE` | `80` | Most rules checked per file (highest priority kept) |
| `MCP_REPO_AUDITOR_MAX_UNTRACKED_BYTES` | `524288` | Largest untracked file read in `working` scope |
| `MCP_REPO_AUDITOR_GIT_TIMEOUT_MS` | `60000` | Timeout for each git command |
| `MCP_REPO_AUDITOR_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` (written to stderr) |

When a limit cuts something off, the audit says so in its warnings and names the files that were not fully checked.

The size limit exists because MCP clients cap how much a tool may return (Claude Code allows 25,000 tokens by default). If your client allows more, raise `MCP_REPO_AUDITOR_MAX_CHARS`; otherwise audit a big change in smaller scopes.

## Troubleshooting

| Problem | What to do |
|---|---|
| The server does not start on Windows | Use the `cmd /c npx` form shown above |
| "Not inside a git repository" | Open the repository folder in your client, set `MCP_REPO_AUDITOR_ROOT`, or name the path in your request |
| "git could not open the repository" | Git itself refused; the message carries its reason and, for "dubious ownership", the command that fixes it |
| "Nothing is staged" | The default audit covers staged changes only. Accept the offer to audit your working changes, run `git add`, or ask for a branch audit |
| No rules found | The repository has none of the files listed above. Add one, or point at your own in setup question 3 |
| The setup questions do not appear | They are asked once per repository. Say "reconfigure the repo auditor" |
| The audit is slow | The time is the model judging each file against each rule. Audit a smaller scope, or lower `MCP_REPO_AUDITOR_MAX_RULES_PER_FILE` |
| I want to see what it is doing | Set `MCP_REPO_AUDITOR_LOG_LEVEL` to `debug` and read the server's stderr log in your client |

To update, restart your client; `npx -y mcp-repo-auditor@latest` in the config always fetches the newest version.

## Privacy

The server itself sends nothing anywhere. The diff and the rules it returns go to whichever AI assistant you are using, as with any other code you show it.

## Development

```bash
npm install        # installs and builds
npm run build      # -> dist/
npm test           # builds, then runs the end-to-end tests
npm run inspect    # try the tools in the MCP Inspector
```

## License

MIT

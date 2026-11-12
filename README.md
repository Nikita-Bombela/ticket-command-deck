# Ticket Command Deck

A local web page that shows your open Jira tickets next to their pull requests and the Claude Code sessions working on them. From each ticket you can resume a session or start a new one.

Everything runs on your machine. The deck reads your Jira tickets, your GitHub pull requests, and the session transcripts Claude Code already keeps in `~/.claude`. It stores nothing of its own.

## Requirements

- macOS. Other operating systems are not supported.
- Node.js 22 or later
- [Claude Code](https://claude.com/claude-code)
- [GitHub CLI](https://cli.github.com), logged in with `gh auth login`
- [WezTerm](https://wezterm.org), with `wezterm` on your `PATH`. WezTerm is the only supported terminal for now.
- A Jira Cloud API token
- Optional: the Claude desktop app. Without it, set **Open in** to **Terminal**.

## Set up

1. Clone the repository.

   ```sh
   git clone https://github.com/Nikita-Bombela/ticket-command-deck.git
   cd ticket-command-deck
   ```

2. Create a Jira API token at <https://id.atlassian.com/manage-profile/security/api-tokens>.

3. Create the file `~/.jira-env` with your own values.

   ```sh
   JIRA_BASE=https://your-company.atlassian.net
   JIRA_EMAIL=you@your-company.com
   JIRA_TOKEN=your-api-token
   ```

4. Make the file readable only by you.

   ```sh
   chmod 600 ~/.jira-env
   ```

5. Install the `/ticket` command for Claude Code.

   ```sh
   mkdir -p ~/.claude/commands
   cp commands/ticket.md ~/.claude/commands/ticket.md
   ```

6. Start the deck.

   ```sh
   node server.mjs
   ```

7. Open <http://127.0.0.1:4747>.

To use another port, start the deck with `PORT=5000 node server.mjs`.

## How a session is linked to a ticket

The deck links a session to a ticket when the ticket key, such as `PROJ-123`, appears in one of these places:

- A git branch the session worked on, such as `fix/PROJ-123-login`.
- The session title. Set it with `claude -n "PROJ-123 login fix"` or with `/rename` in a session.
- A `/ticket PROJ-123` command typed in the session.

Sessions started with the **Start session** button are linked automatically in the terminal. In the Claude desktop app, the button fills in the `/ticket` command as the prompt. Sessions from the last 14 days that match no ticket are listed under **Unlinked sessions**.

## What the page shows

- **Tickets.** Jira issues assigned to you that are not done, grouped by status.
- **Pull requests.** Your pull requests whose branch or title contains the ticket key, and pull requests created by a linked session. Each one shows the state. An open pull request also shows its reviews, its unresolved review comments, and its checks.
- **Sessions.** The title, branch, folder, and last activity of each session. A green dot marks a session that is running now.

## Controls

The header has two settings. The page remembers both.

| Setting | Effect |
|---|---|
| **Open in** | Where sessions open: the terminal (WezTerm) or the Claude desktop app. |
| **Default repo** | The folder for a new session when the ticket has no earlier session. |

Each row has one main button.

| Control | Action |
|---|---|
| **Start session** | Starts a session for the ticket in the place set by **Open in**. |
| Repo name on a ticket | The folder for that ticket's new session. It is the folder of the ticket's last session, or else the default repo. Select another folder to override it for that ticket. |
| **Resume** | Opens the session in the place set by **Open in**. |
| Three-dot menu | **Copy resume command** copies the terminal command. The second item opens the session in the other place. |
| **Rows** and **Board** | Switch between a table of tickets and a board with one column for each Jira status. |
| **Refresh** | Reloads all data. Pull requests are otherwise cached for 2 minutes. |

Do not open one session in WezTerm and in the desktop app at the same time.

## Limits

- The folder list for new sessions contains only folders where you have already run Claude Code.
- The deck currently opens sessions in WezTerm only. A setting to choose your own terminal is planned. Until then, you can change the `terminal` function in `server.mjs`.
- The deck reads at most 100 tickets and your 100 most recently updated pull requests.

## Security

- The server listens on `127.0.0.1` only and rejects requests from other origins.
- Your Jira token is read from `~/.jira-env` on each refresh and is sent only to your Jira site.

## Tests

```sh
node --test
```

## License

[MIT](LICENSE)

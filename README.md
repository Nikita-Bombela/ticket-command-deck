# Ticket Command Deck

A local web page that shows your open Jira tickets next to their pull requests and the Claude Code sessions working on them. From each ticket you can resume a session or start a new one.

Everything runs on your machine. The deck reads your Jira tickets, your GitHub pull requests, and the session transcripts Claude Code already keeps in `~/.claude`. It stores nothing of its own.

## Requirements

- macOS. Other operating systems are not supported.
- Node.js 22 or later
- [Claude Code](https://claude.com/claude-code)
- [GitHub CLI](https://cli.github.com), logged in with `gh auth login`
- Optional: [WezTerm](https://wezterm.org), to open sessions in a terminal. WezTerm is the only supported terminal for now.
- A Jira Cloud API token
- Optional: the Claude desktop app, to open sessions in the app. Without it, set **Open in** to **Terminal**.

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

   The deck also accepts the names `JIRA_DOMAIN`, `JIRA_USER`, and `JIRA_API_TOKEN`.

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

### Run in the background

Started with `node server.mjs`, the deck stops when you press Ctrl+C or close the terminal tab. To keep it running after you close the tab, start it in the background from the repository folder:

```sh
nohup node server.mjs > /tmp/ticket-command-deck.log 2>&1 &
```

Errors are written to `/tmp/ticket-command-deck.log`.

To stop the deck:

```sh
lsof -ti tcp:4747 | xargs kill
```

The deck does not start again after a restart of your computer, so run the start command again. Also stop and start the deck after you pull a new version.

### If Jira and GitHub are already set up

If another tool already created `~/.jira-env` with `JIRA_BASE`, `JIRA_EMAIL`, and `JIRA_TOKEN`, and `gh` is logged in, skip steps 2 to 4. Clone the repository, install the `/ticket` command (step 5), and start the deck.

Step 5 is optional. Without the `/ticket` command, your sessions still appear, but you cannot link a session by hand, and **Start session** cannot link a new session that has no ticket branch yet.

## If no tickets appear

When the deck cannot connect to Jira, the page shows a notice that names the cause and lists the steps to fix it. The causes are a missing `~/.jira-env` file, a missing value in the file, a token that Jira rejects, and a Jira address that cannot be reached. After you fix the file, select **Refresh**. You do not need to restart the deck.

If the GitHub CLI is not installed or not logged in, the page says so, and the deck shows tickets and sessions without pull requests.

## Which sessions appear

You do not need to register sessions. The deck scans the transcripts that Claude Code keeps in `~/.claude` on your computer, so it finds every existing and future session, whether you started it in the terminal or in the Claude desktop app.

- A session appears under a ticket when the deck can link it. See the next section.
- A session from the last 14 days that the deck cannot link appears under **Unlinked sessions**.
- Sessions that ran in the cloud or on another computer are not in `~/.claude` and do not appear.

The deck shows the tickets assigned to the Jira account in `~/.jira-env` and the pull requests of the GitHub account that `gh` is logged in to. Boards, the theme, and other settings are saved in your browser, so each person sets them up once.

## How a session is linked to a ticket

The deck links a session to a ticket when the ticket key, such as `PROJ-123`, appears in one of these places:

- A git branch the session worked on, such as `fix/PROJ-123-login`.
- The session title. Set it with `claude -n "PROJ-123 login fix"` or with `/rename` in a session.
- A `/ticket PROJ-123` command typed in the session.
- A message that starts with "Link this session to Jira ticket PROJ-123".

Sessions started with the **Start session** button are linked automatically. In the terminal, the button sends the `/ticket` command. In the Claude desktop app, it fills in a first message that starts with "Link this session to Jira ticket", because the app does not run a command from a link. Send that message to link the session. Sessions from the last 14 days that match no ticket are listed under **Unlinked sessions**.

## What the page shows

- **Tickets.** Jira issues assigned to you that are not done, grouped by status.
- **Pull requests.** With **Pull requests** set to **Mine**, the pull requests you opened whose title or branch contains the ticket key. With **All**, every pull request with the ticket key in its title, whoever opened it, with the name of its author. The deck searches your own GitHub account and the organizations you belong to. Each pull request shows its state. An open pull request also shows its reviews, its unresolved review comments, and its checks.
- **Sessions.** The title, branch, folder, and last activity of each session. A green dot marks a session that is running now.

## Jira boards

By default, the deck shows every open ticket assigned to you. To see one board only, load the board and select it.

1. Select the board picker next to the page title.
2. Type part of the board name or the project key, or paste a link to the board.
3. Select the board in the results.

The deck then shows only your open tickets on that board. For a board with sprints, it shows the tickets in the active sprint, with the sprint name and the days left. If a pasted link contains quick filters, the deck applies them. To return to every ticket, select **All my tickets** in the picker.

Loaded boards are saved in your browser. On the **Settings** page you can remove a board, or mark one with **Open first** so that the deck starts on it.

## Epics

The deck groups tickets under their Jira epic. Each epic has a header with its title, a link to the epic, and the number of your tickets in it.

- To close or open an epic, select its header. The page remembers which epics are closed.
- A sub-task is listed under the epic of its parent ticket.
- Tickets without an epic are listed last, under **Other tickets**.
- To turn grouping off, set **Group by** in the header to **None**. Each ticket then shows the title of its epic, and tickets are split into in progress and to do.

## Controls

The header has these settings. The page remembers them.

| Setting | Effect |
|---|---|
| **Pull requests** | **Mine** shows the pull requests you opened. **All** also shows the pull requests of other people for the same tickets. |
| **Open in** | Where sessions open: the terminal (WezTerm) or the Claude desktop app. |
| **Default repo** | The folder for a new session when the ticket has no earlier session. |

Each row has one main button.

| Control | Action |
|---|---|
| **Start session** | Starts a session for the ticket in the place set by **Open in**. |
| Repo name on a ticket | The folder for that ticket's new session. Select another folder to override it for that ticket. |
| **Resume** | Opens the session in the place set by **Open in**. |
| Three-dot menu | **Copy resume command** copies the terminal command. The second item opens the session in the other place. |
| **Refresh** | Reloads all data. Pull requests are otherwise cached for 2 minutes. |

Do not open one session in WezTerm and in the desktop app at the same time.

## Settings

Select **Settings** in the header. Settings are saved in your browser.

| Setting | Effect |
|---|---|
| **Theme** | **Default**, **Cyberpunk**, **Nord**, **Everforest**, **Peon**, **Night Elf**, **Alliance**, or **Undead**. |
| **Light or dark** | For the Default theme: light, dark, or the same as your computer. |
| **Layout** | **Table** shows one table of tickets. **Columns** shows one column for each Jira status. |
| **Jira boards** | Load, remove, and order boards. |
| **Open sessions in** | The same setting as **Open in** in the header. |
| **Default repo** | The same setting as in the header. |
| **Start session message** | The first message of a session that **Start session** opens in the Claude desktop app. You can use `{key}`, `{summary}`, and `{url}` for the ticket. A command in the message does not run, because the app treats the message as plain text. If you clear the box, the app opens an empty session, and the deck cannot link that session automatically. |
| **Reuse a ticket's last repo** | When on, a ticket that has sessions starts new ones in the folder of its latest session. |

## Without WezTerm

If the deck cannot find WezTerm, sessions open in the Claude desktop app and the **Terminal** option is unavailable. **Copy resume command** still works. If WezTerm is installed in an unusual place, start the deck with `WEZTERM_BIN=/path/to/wezterm node server.mjs`.

## Limits

- The folder list for new sessions contains only folders where you have already run Claude Code.
- The only terminal the deck can open is WezTerm. A setting to choose your own terminal is planned. Until then, you can change the `terminal` function in `server.mjs`.
- The deck reads at most 100 tickets.
- With **All**, the deck finds a pull request of another person only when the ticket key is in the title of the pull request.
- The deck lists only tickets that are assigned to you and not done, also on a board.

## Security

- The server listens on `127.0.0.1` only and rejects requests from other origins.
- Your Jira token is read from `~/.jira-env` on each refresh and is sent only to your Jira site.

## Tests

```sh
node --test
```

## License

[MIT](LICENSE)

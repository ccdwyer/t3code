# Connect Your Personal T3 Bot to Slack

T3 Code gives each developer a separate Slack identity. For example, Chris can install
`@t3_chris` and Sam can install `@t3_sam`. Each bot runs from that developer's T3 Code server,
uses only that developer's local projects and model settings, and keeps its Slack tokens on that
developer's computer.

You do not need to expose a webhook or public URL. T3 Code connects outward to Slack with Socket
Mode while it is running.

## Before You Start

You need:

- T3 Code running on the computer that will do the work.
- Every project you want the bot to use already added to that T3 Code environment.
- Permission to create and install a Slack app in your work workspace. Some companies require a
  Slack administrator to approve this.

## Step 1: Start the Wizard

1. Open T3 Code.
2. Open **Settings**.
3. Choose **Slack agents**.
4. Choose **Add identity**.
5. Enter your name and a handle suffix. If you enter `chris`, your bot will be `@t3_chris`.

Keep the wizard open. It creates the Slack app manifest for you.

## Step 2: Create the Slack App

1. In the wizard, copy the generated app manifest.
2. Open [Slack API: Your Apps](https://api.slack.com/apps) in your browser.
3. Choose **Create New App**, then **From an app manifest**.
4. Pick your work Slack workspace.
5. Paste the manifest and create the app.

The manifest enables Socket Mode, subscribes to mentions and thread messages, and requests the
permissions T3 Code needs to read context and reply.

## Step 3: Make the App Token

1. In the new Slack app, open **Basic Information**.
2. Find **App-Level Tokens**.
3. Choose **Generate Token and Scopes**.
4. Name it something like `t3-socket`.
5. Add the `connections:write` scope.
6. Generate the token and copy the value beginning with `xapp-`.

Paste that value into the **App token** field in T3 Code.

## Step 4: Install the Bot

1. In the Slack app, open **OAuth & Permissions**.
2. Choose **Install to Workspace** or **Reinstall to Workspace**.
3. Approve the requested permissions. If Slack asks for admin approval, send that request to your
   Slack administrator and continue after it is approved.
4. Copy the **Bot User OAuth Token** beginning with `xoxb-`.

Paste that value into the **Bot token** field in T3 Code. Do not post either token in Slack or put it
in a repository.

## Step 5: Choose Projects and Connect

1. In T3 Code, select every project this bot may use.
2. Choose one linked project as the default. A Slack request without a project selector starts
   there.
3. Optionally choose a default chat model for this Slack identity. Leave it on **Project default**
   to inherit the selected project's model.
4. Review the identity and acknowledge that Slack messages can start model turns on this computer.
5. Choose **Create Slack identity**.
6. Wait for the identity to show **Ready** and **Socket connected**.

T3 Code validates the workspace and bot identity before saving the connection. The tokens are kept
in T3 Code's local secret store and are never returned to the web, desktop, or mobile client.

Anyone in the Slack workspace who can mention or message the app can start model turns in its linked
projects. If the agent determines that a request needs workspace changes, it can promote the chat
to an isolated worktree and continue with full access on the computer running T3 Code. Only invite
the app to conversations whose members you trust with that access.

## Step 6: Use It in Slack

1. Invite the bot to a channel if the channel is private or Slack requires membership.
2. Start or open a Slack thread.
3. Mention the bot and give it a request, for example:

   ```text
   @t3_chris please investigate why the checkout test is failing
   ```

The first mention creates a normal visible T3 Chat in the default project and sends the Slack
thread through that message as context. For unusually long threads, T3 Code keeps up to the 500 most
recent messages through the triggering message and drops the oldest messages if needed to fit the
local snapshot safety limit. Every later message in the same Slack thread is sent to that same T3
Chat, even when the bot is not mentioned again. You can steer the work from Slack or open the linked
task in T3 Code.

New Slack-linked chats use the identity's default chat model when one is configured. Otherwise they
inherit the chosen project's default model. Changing the identity setting later affects only new
Slack-linked chats; an existing thread keeps the model already stored on its T3 Chat.

New Slack-linked chats begin in the project's existing checkout with approval-required access. This
avoids creating a worktree for requests that only need an explanation, investigation, or review.
When the agent decides that the request requires editing files or another workspace mutation, it
promotes the chat automatically. T3 Code then fetches the project's primary remote, reads that
remote's advertised default branch (for example `main` or `develop`), creates an isolated worktree
from the latest fetched commit, and continues the request there in a new model turn. You do not need
to add a flag or repeat the request.

Each promoted Slack thread has its own durable branch, so concurrent Slack threads in the same
project do not share uncommitted files or checkout state. The worktree directory is a disposable
cache: by default, T3 Code removes clean, inactive Slack worktrees after 14 days while keeping their
branches. If someone later replies in that Slack thread and the agent needs to edit again, T3 Code
recreates the checkout from the existing branch. Dirty, active, or shared checkouts are never
removed automatically. Change the retention period, or choose **Never**, under **Settings > Slack
agents > Worktree cleanup**.

### Optional Copy-on-Write Worktree Seeding

Projects with large generated directories can opt into fast copy-on-write seeding in `t3.json`:

```json
{
  "$schema": "https://t3.codes/schema/t3.json",
  "worktreeSeedPaths": ["node_modules", ".venv"]
}
```

Paths are relative to the project root and cannot traverse outside it or include `.git`. On macOS,
T3 Code uses `cp -cR`; on Linux and WSL it uses `cp --reflink=always -a`. Native Windows and
filesystems without clone/reflink support skip the seed and continue the normal project setup
script. T3 Code never falls back to an expensive full copy.

You can also message your personal bot directly. The first direct message creates a T3 Chat, and
later top-level direct messages in that same conversation continue the existing chat instead of
creating a new one each time.

T3 Code must remain running and connected for the bot to receive new Slack messages.

### Choose Another Linked Project

Settings shows a short alias for every project linked to the bot. Put `project:<alias>` in the first
request to choose a non-default project:

```text
@t3_chris project:cellartracker-research-app please review this pull request
```

The selector only applies while a new Slack thread is being linked. Later replies always continue
the same T3 Chat in the project chosen by the first request; they cannot move the linked task to a
different project. An unknown or unlinked alias is rejected without starting a model turn.

## Optional: Kick Off a Workflow

Chat is the default. To deliberately create a workflow ticket instead, include:

```text
@t3_chris project:<alias> workflow board:<board-id> lane:<lane-key> please implement this and open a PR
```

That Slack thread stays in workflow mode after it is linked. Normal mentions do not enter workflow
mode. Ordinary chats promote themselves to worktrees only if the agent needs to mutate the
workspace. Omit `project:<alias>` to use the bot's default project.

## More Than One Developer

Each developer repeats these steps with their own app and identity. Slack can have `@t3_chris`,
`@t3_sam`, and other T3 bots installed at the same time. Each app token, bot token, Socket Mode
connection, linked project set, and resulting T3 Chats belong to its developer's T3 Code server.

## Disconnect or Rotate Tokens

From **Settings > Slack agents** you can:

- Test the connection.
- Use **Edit defaults** on an existing identity to change the default project and chat model for new
  Slack-linked threads. Choosing an unlinked default project links it automatically.
- Change the other linked projects people can target with project selectors.
- Disable an identity without deleting its tokens or history.
- Replace both tokens after rotating or reinstalling the Slack app.
- Disconnect and remove the local tokens while preserving history.
- Delete a disabled identity that has no linked run history.

If an identity will not connect, confirm that the app is installed in the expected workspace, the
bot name matches the T3 handle, Socket Mode is enabled, and the app-level token has
`connections:write`.

If a Slack chat cannot promote itself to a worktree, confirm that the project is a Git repository
with a reachable primary remote and that the remote advertises a default branch. T3 Code does not
guess `main` when the repository's default is unavailable.

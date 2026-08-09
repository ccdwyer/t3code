# Slack Agents Mock Lab

The development-only Slack mock lab tests Slack-shaped T3 Chat behavior without connecting to
slack.com. For the real setup flow, see [Connect Your Personal T3 Bot to Slack](slack-agents.md).

It does not use Slack OAuth, Socket Mode, Events API, bot tokens, signing secrets, or Slack Web API
calls. No real Slack workspace is connected.

## Create @t3_chris

This surface exists only in development builds. Open Settings, then Slack Agents, expand
**Developer testing > Mock Thread Lab**, and choose **Create mock identity**:

1. Enter an owner label, such as `Chris`, and the handle suffix `chris`.
2. Choose any project already registered in the connected T3 environment.
3. Acknowledge that messages from the mock workspace can start agent turns in that project, then
   create the identity.

T3 Code builds the handle as `@t3_chris`. Several people can create their own bot identities in the
same environment. Each instance has an immutable mock bot user id, so renaming a handle does not
redirect an existing Slack thread.

## Chat Is The Default

The first event for a bot and Slack thread creates a normal, visible T3 Chat thread in the bot's
project. The first T3 message includes the complete supported Slack transcript through the selected
triggering message.

Every later event in that linked Slack thread sends the new Slack message as another user turn to
the same T3 Chat thread. Follow-ups use the model, runtime, and interaction settings currently stored
on that linked thread. The project default model selection, or the normal Codex fallback when the
project has no default, is used only when the thread is first created. Replayed Slack events are
ignored, so the same message is not sent to the model twice.

Open the linked T3 Chat thread from the mock lab to watch or continue the conversation directly.

Like real Slack chats, mock chats do not create a worktree just for conversation or read-only work.
If the agent needs to edit, it promotes the linked chat automatically, creates an isolated checkout
from the latest advertised default branch of the primary remote, and continues there. Clean stale
checkouts can later be removed while their durable chat branches are preserved.

## Optional Workflow Mode

Choose Workflow in the mock thread lab when the request should create a workflow ticket instead of
an ordinary chat thread. Workflow mode asks for a board and automatic entry lane, then uses the
existing workflow machinery for admission, isolated worktrees, agent steps, pull requests, and
status updates.

The mode is fixed when the Slack thread is first linked. Later events continue that same chat thread
or workflow ticket; they do not silently convert one kind of run into the other.

## Mock Thread Lab

The lab is a compact test harness, not a Slack clone. Pick an enabled mock bot, add chronological
messages, choose the message representing the new Slack event, and send it.

For a first event, include the whole conversation through the triggering message. For a follow-up,
reuse the same mock thread key and add the new reply. The result links to the ordinary T3 Chat thread
or, when Workflow mode was explicitly selected, the workflow ticket and pull request.

## Context Bounds

The supported transcript includes messages through the triggering message plus attachment metadata
and links. It excludes reactions, canvases, huddles, deleted-message history, and file bytes.

Mock snapshots are limited to 500 messages and 1 MiB of canonical JSON. Oversized threads are
rejected before a T3 thread, workflow ticket, run, or bot reply is created.

## Concurrency And Risk

Multiple bot identities and linked Slack threads can be active at once. Their immutable bot and run
ids keep messages from crossing between employees or source threads.

Treat the mock workspace as an execution surface. Anyone authorized to operate the T3 environment
can send mock events that start model turns. Workflow mode additionally requires workflow access.

# Slack Agents Mock

Slack Agents Mock lets you test a Slack-shaped agent workflow from T3 Code without connecting to
slack.com. It creates local mock bot identities such as `@t3_chris`, accepts a mock thread mention,
starts the configured workflow, and shows the resulting T3 ticket and pull request links when they
exist.

It does not use Slack OAuth, Socket Mode, Events API, bot tokens, signing secrets, or Slack Web API
calls. No real Slack workspace is connected.

## Create @t3_chris

Open Settings, then Slack Agents. Choose Add mock bot and enter:

- Owner label: `Chris`
- `@t3_` handle suffix: `chris`
- A registered project from the connected T3 environment
- A workflow board in that project
- An automatic lane/path that reaches Open PR after an agent step

T3 Code builds the handle as `@t3_chris`. The setup wizard reviews the owner, handle, project,
board, and automatic path before saving. Acknowledge that people represented in the mock workspace
can start an agent that changes code and opens a pull request in the selected project.

## Workflow Requirements

The selected board must have a deterministic automatic path from the entry lane through at least one
agent step and then an Open PR step. If that path is missing or changes later, the instance appears
as Needs setup until the target is fixed or the instance is reconfigured.

Disabled instances reject new mock mentions. Existing linked workflow tickets can continue and keep
reporting final status.

## Mock Thread Lab

The lab is a compact test harness, not a Slack clone. Pick an enabled mock bot, add chronological
messages, choose the message containing the request, and send the mention.

Each bot plus source thread starts at most one run. Re-sending the same thread returns the existing
ticket instead of starting duplicate work. Start a new mock thread for a separate run.

## Context Bounds

The supported thread snapshot includes messages through the triggering request plus attachment
metadata and links. It excludes reactions, canvases, huddles, deleted-message history, file bytes,
and replies posted after the trigger.

Mock snapshots are limited to 500 messages and 1 MiB of canonical JSON. Oversized threads are
rejected before a ticket, run, bot reply, or pull request is created.

## Concurrency And Risk

Multiple mock bot identities can exist in one T3 environment and run concurrently. Workflow
isolation creates separate tickets, branches, and worktrees for accepted mentions, while board WIP
limits may still queue work.

Treat the mock workspace as an execution surface. Anyone with access to operate workflows in the T3
environment can manage mock instances and send mock mentions that start code execution.

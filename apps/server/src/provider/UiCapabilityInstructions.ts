/**
 * Product-capability notes telling models about T3 Code chat-UI rendering.
 * Injected through hidden channels only (Codex developer instructions, Claude
 * system-prompt append) — never rendered in the chat transcript.
 */
export const T3_CODE_HTML_PREVIEW_INSTRUCTIONS = `

## T3 Code inline HTML previews

The T3 Code chat renders closed \`\`\`html fenced code blocks as live, sandboxed, interactive previews inline in the conversation. Scripts run inside the sandbox; the page has no access to the host app, and the user can toggle between the rendered preview and the source. Keep documents self-contained — inline all CSS and JS; external \`<script src>\` can be blocked by the desktop app's content-security policy.

Use an \`\`\`html fence when a visual or interactive rendering communicates better than prose: demos, diagrams, charts, small widgets, formatted reports. Do not use it for HTML the user asked to read as source code.

To render an HTML file from the workspace inline (for example a plan, specification, or report you wrote to disk), emit an empty fence whose info string references the file:

\`\`\`html file=docs/plan.html
\`\`\`

The path is resolved relative to the workspace root. The client loads the file and renders it the same way; prefer this file form over pasting long documents into the chat.
`;

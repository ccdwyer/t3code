import { useEffect } from "react";
import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";

import { getAgentKeySlot } from "./agentKeySlots";
import { toastManager } from "./components/ui/toast";
import { agentKeySlotIndexFromCommand, resolveShortcutCommand } from "./keybindings";
import { isTerminalFocused } from "./lib/terminalFocus";
import { isModelPickerOpen } from "./modelPickerVisibility";
import { primaryServerKeybindingsAtom } from "./state/server";
import { buildThreadRouteParams } from "./threadRoutes";

// ── Agent-key press handler ──────────────────────────────────────────
//
// Dispatches the `agentKey.open.1..6` keybinding commands: a press opens the
// thread in `agentKeySlots` slot N — the SAME store the LED sync reads, so a
// key press and its LED can never point at different threads (spec §4; never
// `thread.jump.N`, whose sidebar-derived ordering can diverge).
//
// Window-level (not route-level) because the agent keys must work anywhere in
// the authenticated app, not only while a chat is open. Mounted once via
// `CodexMicroHost` in routes/__root.tsx. With no device attached the commands
// simply have no bindings (seeding runs on first connect), so this handler is
// a no-op for users without a Codex Micro.

export function CodexMicroAgentKeyHandler(): null {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const router = useRouter();

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: {
          terminalFocus: isTerminalFocused(),
          // This handler runs outside any thread route, so per-thread terminal
          // state is unknown; agent-key bindings are seeded without a `when`
          // clause, and non-agent-key commands are ignored below regardless.
          terminalOpen: false,
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      const slotIndex = agentKeySlotIndexFromCommand(command ?? "");
      if (slotIndex === null) return;
      event.preventDefault();
      event.stopPropagation();
      const slot = getAgentKeySlot(slotIndex);
      if (slot === null) {
        toastManager.add({ type: "info", title: "No chat on that key" });
        return;
      }
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(slot),
      });
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [keybindings, router]);

  return null;
}

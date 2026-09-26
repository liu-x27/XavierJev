/**
 * What the gate says to one Claude Code permission request.
 *
 * Claude Code fires its PermissionRequest hook only when it is about to ask
 * the user about a tool call — a call no rule already allowed or denied —
 * which is exactly the set of calls the gate was built for. The answer is
 * either "allow", which skips that prompt, or nothing at all, which leaves
 * Claude Code to ask as it would have. Never "deny": a denial the user never
 * sees looks, to the agent, like a tool that is broken, and a gate that can
 * only narrow what gets asked about cannot make anything less safe than
 * asking.
 *
 * Three things are left to Claude Code untouched:
 *
 *   - any permission mode other than Manual ("default") and accept-edits.
 *     Auto mode has a classifier of its own, and a prompt it falls back to
 *     after that classifier said no is one this gate must not answer.
 *   - any tool but Bash. The four questions and the 0.2 threshold were
 *     measured on shell commands and nothing else.
 *   - everything but the command itself. Claude Code sends a description the
 *     agent wrote for the call; the gate was measured on the command alone,
 *     and a line of the agent's own prose is not evidence about what the
 *     command does.
 */
import type { GateVerdict, RiskGate } from "../../src/decisions.js";

/** The fields of Claude Code's PermissionRequest hook input that this reads. */
export interface PermissionRequestInput {
  hook_event_name?: string;
  permission_mode?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  session_id?: string;
  cwd?: string;
}

export interface HookResponse {
  hookSpecificOutput?: {
    hookEventName: "PermissionRequest";
    decision: { behavior: "allow"; message: string };
  };
}

export interface Decision {
  /** The JSON to send back: an allow, or an empty object, which leaves the prompt as it was. */
  response: HookResponse;
  /** Why the gate stayed out of it, when it did. */
  skipped?: string;
  command?: string;
  verdict?: GateVerdict;
}

/** The modes in which a person would otherwise be asked, and the gate may clear the call. */
const GATED_MODES = new Set(["default", "acceptEdits"]);

export async function decide(
  input: PermissionRequestInput,
  gate: RiskGate,
  options: { observe?: boolean } = {},
): Promise<Decision> {
  if (input.hook_event_name !== "PermissionRequest") return { response: {}, skipped: "not a PermissionRequest" };
  const mode = input.permission_mode ?? "default";
  if (!GATED_MODES.has(mode)) return { response: {}, skipped: `permission mode "${mode}" is Claude Code's to handle` };
  if (input.tool_name !== "Bash") return { response: {}, skipped: `only Bash was measured, not ${input.tool_name}` };
  const command = input.tool_input?.command;
  if (typeof command !== "string" || !command.trim()) return { response: {}, skipped: "no command" };

  const verdict = await gate({ toolName: "Bash", input: { command }, description: command, cwd: input.cwd });
  if (verdict.action !== "allow" || options.observe) return { response: {}, command, verdict };
  return {
    response: {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", message: `XavierJev cleared it: ${verdict.reason}` },
      },
    },
    command,
    verdict,
  };
}

import { GATE_CANARIES, type GateCanary } from "../../src/gate.js";
import { LlmJudge } from "../../src/llm.js";
import { recordingProblems, SidecarJudge } from "../../src/sidecar.js";
import type { JudgeBackend } from "../../src/types.js";

/** The judge a Claude Code hook server runs the gate on, with what its self-check compares against. */
export interface HookJudge {
  judge: JudgeBackend;
  /** The shipped 0.2 for the prompted judge; a trained judge's own, on its own scale. */
  threshold: number;
  canaries: readonly GateCanary[];
  /** What the canaries were recorded on, not what the judge says it is now: checkGate compares the two. */
  recordedOn?: { model: string; digest: string } | undefined;
  /** Reasons a sidecar's recording may not describe how it is being run (`recordingProblems`). */
  setupProblems: string[];
}

/**
 * The shipped judge, or a trained one served by sidecar/serve.py, which brings its own threshold
 * and canaries: its probabilities are on its own scale. Exits with the reason when neither can
 * be had — no sidecar, no recorded canaries, no judge configured, or one without logprobs.
 */
export async function hookJudge(options: {
  backend?: string | undefined;
  sidecarUrl?: string | undefined;
  readScripts: boolean;
}): Promise<HookJudge> {
  if (options.backend === "sidecar") {
    const sidecar = new SidecarJudge({ url: options.sidecarUrl ?? process.env.XAVIERJEV_SIDECAR_URL });
    const info = await sidecar.info().catch((err: unknown) => {
      console.error(`No sidecar: ${err instanceof Error ? err.message : String(err)} (start sidecar/serve.py first).`);
      process.exit(1);
    });
    if (!info.recording?.canaries?.length) {
      console.error("The sidecar has no recorded canaries: run `npm run sidecar:canaries` once after training.");
      process.exit(1);
    }
    return {
      judge: sidecar,
      threshold: info.threshold,
      canaries: info.recording.canaries,
      recordedOn: info.recording.recordedOn,
      setupProblems: recordingProblems(info, { readScripts: options.readScripts }),
    };
  }
  if (!(process.env.AGENT_JUDGE_API_KEY || process.env.AGENT_JUDGE_BASE_URL)) {
    console.error("No judge: set AGENT_JUDGE_API_KEY, AGENT_JUDGE_BASE_URL and AGENT_JUDGE_MODEL (see .env.example).");
    process.exit(1);
  }
  const llm = new LlmJudge();
  const capability = await llm.probe();
  if (!capability.logprobs) {
    console.error(`${llm.name} cannot be a gate: ${capability.detail}`);
    process.exit(1);
  }
  return { judge: llm, threshold: 0.2, canaries: GATE_CANARIES, setupProblems: [] };
}

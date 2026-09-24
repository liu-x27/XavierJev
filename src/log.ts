/**
 * Where the decision layer's warnings go.
 *
 * It says very little, and each thing it says is a way it has stopped doing
 * its job: an endpoint that quietly returns no logprobs, a gate falling
 * through to the user because its judge is down. So the default is the
 * console, and a host that has a logger of its own passes it to `setLogger`,
 * so that these land wherever the host's own warnings are read.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

function isLevel(value: string | undefined): value is LogLevel {
  return value !== undefined && value in LEVELS;
}

let level: LogLevel = isLevel(process.env.AGENT_LOG_LEVEL) ? process.env.AGENT_LOG_LEVEL : "info";

const consoleLogger: Logger = {
  debug: (msg) => console.debug(`[judge] ${msg}`),
  info: (msg) => console.info(`[judge] ${msg}`),
  warn: (msg) => console.warn(`[judge] ${msg}`),
  error: (msg) => console.error(`[judge] ${msg}`),
};

let sink: Logger = consoleLogger;

/** Send the decision layer's messages to the host's own logger, or back to the console with none. */
export function setLogger(logger: Logger | undefined): void {
  sink = logger ?? consoleLogger;
}

const at =
  (name: Exclude<LogLevel, "silent">) =>
  (msg: string): void => {
    if (LEVELS[name] >= LEVELS[level]) sink[name](msg);
  };

export const logger = {
  debug: at("debug"),
  info: at("info"),
  warn: at("warn"),
  error: at("error"),
  /** The quietest level still shown. Evals set "error", since their failures are counted rather than printed. */
  setLevel(next: LogLevel): void {
    level = next;
  },
};

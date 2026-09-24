import type { NextFunction, Request, Response } from "express";

/**
 * Only this machine may ask.
 *
 * Both servers here put a model behind a port, and the Claude Code one can
 * clear commands for an agent to run, so who can reach them is their whole
 * access control. The socket is bound to loopback, so nothing on the network
 * can connect; a Host header that is not a loopback name is refused, which is
 * what a DNS-rebinding page would send; and an Origin from anywhere but a
 * loopback page is refused, which is what any other website's fetch would
 * send. There are no CORS headers at all.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopback(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function localOnly(req: Request, res: Response, next: NextFunction): void {
  const { host, origin } = req.headers;
  if (!host || !isLoopback(`http://${host}`) || (origin !== undefined && !isLoopback(origin))) {
    res.status(403).json({ ok: false, reason: "this API only answers pages served from this machine" });
    return;
  }
  next();
}

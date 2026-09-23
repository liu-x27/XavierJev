/**
 * Failed read-only calls, labelled by whether trying the exact same call
 * again could succeed. Written in the formats our own tools produce
 * (`src/tools/web-fetch.ts`, `file-read.ts`, `grep.ts`, `glob.ts`), with the
 * underlying Node and HTTP errors as they actually read.
 *
 * The labels are mine, and a few are arguable: a 429 is transient, but
 * retrying it immediately may just earn another 429; a DNS lookup that fails
 * with EAI_AGAIN is a temporary resolver failure, while ENOTFOUND is a name
 * that does not exist. Those pairs are in on purpose — they are where a
 * pattern list and a judge would differ.
 */

export interface RetryCase {
  tool: string;
  call: string;
  error: string;
  transient: boolean;
}

const fetch = (url: string, error: string, transient: boolean): RetryCase => ({
  tool: "WebFetch",
  call: `WebFetch(${url})`,
  error,
  transient,
});

export const RETRY_CASES: RetryCase[] = [
  // ── transient ───────────────────────────────────────────────
  fetch("https://api.github.com/repos/x/y", "HTTP 503 Service Unavailable: https://api.github.com/repos/x/y", true),
  fetch("https://registry.npmjs.org/react", "HTTP 502 Bad Gateway: https://registry.npmjs.org/react", true),
  fetch("https://example.com/docs", "HTTP 504 Gateway Timeout: https://example.com/docs", true),
  fetch("https://pypi.org/simple/numpy/", "Fetch failed: TypeError: fetch failed (cause: ECONNRESET)", true),
  fetch("https://docs.python.org/3/", "Fetch failed: TypeError: fetch failed (cause: ETIMEDOUT)", true),
  fetch("https://nodejs.org/api/fs.html", "Fetch failed: TimeoutError: The operation was aborted due to timeout", true),
  fetch("https://api.openai.com/v1/models", "HTTP 429 Too Many Requests: https://api.openai.com/v1/models", true),
  fetch("https://en.wikipedia.org/wiki/Snake", "Fetch failed: TypeError: fetch failed (cause: getaddrinfo EAI_AGAIN en.wikipedia.org)", true),
  fetch("https://crates.io/api/v1/crates/serde", "Failed to read response body: TypeError: terminated (cause: SocketError: other side closed)", true),
  fetch("https://github.com/x/y/raw/main/a.json", "Fetch failed: Error: socket hang up", true),
  fetch("https://status.example.com/", "HTTP 503 Service Unavailable: The server is temporarily unable to service your request due to maintenance downtime", true),
  fetch("https://example.org/feed.xml", "Fetch failed: TypeError: fetch failed (cause: ECONNREFUSED 93.184.216.34:443)", true),
  fetch("https://huggingface.co/api/models", "HTTP 500 Internal Server Error: https://huggingface.co/api/models", true),
  fetch("https://example.com/big.csv", "Failed to read response body: TypeError: terminated (cause: UND_ERR_SOCKET)", true),
  { tool: "Read", call: "Read(D:/CODE/agent-app/package.json)", error: "Read threw: EBUSY: resource busy or locked, open 'D:/CODE/agent-app/package.json'", transient: true },
  { tool: "Grep", call: 'Grep("TODO" in src)', error: "Grep threw: EMFILE: too many open files, open 'src/agent.ts'", transient: true },
  { tool: "Glob", call: "Glob(**/*.ts)", error: "Glob error: Error: EAGAIN: resource temporarily unavailable, scandir 'node_modules/.cache'", transient: true },

  // ── not transient ───────────────────────────────────────────
  fetch("https://example.com/missing", "HTTP 404 Not Found: https://example.com/missing", false),
  fetch("https://api.github.com/user", "HTTP 401 Unauthorized: https://api.github.com/user", false),
  fetch("https://intranet.corp/wiki", "HTTP 403 Forbidden: https://intranet.corp/wiki", false),
  fetch("https://api.example.com/v2/items", "HTTP 400 Bad Request: https://api.example.com/v2/items", false),
  fetch("https://old.example.com/page", "HTTP 410 Gone: https://old.example.com/page", false),
  fetch("https://nonexistent-domain-xyz.dev", "Fetch failed: TypeError: fetch failed (cause: getaddrinfo ENOTFOUND nonexistent-domain-xyz.dev)", false),
  fetch("htp:/example.com", "Fetch failed: TypeError: Invalid URL", false),
  fetch("https://self-signed.badssl.com/", "Fetch failed: TypeError: fetch failed (cause: SELF_SIGNED_CERT_IN_CHAIN)", false),
  fetch("https://expired.badssl.com/", "Fetch failed: TypeError: fetch failed (cause: CERT_HAS_EXPIRED)", false),
  fetch("https://api.example.com/upload", "HTTP 413 Payload Too Large: https://api.example.com/upload", false),
  fetch("https://example.com/api", "HTTP 405 Method Not Allowed: https://example.com/api", false),
  { tool: "Read", call: "Read(D:/CODE/agent-app/src/agnet.ts)", error: "File not found: D:/CODE/agent-app/src/agnet.ts", transient: false },
  { tool: "Read", call: "Read(D:/CODE/agent-app/data/dump.sql)", error: "File is too large (48213 KB). Use offset/limit to read in chunks.", transient: false },
  { tool: "Read", call: "Read(D:/CODE/agent-app/docs/snake-arena.gif)", error: "Cannot read file as text: D:/CODE/agent-app/docs/snake-arena.gif", transient: false },
  { tool: "Read", call: "Read(C:/Windows/System32/config/SAM)", error: "Read threw: EACCES: permission denied, open 'C:/Windows/System32/config/SAM'", transient: false },
  { tool: "Read", call: "Read(D:/CODE/agent-app/src)", error: "Read threw: EISDIR: illegal operation on a directory, read", transient: false },
  { tool: "Grep", call: 'Grep("(unclosed" in src)', error: "Invalid regex: SyntaxError: Invalid regular expression: /(unclosed/: Unterminated group", transient: false },
  { tool: "Grep", call: 'Grep("TODO" in srcc)', error: "Path not found: D:/CODE/agent-app/srcc", transient: false },
  { tool: "Glob", call: "Glob(**/*.{ts)", error: "Glob error: Error: Unmatched brace in pattern '**/*.{ts'", transient: false },
];

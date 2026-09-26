/**
 * Run `work` with a deadline, and stop it when the deadline passes.
 *
 * Every decision gives its judge a few seconds and then goes on without it. Racing the call
 * against a timer only stops the *waiting*: the request itself keeps running, holding a slot
 * on a local model that serves one request at a time, so the next command's judgement queues
 * behind an answer nobody will read. The signal handed to `work` is aborted at the deadline;
 * backends pass it to their requests (`NoulOptions.signal`), and the call is dropped.
 */
export async function withDeadline<T>(
  ms: number,
  message: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(message);
      controller.abort(err);
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}

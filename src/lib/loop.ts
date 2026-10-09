export interface Loop {
  stop(): void;
}

/**
 * Run `pass` now and then `intervalMs` after each pass finishes.
 *
 * Unlike `setInterval`, a slow pass delays the next one instead of running
 * alongside it. `pass` should handle its own errors; a rejection is swallowed
 * so the loop keeps going.
 */
export function every(intervalMs: number, pass: () => Promise<void>): Loop {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const run = async (): Promise<void> => {
    try {
      await pass();
    } catch {
      // The pass logs its own failures.
    }
    if (!stopped) timer = setTimeout(() => void run(), intervalMs);
  };

  void run();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

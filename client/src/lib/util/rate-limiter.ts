/**
 * A utility class for rate limiting operations
 */
export class RateLimiter {
  private lastExecutionTime: number = 0;
  private timeoutId: NodeJS.Timeout | null = null;
  private queuedExecution: (() => void) | null = null;

  /**
   * Creates a new RateLimiter instance
   * @param minInterval Minimum time interval between executions in milliseconds
   */
  constructor(private minInterval: number) {}

  /**
   * Executes the provided function with rate limiting
   * If called again before the minimum interval has passed:
   * - Cancels any pending execution
   * - Queues the new execution to run after the interval
   * 
   * @param fn Function to execute
   */
  execute(fn: () => void): void {
    const now = Date.now();
    const timeSinceLastExecution = now - this.lastExecutionTime;

    // Clear any pending execution
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    // If enough time has passed, execute immediately
    if (timeSinceLastExecution >= this.minInterval) {
      this.lastExecutionTime = now;
      fn();
    } else {
      // Otherwise, queue for later execution
      this.queuedExecution = fn;
      this.timeoutId = setTimeout(() => {
        if (this.queuedExecution) {
          this.lastExecutionTime = Date.now();
          this.queuedExecution();
          this.queuedExecution = null;
          this.timeoutId = null;
        }
      }, this.minInterval - timeSinceLastExecution);
    }
  }

  /**
   * Executes the provided async function with rate limiting
   * Similar to execute() but handles promises
   * 
   * @param fn Async function to execute
   * @returns Promise that resolves when the function executes
   */
  async executeAsync(fn: () => Promise<any>): Promise<any> {
    return new Promise((resolve, reject) => {
      this.execute(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  /**
   * Cancels any pending execution
   */
  cancel(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
      this.queuedExecution = null;
    }
  }
}

/**
 * Creates a debounced version of a function that delays execution until after
 * the specified wait time has elapsed since the last time it was called.
 * 
 * @param func The function to debounce
 * @param wait The number of milliseconds to delay
 * @returns A debounced function
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout | null = null;
  
  return function(...args: Parameters<T>): void {
    if (timeout) {
      clearTimeout(timeout);
    }
    
    timeout = setTimeout(() => {
      func(...args);
      timeout = null;
    }, wait);
  };
}
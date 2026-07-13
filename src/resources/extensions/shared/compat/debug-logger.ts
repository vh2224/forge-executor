/**
 * Graceful compat shim: gsd debug-logger instrumentation is a no-op.
 */
export function debugTime(label: string): (data?: unknown) => void {
  void label;
  return (data?: unknown) => {
    void data;
  };
}

export function debugCount(label: string): void {
  void label;
}

export function debugPeak(label: string, n: number): void {
  void label;
  void n;
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export const log = {
  info: (...args: unknown[]): void => console.log(`[${stamp()}] [alsf]`, ...args),
  warn: (...args: unknown[]): void => console.warn(`[${stamp()}] [alsf] !`, ...args),
  error: (...args: unknown[]): void => console.error(`[${stamp()}] [alsf] x`, ...args),
};

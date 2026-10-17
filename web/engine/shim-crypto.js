/** 浏览器版 node:crypto.randomBytes 垫片（只用到 toString('hex')）。 */
export function randomBytes(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  const hex = Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  return { length: n, toString: () => hex };
}

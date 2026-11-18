// lib/chain.js as screens/backup.js sees it: keys(), each call answering after the next of `delays` (ms).
export const delays = [];
let n = 0;
export async function keys() {
  const wait = delays.length ? delays.shift() : 0;
  if (wait) await new Promise((r) => setTimeout(r, wait));
  return {
    generateMnemonic: (count) => {
      n += 1;
      return Array.from({ length: count }, (_, i) => `w${n}x${i + 1}`).join(' ');
    },
  };
}

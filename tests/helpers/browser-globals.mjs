export function withBrowserGlobals(values, callback) {
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const restore = () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
  let result;
  try { result = callback(); }
  catch (error) { restore(); throw error; }
  if (result && typeof result.then === 'function') return Promise.resolve(result).finally(restore);
  restore();
  return result;
}

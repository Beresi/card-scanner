import '@testing-library/jest-dom';

// jsdom does not implement window.matchMedia. Provide a minimal stub so
// components that subscribe to (prefers-color-scheme) work in tests.
// The stub always reports dark=true (matching the default 'dark' theme).
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: query.includes('dark'),
      media: query,
      onchange: null,
      addListener: () => {},       // deprecated but some libs still call it
      removeListener: () => {},    // deprecated
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

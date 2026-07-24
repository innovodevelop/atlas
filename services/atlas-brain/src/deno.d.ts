/**
 * Ambient Deno type for the imported `_shared/*` modules (they call
 * `Deno.env.get`). At runtime denoShim.ts provides the real object over
 * process.env — this declaration just satisfies tsc.
 */
declare const Deno: {
  env: { get(key: string): string | undefined };
};

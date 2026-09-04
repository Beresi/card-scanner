/**
 * detach.ts — start a long-running job without holding the HTTP response open.
 *
 * Used by the two "kick it off and poll for progress" routes: the deep-sweep
 * scan and the catalog full-heal. Both take minutes, so the request must return
 * as soon as the job has an id to report; the frontend then polls `scan_runs` /
 * catalog progress.
 *
 * These jobs previously ran in a bundled Tauri sidecar process, which existed
 * ONLY to escape the Worker's CPU and subrequest limits. The self-hosted backend
 * has neither limit, so the work belongs in-process — one writer on the database
 * instead of two racing on the same file.
 *
 * Keeping the promise alive differs by host:
 *   • Node — the HTTP server keeps the event loop alive on its own; simply not
 *     awaiting the promise is enough.
 *   • Workers — an isolate may be torn down the moment the response is returned,
 *     so the promise must be handed to executionCtx.waitUntil. Reading
 *     `c.executionCtx` THROWS on Node (Hono has no execution context there), so
 *     the access is guarded rather than checked for null.
 */

/** The slice of the Workers execution context this module needs. */
interface WaitUntilCtx {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Let `promise` run to completion in the background.
 *
 * `host` is the Hono Context. It is typed as a bare `object` rather than
 * `Context<...>` so this helper stays usable from any router regardless of its
 * Bindings/Path generics — the only member read is `executionCtx`, and that read
 * is already defensive.
 *
 * Always attaches a rejection handler first: an unhandled rejection in a
 * detached job would crash the self-hosted server, which is a long-lived
 * process rather than a per-request isolate.
 */
export function detach(host: object, promise: Promise<unknown>, label: string): void {
  promise.catch((err: unknown) => {
    console.error(`[${label}] detached job failed`, err instanceof Error ? err.message : String(err));
  });

  try {
    const ctx = (host as { executionCtx?: WaitUntilCtx }).executionCtx;
    ctx?.waitUntil(promise);
  } catch {
    // No execution context — the Node host keeps the process alive itself.
  }
}

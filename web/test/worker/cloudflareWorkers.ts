/**
 * `cloudflare:workers` for Vitest in Node (vitest.config.ts aliases it here):
 * the Worker module imports `WorkerEntrypoint` for its cached `Proxy`
 * entrypoint, which only workerd provides.
 */
export class WorkerEntrypoint<E = unknown> {
  protected ctx: ExecutionContext;
  protected env: E;
  constructor(ctx: ExecutionContext, env: E) {
    this.ctx = ctx;
    this.env = env;
  }
}

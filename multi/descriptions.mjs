// multi/descriptions.mjs — thin re-export of the PRODUCTION loader.
// The multi-description build was promoted to production on 2026-10-25
// (descriptions.mjs at the project root). This shim keeps the parallel
// reference implementation in multi/ runnable and prevents the two drifting.
export * from '../descriptions.mjs';

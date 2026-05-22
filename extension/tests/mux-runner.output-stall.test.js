// @tier: integration
// Integration-tiered (not fast): R-APMW-6 drives subprocess timeout/SIGTERM
// cleanup ordering with a delayed-exit child. Under the fast tier's 8-way
// concurrency the child is starved and the timing barrier slips; this file is
// in tests/integration/.serial-tests.json so it runs serialized.

await import('../bin/__tests__/mux-runner.output-stall.spec.js');

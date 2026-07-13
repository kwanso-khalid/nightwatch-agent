// Checkout Service — real Express app for Nightwatch to monitor.
//
// Normal mode: /checkout returns 200 in ~100ms
// Chaos mode:  /checkout returns 500 in ~3000ms with error logs
//
// Chaos endpoint protected by CHAOS_TOKEN env var.
// Structured JSON logging to stdout → CloudWatch Logs via Fargate.

import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;
const CHAOS_TOKEN = process.env.CHAOS_TOKEN || 'chaos-secret';
const VERSION = process.env.APP_VERSION || 'v485';
const startTime = Date.now();

// ── Chaos State ─────────────────────────────────────────────
let chaosEnabled = false;
let chaosMode = null; // 'db-pool' or 'upstream-timeout'
let chaosStartedAt = null;
let requestCount = 0;
let errorCount = 0;

// ── Structured Logging ──────────────────────────────────────
function log(level, message, extra = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: 'checkout-service',
    version: VERSION,
    message,
    ...extra,
  };
  console.log(JSON.stringify(entry));
}

// ── Middleware ───────────────────────────────────────────────
app.use(express.json());

// ── Health Check ────────────────────────────────────────────
app.get('/health', (req, res) => {
  log('INFO', 'healthcheck ok', { route: '/health', latency_ms: 2 });
  res.json({
    status: chaosEnabled ? 'DEGRADED' : 'HEALTHY',
    version: VERSION,
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    chaos_enabled: chaosEnabled,
    request_count: requestCount,
    error_count: errorCount,
  });
});

// ── Checkout Endpoint ───────────────────────────────────────
app.post('/checkout', async (req, res) => {
  requestCount++;
  const orderId = `ord-${Math.floor(10000 + Math.random() * 90000)}`;
  const start = Date.now();

  if (chaosEnabled && chaosMode === 'db-pool') {
    // Scenario 1: Connection pool exhaustion
    const delay = 2500 + Math.random() * 1000;
    await new Promise((r) => setTimeout(r, delay));
    errorCount++;
    const latency = Date.now() - start;

    log('ERROR', `SQLTimeoutException: timeout after 5000ms waiting for connection from pool [pool=checkout-db-primary, active=5, max=5, queued=${Math.floor(40 + Math.random() * 140)}] at OrderRepository.save(OrderRepository.js:142)`, {
      order_id: orderId, latency_ms: latency, error_type: 'SQLTimeoutException',
    });

    return res.status(500).json({
      error: 'checkout_failed',
      message: 'SQLTimeoutException: timeout waiting for connection from pool',
      order_id: orderId, latency_ms: latency,
    });
  }

  if (chaosEnabled && chaosMode === 'upstream-timeout') {
    // Scenario 2: Upstream payment service timeout
    const delay = 4000 + Math.random() * 2000;
    await new Promise((r) => setTimeout(r, delay));
    errorCount++;
    const latency = Date.now() - start;

    log('ERROR', `upstream timeout: payments-api.internal POST /v1/charges timed out after ${Math.floor(latency)}ms order_id=${orderId} retries=3/3 trace_id=${Math.floor(1000000 + Math.random() * 9000000)}`, {
      order_id: orderId, latency_ms: latency, error_type: 'UpstreamTimeout',
      upstream_service: 'payments-api.internal',
    });

    log('WARN', `circuit breaker: payments-api state=OPEN failures=${Math.floor(5 + Math.random() * 10)}/5 last_failure=upstream_timeout`, {
      order_id: orderId, circuit_breaker: 'OPEN', service: 'payments-api.internal',
    });

    return res.status(502).json({
      error: 'upstream_timeout',
      message: 'payments-api.internal: POST /v1/charges timed out',
      order_id: orderId, latency_ms: latency,
    });
  }

  // Normal mode — fast, successful
  const latency = 80 + Math.random() * 40;
  await new Promise((r) => setTimeout(r, latency));

  log('INFO', `order completed order_id=${orderId} amount_usd=${(18 + Math.random() * 400).toFixed(2)} latency_ms=${Math.floor(latency)} payment_provider=stripe`, {
    order_id: orderId,
    latency_ms: Math.floor(latency),
  });

  res.json({
    status: 'completed',
    order_id: orderId,
    latency_ms: Math.floor(latency),
  });
});

// ── Traffic Generator (background) ──────────────────────────
// Generates realistic traffic so CloudWatch has data to alarm on
let trafficInterval = null;

function startTraffic() {
  if (trafficInterval) return;
  trafficInterval = setInterval(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      await fetch(`http://localhost:${PORT}/checkout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ item: 'test', quantity: 1 }),
        signal: controller.signal,
      });
    } catch { /* ignore — timeout or error */ }
    finally { clearTimeout(timeout); }
  }, 2000); // 30 requests/minute
}

// ── Chaos Controls ──────────────────────────────────────────
function authChaos(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (token !== CHAOS_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.post('/chaos/enable', authChaos, (req, res) => {
  const mode = req.query.mode || req.body?.mode || 'db-pool';
  const validModes = ['db-pool', 'upstream-timeout'];
  if (!validModes.includes(mode)) {
    return res.status(400).json({ error: `Invalid mode. Use: ${validModes.join(', ')}` });
  }
  chaosEnabled = true;
  chaosMode = mode;
  chaosStartedAt = new Date().toISOString();
  errorCount = 0;
  log('WARN', `CHAOS MODE ENABLED — mode: ${mode}`, { chaos: true, mode });
  res.json({
    ok: true,
    mode,
    message: mode === 'db-pool'
      ? 'Chaos: DB connection pool exhaustion. Checkout returns SQLTimeoutException.'
      : 'Chaos: Upstream payment service timeout. Checkout returns 502 gateway timeout.',
    started_at: chaosStartedAt,
  });
});

app.post('/chaos/disable', authChaos, (req, res) => {
  chaosEnabled = false;
  chaosMode = null;
  log('INFO', 'Chaos mode disabled — service returning to normal', { chaos: false });
  res.json({ ok: true, message: 'Chaos disabled. Service back to normal.' });
});

app.get('/chaos/status', authChaos, (req, res) => {
  res.json({
    chaos_enabled: chaosEnabled,
    chaos_mode: chaosMode,
    started_at: chaosStartedAt,
    error_count: errorCount,
    request_count: requestCount,
  });
});

// ── Metrics Endpoint (for monitoring) ───────────────────────
app.get('/metrics', (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
  const errorRate = requestCount > 0 ? ((errorCount / requestCount) * 100).toFixed(2) : '0.00';
  res.type('text/plain').send(
    `# HELP checkout_requests_total Total checkout requests\n` +
    `checkout_requests_total ${requestCount}\n` +
    `# HELP checkout_errors_total Total checkout errors\n` +
    `checkout_errors_total ${errorCount}\n` +
    `# HELP checkout_error_rate Error rate percentage\n` +
    `checkout_error_rate ${errorRate}\n` +
    `# HELP checkout_uptime_seconds Service uptime\n` +
    `checkout_uptime_seconds ${uptimeSeconds}\n`
  );
});

// ── Start ───────────────────────────────────────────────────
app.listen(PORT, () => {
  log('INFO', `checkout-service started on port ${PORT}`, { version: VERSION, port: PORT });
  console.log(`\n  checkout-service running on http://localhost:${PORT}`);
  console.log(`  Health:   GET  /health`);
  console.log(`  Checkout: POST /checkout`);
  console.log(`  Chaos:`);
  console.log(`    POST /chaos/enable?token=${CHAOS_TOKEN}&mode=db-pool        (SQLTimeoutException)`);
  console.log(`    POST /chaos/enable?token=${CHAOS_TOKEN}&mode=upstream-timeout (payment API timeout)`);
  console.log(`    POST /chaos/disable?token=${CHAOS_TOKEN}\n`);

  // Start background traffic
  startTraffic();
});

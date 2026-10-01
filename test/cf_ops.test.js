const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const { EventEmitter } = require('node:events');

const {
  CloudflareFleet,
  Logger,
  loadEnv,
  loadConfig,
  parseArgs,
  VALID_SECURITY_LEVELS
} = require('../index.js');

test('VALID_SECURITY_LEVELS contains standard Cloudflare modes', () => {
  assert.ok(VALID_SECURITY_LEVELS.includes('under_attack'));
  assert.ok(VALID_SECURITY_LEVELS.includes('medium'));
  assert.ok(VALID_SECURITY_LEVELS.includes('high'));
  assert.ok(VALID_SECURITY_LEVELS.includes('low'));
  assert.ok(VALID_SECURITY_LEVELS.includes('off'));
});

test('Logger works with and without color', () => {
  const loggerNoColor = new Logger(false);
  assert.strictEqual(loggerNoColor._c('32', 'hello'), 'hello');

  const loggerColor = new Logger(true);
  loggerColor.colorEnabled = true; // force enabled for testing
  assert.strictEqual(loggerColor._c('32', 'hello'), '\x1b[32mhello\x1b[0m');
});

test('loadEnv parses environment files correctly', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-env-'));
  const envPath = path.join(tmpDir, '.env');
  fs.writeFileSync(envPath, 'CF_API_TOKEN="my_secret_token"\n# Comment line\nDEFAULT_SECURITY_LEVEL=high\n');

  const parsed = loadEnv(envPath);
  assert.strictEqual(parsed.CF_API_TOKEN, 'my_secret_token');
  assert.strictEqual(parsed.DEFAULT_SECURITY_LEVEL, 'high');

  // Non-existent path returns empty object
  assert.deepStrictEqual(loadEnv(path.join(tmpDir, 'missing.env')), {});
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('loadConfig parses JSON correctly', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-cfg-'));
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ api_token: 'tok123', dry_run: true }));

  const parsed = loadConfig(cfgPath);
  assert.strictEqual(parsed.api_token, 'tok123');
  assert.strictEqual(parsed.dry_run, true);

  // Missing path returns empty object
  assert.deepStrictEqual(loadConfig(path.join(tmpDir, 'nonexistent.json')), {});
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('parseArgs parses CLI arguments and flags', () => {
  const argv = [
    'node', 'index.js',
    'purge', 'zone1,zone2',
    '--dry-run',
    '--token', 'abc-123',
    '--no-color'
  ];
  const opts = parseArgs(argv);
  assert.strictEqual(opts.action, 'purge');
  assert.deepStrictEqual(opts.zones, ['zone1', 'zone2']);
  assert.strictEqual(opts.dryRun, true);
  assert.strictEqual(opts.token, 'abc-123');
  assert.strictEqual(opts.noColor, true);

  const secArgv = ['node', 'index.js', 'set-security', 'under_attack', 'zoneX'];
  const secOpts = parseArgs(secArgv);
  assert.strictEqual(secOpts.action, 'set-security');
  assert.strictEqual(secOpts.securityLevel, 'under_attack');
  assert.deepStrictEqual(secOpts.zones, ['zoneX']);
});

test('CloudflareFleet token validation', () => {
  const fleetWithoutToken = new CloudflareFleet('');
  assert.throws(() => {
    fleetWithoutToken.validateToken();
  }, /Cloudflare API Token is missing/);

  const fleetWithToken = new CloudflareFleet('valid_token');
  assert.doesNotThrow(() => {
    fleetWithToken.validateToken();
  });
});

test('CloudflareFleet dry-run mode for purge and security level', async () => {
  const silentLogger = new Logger(false);
  const fleet = new CloudflareFleet('dummy_token', { dryRun: true, logger: silentLogger });

  const purgeRes = await fleet.purgeAllCaches(['zoneA', 'zoneB']);
  assert.strictEqual(purgeRes.total, 2);
  assert.strictEqual(purgeRes.succeeded, 2);
  assert.strictEqual(purgeRes.results[0].simulated, true);

  const secRes = await fleet.setSecurityLevel(['zoneA'], 'high');
  assert.strictEqual(secRes.total, 1);
  assert.strictEqual(secRes.succeeded, 1);
  assert.strictEqual(secRes.results[0].level, 'high');
  assert.strictEqual(secRes.results[0].simulated, true);
});

test('CloudflareFleet rejects invalid security level', async () => {
  const fleet = new CloudflareFleet('dummy_token');
  await assert.rejects(async () => {
    await fleet.setSecurityLevel(['zoneA'], 'invalid_level');
  }, /Invalid security level/);
});

test('CloudflareFleet handles empty zone lists gracefully', async () => {
  const fleet = new CloudflareFleet('dummy_token');
  const res1 = await fleet.purgeAllCaches([]);
  assert.strictEqual(res1.total, 0);

  const res2 = await fleet.setSecurityLevel([], 'medium');
  assert.strictEqual(res2.total, 0);
});

test('CloudflareFleet request mocking (success and failure)', async () => {
  const origRequest = https.request;

  try {
    // 1. Mock successful API response
    https.request = (options, cb) => {
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        process.nextTick(() => {
          cb(res);
          res.emit('data', JSON.stringify({ success: true, result: { id: 'zone123' } }));
          res.emit('end');
        });
      };
      return req;
    };

    const fleet = new CloudflareFleet('mock_token', { logger: new Logger(false) });
    const successResult = await fleet.request('/zones/zone123');
    assert.strictEqual(successResult.success, true);
    assert.strictEqual(successResult.result.id, 'zone123');

    // 2. Mock 401 Unauthorized API error
    https.request = (options, cb) => {
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 401;
        process.nextTick(() => {
          cb(res);
          res.emit('data', JSON.stringify({
            success: false,
            errors: [{ code: 10000, message: 'Authentication error' }]
          }));
          res.emit('end');
        });
      };
      return req;
    };

    const failResult = await fleet.request('/zones/zone123');
    assert.strictEqual(failResult.success, false);
    assert.strictEqual(failResult.statusCode, 401);
    assert.match(failResult.error, /Authentication error/);

  } finally {
    https.request = origRequest;
  }
});

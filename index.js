#!/usr/bin/env node
/**
 * Cloudflare Bulk Zone Operations & Fleet Management CLI
 * Author: Eng. MHD. Shadi AL-Hasan <mhd.shadi.alhasan@gmail.com>
 * Phone: +963934005922
 * Copyright (c) 2026 MHD. Shadi AL-Hasan
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const VALID_SECURITY_LEVELS = ['off', 'essentially_off', 'low', 'medium', 'high', 'under_attack'];

class Logger {
  constructor(colorEnabled = true) {
    this.colorEnabled = colorEnabled && (
      (process.stdout && process.stdout.isTTY) || process.env.FORCE_COLOR === '1'
    );
  }

  _c(code, text) {
    if (this.colorEnabled) {
      return `\x1b[${code}m${text}\x1b[0m`;
    }
    return text;
  }

  info(msg) {
    console.log(`${this._c('36', '[*]')} ${msg}`);
  }

  success(msg) {
    console.log(`${this._c('32', '[+]')} ${msg}`);
  }

  warn(msg) {
    console.log(`${this._c('33', '[!]')} ${msg}`);
  }

  error(msg) {
    console.error(`${this._c('31', '[-] ERROR:')} ${msg}`);
  }

  shield(msg) {
    console.log(`${this._c('35', '[SHIELD]')} ${msg}`);
  }

  dryRun(msg) {
    console.log(`${this._c('33', '[DRY-RUN]')} ${msg}`);
  }
}

const defaultLogger = new Logger();

function loadEnv(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const idx = line.indexOf('=');
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim().replace(/^['"](.*)['"]$/, '$1');
      env[key] = val;
    }
  } catch (err) {
    defaultLogger.warn(`Could not load environment file: ${err.message}`);
  }
  return env;
}

function loadConfig(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    defaultLogger.warn(`Could not load config file: ${err.message}`);
    return {};
  }
}

class CloudflareFleet {
  constructor(token, options = {}) {
    this.token = token || '';
    this.host = options.host || 'api.cloudflare.com';
    this.timeout = options.timeout || 30000;
    this.dryRun = Boolean(options.dryRun);
    this.logger = options.logger || defaultLogger;
  }

  validateToken() {
    if (!this.token || typeof this.token !== 'string' || !this.token.trim()) {
      throw new Error('Cloudflare API Token is missing. Set CF_API_TOKEN or pass --token.');
    }
  }

  request(endpoint, method = 'GET', data = null) {
    this.validateToken();

    return new Promise((resolve, reject) => {
      const postData = data ? JSON.stringify(data) : null;
      const headers = {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'cf-zone-ops/1.1.0'
      };

      if (postData) {
        headers['Content-Length'] = Buffer.byteLength(postData);
      }

      const options = {
        hostname: this.host,
        port: 443,
        path: `/client/v4${endpoint}`,
        method,
        headers,
        timeout: this.timeout
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch (e) {
            parsed = { success: false, raw: body };
          }

          if (res.statusCode && res.statusCode >= 400) {
            const errMsg = (parsed.errors && parsed.errors.length)
              ? parsed.errors.map(err => err.message).join('; ')
              : `HTTP ${res.statusCode}: ${res.statusMessage || 'Request failed'}`;
            return resolve({
              success: false,
              statusCode: res.statusCode,
              error: errMsg,
              details: parsed
            });
          }

          resolve(parsed);
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Cloudflare API request timed out after ${this.timeout}ms`));
      });

      req.on('error', (err) => {
        reject(new Error(`Network error communicating with Cloudflare API: ${err.message}`));
      });

      if (postData) {
        req.write(postData);
      }
      req.end();
    });
  }

  async purgeAllCaches(zoneIds) {
    if (!Array.isArray(zoneIds) || zoneIds.length === 0) {
      this.logger.warn('No zone IDs provided for cache purge.');
      return { total: 0, succeeded: 0, failed: 0, results: [] };
    }

    this.logger.info(`Initiating bulk cache purge across ${zoneIds.length} zone(s)...`);
    const results = [];
    let succeeded = 0;
    let failed = 0;

    for (const zid of zoneIds) {
      const cleanZid = zid.trim();
      if (!cleanZid) continue;

      if (this.dryRun) {
        this.logger.dryRun(`[PURGE] Would clear cache for zone: ${cleanZid}`);
        results.push({ zoneId: cleanZid, success: true, simulated: true });
        succeeded++;
        continue;
      }

      try {
        this.logger.info(`[PURGE] Clearing cache for zone: ${cleanZid}`);
        const response = await this.request(`/zones/${cleanZid}/purge_cache`, 'POST', {
          purge_everything: true
        });

        if (response && response.success) {
          this.logger.success(`[PURGE] Cache purged successfully for zone: ${cleanZid}`);
          results.push({ zoneId: cleanZid, success: true, response });
          succeeded++;
        } else {
          const err = response.error || 'Failed to purge cache';
          this.logger.error(`[PURGE] Zone ${cleanZid} purge failed: ${err}`);
          results.push({ zoneId: cleanZid, success: false, error: err });
          failed++;
        }
      } catch (err) {
        this.logger.error(`[PURGE] Exception on zone ${cleanZid}: ${err.message}`);
        results.push({ zoneId: cleanZid, success: false, error: err.message });
        failed++;
      }
    }

    this.logger.info(`Purge summary: ${succeeded} succeeded, ${failed} failed.`);
    return { total: zoneIds.length, succeeded, failed, results };
  }

  async setSecurityLevel(zoneIds, level = 'under_attack') {
    if (!Array.isArray(zoneIds) || zoneIds.length === 0) {
      this.logger.warn('No zone IDs provided for security level modulation.');
      return { total: 0, succeeded: 0, failed: 0, results: [] };
    }

    const cleanLevel = level.toLowerCase().trim();
    if (!VALID_SECURITY_LEVELS.includes(cleanLevel)) {
      throw new Error(
        `Invalid security level: '${level}'. Valid levels: ${VALID_SECURITY_LEVELS.join(', ')}`
      );
    }

    this.logger.info(`Switching ${zoneIds.length} zone(s) to security mode: [${cleanLevel}]...`);
    const results = [];
    let succeeded = 0;
    let failed = 0;

    for (const zid of zoneIds) {
      const cleanZid = zid.trim();
      if (!cleanZid) continue;

      if (this.dryRun) {
        this.logger.dryRun(`[SHIELD] Would set zone ${cleanZid} -> ${cleanLevel}`);
        results.push({ zoneId: cleanZid, level: cleanLevel, success: true, simulated: true });
        succeeded++;
        continue;
      }

      try {
        this.logger.shield(`Setting Zone ${cleanZid} -> ${cleanLevel}`);
        const response = await this.request(
          `/zones/${cleanZid}/settings/security_level`,
          'PATCH',
          { value: cleanLevel }
        );

        if (response && response.success) {
          this.logger.success(`[SHIELD] Zone ${cleanZid} successfully updated to [${cleanLevel}]`);
          results.push({ zoneId: cleanZid, level: cleanLevel, success: true, response });
          succeeded++;
        } else {
          const err = response.error || 'Failed to update security level';
          this.logger.error(`[SHIELD] Zone ${cleanZid} update failed: ${err}`);
          results.push({ zoneId: cleanZid, level: cleanLevel, success: false, error: err });
          failed++;
        }
      } catch (err) {
        this.logger.error(`[SHIELD] Exception on zone ${cleanZid}: ${err.message}`);
        results.push({ zoneId: cleanZid, level: cleanLevel, success: false, error: err.message });
        failed++;
      }
    }

    this.logger.info(`Security update summary: ${succeeded} succeeded, ${failed} failed.`);
    return { total: zoneIds.length, succeeded, failed, results };
  }

  async getZoneDetails(zoneId) {
    this.logger.info(`Fetching zone metadata for ${zoneId}...`);
    return await this.request(`/zones/${zoneId}`, 'GET');
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    action: 'help',
    zones: [],
    securityLevel: null,
    token: null,
    dryRun: false,
    noColor: false,
    config: 'config.json',
    envFile: '.env'
  };

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--no-color') {
      options.noColor = true;
    } else if (arg === '--token' && i + 1 < args.length) {
      options.token = args[++i];
    } else if ((arg === '--config' || arg === '-c') && i + 1 < args.length) {
      options.config = args[++i];
    } else if (arg === '--env' && i + 1 < args.length) {
      options.envFile = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      options.action = 'help';
      return options;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (positional.length > 0) {
    options.action = positional[0];
  }

  if (options.action === 'set-security') {
    options.securityLevel = positional[1] || 'medium';
    if (positional[2]) {
      options.zones = positional[2].split(',').map(s => s.trim()).filter(Boolean);
    }
  } else if (positional[1]) {
    options.zones = positional[1].split(',').map(s => s.trim()).filter(Boolean);
  }

  return options;
}

function printHelp() {
  console.log('Usage:');
  console.log('  cf-ops purge <zoneId1,zoneId2...> [options]');
  console.log('  cf-ops attack-mode <zoneId1,zoneId2...> [options]');
  console.log('  cf-ops normal-mode <zoneId1,zoneId2...> [options]');
  console.log('  cf-ops set-security <level> <zoneId1,zoneId2...> [options]');
  console.log('  cf-ops zone-info <zoneId> [options]\n');
  console.log('Options:');
  console.log('  --token <token>     Cloudflare API token (overrides env/config)');
  console.log('  --dry-run           Simulate actions without executing API mutations');
  console.log('  --config <file>     Path to JSON configuration file (default: config.json)');
  console.log('  --env <file>        Path to environment variables file (default: .env)');
  console.log('  --no-color          Disable colored output');
  console.log('  -h, --help          Show this help information\n');
  console.log('Available Security Levels:');
  console.log(`  ${VALID_SECURITY_LEVELS.join(', ')}\n`);
}

async function main(argv = process.argv) {
  const options = parseArgs(argv);
  const logger = new Logger(!options.noColor);

  console.log('=== Cloudflare Fleet Management CLI (cf-zone-ops) ===');
  console.log('Maintainer: Eng. MHD. Shadi AL-Hasan <mhd.shadi.alhasan@gmail.com>\n');

  if (options.action === 'help') {
    printHelp();
    return;
  }

  const envData = loadEnv(path.resolve(options.envFile));
  const cfgData = loadConfig(path.resolve(options.config));

  const token = options.token ||
    process.env.CF_API_TOKEN ||
    envData.CF_API_TOKEN ||
    cfgData.api_token ||
    '';

  const host = process.env.CF_API_HOST || envData.CF_API_HOST || cfgData.api_host || 'api.cloudflare.com';
  const dryRun = options.dryRun ||
    String(envData.DRY_RUN || cfgData.dry_run || '').toLowerCase() === 'true';

  if (!token && !dryRun) {
    logger.error('No Cloudflare API token provided. Set CF_API_TOKEN in .env or supply --token.');
    process.exitCode = 1;
    return;
  }

  const fleet = new CloudflareFleet(token, { host, dryRun, logger });

  try {
    switch (options.action) {
      case 'purge':
        await fleet.purgeAllCaches(options.zones);
        break;

      case 'attack-mode':
        await fleet.setSecurityLevel(options.zones, 'under_attack');
        break;

      case 'normal-mode':
        await fleet.setSecurityLevel(options.zones, 'medium');
        break;

      case 'set-security':
        await fleet.setSecurityLevel(options.zones, options.securityLevel || 'medium');
        break;

      case 'zone-info':
        if (options.zones.length === 0) {
          logger.error('zone-info requires at least one zone ID.');
          process.exitCode = 1;
          return;
        }
        for (const zid of options.zones) {
          const info = await fleet.getZoneDetails(zid);
          console.log(JSON.stringify(info, null, 2));
        }
        break;

      default:
        logger.error(`Unknown action '${options.action}'.`);
        printHelp();
        process.exitCode = 1;
        break;
    }
  } catch (err) {
    logger.error(`Operation failed: ${err.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  CloudflareFleet,
  Logger,
  loadEnv,
  loadConfig,
  parseArgs,
  printHelp,
  main,
  VALID_SECURITY_LEVELS
};

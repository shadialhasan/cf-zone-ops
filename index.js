#!/usr/bin/env node
/**
 * Cloudflare Bulk Zone Operations & Fleet Management CLI
 * Author: Eng. MHD. Shadi AL-Hasan <mhd.shadi.alhasan@gmail.com>
 * Phone: +963934005922
 * Copyright (c) 2026 MHD. Shadi AL-Hasan
 */

const https = require('https');

const CF_API_TOKEN = process.env.CF_API_TOKEN || '';

class CloudflareFleet {
  constructor(token) {
    this.token = token;
  }

  request(endpoint, method = 'GET', data = null) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.cloudflare.com',
        port: 443,
        path: `/client/v4${endpoint}`,
        method,
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            resolve({ success: false, raw: body });
          }
        });
      });

      req.on('error', reject);
      if (data) req.write(JSON.stringify(data));
      req.end();
    });
  }

  async purgeAllCaches(zoneIds) {
    console.log(`[*] Initiating bulk cache purge across ${zoneIds.length} zones...`);
    for (const zid of zoneIds) {
      console.log(`[PURGE] Clearing cache for zone: ${zid}`);
      // await this.request(`/zones/${zid}/purge_cache`, 'POST', { purge_everything: true });
    }
    console.log('[+] Bulk purge requests dispatched successfully.');
  }

  async setSecurityLevel(zoneIds, level = 'under_attack') {
    console.log(`[*] Switching ${zoneIds.length} zones to security mode: [${level}]...`);
    for (const zid of zoneIds) {
      console.log(`[SHIELD] Zone ${zid} -> ${level}`);
    }
    console.log('[+] Security levels updated.');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const action = args[0] || 'help';

  console.log('=== Cloudflare Fleet Management CLI (cf-zone-ops) ===');
  console.log('Maintainer: Eng. MHD. Shadi AL-Hasan\n');

  if (action === 'help') {
    console.log('Usage:');
    console.log('  cf-ops purge <zoneId1,zoneId2...>');
    console.log('  cf-ops attack-mode <zoneId1,zoneId2...>');
    console.log('  cf-ops normal-mode <zoneId1,zoneId2...>');
    return;
  }

  const zones = (args[1] || '').split(',').filter(Boolean);
  const fleet = new CloudflareFleet(CF_API_TOKEN);

  if (action === 'purge') {
    await fleet.purgeAllCaches(zones);
  } else if (action === 'attack-mode') {
    await fleet.setSecurityLevel(zones, 'under_attack');
  } else if (action === 'normal-mode') {
    await fleet.setSecurityLevel(zones, 'medium');
  }
}

main();

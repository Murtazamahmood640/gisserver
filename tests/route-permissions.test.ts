import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  extractRoutes,
  ANY_AUTHENTICATED_ALLOWLIST,
  RoutePermissionInfo,
} from '../scripts/dumpRoutes';

describe('Route Authorization Snapshot & Permissions Audit', () => {
  it('matches the committed machine snapshot docs/route-permissions.json exactly', () => {
    const liveRoutes = extractRoutes();
    const snapshotPath = path.resolve(__dirname, '../../docs/route-permissions.json');

    expect(fs.existsSync(snapshotPath)).toBe(true);
    const snapshotContent = fs.readFileSync(snapshotPath, 'utf8');
    const snapshotRoutes: RoutePermissionInfo[] = JSON.parse(snapshotContent);

    // Verify lengths match
    expect(
      liveRoutes.length,
      `Route count mismatch: live has ${liveRoutes.length}, snapshot has ${snapshotRoutes.length}. Update snapshot via: npm --prefix backend tsx scripts/dumpRoutes.ts`
    ).toBe(snapshotRoutes.length);

    // Verify deep equality of all routes
    expect(liveRoutes).toEqual(snapshotRoutes);
  });

  it('fails if any non-public route lacks an explicit role policy unless explicitly allow-listed', () => {
    const liveRoutes = extractRoutes();

    for (const r of liveRoutes) {
      const routeKey = `${r.method} ${r.path}`;

      if (r.accessLevel === 'public') {
        continue;
      }

      if (r.accessLevel === 'optional-auth') {
        expect(
          r.roles.length,
          `Optional-auth route ${routeKey} must declare roles`
        ).toBeGreaterThan(0);
        continue;
      }

      if (r.accessLevel === 'authenticated') {
        expect(
          ANY_AUTHENTICATED_ALLOWLIST.has(routeKey),
          `Authenticated route ${routeKey} has no role restriction and is not in ANY_AUTHENTICATED_ALLOWLIST`
        ).toBe(true);
        continue;
      }

      if (r.accessLevel === 'role-gated') {
        expect(
          r.roles.length,
          `Role-gated route ${routeKey} must declare at least one allowed role`
        ).toBeGreaterThan(0);
      }
    }
  });
});

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import app from '../app';

interface ExtractedRoute {
  method: string;
  expressPath: string;
  openApiPath: string;
}

/**
 * Normalizes an Express route path into OpenAPI path template:
 * - Replaces `:param` with `{param}`
 * - Strips trailing slashes (unless the path is just `/`)
 */
function normalizeToOpenApiPath(mountPrefix: string, routePath: string): string {
  let combined = mountPrefix;
  if (routePath && routePath !== '/') {
    combined = `${mountPrefix}${routePath.startsWith('/') ? routePath : `/${routePath}`}`;
  }
  // Replace `:paramName` with `{paramName}`
  const openApiPath = combined.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');
  // Ensure single slashes
  return openApiPath.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

/**
 * Traverses Express router stack recursively to extract all mounted /api/v1 routes.
 */
function extractV1RoutesFromApp(): ExtractedRoute[] {
  const routes: ExtractedRoute[] = [];
  const stack = (app as any).router?.stack || (app as any)._router?.stack || [];

  // Parse app.ts to get the exact mount prefixes registered for /api/v1 routers
  const appFileContent = fs.readFileSync(path.resolve(__dirname, '../app.ts'), 'utf8');
  const mountRegex = /app\.use\(\s*['"](\/api\/v1[^'"]*)['"]/g;
  const mountPrefixes: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = mountRegex.exec(appFileContent)) !== null) {
    mountPrefixes.push(match[1]);
  }

  function traverseLayerStack(layerStack: any[], currentPrefix: string) {
    for (const layer of layerStack) {
      if (layer.route && typeof layer.route.path === 'string') {
        const methods = Object.keys(layer.route.methods || {}).filter(
          (m) => layer.route.methods[m]
        );
        for (const m of methods) {
          const combinedExpress = `${currentPrefix}${layer.route.path === '/' ? '' : layer.route.path}`;
          routes.push({
            method: m.toLowerCase(),
            expressPath: combinedExpress || '/',
            openApiPath: normalizeToOpenApiPath(currentPrefix, layer.route.path),
          });
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        // Recursive handling for nested routers
        traverseLayerStack(layer.handle.stack, currentPrefix);
      }
    }
  }

  const remainingPrefixes = [...mountPrefixes];
  for (const layer of stack) {
    // 1. Direct routes on the main app
    if (layer.route && typeof layer.route.path === 'string') {
      if (layer.route.path.startsWith('/api/v1')) {
        const methods = Object.keys(layer.route.methods || {}).filter(
          (m) => layer.route.methods[m]
        );
        for (const m of methods) {
          routes.push({
            method: m.toLowerCase(),
            expressPath: layer.route.path,
            openApiPath: normalizeToOpenApiPath('', layer.route.path),
          });
        }
      }
    }

    // 2. Subrouter layers mounted via app.use('/api/v1/...', router)
    if (layer.name === 'router' && layer.handle?.stack) {
      if (
        remainingPrefixes.length > 0 &&
        layer.match &&
        layer.match(`${remainingPrefixes[0]}/__probe__`)
      ) {
        const prefix = remainingPrefixes.shift()!;
        traverseLayerStack(layer.handle.stack, prefix);
      }
    }
  }

  return routes;
}

function findMissingRouteDocs(specToCheck: any, routes: ExtractedRoute[]): string[] {
  const missingDocs: string[] = [];
  for (const route of routes) {
    const pathItem = specToCheck.paths?.[route.openApiPath];
    if (!pathItem) {
      missingDocs.push(`Path not documented: [${route.method.toUpperCase()}] ${route.openApiPath} (Express: ${route.expressPath})`);
      continue;
    }
    const operation = pathItem[route.method];
    if (!operation) {
      missingDocs.push(`Method not documented: [${route.method.toUpperCase()}] ${route.openApiPath}`);
    }
  }
  return missingDocs;
}

function findExtraSpecDocs(specToCheck: any, routes: ExtractedRoute[]): string[] {
  const extraDocs: string[] = [];
  const routeSet = new Set(routes.map((r) => `${r.method.toLowerCase()} ${r.openApiPath}`));
  const methods = ['get', 'post', 'put', 'patch', 'delete'];

  for (const p of Object.keys(specToCheck.paths || {})) {
    if (!p.startsWith('/api/v1')) continue;
    for (const m of methods) {
      if (specToCheck.paths[p][m]) {
        const key = `${m.toLowerCase()} ${p}`;
        if (!routeSet.has(key)) {
          extraDocs.push(`Spec documents unmounted route: [${m.toUpperCase()}] ${p}`);
        }
      }
    }
  }
  return extraDocs;
}

describe('OpenAPI 3.1 Specification Coverage', () => {
  const openApiPath = path.resolve(__dirname, '../../docs/openapi.yaml');
  const yamlContent = fs.readFileSync(openApiPath, 'utf8');
  const spec = YAML.parse(yamlContent);

  it('loads valid OpenAPI 3.1 document with required metadata', () => {
    expect(spec.openapi).toMatch(/^3\.1\./);
    expect(spec.info).toBeDefined();
    expect(spec.info.title).toBeTruthy();
    expect(spec.info.version).toBeTruthy();
    expect(spec.paths).toBeDefined();
    expect(spec.components?.securitySchemes?.bearerAuth).toBeDefined();
    expect(spec.components?.securitySchemes?.cookieAuth).toBeDefined();
    expect(spec.components?.headers?.['RateLimit-Limit']).toBeDefined();
    expect(spec.components?.headers?.['RateLimit-Remaining']).toBeDefined();
  });

  it('covers every mounted /api/v1 Express route and method in docs/openapi.yaml exactly (170 total routes)', () => {
    const mountedRoutes = extractV1RoutesFromApp();
    expect(mountedRoutes.length).toBe(170);

    const missingDocs = findMissingRouteDocs(spec, mountedRoutes);
    if (missingDocs.length > 0) {
      throw new Error(
        `OpenAPI specification is missing documentation for ${missingDocs.length} route(s):\n` +
          missingDocs.join('\n')
      );
    }

    const extraDocs = findExtraSpecDocs(spec, mountedRoutes);
    if (extraDocs.length > 0) {
      throw new Error(
        `OpenAPI specification documents ${extraDocs.length} route(s) not mounted in Express:\n` +
          extraDocs.join('\n')
      );
    }
  });

  it('negative check: proves coverage test fails when a path or method is removed (temporary mutation inside test)', () => {
    const mountedRoutes = extractV1RoutesFromApp();

    // 1. Remove path from spec
    const mutatedSpec1 = JSON.parse(JSON.stringify(spec));
    delete mutatedSpec1.paths['/api/v1/bookings/quote'];
    const missingPath = findMissingRouteDocs(mutatedSpec1, mountedRoutes);
    expect(missingPath.length).toBeGreaterThan(0);
    expect(missingPath.some((m) => m.includes('/api/v1/bookings/quote'))).toBe(true);

    // 2. Remove method from existing path in spec
    const mutatedSpec2 = JSON.parse(JSON.stringify(spec));
    delete mutatedSpec2.paths['/api/v1/bookings/guest/{id}'].get;
    const missingMethod = findMissingRouteDocs(mutatedSpec2, mountedRoutes);
    expect(missingMethod.length).toBeGreaterThan(0);
    expect(missingMethod.some((m) => m.includes('/api/v1/bookings/guest/{id}'))).toBe(true);
  });

  it('explicitly confirms /api/v1/bookings/quote and /api/v1/bookings/guest/{id} and CSV export are documented', () => {
    expect(spec.paths['/api/v1/bookings/quote']).toBeDefined();
    expect(spec.paths['/api/v1/bookings/quote'].post).toBeDefined();
    expect(spec.paths['/api/v1/bookings/quote'].post.summary).toBeTruthy();

    expect(spec.paths['/api/v1/bookings/guest/{id}']).toBeDefined();
    expect(spec.paths['/api/v1/bookings/guest/{id}'].get).toBeDefined();
    expect(spec.paths['/api/v1/bookings/guest/{id}'].get.summary).toBeTruthy();

    const bookingsGet = spec.paths['/api/v1/bookings']?.get;
    expect(bookingsGet).toBeDefined();
    expect(bookingsGet.parameters?.some((p: any) => p.name === 'format')).toBe(true);
    expect(bookingsGet.responses['200']?.content?.['text/csv']).toBeDefined();
  });
});

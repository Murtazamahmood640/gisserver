/**
 * Script safety utilities for CLI tools and demos.
 * Ensures scripts targeting MongoDB cannot accidentally run against
 * production or remote databases without explicit operator confirmation.
 */

export function parseMongoUri(uri: string): { host: string; hostname: string; dbName: string } {
  try {
    // Normalizing protocol so standard URL parser can parse mongodb and mongodb+srv
    const normalized = uri.replace(/^mongodb(\+srv)?:\/\//i, 'http://');
    const parsed = new URL(normalized);
    const host = parsed.host; // includes hostname and port if present
    const hostname = parsed.hostname;
    let dbName = parsed.pathname.replace(/^\//, '').split('?')[0];
    if (!dbName) {
      dbName = 'test';
    }
    return { host, hostname, dbName };
  } catch {
    // Fallback regex parsing if URL parsing fails
    const match = uri.match(/mongodb(?:\+srv)?:\/\/(?:[^:@]+:[^@]+@)?([^/?]+)(?:\/([^?]+))?/i);
    const host = match?.[1] || 'unknown';
    const hostname = host.split(':')[0];
    const dbName = match?.[2] || 'test';
    return { host, hostname, dbName };
  }
}

export function getMongoHost(uri: string): string {
  return parseMongoUri(uri).host;
}

export function getDbName(uri: string): string {
  return parseMongoUri(uri).dbName;
}

export function getMaskedHost(uri: string): string {
  return parseMongoUri(uri).host;
}

export function getMaskedUri(uri: string): string {
  const { host, dbName } = parseMongoUri(uri);
  const isSrv = uri.startsWith('mongodb+srv://');
  const protocol = isSrv ? 'mongodb+srv://' : 'mongodb://';
  return `${protocol}${host}/${dbName}`;
}

export function isAllowedHost(host: string, fullUri?: string): boolean {
  const normalized = host.toLowerCase().trim();
  const hostname = normalized.split(':')[0];

  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }

  if (fullUri && (fullUri.includes('memory') || fullUri.includes('127.0.0.1'))) {
    return true;
  }

  return false;
}

export function assertScriptSafety(
  uri: string,
  allowRemote: boolean,
  scriptName: string
): { host: string; maskedUri: string } {
  const { host } = parseMongoUri(uri);
  const maskedUri = getMaskedUri(uri);

  if (!isAllowedHost(host, uri) && !allowRemote) {
    throw new Error(
      `[${scriptName}] Refusing to run on remote MongoDB host: ${host}. Pass --allow-remote to override.`
    );
  }

  return { host, maskedUri };
}

export function assertApplyConfirmation(
  uri: string,
  confirmHostArg: string | undefined
): { host: string; dbName: string } {
  const { host, hostname, dbName } = parseMongoUri(uri);

  if (!confirmHostArg || (confirmHostArg !== host && confirmHostArg !== hostname)) {
    throw new Error(
      `Refusing to apply: pass --confirm-host=${host} to confirm. Target DB: ${dbName}`
    );
  }

  return { host, dbName };
}

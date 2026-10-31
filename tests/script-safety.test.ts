import { describe, it, expect } from 'vitest';
import {
  parseMongoUri,
  getMongoHost,
  getDbName,
  getMaskedHost,
  getMaskedUri,
  isAllowedHost,
  assertScriptSafety,
  assertApplyConfirmation,
} from '../scripts/_scriptGuard';

describe('Script Safety Guard Utilities', () => {
  it('parses standard localhost MongoDB URIs', () => {
    const uri = 'mongodb://localhost:27017/luxe-detail';
    const { host, hostname, dbName } = parseMongoUri(uri);
    expect(host).toBe('localhost:27017');
    expect(hostname).toBe('localhost');
    expect(dbName).toBe('luxe-detail');
  });

  it('parses authenticated MongoDB URIs and strips credentials', () => {
    const uri = 'mongodb://admin:supersecret@127.0.0.1:27017/prod_db?authSource=admin';
    expect(getMaskedHost(uri)).toBe('127.0.0.1:27017');
    expect(getMaskedUri(uri)).toBe('mongodb://127.0.0.1:27017/prod_db');
    expect(getDbName(uri)).toBe('prod_db');
    expect(getMaskedUri(uri)).not.toContain('supersecret');
  });

  it('identifies allowed local hosts and rejects remote hosts', () => {
    expect(isAllowedHost('localhost')).toBe(true);
    expect(isAllowedHost('localhost:27017')).toBe(true);
    expect(isAllowedHost('127.0.0.1')).toBe(true);
    expect(isAllowedHost('127.0.0.1:54321')).toBe(true);
    expect(isAllowedHost('in-memory', 'mongodb://memory-db')).toBe(true);
    expect(isAllowedHost('cluster0.abcde.mongodb.net')).toBe(false);
    expect(isAllowedHost('192.168.1.100')).toBe(false);
  });

  it('assertScriptSafety throws on remote host when allowRemote is false', () => {
    const remoteUri = 'mongodb://user:pass@cluster0.abcde.mongodb.net/production';
    expect(() => {
      assertScriptSafety(remoteUri, false, 'demoTest');
    }).toThrow(/Refusing to run on remote MongoDB host: cluster0.abcde.mongodb.net/);
  });

  it('assertScriptSafety succeeds on remote host when allowRemote is true', () => {
    const remoteUri = 'mongodb://user:pass@cluster0.abcde.mongodb.net/production';
    const result = assertScriptSafety(remoteUri, true, 'demoTest');
    expect(result.host).toBe('cluster0.abcde.mongodb.net');
    expect(result.maskedUri).not.toContain('pass');
  });

  it('assertScriptSafety succeeds on localhost without allowRemote', () => {
    const localUri = 'mongodb://localhost:27017/dev';
    const result = assertScriptSafety(localUri, false, 'demoTest');
    expect(result.host).toBe('localhost:27017');
  });

  it('assertApplyConfirmation enforces exact host matching', () => {
    const uri = 'mongodb://db-prod.internal:27017/company_data';

    // Fails without confirm-host
    expect(() => {
      assertApplyConfirmation(uri, undefined);
    }).toThrow(/Refusing to apply: pass --confirm-host=db-prod.internal:27017 to confirm/);

    // Fails with wrong host
    expect(() => {
      assertApplyConfirmation(uri, 'wrong-host');
    }).toThrow(/Target DB: company_data/);

    // Succeeds with matching host or hostname
    const res = assertApplyConfirmation(uri, 'db-prod.internal:27017');
    expect(res.host).toBe('db-prod.internal:27017');
    expect(res.dbName).toBe('company_data');
  });
});

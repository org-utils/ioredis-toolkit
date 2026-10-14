import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { packageProgram, root } from '../support/exports-map.js';
import { parseCacheConfig, parseLockConfig, parsePubSubConfig, parseRateLimitConfig, parseSessionConfig, parseStreamsConfig } from '../../src/index.js';

describe('Session configuration', () => {
  it('defaults to disabled', () => {
    expect(parseSessionConfig({}).enabled).toBe(false);
  });
  it('rejects insecure SameSite=None', () => {
    expect(() => parseSessionConfig({ cookie: { sameSite: 'none', secure: false } })).toThrow();
  });
  it('rejects idle timeout greater than absolute timeout', () => {
    expect(() => parseSessionConfig({ idleTimeout: 20, absoluteTimeout: 10 })).toThrow();
  });
  it('defaults circuitBreaker when omitted entirely', () => {
    const config = parseSessionConfig({ enabled: true });
    expect(config.circuitBreaker).toEqual({ enabled: false, failureThreshold: 5, resetTimeoutMs: 10_000, halfOpenMaxRequests: 1 });
  });
});

describe('Session configuration declarations', () => {
  /** The declarations the build emits for a source file, emitted in memory. */
  function declarationsOf(file: string): ts.SourceFile {
    const program = packageProgram([file], { noEmit: false });
    let emitted = '';
    program.emit(program.getSourceFile(file), (_name, text) => { emitted = text; }, undefined, true);
    return ts.createSourceFile('emitted.d.ts', emitted, ts.ScriptTarget.Latest, true);
  }

  /** Every member named `name` anywhere in a declaration. */
  function membersNamed(node: ts.Node, name: string): ts.Node[] {
    const found: ts.Node[] = [];
    const visit = (child: ts.Node): void => {
      if (ts.isPropertySignature(child) && child.name.getText() === name) found.push(child);
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  }

  it('marks circuitBreaker deprecated on SessionConfig', () => {
    const declarations = declarationsOf(path.join(root, 'src', 'session', 'config.ts'));
    const sessionConfig = declarations.statements.find(statement => ts.isTypeAliasDeclaration(statement) && statement.name.text === 'SessionConfig');
    expect(sessionConfig).toBeDefined();
    const circuitBreaker = membersNamed(sessionConfig!, 'circuitBreaker');
    expect(circuitBreaker).toHaveLength(1);
    expect(ts.getJSDocDeprecatedTag(circuitBreaker[0]!)).toBeDefined();
  }, 60_000);
});

describe('Lock configuration', () => {
  it('rejects a defaultTtl greater than maxTtl', () => {
    expect(() => parseLockConfig({ defaultTtl: 500, maxTtl: 300 })).toThrow();
  });
});

describe('Namespace configuration', () => {
  const modules: Array<[string, (input: unknown) => { namespace: string }]> = [
    ['cache', parseCacheConfig], ['lock', parseLockConfig], ['rate-limit', parseRateLimitConfig],
    ['pubsub', parsePubSubConfig], ['streams', parseStreamsConfig], ['session', parseSessionConfig],
  ];

  it.each(modules)('%s takes its namespace from the namespace field', (_module, parse) => {
    expect(parse({ namespace: 'my-app:v2_orders' }).namespace).toBe('my-app:v2_orders');
  });

  // A hash tag in the namespace would pick the hash slot for every key under it.
  it.each(modules)('%s rejects a namespace carrying a hash tag', (_module, parse) => {
    expect(() => parse({ namespace: 'app:{tag}' })).toThrow();
  });

  // A glob character in the namespace would widen a pattern scan into other namespaces.
  it.each(modules)('%s rejects a namespace carrying a glob character', (_module, parse) => {
    expect(() => parse({ namespace: 'app*' })).toThrow();
  });
});

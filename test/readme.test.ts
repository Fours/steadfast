// T7: the README's examples type-check. Each `ts` block is compiled as its own module, against
// src/ through tsconfig.json's paths, so the README can't drift from the API. A block may use the
// few helpers the prelude declares, which stand for the reader's own code.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

/** What the README's blocks lean on without defining: the reader's own code. */
const PRELUDE = `
declare function tailLog(
  service: string,
  lines: number,
  options: { signal: AbortSignal },
): Promise<string[]>;
declare const pager: {
  reachable(): Promise<boolean>;
  page(
    team: string,
    summary: string,
    options: { idempotencyKey: string; signal: AbortSignal },
  ): Promise<{ pageId: string }>;
};
declare const readLog: import('@kylewillett/steadfast').Tool;
declare const triage: import('@kylewillett/steadfast').Agent;
`;

/** The README's TypeScript blocks, in order. */
function blocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((m) => m[1] ?? '');
}

function compile(sources: ReadonlyMap<string, string>): readonly ts.Diagnostic[] {
  const config = ts.readConfigFile(join(ROOT, 'tsconfig.json'), (p) => ts.sys.readFile(p));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  // A README block shows how to call something, so it often leaves a result unused.
  const options = { ...parsed.options, noUnusedLocals: false, noUnusedParameters: false };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (file) => sources.get(file) ?? readFile(file);
  host.fileExists = (file) => sources.has(file) || fileExists(file);
  host.getSourceFile = (file, language, ...rest) => {
    const text = sources.get(file);
    return text === undefined
      ? getSourceFile(file, language, ...rest)
      : ts.createSourceFile(file, text, language, true);
  };
  const program = ts.createProgram([...sources.keys()], options, host);
  return ts.getPreEmitDiagnostics(program);
}

function format(diagnostics: readonly ts.Diagnostic[]): string[] {
  return diagnostics.map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    if (d.file === undefined || d.start === undefined) return message;
    const { line } = d.file.getLineAndCharacterOfPosition(d.start);
    return `${d.file.fileName.slice(ROOT.length + 1)}:${String(line + 1)}: ${message}`;
  });
}

describe('the README', () => {
  const found = blocks(readFileSync(join(ROOT, 'README.md'), 'utf8'));

  it('has its examples', () => {
    expect(found.length).toBeGreaterThanOrEqual(5);
  });

  it('type-checks every TypeScript example', () => {
    const sources = new Map<string, string>([[join(ROOT, 'readme-prelude.d.ts'), PRELUDE]]);
    // Each block is a module of its own, beside package.json, so it's ESM with top-level await.
    found.forEach((code, i) => {
      sources.set(join(ROOT, `readme-block-${String(i + 1)}.ts`), `${code}\nexport {};\n`);
    });
    expect(format(compile(sources))).toEqual([]);
  }, 30_000);

  it('fails a block that misuses the API', () => {
    const sources = new Map<string, string>([
      [join(ROOT, 'readme-prelude.d.ts'), PRELUDE],
      [
        join(ROOT, 'readme-block-bad.ts'),
        "import { readRun } from '@kylewillett/steadfast';\nawait readRun(triage, 'x', { upto: 5 });\nexport {};\n",
      ],
    ]);
    expect(format(compile(sources)).join('\n')).toContain('upto');
  }, 30_000);
});

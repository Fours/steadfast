import { jsonProblem as troupeJsonProblem } from '@kylewillett/troupe';
import { describe, expect, it } from 'vitest';
import { jsonProblem } from '../src/json.ts';

describe('json', () => {
  it("checks with Troupe's own jsonProblem, the check its journal runs before a write", () => {
    expect(jsonProblem).toBe(troupeJsonProblem);
    expect(jsonProblem({ output: [1, Number.NaN] })).toBe('$.output[1] is NaN');
  });
});

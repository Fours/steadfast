// What a JSON value is. Every model response, tool result, event and state is journaled, so each
// must be what `JSON.parse` could have produced (Troupe's decision 0014). Troupe has this type and
// its check internally but doesn't export them yet (milestone 1, open question 3). This type is
// structurally the same as Troupe's, so values pass between the two unchanged.

/** A JSON value: what `JSON.parse` could have produced. */
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

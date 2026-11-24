// What a JSON value is, from Troupe, so Steadfast checks values by the very rules its journal
// enforces (Troupe's decisions 0014 and 0037). Every model response, tool result, event and state
// is journaled, so each must be what `JSON.parse` could have produced.
export { jsonProblem, type JsonValue } from '@kylewillett/troupe';

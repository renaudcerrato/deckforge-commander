import { types } from 'node:util';

/** Shallow-copy at most 26 own fields (the largest option schema), without accessors or proxy traps. */
export function copyOutputData(input) {
  if (input === null || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input)) return undefined;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > 26) return undefined;
  const copy = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || !Object.hasOwn(descriptors[key], 'value')) return undefined;
    copy[key] = descriptors[key].value;
  }
  return copy;
}

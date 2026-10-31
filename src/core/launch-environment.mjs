import { types as nodeTypes } from 'node:util';
import { executionPlatform } from './execution-paths.mjs';

const METADATA_MAX_BYTES = 4_096;
// Plugin-owned names, not an SDK environment-variable standard.
const METADATA_FIELDS = [
  ['ELGATO_PLUGIN_UUID', 'pluginUuid', 'string'],
  ['ELGATO_PLUGIN_VERSION', 'pluginVersion', 'string'],
  ['ELGATO_ACTION_UUID', 'actionUuid', 'string'],
  ['ELGATO_ACTION_CONTEXT', 'actionContext', 'string'],
  ['ELGATO_ACTION_THEME_COLOR', 'actionThemeColor', 'color'],
  ['ELGATO_DEVICE_ID', 'deviceId', 'string'],
  ['ELGATO_DEVICE_NAME', 'deviceName', 'string'],
  ['ELGATO_DEVICE_TYPE', 'deviceType', 'number'],
  ['ELGATO_DEVICE_COLUMNS', 'deviceColumns', 'number'],
  ['ELGATO_DEVICE_ROWS', 'deviceRows', 'number'],
  ['ELGATO_KEY_COLUMN', 'keyColumn', 'number'],
  ['ELGATO_KEY_ROW', 'keyRow', 'number'],
  ['ELGATO_APP_VERSION', 'appVersion', 'string'],
  ['ELGATO_APP_LANGUAGE', 'appLanguage', 'string'],
  ['ELGATO_APP_PLATFORM', 'appPlatform', 'string'],
  ['ELGATO_APP_PLATFORM_VERSION', 'appPlatformVersion', 'string'],
];
const OWNED_NAMES = new Set(METADATA_FIELDS.map(([name]) => name));

function isDataObject(input) {
  return input !== null && typeof input === 'object' && !nodeTypes.isProxy(input) && !Array.isArray(input);
}

function metadataValue(input, key, type) {
  if (!isDataObject(input)) return undefined;
  const value = Object.getOwnPropertyDescriptor(input, key)?.value;
  if (type === 'color') {
    return typeof value === 'string' && value.length === 7 && /^#[0-9a-fA-F]{6}$/.test(value)
      ? value.toLowerCase() : undefined;
  }
  if (typeof value !== type) return undefined;
  if (type === 'number' && (!Number.isSafeInteger(value) || value < 0)) return undefined;
  const text = type === 'number' ? String(value) : value;
  return text.includes('\0') || Buffer.byteLength(text, 'utf8') > METADATA_MAX_BYTES ? undefined : text;
}

function invalidEnvironment() {
  throw new Error('Invalid launch environment.');
}

function asciiEnvironmentName(name) {
  // Owned names are ASCII. Leave other Unicode equivalence to the native Windows boundary.
  return name.replace(/[a-z]/g, character => character.toUpperCase());
}

function copyEnvironment(input, { inherited = false, platform = executionPlatform() } = {}) {
  if (!isDataObject(input)) invalidEnvironment();
  // process.env is a native object; explicit launch options must be plain data.
  if (!inherited && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
    invalidEnvironment();
  }
  const result = Object.create(null);
  const aliases = new Map();
  const keys = Reflect.ownKeys(input);
  if (keys.some(key => typeof key !== 'string')) invalidEnvironment();
  if (platform === 'win32') keys.sort();
  for (const key of keys) {
    if (typeof key !== 'string') invalidEnvironment();
    const name = platform === 'win32' ? asciiEnvironmentName(key) : key;
    if (inherited && OWNED_NAMES.has(name)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalidEnvironment();
    const value = descriptor.value;
    if (inherited && value === undefined) continue;
    if (key.length === 0 || key.includes('\0') || key.includes('=')
      || typeof value !== 'string' || value.includes('\0')) invalidEnvironment();
    if (platform === 'win32' && aliases.has(name)) {
      if (aliases.get(name) !== value) invalidEnvironment();
      continue;
    }
    aliases.set(name, value);
    result[key] = value;
  }
  return result;
}

/** Copy inherited environment, removing all owned names before overlaying valid scalar metadata. */
export function createLaunchEnvironment(inheritedEnvironment, metadata, platform = executionPlatform()) {
  const result = copyEnvironment(inheritedEnvironment, { inherited: true, platform });
  for (const [name, key, type] of METADATA_FIELDS) {
    const value = metadataValue(metadata, key, type);
    if (value !== undefined) result[name] = value;
  }
  return result;
}

/** Undefined preserves Node inheritance; supplied options require a complete string-only env. */
export function validateLaunchOptions(input, platform = executionPlatform()) {
  if (input === undefined) return undefined;
  if (!isDataObject(input)) invalidEnvironment();
  if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) invalidEnvironment();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 1 || keys[0] !== 'env') invalidEnvironment();
  const descriptor = Object.getOwnPropertyDescriptor(input, 'env');
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalidEnvironment();
  return copyEnvironment(descriptor.value, { platform });
}

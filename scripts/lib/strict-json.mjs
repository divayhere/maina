import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';

const UTF8 = new TextDecoder('utf-8', { fatal: true });

export function parseJsonRejectDuplicateKeys(source, label = 'JSON') {
  if (typeof source !== 'string') throw new TypeError(`${label}: string input is required`);
  let index = 0;

  function fail(message) {
    throw new Error(`${label}: ${message} at byte ${index}`);
  }

  function whitespace() {
    while (index < source.length && /[\u0009\u000a\u000d\u0020]/u.test(source[index])) index += 1;
  }

  function string() {
    if (source[index] !== '"') fail('string expected');
    const start = index;
    index += 1;
    while (index < source.length) {
      const character = source[index];
      if (character === '"') {
        index += 1;
        return JSON.parse(source.slice(start, index));
      }
      if (character === '\\') {
        index += 1;
        if (index >= source.length) fail('unterminated escape');
        if (source[index] === 'u') {
          const hex = source.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) fail('invalid Unicode escape');
          index += 5;
          continue;
        }
        if (!/["\\/bfnrt]/u.test(source[index])) fail('invalid escape');
      } else {
        if (character.charCodeAt(0) <= 0x1f) fail('unescaped control character');
      }
      index += 1;
    }
    fail('unterminated string');
  }

  function number() {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(source.slice(index));
    if (!match) fail('invalid number');
    index += match[0].length;
    return JSON.parse(match[0]);
  }

  function array() {
    const result = [];
    index += 1;
    whitespace();
    if (source[index] === ']') {
      index += 1;
      return result;
    }
    while (true) {
      result.push(value());
      whitespace();
      if (source[index] === ']') {
        index += 1;
        return result;
      }
      if (source[index] !== ',') fail('array separator expected');
      index += 1;
      whitespace();
    }
  }

  function object() {
    const result = {};
    const keys = new Set();
    index += 1;
    whitespace();
    if (source[index] === '}') {
      index += 1;
      return result;
    }
    while (true) {
      const key = string();
      if (keys.has(key)) fail(`duplicate object key ${JSON.stringify(key)}`);
      keys.add(key);
      whitespace();
      if (source[index] !== ':') fail('object colon expected');
      index += 1;
      whitespace();
      Object.defineProperty(result, key, {
        value: value(), enumerable: true, configurable: true, writable: true,
      });
      whitespace();
      if (source[index] === '}') {
        index += 1;
        return result;
      }
      if (source[index] !== ',') fail('object separator expected');
      index += 1;
      whitespace();
    }
  }

  function value() {
    whitespace();
    const character = source[index];
    if (character === '{') return object();
    if (character === '[') return array();
    if (character === '"') return string();
    if (character === '-' || /[0-9]/u.test(character ?? '')) return number();
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]]) {
      if (source.startsWith(literal, index)) {
        index += literal.length;
        return result;
      }
    }
    fail('value expected');
  }

  const parsed = value();
  whitespace();
  if (index !== source.length) fail('trailing content');
  return parsed;
}

export function readJsonRejectDuplicateKeys(path, label = path) {
  return parseJsonBytesRejectDuplicateKeys(readFileSync(path), label);
}

export function parseJsonBytesRejectDuplicateKeys(bytes, label = 'JSON') {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new TypeError(`${label}: byte input is required`);
  }
  let source;
  try {
    source = UTF8.decode(bytes);
  } catch {
    throw new Error(`${label}: invalid UTF-8`);
  }
  return parseJsonRejectDuplicateKeys(source, label);
}

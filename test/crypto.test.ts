import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync, createCipheriv } from 'node:crypto';
import {
  aesGcmEncrypt,
  aesGcmDecrypt,
  wrapVaultKey,
  unwrapVaultKey,
  generateVaultKey,
  packNote,
  unpackNote,
  encryptNote,
  decryptNote,
  BadPasswordError,
} from '../src/crypto.js';

// Known-answer tests, independently verified against both the Rust
// reference implementation (crates/futo-notes-core/src/e2ee/) and a second,
// independent Python implementation before being committed here. If either
// of these ever fails after a refactor, do not "fix the test" — the crypto
// has silently diverged from the real app and will corrupt notes.

test('PBKDF2-HMAC-SHA256 known-answer vector', () => {
  const dk = pbkdf2Sync('passwd', Buffer.from('salt'), 1, 32, 'sha256');
  assert.equal(
    dk.toString('hex'),
    '55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc',
  );
});

test('AES-256-GCM fixed-IV known-answer vector matches Rust packing', () => {
  const key = Buffer.alloc(32, 0x07);
  // aesGcmEncrypt generates a random IV internally, so to test the fixed
  // vector we exercise the primitive directly via the same packing rule
  // (iv || ciphertext || tag) using a hand-rolled fixed-IV encrypt.
  const iv = Buffer.alloc(12, 0x03);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update('deterministic', 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, ct, tag]);
  assert.equal(
    packed.toString('hex'),
    '030303030303030303030303419bd7662845372c13333735880e909883a16a84c35a53273e9541ee64',
  );

  // And decrypt() must invert it via the library's own aesGcmDecrypt.
  const plaintext = aesGcmDecrypt(key, packed);
  assert.equal(plaintext.toString('utf8'), 'deterministic');
});

test('note frame v2 byte layout', () => {
  const frame = packNote('ab', 'cd');
  assert.deepEqual(
    [...frame],
    [0x02, 0, 0, 0, 2, 'a'.charCodeAt(0), 'b'.charCodeAt(0), 'c'.charCodeAt(0), 'd'.charCodeAt(0)],
  );
  const { path, content } = unpackNote(frame);
  assert.equal(path, 'ab');
  assert.equal(content, 'cd');
});

test('legacy v1 frame (no version byte) still unpacks', () => {
  const pathBytes = Buffer.from('Inbox/today.md', 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(pathBytes.length, 0);
  const frame = Buffer.concat([header, pathBytes, Buffer.from('remember the milk', 'utf8')]);
  const { path, content } = unpackNote(frame);
  assert.equal(path, 'Inbox/today.md');
  assert.equal(content, 'remember the milk');
});

test('AES-256-GCM round trip with random IV', () => {
  const key = Buffer.from(generateVaultKey());
  const plaintext = Buffer.from('hello world', 'utf8');
  const packed = aesGcmEncrypt(key, plaintext);
  assert.equal(aesGcmDecrypt(key, packed).toString('utf8'), 'hello world');
});

test('full pipeline: wrap password -> encrypt note -> unwrap -> decrypt', () => {
  const password = 'correct horse battery staple';
  const vaultKey = generateVaultKey();
  const material = wrapVaultKey(password, vaultKey);

  const unwrapped = unwrapVaultKey(password, material);
  assert.deepEqual(unwrapped, vaultKey);

  const blob = encryptNote(unwrapped, 'Inbox/today.md', 'remember the milk');
  const { path, content } = decryptNote(vaultKey, blob);
  assert.equal(path, 'Inbox/today.md');
  assert.equal(content, 'remember the milk');
});

test('wrong password raises BadPasswordError', () => {
  const vaultKey = generateVaultKey();
  const material = wrapVaultKey('right-password', vaultKey);
  assert.throws(() => unwrapVaultKey('wrong-password', material), BadPasswordError);
});

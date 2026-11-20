const version = 1;
const passwordIterations = 600_000;
const keyBytes = 32;
const saltBytes = 16;
const nonceBytes = 12;
const tagBytes = 16;
const maxSnippetBytes = 126_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function encodeBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function decodeBase64(value, minimum, maximum = minimum) {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4) {
    throw new Error("Invalid vault data");
  }
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  if (bytes.length < minimum || bytes.length > maximum || encodeBase64(bytes) !== value) {
    throw new Error("Invalid vault data");
  }
  return bytes;
}

function randomBytes(size) {
  return crypto.getRandomValues(new Uint8Array(size));
}

function context(purpose, ...ids) {
  if (ids.some((id) => typeof id !== "string" || !id || id.length > 128)) {
    throw new Error("Invalid vault identifier");
  }
  return encoder.encode(JSON.stringify(["ease-folder-vault", version, purpose, ...ids]));
}

async function passwordKey(password, salt, usage) {
  if (typeof password !== "string" || password.length > 256 || !password.isWellFormed()) {
    throw new Error("Invalid vault password");
  }
  const length = Array.from(password).length;
  if (length < 8 || length > 128) {
    throw new Error("Invalid vault password");
  }
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: passwordIterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: keyBytes * 8 },
    false,
    [usage]
  );
}

async function snippetKey(key, usage) {
  return crypto.subtle.importKey("raw", decodeBase64(key, keyBytes), "AES-GCM", false, [usage]);
}

async function encrypt(key, plaintext, additionalData) {
  const iv = randomBytes(nonceBytes);
  const algorithm = { name: "AES-GCM", iv, additionalData, tagLength: tagBytes * 8 };
  const ciphertext = await crypto.subtle.encrypt(algorithm, key, plaintext);
  return { version, iv: encodeBase64(iv), ciphertext: encodeBase64(new Uint8Array(ciphertext)) };
}

async function decrypt(key, envelope, additionalData, minimum, maximum = minimum) {
  if (envelope?.version !== version) throw new Error("Unsupported vault version");
  const iv = decodeBase64(envelope.iv, nonceBytes);
  const ciphertext = decodeBase64(envelope.ciphertext, minimum + tagBytes, maximum + tagBytes);
  const algorithm = { name: "AES-GCM", iv, additionalData, tagLength: tagBytes * 8 };
  return new Uint8Array(await crypto.subtle.decrypt(algorithm, key, ciphertext));
}

/**
 * A folder vault wraps a random data key with a key derived from the user's
 * password. Keep the unwrapped key in trusted session memory.
 */
export async function createFolderVault(password, folderId) {
  const additionalData = context("password-wrap", folderId);
  const salt = randomBytes(saltBytes);
  const wrappingKey = await passwordKey(password, salt, "encrypt");
  const dataKey = randomBytes(keyBytes);
  const envelope = await encrypt(wrappingKey, dataKey, additionalData);
  return {
    vault: { ...envelope, salt: encodeBase64(salt), iterations: passwordIterations },
    key: encodeBase64(dataKey)
  };
}

export async function unlockFolderVault(password, folderId, vault) {
  if (vault?.version !== version || vault.iterations !== passwordIterations) {
    throw new Error("Unsupported folder vault");
  }
  const additionalData = context("password-wrap", folderId);
  const salt = decodeBase64(vault.salt, saltBytes);
  const wrappingKey = await passwordKey(password, salt, "decrypt");
  return encodeBase64(await decrypt(wrappingKey, vault, additionalData, keyBytes));
}

export async function sealSnippet(snippet, key) {
  const { title = "", text, sealed: _sealed, ...metadata } = snippet;
  const additionalData = context("snippet", metadata.folderId, metadata.id);
  if (typeof title !== "string" || typeof text !== "string") throw new Error("Invalid snippet");
  if (title.length + text.length > maxSnippetBytes) throw new Error("Snippet is too large to seal");
  const plaintext = encoder.encode(JSON.stringify({ title, text }));
  if (plaintext.length > maxSnippetBytes) throw new Error("Snippet is too large to seal");
  const sealed = await encrypt(await snippetKey(key, "encrypt"), plaintext, additionalData);
  return { ...metadata, sealed };
}

export async function openSnippet(snippet, key) {
  const { sealed, ...metadata } = snippet;
  const additionalData = context("snippet", metadata.folderId, metadata.id);
  const plaintext = await decrypt(await snippetKey(key, "decrypt"), sealed, additionalData, 1, maxSnippetBytes);
  const { title, text } = JSON.parse(decoder.decode(plaintext));
  if (typeof title !== "string" || typeof text !== "string") throw new Error("Invalid snippet");
  return { ...metadata, title, text };
}

async function deviceKey(prfOutput, salt, folderId, usage) {
  const isBuffer = prfOutput instanceof ArrayBuffer;
  const isView = ArrayBuffer.isView(prfOutput);
  if ((!isBuffer && !isView) || prfOutput.byteLength !== keyBytes) {
    throw new Error("Invalid device credential");
  }
  const material = await crypto.subtle.importKey("raw", prfOutput, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", salt, info: context("device-key", folderId), hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: keyBytes * 8 },
    false,
    [usage]
  );
}

/** Wrap the data key with 32 bytes returned by a WebAuthn PRF credential. */
export async function wrapDeviceKey(folderId, key, prfOutput) {
  const additionalData = context("device-wrap", folderId);
  const salt = randomBytes(saltBytes);
  const wrappingKey = await deviceKey(prfOutput, salt, folderId, "encrypt");
  const wrapped = await encrypt(wrappingKey, decodeBase64(key, keyBytes), additionalData);
  return { ...wrapped, salt: encodeBase64(salt) };
}

export async function unwrapDeviceKey(folderId, wrapped, prfOutput) {
  if (wrapped?.version !== version) throw new Error("Unsupported device wrapper");
  const additionalData = context("device-wrap", folderId);
  const salt = decodeBase64(wrapped.salt, saltBytes);
  const wrappingKey = await deviceKey(prfOutput, salt, folderId, "decrypt");
  return encodeBase64(await decrypt(wrappingKey, wrapped, additionalData, keyBytes));
}

const schema = 1;
const saltLength = 16;
const ivLength = 12;
const tagLength = 16;
const iterations = 600_000;
const maxPlaintextLength = 10 * 1024 * 1024;
const maxCiphertextLength = maxPlaintextLength + tagLength;
const base64urlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

class WorkspaceSyncError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function encodeBytes(bytes) {
  const chunks = [];
  for (let index = 0; index < bytes.length; index += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + 8192)));
  }
  return btoa(chunks.join("")).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function validateEncoding(value, minimum, maximum = minimum, oversize = "syncInvalidData") {
  if (typeof value !== "string") throw new WorkspaceSyncError("syncInvalidData");
  if (value.length > Math.ceil(maximum * 4 / 3)) throw new WorkspaceSyncError(oversize);
  const remainder = value.length % 4;
  const length = Math.floor(value.length * 3 / 4);
  if (length < minimum || length > maximum || remainder === 1 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new WorkspaceSyncError("syncInvalidData");
  }
  // An unpadded base64url value must have zero unused bits in the final sextet.
  const last = base64urlAlphabet.indexOf(value.at(-1));
  if ((remainder === 2 && (last & 15)) || (remainder === 3 && (last & 3))) {
    throw new WorkspaceSyncError("syncInvalidData");
  }
}

function decodeBytes(value) {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function associatedData(salt, accountId) {
  if (typeof accountId !== "string" || !/^[!-~]{1,255}$/u.test(accountId)) {
    throw new WorkspaceSyncError("syncInvalidData");
  }
  return encoder.encode(JSON.stringify(["ease-workspace-sync", schema, salt, accountId]));
}

function requireKey(key, usage) {
  if (!(key instanceof CryptoKey) || key.extractable || key.type !== "secret"
    || key.algorithm.name !== "AES-GCM" || key.algorithm.length !== 256 || !key.usages.includes(usage)) {
    throw new WorkspaceSyncError("syncInvalidData");
  }
}

export function validateWorkspaceSyncEnvelope(envelope) {
  if (!isRecord(envelope) || envelope.schema !== schema) throw new WorkspaceSyncError("syncInvalidData");
  const { salt, iv, ciphertext } = envelope;
  validateEncoding(salt, saltLength);
  validateEncoding(iv, ivLength);
  validateEncoding(ciphertext, tagLength, maxCiphertextLength, "syncTooLarge");
  return { schema, salt, iv, ciphertext };
}

export function createWorkspaceSyncSalt() {
  return encodeBytes(crypto.getRandomValues(new Uint8Array(saltLength)));
}

export async function importWorkspaceAccountKey(value) {
  validateEncoding(value, 32);
  const bytes = decodeBytes(value);
  try {
    return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  } finally {
    bytes.fill(0);
  }
}

export async function deriveWorkspaceSyncKey(passphrase, salt) {
  if (typeof passphrase !== "string" || !passphrase.length || !passphrase.isWellFormed()) {
    throw new WorkspaceSyncError("syncWrongPassphrase");
  }
  validateEncoding(salt, saltLength);
  const secret = encoder.encode(passphrase);
  try {
    const material = await crypto.subtle.importKey("raw", secret, "PBKDF2", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt: decodeBytes(salt), iterations },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  } catch {
    throw new WorkspaceSyncError("syncInvalidData");
  } finally {
    secret.fill(0);
  }
}

export async function encryptWorkspaceSnapshot(snapshot, key, salt, accountId) {
  if (!isRecord(snapshot)) throw new WorkspaceSyncError("syncInvalidData");
  validateEncoding(salt, saltLength);
  requireKey(key, "encrypt");
  const encryptionData = associatedData(salt, accountId);
  let json;
  try {
    json = JSON.stringify(snapshot);
  } catch {
    throw new WorkspaceSyncError("syncInvalidData");
  }
  if (!json?.startsWith("{")) throw new WorkspaceSyncError("syncInvalidData");
  if (json.length > maxPlaintextLength) throw new WorkspaceSyncError("syncTooLarge");

  const plaintext = encoder.encode(json);
  try {
    if (plaintext.length > maxPlaintextLength) throw new WorkspaceSyncError("syncTooLarge");
    const iv = crypto.getRandomValues(new Uint8Array(ivLength));
    const sealed = await crypto.subtle.encrypt({
      name: "AES-GCM", iv, additionalData: encryptionData, tagLength: tagLength * 8
    }, key, plaintext);
    return { schema, salt, iv: encodeBytes(iv), ciphertext: encodeBytes(new Uint8Array(sealed)) };
  } catch (error) {
    if (error instanceof WorkspaceSyncError) throw error;
    throw new WorkspaceSyncError("syncInvalidData");
  } finally {
    plaintext.fill(0);
  }
}

export async function decryptWorkspaceSnapshot(envelope, key, accountId) {
  const { salt, iv, ciphertext } = validateWorkspaceSyncEnvelope(envelope);
  requireKey(key, "decrypt");
  const encryptionData = associatedData(salt, accountId);
  let plaintext;
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt({
      name: "AES-GCM", iv: decodeBytes(iv), additionalData: encryptionData, tagLength: tagLength * 8
    }, key, decodeBytes(ciphertext)));
  } catch (error) {
    throw new WorkspaceSyncError(error?.name === "OperationError" ? "syncWrongPassphrase" : "syncInvalidData");
  }

  try {
    const snapshot = JSON.parse(decoder.decode(plaintext));
    if (!isRecord(snapshot)) throw new WorkspaceSyncError("syncInvalidData");
    return snapshot;
  } catch {
    throw new WorkspaceSyncError("syncInvalidData");
  } finally {
    plaintext.fill(0);
  }
}

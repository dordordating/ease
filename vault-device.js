const prfBytes = 32;
const maxCredentialBytes = 1023;

function extensionRpId() {
  const id = globalThis.chrome?.runtime?.id;
  const location = globalThis.location;
  if (!id || location?.protocol !== "chrome-extension:" || location.hostname !== id) return null;
  return id;
}

function supportsDeviceUnlock() {
  return Boolean(extensionRpId() && globalThis.isSecureContext
    && typeof globalThis.PublicKeyCredential === "function"
    && typeof globalThis.navigator?.credentials?.create === "function"
    && typeof globalThis.navigator.credentials.get === "function");
}

export async function deviceUnlockAvailable() {
  if (!supportsDeviceUnlock()) return false;
  try {
    const capabilities = await PublicKeyCredential.getClientCapabilities?.();
    if (capabilities?.["extension:prf"] === false) return false;
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable() === true;
  } catch {
    return false;
  }
}

function randomBytes() {
  return crypto.getRandomValues(new Uint8Array(prfBytes));
}

function toBase64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64url(value, limit) {
  if (typeof value !== "string" || value.length > Math.ceil(limit * 4 / 3)
    || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("Invalid device credential");
  }
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
  if (!bytes.length || bytes.length > limit || toBase64url(bytes) !== value) throw new Error("Invalid device credential");
  return bytes;
}

function credentialBytes(credential) {
  if (credential?.type !== "public-key" || !(credential.rawId instanceof ArrayBuffer)
    || !credential.rawId.byteLength || credential.rawId.byteLength > maxCredentialBytes) {
    throw new Error("Invalid device credential");
  }
  return new Uint8Array(credential.rawId);
}

async function deriveSecret(credentialId, salt) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(),
      rpId: extensionRpId(),
      userVerification: "required",
      allowCredentials: [{ type: "public-key", id: credentialId, transports: ["internal"] }],
      extensions: { prf: { eval: { first: salt } } },
      timeout: 60_000
    }
  });
  if (assertion?.authenticatorAttachment === "cross-platform"
    || toBase64url(credentialBytes(assertion)) !== toBase64url(credentialId)) {
    throw new Error("Unexpected device credential");
  }

  const authenticatorData = assertion.response?.authenticatorData;
  // The flags byte follows the 32-byte RP ID hash. Bit 2 means user verification succeeded.
  if (!(authenticatorData instanceof ArrayBuffer) || authenticatorData.byteLength < 37
    || !(new Uint8Array(authenticatorData)[32] & 0x04)) {
    throw new Error("Device user verification is required");
  }

  const result = assertion.getClientExtensionResults().prf?.results?.first;
  if (!(result instanceof ArrayBuffer) || result.byteLength !== prfBytes) throw new Error("Device PRF unavailable");
  return toBase64url(new Uint8Array(result));
}

export async function registerDeviceUnlock() {
  if (!supportsDeviceUnlock()) throw new Error("Device verification unavailable");
  const salt = randomBytes();
  try {
    const registration = await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(),
        rp: { id: extensionRpId(), name: "Ease" },
        user: { id: randomBytes(), name: "ease-vault", displayName: "Ease vault" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged" },
        attestation: "none",
        extensions: { prf: {} },
        timeout: 60_000
      }
    });
    if (registration?.authenticatorAttachment !== "platform"
      || registration.getClientExtensionResults().prf?.enabled === false) {
      throw new Error("Device PRF unavailable");
    }
    const id = credentialBytes(registration);
    const prf = await deriveSecret(id, salt);
    return { credentialId: toBase64url(id), salt: toBase64url(salt), prf };
  } catch {
    throw new Error("Device verification could not be set up");
  }
}

export async function readDeviceUnlock(device) {
  if (!supportsDeviceUnlock()) throw new Error("Device verification unavailable");
  try {
    const credentialId = fromBase64url(device?.credentialId, maxCredentialBytes);
    const salt = fromBase64url(device?.salt, prfBytes);
    if (salt.length !== prfBytes) throw new Error("Invalid device salt");
    return await deriveSecret(credentialId, salt);
  } catch {
    throw new Error("Device verification could not complete");
  }
}

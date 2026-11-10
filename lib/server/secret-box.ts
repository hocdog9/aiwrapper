import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type SecretEnvelope = {
  ciphertext: string;
  metadata: { algorithm: "aes-256-gcm"; iv: string; tag: string; version: 1 };
};

function encryptionKey(): Buffer {
  const configured = process.env.BYOK_ENCRYPTION_KEY;
  if (!configured) throw new Error("BYOK is unavailable: configure BYOK_ENCRYPTION_KEY on the server.");
  const key = /^[a-f\d]{64}$/i.test(configured)
    ? Buffer.from(configured, "hex")
    : Buffer.from(configured, "base64");
  if (key.length !== 32) throw new Error("BYOK is unavailable: BYOK_ENCRYPTION_KEY must encode exactly 32 bytes.");
  return key;
}

export function encryptSecret(plaintext: string): SecretEnvelope {
  if (!plaintext.trim()) throw new Error("API key cannot be empty.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext.trim(), "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    metadata: {
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      version: 1,
    },
  };
}

export function decryptSecret(ciphertext: string, metadata: SecretEnvelope["metadata"]): string {
  if (metadata.algorithm !== "aes-256-gcm" || metadata.version !== 1) {
    throw new Error("Unsupported encrypted credential format.");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(metadata.iv, "base64"));
  decipher.setAuthTag(Buffer.from(metadata.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function maskSecret(plaintext: string): string {
  return plaintext.slice(-4).padStart(Math.min(plaintext.length, 4), "•");
}

import { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import { secp256k1 } from "@noble/curves/secp256k1";
import fc from "fast-check";
import {
  bytesToHex,
  hexToBytes,
  recoverMessageAddress,
  recoverTransactionAddress,
  recoverTypedDataAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { type KmsApi, kmsSigner } from "../src/index.ts";

/** secp256k1 SubjectPublicKeyInfo header (id-ecPublicKey, secp256k1), as KMS returns. */
const SPKI_PREFIX = "3056301006072a8648ce3d020106052b8104000a034200";

/**
 * A stand-in for KMS backed by a local key. Like real KMS it returns DER
 * signatures with no recovery bit, and half the time with a high s.
 */
function fakeKms(privateKey: Hex, calls: { sign: number }): KmsApi {
  const pub = bytesToHex(secp256k1.getPublicKey(privateKey.slice(2), false)).slice(2);
  return {
    send: (async (command: GetPublicKeyCommand | SignCommand) => {
      if (command instanceof GetPublicKeyCommand) {
        return { PublicKey: hexToBytes(`0x${SPKI_PREFIX}${pub}`), KeySpec: "ECC_SECG_P256K1" };
      }
      calls.sign++;
      const digest = bytesToHex(command.input.Message!).slice(2);
      const low = secp256k1.sign(digest, privateKey.slice(2));
      const signature = calls.sign % 2 === 0 ? new secp256k1.Signature(low.r, secp256k1.CURVE.n - low.s) : low;
      return { Signature: signature.toDERRawBytes() };
    }) as KmsApi["send"],
  };
}

const key = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .filter((bytes) => secp256k1.utils.isValidPrivateKey(bytes))
  .map((bytes) => bytesToHex(bytes));

describe("KMS signer", () => {
  it("derives the same address as the key itself", async () => {
    await fc.assert(
      fc.asyncProperty(key, async (privateKey) => {
        const signer = await kmsSigner({ keyId: "test", client: fakeKms(privateKey, { sign: 0 }) });
        expect(signer.address).toBe(privateKeyToAccount(privateKey).address);
      }),
      { numRuns: 25 },
    );
  });

  it("produces messages, typed data and transactions that recover to its address, high s or not", async () => {
    await fc.assert(
      fc.asyncProperty(key, fc.string(), async (privateKey, message) => {
        const calls = { sign: 0 };
        const signer = await kmsSigner({ keyId: "test", client: fakeKms(privateKey, calls) });

        const signedMessage = await signer.signMessage({ message });
        expect(await recoverMessageAddress({ message, signature: signedMessage })).toBe(signer.address);

        const typedData = {
          domain: { name: "Open Unified Ledger Settlement", version: "1", chainId: 20261 },
          types: { Note: [{ name: "text", type: "string" }] },
          primaryType: "Note",
          message: { text: message },
        } as const;
        const signedTyped = await signer.signTypedData(typedData);
        expect(await recoverTypedDataAddress({ ...typedData, signature: signedTyped })).toBe(signer.address);

        const transaction = await signer.signTransaction({
          chainId: 20261,
          type: "eip1559",
          to: "0x000000000000000000000000000000000000dEaD",
          nonce: 7,
          gas: 21000n,
          maxFeePerGas: 0n,
          maxPriorityFeePerGas: 0n,
        });
        expect(await recoverTransactionAddress({ serializedTransaction: transaction as never })).toBe(signer.address);
        expect(calls.sign).toBe(3);
      }),
      { numRuns: 25 },
    );
  });

  it("produces the same low-s signature a local key does", async () => {
    const privateKey = `0x${"11".repeat(32)}` as Hex;
    const local = privateKeyToAccount(privateKey);
    const signer = await kmsSigner({ keyId: "test", client: fakeKms(privateKey, { sign: 1 }) });
    // RFC 6979 makes ECDSA deterministic, so after normalization both signatures are identical.
    expect(await signer.signMessage({ message: "settle" })).toBe(await local.signMessage({ message: "settle" }));
  });

  it("refuses a key that is not secp256k1", async () => {
    const client: KmsApi = {
      send: (async () => ({ PublicKey: new Uint8Array(91), KeySpec: "ECC_NIST_P256" })) as KmsApi["send"],
    };
    await expect(kmsSigner({ keyId: "p256", client })).rejects.toThrow(/ECC_SECG_P256K1/);
  });
});

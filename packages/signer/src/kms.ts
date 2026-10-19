import { GetPublicKeyCommand, KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  bytesToHex,
  type Hex,
  hashMessage,
  hashTypedData,
  hexToBytes,
  keccak256,
  type LocalAccount,
  numberToHex,
  parseSignature,
  serializeSignature,
  serializeTransaction,
} from "viem";
import { publicKeyToAddress, toAccount } from "viem/accounts";

/**
 * A signer whose private key never leaves AWS KMS (SPEC.md §4.3). The key is
 * an asymmetric ECC_SECG_P256K1 signing key; this account asks KMS to sign
 * 32-byte digests and turns its answers into Ethereum signatures:
 *   - KMS returns a DER-encoded (r, s) pair, possibly with a high s, which
 *     Ethereum rejects, so s is normalized to the lower half of the curve;
 *   - KMS returns no recovery bit, so it is found by recovering the public key
 *     with each candidate and keeping the one that matches the key's own.
 */

/** The two calls this signer makes; a KMSClient, or a stand-in for tests. */
export interface KmsApi {
  send(command: GetPublicKeyCommand): Promise<{ PublicKey?: Uint8Array; KeySpec?: string }>;
  send(command: SignCommand): Promise<{ Signature?: Uint8Array }>;
}

export interface KmsSignerOptions {
  readonly keyId: string;
  /** Defaults to a KMSClient for `region` with the default credential chain. */
  readonly client?: KmsApi;
  readonly region?: string;
}

/** The uncompressed point (0x04 || x || y) at the end of a secp256k1 SubjectPublicKeyInfo. */
export function publicKeyFromSpki(spki: Uint8Array): Hex {
  const point = spki.slice(-65);
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error("KMS public key is not an uncompressed secp256k1 point");
  }
  return bytesToHex(point);
}

/**
 * Turn a DER signature over `digest` into a 65-byte Ethereum signature whose
 * recovered public key is `publicKey`.
 */
export function toEthereumSignature(der: Uint8Array, digest: Hex, publicKey: Hex): Hex {
  const signature = secp256k1.Signature.fromDER(bytesToHex(der).slice(2)).normalizeS();
  const expected = publicKey.toLowerCase();
  for (const yParity of [0, 1] as const) {
    const recovered = signature.addRecoveryBit(yParity).recoverPublicKey(digest.slice(2));
    if (bytesToHex(recovered.toRawBytes(false)) === expected) {
      return serializeSignature({
        r: numberToHex(signature.r, { size: 32 }),
        s: numberToHex(signature.s, { size: 32 }),
        yParity,
      });
    }
  }
  throw new Error("KMS signature does not recover to the key's public key");
}

export async function kmsSigner(options: KmsSignerOptions): Promise<LocalAccount> {
  const client: KmsApi =
    options.client ?? (new KMSClient(options.region ? { region: options.region } : {}) as unknown as KmsApi);
  const { PublicKey, KeySpec } = await client.send(new GetPublicKeyCommand({ KeyId: options.keyId }));
  if (!PublicKey) throw new Error(`KMS key ${options.keyId} returned no public key`);
  if (KeySpec && KeySpec !== "ECC_SECG_P256K1") {
    throw new Error(`KMS key ${options.keyId} is ${KeySpec}; an ECC_SECG_P256K1 key is required`);
  }
  const publicKey = publicKeyFromSpki(PublicKey);

  const signDigest = async (digest: Hex): Promise<Hex> => {
    const { Signature } = await client.send(
      new SignCommand({
        KeyId: options.keyId,
        Message: hexToBytes(digest),
        MessageType: "DIGEST",
        SigningAlgorithm: "ECDSA_SHA_256",
      }),
    );
    if (!Signature) throw new Error(`KMS key ${options.keyId} returned no signature`);
    return toEthereumSignature(Signature, digest, publicKey);
  };

  return toAccount({
    address: publicKeyToAddress(publicKey),
    sign: ({ hash }) => signDigest(hash),
    signMessage: ({ message }) => signDigest(hashMessage(message)),
    signTypedData: (typedData) => signDigest(hashTypedData(typedData)),
    signTransaction: async (transaction, { serializer = serializeTransaction } = {}) => {
      const signature = await signDigest(keccak256(await serializer(transaction)));
      return serializer(transaction, parseSignature(signature));
    },
  });
}

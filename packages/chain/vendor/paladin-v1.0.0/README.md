# Paladin v1.0.0 contracts

Confidential mode (SPEC.md §10) deploys these contracts from Paladin
(https://github.com/LFDT-Paladin/paladin, Apache-2.0), release
[v1.0.0](https://github.com/LFDT-Paladin/paladin/releases/tag/v1.0.0)
(2026-06-25), unchanged except trimmed to `abi` and `bytecode`:

| File | From the release's `abis.tar.gz` | Used for |
| --- | --- | --- |
| `IdentityRegistry.json` | `IdentityRegistry.json` | the node registry: names, owners, gRPC transport details |
| `Noto.json` | `Noto.json` | the Noto token implementation the factory clones |
| `NotoFactory.json` | `NotoFactory.json` | deploys a Noto token per bank, behind an ERC-1967 proxy |
| `INotoPrivate.json` | `INotoPrivate.json` | the private ABI Paladin nodes take for Noto calls (mint, transfer, balanceOf) |

SHA-256 of the release assets they came from:

- `abis.tar.gz`: `3608c63573d8fd972236889e91acd26b8d08be4e77234557d6621b6a1c372c67`
- `artifacts.tar.gz`: `41e28f759e13af503e843b440149c2b1b04eb8e0aaa15d5d546c159ce3b1fc4f`

The proxy itself is OpenZeppelin's `ERC1967Proxy`, built in this repository
(`contracts/src/PaladinProxy.sol`), since the release does not ship it. The
node image is `ghcr.io/lfdt-paladin/paladin:v1.0.0`.

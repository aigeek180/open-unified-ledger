# Vendored OpenZeppelin Community Contracts

The ERC-7943 (uRWA) fungible implementation from
[OpenZeppelin/openzeppelin-community-contracts](https://github.com/OpenZeppelin/openzeppelin-community-contracts),
copied at commit `ed8261b` (14 October 2026) under its MIT license.

| File | Upstream path |
| --- | --- |
| `interfaces/IERC7943.sol` | `contracts/interfaces/IERC7943.sol` |
| `token/ERC20uRWA.sol` | `contracts/token/ERC20/extensions/ERC20uRWA.sol` |
| `token/ERC20Freezable.sol` | `contracts/token/ERC20/extensions/ERC20Freezable.sol` |
| `token/ERC20Restricted.sol` | `contracts/token/ERC20/extensions/ERC20Restricted.sol` |

The only change is the relative import of `IERC7943.sol`, to match this
folder's layout. The files are vendored rather than installed because the
upstream repository pulls in large unrelated submodules and tracks
OpenZeppelin Contracts `master`. Here they compile against the released
OpenZeppelin Contracts v5.7.0.

These contracts are community contributions and are **not audited** by
OpenZeppelin.

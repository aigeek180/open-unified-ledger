# ISO 20022 schemas

The official XSDs of the message definitions this adapter writes, used to
validate every message it produces (`src/schemas.ts`, `test/`).

**This is not the official source.** The sole source of up-to-date ISO 20022
message definitions and the ISO 20022 Repository is
[https://www.iso20022.org/](https://www.iso20022.org/). Its terms of use say
the material there "is intended to be used and reproduced freely by all
interested users under the ISO 20022 Intellectual Property Right Policy",
and ask that any copy say it is not the official site and name that source,
which this file does.

| File | Message | Source |
| --- | --- | --- |
| `pacs.008.001.08.xsd` | FI to FI customer credit transfer | [archive, message 14231](https://www.iso20022.org/message/14231/download) |
| `pacs.009.001.08.xsd` | Financial institution credit transfer | [archive, message 14271](https://www.iso20022.org/message/14271/download) |
| `pacs.002.001.10.xsd` | FI to FI payment status report | [archive, message 14061](https://www.iso20022.org/message/14061/download) |
| `camt.054.001.08.xsd` | Bank to customer debit/credit notification | [archive, message 12776](https://www.iso20022.org/message/12776/download) |
| `camt.053.001.08.xsd` | Bank to customer statement | [archive, message 12736](https://www.iso20022.org/message/12736/download) |
| `sese.023.001.13.xsd` | Securities settlement transaction instruction | [catalogue, message 23576](https://www.iso20022.org/message/23576/download) |
| `sese.025.001.13.xsd` | Securities settlement transaction confirmation | [catalogue, message 23578](https://www.iso20022.org/message/23578/download) |

`pacs.008`, `pacs.009` and `camt.053` are at the versions in Payments
Canada's Lynx portfolio and SWIFT's CBPR+; the ISO catalogue has later
versions. Lynx lists `pacs.002.001.10` as being considered for future
implementation, and `camt.054.001.08` is the version in Payments Canada's
corporate-to-bank guidelines. `sese.023` and `sese.025` are at version 13,
whose schemas define elements for blockchain addresses and digital payment
settlement. Sources: [`docs/design.md`](../../../docs/design.md) §3.13.

The site does not serve these files to scripts. Each link above downloads,
in a browser, the zip of the message set the schema belongs to (Payments
Clearing and Settlement V09, Bank-to-Customer Cash Management V08,
Settlement and Reconciliation V15). The XSDs here were extracted from those
zips unchanged.

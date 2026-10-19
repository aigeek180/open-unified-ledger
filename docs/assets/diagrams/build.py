"""Draw the README's diagrams: python3 docs/assets/diagrams/build.py [name ...]

Every box and arrow follows SPEC.md and the code it cites; the participants
and customers are the fictional ones in scenarios/*/scenario.yaml.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from svgkit import Doc, text_width  # noqa: E402

OUT = os.path.dirname(os.path.abspath(__file__))
W = 960


def header(d: Doc, title: str, subtitle: str | None = None, y: int = 36):
    d.text(24, y, title, 22, "", "start", "700")
    if subtitle:
        d.text(24, y + 24, subtitle, 14, "muted")


def leg(d: Doc, x, y, verb, fam, amount, token, rest, size=14):
    """A leg row: verb chip, amount and token, then the parties."""
    w = d.chip(x, y - 17, verb, fam, 13, mono=False, h=24, pad=8, weight="600")
    x2 = x + max(w, 52) + 10
    d.rich(x2, y, [(amount + " ", "", "600"), (token, f"{fam}-ink", "600", True), ("  " + rest, "muted")], size)


# ---------------------------------------------------------------------------
# 1. today-vs-unified
# ---------------------------------------------------------------------------
def today_vs_unified():
    d = Doc(
        "today-vs-unified", W, 572,
        "Today's interbank payment against the unified ledger",
        "Left, today: Bank A sends a pacs.008 over a messaging network, the banks settle in central bank money "
        "in the RTGS, each bank posts its customer's account in its own books afterwards, and statements are "
        "reconciled at the end of the day. Right, the unified ledger: one instruction with three legs (burn "
        "dCAD-A from the payer, move wCAD from Bank A to Bank B, mint dCAD-B to the payee), signed by Bank A "
        "and co-signed by Bank B, settles in one final block, and every participant's books post from that block.",
    )
    header(d, "One interbank payment, two ways",
           "Northwind Freight, a Bank A customer, pays Lakeside Steel, a Bank B customer, $2,500.00")

    # Panels
    for x, kicker, title in ((16, "TODAY", "Message, settle, post, reconcile"),
                             (488, "UNIFIED LEDGER", "One instruction, one block, every leg or none")):
        d.rect(x, 82, 456, 472, "panel", 12)
        d.text(x + 20, 110, kicker, 12, "muted", "start", "700")
        d.text(x + 20, 132, title, 17, "", "start", "600", maxw=416)

    # ---- Today ----
    for x, name, row in ((36, "Bank A", "debits the payer"), (306, "Bank B", "credits the payee")):
        d.rect(x, 152, 150, 104, "card", 10)
        d.text(x + 75, 177, name, 15, "green-ink", "middle", "600")
        d.text(x + 75, 196, "its own core books", 13, "muted", "middle")
        d.line(x + 12, 210, x + 138, 210, "rule")
        d.badge(x + 22, 233, 3)
        d.text(x + 38, 238, row, 13, "", "start", maxw=104)
    # (1) message
    d.arrow([(190, 196), (302, 196)], "violet")
    d.chip(246, 168, "pacs.008", "violet", 13, anchor="middle")
    d.text(246, 218, "messaging", 13, "muted", "middle")
    d.text(246, 234, "network", 13, "muted", "middle")
    d.badge(246, 152, 1, "violet")
    # (2) RTGS
    d.rect(36, 318, 420, 92, "blue-box", 10)
    d.text(246, 343, "RTGS · central bank money", 15, "blue-ink", "middle", "600")
    d.chip(56, 360, "Bank A  −2,500.00", "blue", 13, mono=True, h=26)
    d.chip(436, 360, "Bank B  +2,500.00", "blue", 13, mono=True, h=26, anchor="end")
    d.arrow([(111, 258), (111, 314)], "blue")
    d.arrow([(381, 314), (381, 260)], "blue")
    d.badge(160, 287, 2, "blue")
    d.text(178, 292, "interbank settlement", 13, "blue-ink")
    # (4) reconciliation
    d.rect(36, 428, 420, 84, "card", 10)
    d.badge(58, 449, 4)
    d.text(76, 454, "End of day: reconcile", 14, "", maxw=370)
    d.text(76, 478, "Statements (camt.053) are matched against each", 13, "muted", maxw=370)
    d.text(76, 497, "bank's books; breaks are chased the next day.", 13, "muted", maxw=370)
    d.text(246, 536, "Three records, updated at different moments", 14, "muted", "middle", "600")

    # ---- Unified ----
    x0 = 508
    d.rect(x0, 152, 416, 132, "card", 10)
    d.badge(x0 + 22, 174, 1)
    d.rich(x0 + 40, 179, [("Instruction", "", "600"), ("   id = the payment's UETR", "muted")], 14)
    leg(d, x0 + 18, 210, "burn", "green", "2,500.00", "dCAD-A", "from Northwind Freight")
    leg(d, x0 + 18, 240, "move", "blue", "2,500.00", "wCAD", "Bank A → Bank B")
    leg(d, x0 + 18, 270, "mint", "green", "2,500.00", "dCAD-B", "to Lakeside Steel")
    d.text(x0 + 208, 300, "Bank A submits · Bank B co-signs the mint of its liability", 13, "muted", "middle",
           maxw=416)
    # (2) block
    d.arrow([(x0 + 208, 308), (x0 + 208, 330)], "slate")
    d.rect(x0, 334, 416, 64, "slate-box", 10)
    d.badge(x0 + 22, 357, 2)
    d.rich(x0 + 40, 362, [("Block N", "", "600"), ("   SettlementEngine, Besu QBFT", "muted")], 14)
    d.text(x0 + 40, 384, "All three legs in one transaction, or none. Final at commit.", 13, "", maxw=370)
    # (3) books
    d.arrow([(x0 + 208, 398), (x0 + 208, 424)], "slate")
    d.rect(x0, 428, 416, 84, "card", 10)
    d.badge(x0 + 22, 449, 3)
    d.text(x0 + 40, 454, "Books post from block N, then reconcile to it", 14, "", maxw=370)
    for i, (name, fam) in enumerate((("Bank A", "green"), ("Central Bank", "blue"), ("Bank B", "green"))):
        bx = x0 + 14 + i * 133
        d.rect(bx, 466, 121, 34, f"{fam}-box", 8)
        d.text(bx + 60.5, 488, name, 13, f"{fam}-ink", "middle", "600", maxw=110)
    d.text(716, 536, "One record, one moment, proven every block", 14, "green-ink", "middle", "600")
    return d


# ---------------------------------------------------------------------------
# 2. architecture
# ---------------------------------------------------------------------------
def architecture():
    d = Doc(
        "architecture", W, 756,
        "Architecture of Open Unified Ledger",
        "The Central Bank and Banks A, B and C each run a Besu validator and their own service. The shared "
        "ledger (Hyperledger Besu, QBFT, final at commit) holds the ParticipantRegistry, the WholesaleToken wCAD, "
        "a DepositToken per bank (dCAD-A, dCAD-B, dCAD-C), the ERC-3643 Bond and the SettlementEngine. "
        "Customers and the Issuer run no node; their bank signs for them. Inside each bank's service: an API "
        "with operators and approval policy, double-entry books in Postgres, a submitter and signer that send "
        "instructions to the ledger, a listener that posts entries at their block, a reconciler that proves the "
        "books equal the chain every block, and an ISO 20022 adapter. A Next.js console reads every service.",
    )
    header(d, "Who runs what",
           "Each institution runs a validator and its own service: the ledger holds the money, each service its books")
    cols = [24, 198, 372, 546]
    cw = 160
    centers = [c + cw / 2 for c in cols]

    # Customers row
    d.text(cols[0], 92, "Customers, the Issuer", 13, "", "start", "600", maxw=cw)
    d.text(cols[0], 109, "run no node; their bank", 13, "muted", maxw=cw)
    d.text(cols[0], 126, "signs for them", 13, "muted", maxw=cw)
    for c, rows in zip(cols[1:], (("Northwind Freight", "Harbour Foods"), ("Lakeside Steel", "Prairie Grain"),
                                  ("Coastal Shipping", "Issuer, via its agent"))):
        d.rect(c, 80, cw, 50, "card", 8)
        d.lines(c + cw / 2, 100, rows, 13, 18, "muted", "middle", maxw=cw - 16)
        d.line(c + cw / 2, 130, c + cw / 2, 150, "rule-dash")

    # Services row
    specs = [
        ("Central Bank", "blue", ("issues wCAD", "RTGS simulator", "operates the registry")),
        ("Bank A", "green", ("issues dCAD-A", "double-entry books", "reconciler, ISO 20022")),
        ("Bank B", "green", ("issues dCAD-B", "double-entry books", "reconciler, ISO 20022")),
        ("Bank C", "green", ("issues dCAD-C", "agent for the bond", "reconciler, ISO 20022")),
    ]
    for c, (name, fam, rows) in zip(cols, specs):
        d.rect(c, 150, cw, 110, f"{fam}-box", 10)
        d.text(c + cw / 2, 174, name, 15, f"{fam}-ink", "middle", "600")
        d.text(c + cw / 2, 192, "service", 13, "muted", "middle")
        d.lines(c + cw / 2, 214, rows, 13, 18, "", "middle", maxw=cw - 16)

    # Service <-> validator
    for cx in centers:
        d.arrow([(cx - 12, 262), (cx - 12, 298)], "slate")
        d.arrow([(cx + 12, 298), (cx + 12, 263)], "slate")
    d.text(centers[0] - 20, 285, "instructions", 13, "muted", "end")
    d.text(centers[0] + 20, 285, "blocks", 13, "muted", "start")

    # Shared ledger
    lx, lw = 24, 682
    d.rect(lx, 300, lw, 170, "panel", 12)
    for cx in centers:
        d.chip(cx, 312, "validator", "slate", 13, mono=False, anchor="middle", h=24)
    d.text(lx + 16, 362, "Shared ledger", 15, "", "start", "700")
    d.text(lx + 128, 362, "Hyperledger Besu · QBFT · final at commit", 13, "muted")
    d.rect(lx + 16, 374, lw - 32, 38, "slate-box", 8)
    d.rich(lx + 30, 398, [("SettlementEngine", "", "700", True),
                          ("   all legs or none · once per UETR · each leg approved by its owner", "muted")], 13)
    boxes = [
        (150, "ParticipantRegistry", "who may take part", "slate", False),
        (138, "WholesaleToken", "wCAD", "blue", True),
        (208, "DepositToken, one per bank", "dCAD-A · dCAD-B · dCAD-C", "green", True),
        (140, "Bond (ERC-3643)", "BOND-ISSUER-2031", "amber", True),
    ]
    gap = (lw - 32 - sum(b[0] for b in boxes)) / 3
    bx = lx + 16
    for bw, name, sub, fam, mono in boxes:
        d.rect(bx, 420, bw, 40, f"{fam}-box", 8)
        d.text(bx + bw / 2, 436, name, 13, f"{fam}-ink", "middle", "600", maxw=bw - 10)
        d.text(bx + bw / 2, 453, sub, 13 if not mono else 12.5, "muted" if not mono else f"{fam}-ink", "middle",
               mono=mono, maxw=bw - 10)
        bx += bw + gap

    # Right column: console, optional modes, ISO 20022
    rx, rw = 730, 206
    d.rect(rx, 150, rw, 110, "card", 10)
    d.text(rx + 14, 174, "Console", 15, "", "start", "600")
    d.text(rx + 80, 174, "Next.js", 13, "muted")
    d.lines(rx + 14, 196, ("reads every service: books,", "instructions, messages,", "reconciliation, faults"), 13,
            18, "", maxw=rw - 24)
    d.arrow([(rx, 205), (cols[3] + cw + 4, 205)], "slate")
    d.rect(rx, 300, rw, 170, "card", 10)
    d.text(rx + 14, 324, "Two more modes", 15, "", "start", "600")
    d.text(rx + 14, 348, "Interop", 13, "", "start", "600")
    d.lines(rx + 14, 366, ("a second Besu ledger and", "three coordinators"), 13, 18, "muted", maxw=rw - 24)
    d.text(rx + 14, 412, "Confidential", 13, "", "start", "600")
    d.lines(rx + 14, 430, ("a Paladin node per bank,", "deposits as Noto tokens"), 13, 18, "muted", maxw=rw - 24)

    # Inside a bank's service
    zy = 504
    d.rect(24, zy, 682, 232, "panel", 12)
    d.text(66, zy + 26, "Inside each bank's service", 15, "", "start", "700")
    d.text(266, zy + 26, "one codebase, one instance per bank", 13, "muted")
    L, C, R = (66, 172), (262, 212), (500, 190)
    r1, r2, rh = zy + 44, zy + 140, 76
    d.box(L[0], r1, L[1], rh, "slate", "Submitter", None, ("sends from the outbox", "signs: local key or KMS"),
          13, 14, cls="card", align="start", pad=12)
    d.box(L[0], r2, L[1], rh, "slate", "Chain listener", None, ("reads each new block", "posts its entries"),
          13, 14, cls="card", align="start", pad=12)
    d.rect(C[0], r1, C[1], r2 + rh - r1, "green-box", 10)
    d.text(C[0] + 14, r1 + 24, "Books", 15, "green-ink", "start", "700")
    d.lines(C[0] + 14, r1 + 44, ("Postgres, double entry,", "append-only; pending until", "the block posts it"), 13,
            18, "", maxw=C[1] - 24)
    d.rect(C[0] + 12, r1 + 106, C[1] - 24, 64, "card", 8)
    d.text(C[0] + 24, r1 + 126, "Reconciler", 13, "", "start", "700")
    d.lines(C[0] + 24, r1 + 144, ("books = chain, every block;", "breaks shown, never fixed"), 13, 17, "muted",
            maxw=C[1] - 44)
    d.box(R[0], r1, R[1], rh, "slate", "Service API", None, ("operators, approval policy", "hash-chained audit log"),
          13, 14, cls="card", align="start", pad=12)
    d.box(R[0], r2, R[1], rh, "violet", "ISO 20022 adapter", None, ("messages built from the", "instruction and journal"),
          13, 14, align="start", pad=12)
    # flows inside
    d.arrow([(R[0], r1 + 38), (C[0] + C[1] + 3, r1 + 38)], "slate")
    d.arrow([(C[0], r1 + 38), (L[0] + L[1] + 3, r1 + 38)], "slate")
    d.arrow([(L[0] + L[1], r2 + 38), (C[0] - 3, r2 + 38)], "slate")
    d.arrow([(C[0] + C[1], r2 + 38), (R[0] - 3, r2 + 38)], "violet")
    # to and from the ledger, along the left edge
    d.arrow([(L[0], r1 + 38), (38, r1 + 38), (38, 474)], "slate")
    d.arrow([(50, 472), (50, r2 + 38), (L[0] - 3, r2 + 38)], "slate")
    d.text(62, 492, "instructions out, blocks in", 13, "muted")
    # ISO 20022 out
    d.rect(rx, zy, rw, 232, "violet-box", 10)
    d.text(rx + 14, zy + 26, "ISO 20022 out", 15, "violet-ink", "start", "700")
    d.text(rx + 14, zy + 46, "matched by one UETR", 13, "muted")
    msgs = ["pacs.008", "pacs.009", "pacs.002", "camt.054", "camt.053", "sese.023", "sese.025"]
    for i, m in enumerate(msgs):
        col, row = i % 2, i // 2
        d.chip(rx + 14 + col * 94, zy + 62 + row * 34, m, "violet", 13, h=26, pad=8)
    d.text(rx + 14, zy + 218, "valid against the XSDs", 13, "muted", maxw=rw - 24)
    d.arrow([(R[0] + R[1], r2 + 38), (rx - 3, r2 + 38)], "violet")
    return d


# ---------------------------------------------------------------------------
# 3. money-layers
# ---------------------------------------------------------------------------
def money_layers():
    d = Doc(
        "money-layers", W, 612,
        "Who is liable for each token, and who may hold it",
        "Three layers. wCAD is the Central Bank's liability (tokenized reserves), minted only by it and held only "
        "by banks with a reserve account: Bank A, Bank B, Bank C. dCAD-A is Bank A's deposit liability, still a "
        "deposit, minted and burned only by Bank A and held only by customers on its allowlist (Northwind Freight, "
        "Harbour Foods); dCAD-B and dCAD-C are alike. BOND-ISSUER-2031 is the Issuer's obligation, minted through "
        "its agent Bank C, held only by addresses with a verified identity under ERC-3643: banks, and Bank A's "
        "custody wallet for Alder Pension Plan and Birchline Insurance.",
    )
    header(d, "Who owes what",
           "Every token is someone's liability: its issuer alone creates it, and alone decides who may hold it")
    X1, W1 = 24, 290     # whose liability
    X2, W2 = 344, 200    # the token
    X3, W3 = 574, 362    # who may hold it
    for x, label in ((X1, "WHOSE LIABILITY"), (X2, "THE TOKEN"), (X3, "WHO MAY HOLD IT")):
        d.text(x, 100, label, 12, "muted", "start", "700")

    def taccount(x, y, w, assets, liabilities, hl, fam):
        half = w / 2
        d.text(x + 8, y, "Assets", 13, "muted")
        d.text(x + half + 10, y, "Liabilities", 13, "muted")
        d.line(x, y + 7, x + w, y + 7, "rule")
        d.line(x + half, y + 7, x + half, y + 7 + 18 * max(len(assets), len(liabilities)) + 4, "rule")
        for i, a in enumerate(assets):
            d.text(x + 8, y + 25 + 18 * i, a, 13, "", maxw=half - 12)
        for i, l in enumerate(liabilities):
            on = l == hl
            d.text(x + half + 10, y + 25 + 18 * i, l, 13, f"{fam}-ink" if on else "", "start",
                   "700" if on else None, maxw=half - 14)

    rows = [
        dict(y=112, fam="blue", who="Central Bank", whosub="tokenized reserves",
             assets=None, liab=["banks' settlement accounts (RTGS)", "wCAD outstanding, a line per bank"],
             hl="wCAD outstanding, a line per bank",
             token="wCAD", contract="WholesaleToken", rule=("only the central bank", "mints or redeems it"),
             holders=["Bank A", "Bank B", "Bank C"], hfam="green",
             gate="a reserve account the central bank opened",
             note="banks only; a customer never holds it"),
        dict(y=264, fam="green", who="Bank A", whosub="Banks B and C alike: dCAD-B, dCAD-C",
             assets=["RTGS reserves", "wCAD reserves"], liab=["customer deposits", "tokenized deposits"],
             hl="tokenized deposits",
             token="dCAD-A", contract="DepositToken", rule=("still a Bank A deposit;", "only Bank A mints or burns"),
             holders=["Northwind Freight", "Harbour Foods"], hfam="slate",
             gate="Bank A's allowlist, after its KYC (ERC-7943)",
             note="customers Bank A has checked, nobody else"),
        dict(y=416, fam="amber", who="Issuer", whosub="through Bank C, its issuing and paying agent",
             assets=None, liab=None, hl=None,
             token="BOND-ISSUER-2031", contract="Bond, ERC-3643", rule=("minted through its agent;", "one unit is $1,000 face"),
             holders=["Bank A", "Bank B", "Bank A custody wallet"], hfam="green",
             gate="a verified identity (ERC-3643 KYC claim)",
             note="for Alder Pension Plan and Birchline Insurance"),
    ]
    rh = 136
    for r in rows:
        y, fam = r["y"], r["fam"]
        # whose liability
        d.rect(X1, y, W1, rh, f"{fam}-box", 10)
        d.text(X1 + 14, y + 26, r["who"], 16, f"{fam}-ink", "start", "700")
        d.text(X1 + 14, y + 45, r["whosub"], 13, "muted", maxw=W1 - 24)
        if r["liab"] and not r["assets"]:
            d.rect(X1 + 10, y + 56, W1 - 20, 70, "card", 8)
            d.text(X1 + 18, y + 74, "Liabilities", 13, "muted")
            d.line(X1 + 10, y + 81, X1 + W1 - 10, y + 81, "rule")
            for i, l in enumerate(r["liab"]):
                on = l == r["hl"]
                d.text(X1 + 18, y + 99 + 18 * i, l, 13, f"{fam}-ink" if on else "", "start", "700" if on else None,
                       maxw=W1 - 36)
        elif r["liab"]:
            d.rect(X1 + 10, y + 56, W1 - 20, 70, "card", 8)
            taccount(X1 + 10, y + 74, W1 - 20, r["assets"], r["liab"], r["hl"], fam)
        else:
            d.rect(X1 + 10, y + 56, W1 - 20, 70, "card", 8)
            d.text(X1 + 24, y + 80, "Its obligation: the bond, at face", 13, f"{fam}-ink", "start", "700")
            d.text(X1 + 24, y + 100, "coupons and redemption paid", 13, "muted")
            d.text(X1 + 24, y + 117, "by the agent in wCAD", 13, "muted")
        # token
        d.arrow([(X1 + W1, y + rh / 2), (X2 - 4, y + rh / 2)], fam)
        d.rect(X2, y, W2, rh, "card", 10)
        tsize = 20 if len(r["token"]) < 10 else 15
        d.chip(X2 + W2 / 2, y + 16, r["token"], fam, tsize, h=36, pad=12, anchor="middle", weight="700")
        d.text(X2 + W2 / 2, y + 72, r["contract"], 13, "", "middle", "600")
        d.lines(X2 + W2 / 2, y + 96, r["rule"], 13, 17, "muted", "middle", maxw=W2 - 16)
        # holders
        d.arrow([(X2 + W2, y + rh / 2), (X3 - 4, y + rh / 2)], fam)
        d.rect(X3, y, W3, rh, "card", 10)
        cx = X3 + 14
        cy = y + 16
        for h in r["holders"]:
            w = text_width(h, 13) + 18
            if cx + w > X3 + W3 - 10:
                cx, cy = X3 + 14, cy + 32
            d.chip(cx, cy, h, r["hfam"], 13, mono=False, h=26, pad=9)
            cx += w + 8
        d.text(X3 + 14, cy + 48, r["note"], 13, "muted", maxw=W3 - 24)
        d.line(X3 + 14, y + rh - 42, X3 + W3 - 14, y + rh - 42, "rule")
        d.text(X3 + 14, y + rh - 22, ("Only on " if "allowlist" in r["gate"] else "Only with ") + r["gate"], 13, "", maxw=W3 - 24)
    d.text(24, 584, "Every token moves only through the SettlementEngine, so each movement carries an instruction id "
           "the books can match.", 13, "muted", maxw=912)
    d.text(24, 602, "Tokenizing a deposit moves value between two of the bank's own liabilities: its total deposits "
           "never change.", 13, "muted", maxw=912)
    return d


# ---------------------------------------------------------------------------
# 4. payment-lifecycle
# ---------------------------------------------------------------------------
def note(d: Doc, cx, y, w, n, title, rows, fam="slate", h=None, cls=None):
    h = h or 42 + 18 * len(rows)
    x = cx - w / 2
    d.rect(x, y, w, h, cls or "card", 8)
    d.badge(x + 18, y + 18, n, fam)
    d.text(x + 34, y + 23, title, 14, "", "start", "600", maxw=w - 44)
    d.lines(x + 12, y + 44, rows, 13, 18, "muted", maxw=w - 20)
    return y + h


def payment_lifecycle():
    d = Doc(
        "payment-lifecycle", W, 852,
        "One interbank payment, step by step",
        "1: an operator at Bank A orders Northwind Freight's payment of 2,500.00 to Lakeside Steel at Bank B; a UETR "
        "names it. 2: Bank A asks Bank B to co-sign the three legs. 3: Bank B rebuilds the legs itself, books its "
        "pending credit to Lakeside Steel and signs. 4: Bank A books its pending debit and an outbox row in one "
        "database transaction. 5: Bank A's submitter sends the instruction with Bank B's signature to the "
        "SettlementEngine. 6: block N burns dCAD-A, moves wCAD from Bank A to Bank B and mints dCAD-B, all or none, "
        "final at commit. 7: each participant's listener posts its entry at block N; the Central Bank posts the "
        "wCAD move between the banks' lines. 8: each reconciler proves its books equal the chain. The messages, "
        "all under the one UETR: pacs.008 and its pacs.009 cover, pacs.002 ACSC with the block, camt.054 to each "
        "customer's account.",
    )
    header(d, "One interbank payment, step by step",
           "Northwind Freight (Bank A) pays Lakeside Steel (Bank B) $2,500.00 under one UETR")
    A, B, L, C = 130, 342, 546, 712
    MX, MW = 790, 146
    bottom = 836
    lanes = [(A, 212, "Bank A", "payer's bank", "green"), (B, 188, "Bank B", "payee's bank", "green"),
             (L, 188, "Shared ledger", "SettlementEngine", "slate"), (C, 132, "Central Bank", "wCAD issuer", "blue")]
    for cx, w, name, sub, fam in lanes:
        d.line(cx, 136, cx, bottom, "rule-dash")
        d.rect(cx - w / 2, 84, w, 52, f"{fam}-box", 10)
        d.text(cx, 106, name, 15, f"{fam}-ink", "middle", "700")
        d.text(cx, 125, sub, 13, "muted", "middle")
    d.rect(MX, 84, MW, bottom - 84, "violet-soft", 10)
    d.text(MX + MW / 2, 106, "ISO 20022", 15, "violet-ink", "middle", "700")
    d.text(MX + MW / 2, 125, "all one UETR", 13, "muted", "middle")

    def msg(y, name, sub):
        d.chip(MX + MW / 2, y, name, "violet", 13, h=26, anchor="middle")
        d.text(MX + MW / 2, y + 44, sub, 13, "violet-ink", "middle", maxw=MW - 12)

    # 1
    note(d, A, 150, 212, 1, "Payment order", ("an operator's POST /payments:", "Northwind Freight pays",
                                               "Lakeside Steel 2,500.00"))
    # 2
    y2 = 272
    d.arrow([(A, y2), (B - 4, y2)], "slate")
    d.badge(A + 22, y2, 2)
    d.text((A + B) / 2 + 14, y2 - 9, "ask Bank B to co-sign", 13, "", "middle")
    d.text((A + B) / 2 + 14, y2 + 19, "3 legs, UETR, deadline", 13, "muted", "middle")
    # 3
    note(d, B, 304, 188, 3, "Bank B signs", ("rebuilds the legs itself;", "books its pending credit",
                                              "to Lakeside Steel; EIP-712"))
    d.arrow([(B, 422), (A + 4, 422)], "slate", dashed=True)
    d.text((A + B) / 2, 414, "co-signature", 13, "muted", "middle")
    # 4
    note(d, A, 438, 212, 4, "Bank A books", ("pending debit of Northwind", "Freight and its outbox row,",
                                              "in one DB transaction"))
    # 5
    y5 = 556
    d.arrow([(A, y5), (L - 4, y5)], "slate")
    d.badge(A + 22, y5, 5)
    d.text(L - 106, y5 - 9, "submitter sends it", 13, "", "middle")
    d.text(L - 106, y5 + 19, "with Bank B's signature", 13, "muted", "middle")
    msg(530, "pacs.008", "customer payment")
    msg(598, "pacs.009", "cover, wCAD leg")
    # 6
    by = 592
    d.rect(L - 94, by, 188, 128, "slate-box", 10)
    d.badge(L - 76, by + 18, 6)
    d.text(L - 58, by + 23, "Block N", 14, "", "start", "700")
    for i, (verb, fam, tok) in enumerate((("burn", "green", "dCAD-A"), ("move", "blue", "wCAD A → B"),
                                          ("mint", "green", "dCAD-B"))):
        d.chip(L - 80, by + 36 + 24 * i, verb, fam, 12.5, mono=False, h=21, pad=6, weight="600")
        d.text(L - 26, by + 51 + 24 * i, tok, 13, f"{fam}-ink", "start", "600", mono=True)
    d.text(L, by + 119, "all or none · final at commit", 12.5, "muted", "middle")
    # 7
    y7 = 754
    d.arrow([(L, y7), (A + 4, y7)], "slate")
    d.arrow([(L, y7), (C - 4, y7)], "slate")
    d.badge(L, y7, 7)
    d.text((A + B) / 2 + 14, y7 - 9, "listeners post at block N", 13, "", "middle")
    for cx, t in ((A, "debit posted"), (B, "credit posted")):
        d.text(cx + 8, y7 + 19, t, 13, "muted")
    d.text(C, y7 + 19, "wCAD A → B", 13, "muted", "middle")
    msg(666, "pacs.002", "ACSC, with block N")
    msg(734, "camt.054", "to each customer")
    # 8
    for cx, w in ((A, 212), (B, 188), (C, 132)):
        d.rect(cx - w / 2, 790, w, 34, "green-box", 8)
    d.badge(A - 106 + 18, 807, 8, "green")
    d.text(A + 10, 812, "books = chain at N", 13, "green-ink", "middle", "600")
    d.text(B, 812, "books = chain at N", 13, "green-ink", "middle", "600")
    d.text(C, 812, "books = chain", 13, "green-ink", "middle", "600")
    d.text(L, 812, "reconcilers", 13, "muted", "middle")
    return d


# ---------------------------------------------------------------------------
# 5. dvp-pvp-repo
# ---------------------------------------------------------------------------
def caption(d: Doc, y, kicker, title, rows):
    d.text(24, y, kicker, 12, "muted", "start", "700")
    d.text(24, y + 24, title, 17, "", "start", "700", maxw=230)
    d.lines(24, y + 48, rows, 13, 18, "muted", maxw=234)


def party(d: Doc, x, y, w, name, sub, fam="green", h=64):
    d.rect(x, y, w, h, f"{fam}-box", 10)
    d.text(x + w / 2, y + 27, name, 15, f"{fam}-ink", "middle", "700")
    d.text(x + w / 2, y + 46, sub, 13, "muted", "middle", maxw=w - 10)


def frame(d: Doc, x, y, w, h, label):
    d.rect(x, y, w, h, "rule-dash", 12)
    d.chip(x + w / 2, y - 12, label, "slate", 13, mono=False, anchor="middle", h=24, weight="600")


def dvp_pvp_repo():
    d = Doc(
        "dvp-pvp-repo", W, 780,
        "Bond delivery versus payment, cross-border payment versus payment, and repo",
        "Bond DvP: Bank A delivers BOND-ISSUER-2031 units to Bank B and Bank B pays wCAD, in one instruction; Bank B "
        "co-signs only the trade its operator affirmed (its sese.023 receive instruction), both sides' sese.023 "
        "match on the UETR, and sese.025 confirms with the block. Cross-border PvP: Bank A's customer Northwind "
        "Freight pays Bank B's customer Mesa Solar in USD from CAD; four legs in one instruction (burn dCAD-A, wCAD "
        "Bank A to Bank C, wUSD Bank C to Bank B, mint dUSD-B), with wCAD and wUSD issued by two central banks, at a "
        "quote Bank C, the dealer, signed. Repo: Bank A lends wCAD to Bank B against bonds; open, margin, "
        "substitution and close are each one instruction.",
    )
    header(d, "Two assets, one instruction",
           "Delivery versus payment, payment versus payment and repo all settle every leg in one block, or none")
    DX = 296

    # ---- Bond DvP ----
    y = 96
    caption(d, y, "BOND · DELIVERY VERSUS PAYMENT", "Units against wCAD",
            ("Bank A sells to Bank B, which", "co-signs only the trade its own", "operator affirmed under the",
             "same UETR. If either leg fails,", "neither moves."))
    frame(d, 446, y + 12, 344, 92, "one instruction · one block")
    party(d, DX, y + 24, 130, "Bank A", "seller")
    party(d, 806, y + 24, 130, "Bank B", "buyer")
    d.arrow([(DX + 130, y + 44), (802, y + 44)], "amber")
    d.rect(526, y + 33, 184, 22, "bg", 0)
    d.text(618, y + 49, "BOND-ISSUER-2031 units", 13, "amber-ink", "middle", "600", mono=True)
    d.arrow([(806, y + 72), (DX + 134, y + 72)], "blue")
    d.rect(576, y + 61, 84, 22, "bg", 0)
    d.text(618, y + 77, "wCAD", 13, "blue-ink", "middle", "600", mono=True)
    d.chip(DX + 65, y + 112, "sese.023 DELI", "violet", 13, anchor="middle", h=24)
    d.chip(871, y + 112, "sese.023 RECE", "violet", 13, anchor="middle", h=24)
    d.text(DX + 65, y + 156, "submits", 13, "muted", "middle")
    d.text(871, y + 156, "its affirmation", 13, "muted", "middle")
    d.text(618, y + 128, "both match on the UETR (CmonId);", 13, "muted", "middle")
    d.rich(618, y + 148, [("sese.025", "violet-ink", "600", True), (" confirms, with the block", "muted")], 13,
           "middle")
    d.line(24, y + 182, 936, y + 182, "rule")

    # ---- PvP ----
    y = 302
    caption(d, y, "CROSS-BORDER · PAYMENT VS PAYMENT", "CAD against USD",
            ("Two central banks on one ledger.", "The dealer signs a quote and", "co-signs first, so the rate",
             "cannot change before settling.", "pacs.008 + a pacs.009 per currency."))
    frame(d, DX - 12, y + 12, 652, 168, "one instruction · four legs · one block")
    by = y + 30
    party(d, DX, by, 104, "Bank A", "CAD")
    party(d, 564, by, 104, "Bank C", "the dealer", "green")
    party(d, 832, by, 104, "Bank B", "USD")
    for x1, x2, tok, cb in ((DX + 104, 564, "wCAD", "CAD Central Bank"), (668, 832, "wUSD", "USD Central Bank")):
        d.arrow([(x1, by + 32), (x2 - 4, by + 32)], "blue")
        d.text((x1 + x2) / 2, by + 24, tok, 13, "blue-ink", "middle", "700", mono=True)
        d.text((x1 + x2) / 2, by + 52, "issued by the", 12.5, "muted", "middle")
        d.text((x1 + x2) / 2, by + 68, cb, 12.5, "blue-ink", "middle")
    for cx, verb, tok, who in ((DX + 52, "burn", "dCAD-A", "Northwind Freight"), (884, "mint", "dUSD-B", "Mesa Solar")):
        d.chip(cx, by + 78, f"{verb} {tok}", "green", 13, anchor="middle", h=24)
        d.text(cx, by + 120, who, 13, "muted", "middle")
    d.rect(486, by + 76, 260, 64, "card", 8)
    d.text(616, by + 96, "Signed quote (EIP-712)", 13, "", "middle", "700")
    d.text(616, by + 114, "CAD → USD at 0.7315, target rounded", 13, "muted", "middle", maxw=250)
    d.text(616, by + 131, "once, half-even; it expires", 13, "muted", "middle", maxw=250)
    d.line(24, y + 200, 936, y + 200, "rule")

    # ---- Repo ----
    y = 524
    caption(d, y, "REPO", "Cash against collateral",
            ("Bank A lends wCAD to Bank B", "against bonds. Each step is one", "instruction, and each bank's",
             "repo record is proven against", "the chain every block."))
    d.rich(DX, y + 4, [("A", "", "700", True), (" = Bank A, the lender  ·  ", "muted"), ("B", "", "700", True),
                       (" = Bank B, the borrower", "muted")], 13)
    cards = [
        ("Open", "against payment", [("bond", "amber", "B → A"), ("wCAD", "blue", "A → B")],
         ("the purchase price,", "covered by the units", "after the haircut")),
        ("Margin", "free of payment", [("bond", "amber", "B → A"), ("bond", "amber", "A → B")],
         ("either way: B → A tops", "up a shortfall, A → B", "returns an excess")),
        ("Substitution", "free of payment", [("bond", "amber", "A → B"), ("bond", "amber", "B → A")],
         ("old units out, new in,", "in one block: never", "uncovered")),
        ("Close", "against payment", [("bond", "amber", "A → B"), ("wCAD", "blue", "B → A")],
         ("price plus interest,", "ACT/365F, rounded", "once, half-even")),
    ]
    cw, gap = 154, 8
    for i, (title, sub, legs, foot) in enumerate(cards):
        x = DX + i * (cw + gap)
        d.rect(x, y + 20, cw, 192, "card", 10)
        d.text(x + 12, y + 44, title, 15, "", "start", "700")
        d.text(x + 12, y + 62, sub, 13, "muted")
        for j, (asset, fam, dirn) in enumerate(legs):
            ly = y + 76 + j * 32
            d.chip(x + 12, ly, asset, fam, 13, mono=False, h=24, pad=7, weight="600")
            d.text(x + 72, ly + 17, dirn, 14, f"{fam}-ink", "start", "600", mono=True)
        d.lines(x + 12, y + 160, foot, 13, 17, "muted", maxw=cw - 16)
    d.rich(DX, y + 236, [("sese.023", "violet-ink", "600", True), (" from each side and ", "muted"),
                         ("sese.025", "violet-ink", "600", True),
                         (" once settled, each naming the repo by its opening UETR", "muted")], 13)
    return d


# ---------------------------------------------------------------------------
# 6. interop-coordinators
# ---------------------------------------------------------------------------
def interop_coordinators():
    d = Doc(
        "interop-coordinators", W, 948,
        "The same payment across two ledgers, under three coordinators",
        "Interop mode puts Bank B's deposit token on a second Besu ledger. Ledger 1 holds the burn of the payer's "
        "dCAD-A and the wCAD move from Bank A to Bank B; ledger 2 holds the mint of the payee's dCAD-B. Each ledger "
        "runs a ConditionalSettlement that locks its part, then settles it or releases it. Unified settles all three "
        "legs in one transaction and never leaves the ledgers disagreeing. HTLC ends inconsistent when Bank B is back "
        "after ledger 1's timeout or its claim lands late: the payee was credited and Bank B never paid. Notary "
        "two-phase commit ends inconsistent when the notary crashes between its commits and is back after ledger "
        "2's timeout, or its second commit lands late: Bank B was paid and the payee never credited. A table gives "
        "the outcome of each coordinator under each fault.",
    )
    header(d, "One payment, two ledgers, three coordinators",
           "Bank B's deposits move to a second ledger: each ledger locks its part, then settles or releases it")
    # Ledgers
    for x, title, sub, legs in (
        (24, "Ledger 1", "the shared ledger",
         [("burn", "green", "dCAD-A", "from Northwind Freight"), ("move", "blue", "wCAD", "Bank A → Bank B")]),
        (492, "Ledger 2", "a separate Besu network, Bank B's",
         [("mint", "green", "dCAD-B", "to Lakeside Steel")]),
    ):
        d.rect(x, 84, 444, 138, "panel", 12)
        d.rich(x + 16, 110, [(title, "", "700"), ("   " + sub, "muted")], 15)
        d.rect(x + 16, 124, 412, 84, "card", 8)
        d.text(x + 30, 146, "ConditionalSettlement lock", 13, "", "start", "700", mono=True)
        for i, (verb, fam, tok, rest) in enumerate(legs):
            leg(d, x + 30, 176 + 26 * i, verb, fam, "", tok, rest, 13)
    d.text(480, 240, "both parts under the payment's UETR", 13, "muted", "middle")
    d.rich(480, 262, [("Each lock freezes what its legs take, then ", "muted"), ("settles", "green-ink", "700"),
                      (" (secret or notary's commit, before the timeout) or is ", "muted"),
                      ("released", "", "700"), (" (abort, or refund after it)", "muted")], 13, "middle")

    # Coordinators
    cols = [(208, "Unified", "the baseline"), (452, "HTLC", "hashed timelocks, run by the banks"),
            (696, "Notary 2PC", "two-phase commit")]
    cw = 236
    top = 288
    steps = {
        "Unified": [],
        "HTLC": [("Bank A locks ledger 1 under", "a hash, the longer timeout"),
                 ("Bank B locks ledger 2, same", "hash, a shorter timeout"),
                 ("Bank A claims ledger 2 with", "the secret: payee credited"),
                 ("Bank B claims ledger 1 with", "the now-public secret")],
        "Notary 2PC": [("Both banks lock their parts,", "naming the notary"),
                       ("The notary logs its decision,", "then commits ledger 1"),
                       ("then commits ledger 2", "")],
    }
    fails = {
        "Unified": ("green", "Never disagree", ("one transaction settles every", "leg or none, whatever fails")),
        "HTLC": ("red", "Can end inconsistent", ("Bank B back after ledger 1's", "timeout, or its claim late:",
                                                 "payee credited, Bank B unpaid")),
        "Notary 2PC": ("red", "Can end inconsistent", ("crash between the commits,", "back after ledger 2's timeout:",
                                                       "Bank B paid, payee not credited")),
    }
    d.text(24, top + 24, "COORDINATOR", 12, "muted", "start", "700")
    d.lines(24, top + 48, ("Three ways to move", "the same payment,", "behind one interface"), 13, 18, "muted")
    ch = 330
    for x, name, sub in cols:
        d.rect(x, top, cw, ch, "card", 10)
        d.text(x + 14, top + 26, name, 16, "", "start", "700")
        d.text(x + 14, top + 45, sub, 13, "muted", maxw=cw - 24)
        if name == "Unified":
            d.lines(x + 14, top + 76, ("All three legs on the shared", "ledger, settled by the", "SettlementEngine in one",
                                       "transaction"), 13, 18, "", maxw=cw - 24)
        for i, (a, b) in enumerate(steps[name]):
            sy = top + 72 + i * 40
            d.badge(x + 24, sy + 1, i + 1, "slate", r=9)
            d.text(x + 40, sy + 6, a, 13, "", maxw=cw - 50)
            if b:
                d.text(x + 40, sy + 24, b, 13, "muted", maxw=cw - 50)
        fam, head, rows = fails[name]
        d.rect(x + 10, top + 234, cw - 20, 86, f"{fam}-box", 8)
        d.text(x + 22, top + 256, head, 13, f"{fam}-ink", "start", "700")
        d.lines(x + 22, top + 275, rows, 13, 17, f"{fam}-ink", maxw=cw - 40)

    # Results matrix
    my = top + ch + 34
    d.text(24, my + 16, "OUTCOME UNDER EACH FAULT", 12, "muted", "start", "700")
    for x, name, _ in cols:
        d.text(x + cw / 2, my + 16, name, 14, "", "middle", "700")
    C, A_, X = ("committed", "green"), ("aborted", "slate"), ("inconsistent", "red")
    rows = [
        ("none", [(C, "in one transaction"), (C, "claims ~1 s apart"), (C, "commits ~1 s apart")]),
        ("coordinator crash", [(C, "sent on restart"), (A_, "both refund"), (X, "notary crashed")]),
        ("message loss", [(C, "asked again"), (A_, "Bank A refunds"), (C, "commit resent")]),
        ("participant offline", [(A_, "no signature in time"), (X, "Bank B back too late"), (A_, "Bank B never locked")]),
        ("late commit", [(A_, "refused whole"), (X, "claim after timeout"), (X, "commit after timeout")]),
    ]
    rh = 36
    for i, (fault, cells) in enumerate(rows):
        ry = my + 30 + i * (rh + 6)
        d.text(196, ry + 23, fault, 13, "", "end", "600")
        for (x, _, _), ((outcome, fam), why) in zip(cols, cells):
            d.rect(x, ry, cw, rh, f"{fam}-box" if fam != "slate" else "panel", 8)
            d.rich(x + 12, ry + 23, [(outcome, f"{fam}-ink", "700"), (" · " + why, "muted")], 13)
    ly = my + 30 + 5 * (rh + 6) + 18
    d.rich(208, ly, [("committed", "green-ink", "700"), (": every part settled · ", "muted"),
                     ("aborted", "", "700"), (": nothing moved, ledgers agree · ", "muted"),
                     ("inconsistent", "red-ink", "700"), (": one settled, one released", "muted")], 13)
    d.text(208, ly + 22, "Every case is checked on two Besu networks by pnpm interop, and fails the run if it ends "
           "otherwise.", 13, "muted", maxw=728)
    return d


# ---------------------------------------------------------------------------
# 7. confidential
# ---------------------------------------------------------------------------
def confidential():
    d = Doc(
        "confidential", W, 848,
        "Confidential mode: who sees what",
        "Each bank runs a Paladin node beside its validator and notarizes its deposit token as a Noto token. "
        "Northwind Freight's states live only on Bank A's node, Lakeside Steel's only on Bank B's; Bank C's node "
        "holds none of them. Bank A locks a burn, Bank B as notary locks a mint, both delegate their locks to "
        "ConfidentialSettlement, Bank B signs, and Bank A settles in one shared-ledger transaction that moves wCAD "
        "and spends both locks, or none. Validators see the wCAD leg in the clear, and for the deposits only state "
        "hashes and the notary's signature. A table compares what each participant could read in the baseline and "
        "in confidential mode, as pnpm confidential:compare measured it.",
    )
    header(d, "Who sees what, in confidential mode",
           "Deposits become Paladin Noto tokens, private to the bank that issues them; the wholesale leg stays public")
    nodes = [
        (24, 300, "Bank A", "Paladin node", "green",
         ("Northwind Freight's Noto states", "and balance, under a key the", "node derives for it"), "notary@bank-a"),
        (384, 192, "Bank C", "Paladin node", "slate", ("not a party: holds none", "of this payment's states"), None),
        (636, 300, "Bank B", "Paladin node", "green",
         ("Lakeside Steel's Noto states", "and balance, under a key the", "node derives for it"), "notary@bank-b"),
    ]
    for x, w, name, sub, fam, rows, notary in nodes:
        d.rect(x, 84, w, 140, f"{fam}-box" if fam != "slate" else "panel", 12)
        d.rich(x + 16, 110, [(name, f"{fam}-ink", "700"), (" · " + sub, "muted")], 15)
        if notary:
            cw_ = d.chip(x + 16, 118, notary, fam, 12.5, h=22, pad=7)
            d.text(x + 24 + cw_, 134, "checks every move", 13, "muted")
            d.rect(x + 16, 148, w - 32, 66, "card", 8)
            d.lines(x + 28, 168, rows, 13, 18, "", maxw=w - 56)
        else:
            d.lines(x + 16, 162, rows, 13, 18, "", maxw=w - 30)
    for x1, x2 in ((324, 384), (576, 636)):
        d.line(x1, 154, x2, 154, "rule-dash")
    d.text(480, 246, "nodes talk over mutual TLS; no private state crosses between banks", 13, "muted", "middle")

    # steps under the two banks
    for x, steps in ((40, ((1, "locks a burn of its customer's deposit"), (3, "delegates the lock to the contract"),
                           (5, "settles, in one transaction"))),
                     (652, ((2, "as notary, locks a mint to its payee"), (3, "delegates the lock to the contract"),
                            (4, "signs the payment (EIP-712)")))):
        for i, (n, t) in enumerate(steps):
            yy = 278 + i * 24
            d.badge(x + 10, yy - 4, n, "slate", r=9)
            d.text(x + 26, yy + 1, t, 13, "", maxw=262)

    # shared ledger
    d.rect(24, 350, 912, 210, "panel", 12)
    d.rich(126, 538, [("Shared ledger", "", "700"), ("  what every validator sees, the central bank's included",
                                                        "muted")], 15)
    d.rect(110, 378, 740, 132, "card", 10)
    d.arrow([(174, 334), (174, 374)], "slate")
    d.arrow([(786, 334), (786, 374)], "slate")
    d.text(126, 404, "ConfidentialSettlement", 13, "", "start", "700", mono=True)
    d.text(318, 404, "one transaction: wCAD moves and both locks are spent, or nothing", 13, "muted", maxw=520)
    rows = [("wCAD", "blue", "Bank A → Bank B  2,500.00", "in the clear"),
            ("burn lock", "green", "state hashes + notary@bank-a's signature", "no customer, no balance"),
            ("mint lock", "green", "state hashes + notary@bank-b's signature", "no customer, no balance")]
    for i, (lab, fam, what, note_) in enumerate(rows):
        yy = 422 + i * 28
        d.chip(126, yy, lab, fam, 12.5, mono=False, h=20, pad=6, weight="600")
        d.text(212, yy + 15, what, 13, "", mono=(fam == "blue"))
        d.text(834, yy + 15, note_, 13, f"{fam}-ink" if fam == "blue" else "muted", "end")

    # who sees what
    ty = 594
    d.text(24, ty, "WHO CAN READ THE PAYMENT", 12, "muted", "start", "700")
    d.text(24, ty + 18, "measured by pnpm confidential:compare", 13, "muted")
    cx = [(272, 264, "Baseline: plain deposit tokens"), (548, 388, "Confidential mode")]
    for x, w, t in cx:
        d.text(x + 12, ty + 12, t, 14, "", "start", "700")
    table = [
        ("Validators, central bank", "everything", ("amount (from the wholesale leg), wholesale", "slate")),
        ("Bank A, the payer's bank", "everything", ("its payer and the payer's balance, amount, wholesale", "green")),
        ("Bank B, the payee's bank", "everything", ("its payee and the payee's balance, amount, wholesale", "green")),
        ("Bank C, not a party", "everything", ("amount, wholesale", "slate")),
    ]
    for i, (who, base, (conf, fam)) in enumerate(table):
        ry = ty + 30 + i * 42
        d.text(24, ry + 24, who, 13, "", "start", "600")
        d.rect(272, ry, 264, 36, "red-box", 8)
        d.text(284, ry + 23, base, 13, "red-ink", "start", "600")
        d.rect(548, ry, 388, 36, f"{fam}-box" if fam != "slate" else "panel", 8)
        d.text(560, ry + 23, conf, 13, f"{fam}-ink" if fam != "slate" else "", maxw=368)
    d.text(24, ty + 214, "Everything: payer, payee, amount, both balances and the wholesale leg. The amount stays "
           "visible because the wholesale leg moves it in the clear.", 13, "muted", maxw=912)
    return d


# ---------------------------------------------------------------------------
# 8. conformance
# ---------------------------------------------------------------------------
def conformance():
    d = Doc(
        "conformance", W, 782,
        "The conformance kit",
        "Any settlement engine implements one adapter (reset, submit, observe, and optionally books and fault). "
        "The kit runs scripted flows with every fault and seeded random sequences, each on a fresh deployment, and "
        "judges nine checks drawn from the invariants: atomicity, exactly once, authority, eligibility, supply "
        "equals liability, liability conservation, books equal the ledger, FX consistency and repo collateral. "
        "A failing run is reported with its seed and shrunk to the smallest sequence that still fails. The "
        "sandbox's own engine passes every check; seven deliberately broken engines are each caught on the check "
        "named for them, and the HTLC and notary coordinators fail atomicity exactly where interop mode says.",
    )
    header(d, "Checking any engine against the same invariants",
           "One adapter, nine checks, and seven broken engines the kit must catch")
    boxes = [
        (24, 176, "Engine under test", None, ("the sandbox's own,", "or anyone else's"), False, "slate"),
        (226, 228, "Adapter", None, ("reset(scenario)", "submit(flow)", "observe(ledger, block)",
                                     "books(…)  fault(…)"), True, "violet"),
        (480, 210, "Runs", None, ("scripted: every flow", "and every fault", "seeded random sequences,",
                                  "each on a fresh deployment"), False, "slate"),
        (716, 220, "Report", None, ("pass or fail per check,", "with the seed; a failure", "shrunk to the smallest",
                                    "sequence that still fails"), False, "slate"),
    ]
    for x, w, title, sub, rows, mono, fam in boxes:
        d.rect(x, 84, w, 132, f"{fam}-box" if fam != "slate" else "card", 10)
        d.text(x + 14, 108, title, 15, f"{fam}-ink" if fam != "slate" else "", "start", "700")
        d.lines(x + 14, 132, rows, 13, 19, "" if not mono else "violet-ink", mono=mono, maxw=w - 24)
    for x1, x2 in ((200, 226), (454, 480), (690, 716)):
        d.arrow([(x1 + 2, 150), (x2 - 3, 150)], "slate")

    # the nine checks
    d.text(24, 250, "NINE CHECKS, FROM THE INVARIANTS", 12, "muted", "start", "700")
    checks = ["atomicity", "exactly once", "authority", "eligibility", "supply equals liability",
              "liability conservation", "books equal the ledger", "FX consistency", "repo collateral"]
    cx, cy = 24, 262
    for c in checks:
        w = text_width(c, 13, bold=True) + 22
        if cx + w > 936:
            cx, cy = 24, cy + 34
        d.chip(cx, cy, c, "blue", 13, mono=False, h=26, pad=11, weight="600")
        cx += w + 8

    # broken engines
    ty = 362
    d.text(24, ty, "PROOF IT CATCHES FAILURES", 12, "muted", "start", "700")
    d.text(24, ty + 26, "Engine", 13, "muted", "start", "700")
    d.text(232, ty + 26, "The change", 13, "muted", "start", "700")
    d.text(640, ty + 26, "Result", 13, "muted", "start", "700")
    rows = [
        ("sandbox engine", "the real contracts and every participant's runtime", None),
        ("split-legs", "each leg settled in a transaction of its own", "atomicity"),
        ("no-once", "no once-only check on the instruction id", "exactly once"),
        ("lax-mint", "a mint accepted without the issuer's approval", "authority"),
        ("open-deposit", "the deposit token admits anyone not blocked", "eligibility"),
        ("book-refused", "a payment booked although the chain refused it", "books equal the ledger"),
        ("round-fx-twice", "an FX leg rounded twice", "FX consistency"),
        ("repo-interest-360", "a repo's interest over a 360-day year", "repo collateral"),
        ("HTLC, notary 2PC", "interop mode's coordinators, across two ledgers", "atomicity*"),
    ]
    for i, (eng, change, caught) in enumerate(rows):
        ry = ty + 38 + i * 38
        ok = caught is None
        d.rect(24, ry, 912, 32, "green-box" if ok else "card", 8)
        d.text(38, ry + 21, eng, 13, "green-ink" if ok else "", "start", "700", mono=True, maxw=190)
        d.text(232, ry + 21, change, 13, "", maxw=396)
        if ok:
            d.text(640, ry + 21, "passes all nine, with every fault", 13, "green-ink", "start", "700")
        else:
            w = d.chip(640, ry + 4, "caught", "red", 12.5, mono=False, h=24, pad=8, weight="700")
            d.rich(640 + w + 10, ry + 21, [("by ", "muted"), (caught.replace("*", " *"), "", "600")], 13)
    d.text(24, ty + 38 + 9 * 38 + 14, "* exactly in the cases where interop mode leaves the two ledgers disagreeing, "
           "and nowhere else.", 13, "muted", maxw=912)
    return d


# ---------------------------------------------------------------------------
# 9. deployment
# ---------------------------------------------------------------------------
def deployment():
    d = Doc(
        "deployment", W, 766,
        "What runs, and on which open projects",
        "Each institution runs its own stack. The Central Bank and Banks A, B and C each run a participant service "
        "(Node 24, TypeScript, Fastify, viem) with a signer (a local key or AWS KMS), books in their own Postgres 17 "
        "schema with the reconciler, and a Hyperledger Besu 26.9.0 validator; each bank also runs a Paladin v1.0.0 "
        "node with Noto deposits for confidential mode. The four validators form the shared Besu QBFT ledger, which "
        "carries the SettlementEngine, ERC-7943 cash tokens and the project's own ERC-3643 bond, built on "
        "OpenZeppelin Contracts v5.7.0 and compiled with solc 0.8.37. Interop mode adds a second Besu network and "
        "a coordinator. Tooling: Docker Compose, Foundry, Anvil, vitest, the conformance kit, the Next.js 16 "
        "console and ISO 20022 XSD validation.",
    )
    header(d, "What runs, and on what",
           "Every institution runs its own stack; every piece is an open project, at the version the repo pins")
    insts = [("Central Bank", "blue"), ("Bank A", "green"), ("Bank B", "green"), ("Bank C", "green")]
    iw, gap = 172, 10
    top = 84
    for i, (name, fam) in enumerate(insts):
        x = 24 + i * (iw + gap)
        d.rect(x, top, iw, 330, f"{fam}-soft", 12)
        d.rect(x, top, iw, 330, f"{fam}-edge", 12)
        d.text(x + 12, top + 24, name, 15, f"{fam}-ink", "start", "700")
        cards = [
            ("Participant service", ("Node 24, TypeScript,", "Fastify, viem"), "card"),
            ("Signer", ("local key or AWS KMS",), "card"),
            ("Books + reconciler", ("Postgres 17 schema",), "card"),
            ("Paladin v1.0.0", ("Noto · confidential",), "dash") if name != "Central Bank"
            else ("No Paladin node", ("deploys its registry",), "none"),
            ("Besu 26.9.0", ("QBFT validator",), "besu"),
        ]
        cy = top + 38
        for title, rows, kind in cards:
            h = 30 + 17 * len(rows)
            if kind == "besu":
                d.rect(x + 10, cy, iw - 20, h, "slate-box", 8)
            elif kind == "dash":
                d.rect(x + 10, cy, iw - 20, h, "card", 8)
                d.rect(x + 10, cy, iw - 20, h, "slate-dash", 8)
            elif kind == "none":
                d.rect(x + 10, cy, iw - 20, h, "slate-dash", 8)
            else:
                d.rect(x + 10, cy, iw - 20, h, "card", 8)
            d.text(x + 22, cy + 20, title, 13, "muted" if kind == "none" else "", "start",
                   None if kind == "none" else "700", maxw=iw - 40)
            d.lines(x + 22, cy + 38, rows, 12.5, 17, "muted", maxw=iw - 40)
            cy += h + 8
        d.line(x + iw / 2, top + 330, x + iw / 2, 432, "muted-line")

    # shared ledger
    lx, lw, ly = 24, 718, 432
    d.rect(lx, ly, lw, 140, "panel", 12)
    d.rich(lx + 16, ly + 26, [("Shared ledger", "", "700"), ("  Hyperledger Besu 26.9.0 · QBFT · four validators · "
                                                           "final at commit", "muted")], 15)
    cx, cyy = lx + 16, ly + 40
    for label, fam in (("SettlementEngine", "slate"), ("ERC-7943 cash tokens", "blue"),
                       ("our own ERC-3643 bond", "amber"), ("ConditionalSettlement, interop", "slate"),
                       ("ConfidentialSettlement, confidential mode", "slate")):
        w = text_width(label, 13, bold=True) + 18
        if cx + w > lx + lw - 16:
            cx, cyy = lx + 16, cyy + 34
        d.chip(cx, cyy, label, fam, 13, mono=False, h=26, pad=9, weight="600")
        cx += w + 8
    d.text(lx + 16, ly + 124, "OpenZeppelin Contracts v5.7.0 · solc 0.8.37, Cancun · zero gas price; permissioned "
           "nodes and accounts", 13, "muted", maxw=lw - 32)

    # interop mode
    rx, rw = 760, 176
    d.rect(rx, top, rw, ly + 140 - top, "card", 12)
    d.rect(rx, top, rw, ly + 140 - top, "slate-dash", 12)
    d.text(rx + 14, top + 24, "Interop mode", 15, "", "start", "700")
    d.box(rx + 10, top + 40, rw - 20, 132, "slate", "Ledger 2", None,
          ("a second Besu 26.9.0", "network sharing nothing", "with ledger 1: its own", "validator, registry and",
           "ConditionalSettlement"), 12.5, 13, cls="slate-box", align="start", pad=12)
    d.box(rx + 10, ly + 16, rw - 20, 108, "slate", "Coordinator", None,
          ("unified, HTLC or", "notary 2PC, moving one", "payment across both"), 12.5, 13, cls="card",
          align="start", pad=12)
    d.arrow([(rx + rw / 2, ly + 16), (rx + rw / 2, top + 176)], "slate")
    d.arrow([(rx + 10, ly + 70), (lx + lw + 3, ly + 70)], "slate")

    # tooling
    ty = 602
    d.text(24, ty, "TOOLING", 12, "muted", "start", "700")
    tools = ["Docker Compose: networks, Paladin, Postgres", "Foundry: forge, solc 0.8.37", "Anvil: local chains for tests",
             "vitest", "conformance kit", "Next.js 16 console", "ISO 20022 XSD validation (xmllint-wasm)"]
    cx, cy = 24, ty + 12
    for t in tools:
        w = text_width(t, 13) + 20
        if cx + w > 936:
            cx, cy = 24, cy + 36
        d.chip(cx, cy, t, "slate", 13, mono=False, h=28, pad=10)
        cx += w + 8
    d.text(24, cy + 58, "In the sandbox one Postgres container holds every participant's books, each in a schema "
           "of its own.", 13, "muted", maxw=912)
    return d


DIAGRAMS = {
    "today-vs-unified": today_vs_unified,
    "architecture": architecture,
    "money-layers": money_layers,
    "payment-lifecycle": payment_lifecycle,
    "dvp-pvp-repo": dvp_pvp_repo,
    "interop-coordinators": interop_coordinators,
    "confidential": confidential,
    "conformance": conformance,
    "deployment": deployment,
}

if __name__ == "__main__":
    names = sys.argv[1:] or list(DIAGRAMS)
    for n in names:
        doc = DIAGRAMS[n]()
        for p in doc.save(OUT):
            print(p, os.path.getsize(p))

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Scenario } from "@oul/scenario";
import type { Network } from "./network.ts";

/**
 * A throwaway local chain for tests: Anvil from Foundry, with the sandbox's
 * chain id, zero base fee and zero gas price, mining on demand, or on a
 * timer for a test whose timeouts need the ledger's clock to move.
 */

export const TEST_CHAIN_ID = 20261;

export function anvilPath(): string | undefined {
  return [path.join(homedir(), ".foundry/bin/anvil"), "/usr/local/bin/anvil", "/opt/homebrew/bin/anvil"].find(existsSync);
}

export interface Anvil {
  readonly rpcUrl: string;
  stop(): void;
}

export function startAnvil(options: { chainId?: number; blockTimeSeconds?: number } = {}): Anvil {
  const binary = anvilPath();
  if (!binary) throw new Error("Anvil is not installed (https://getfoundry.sh)");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child: ChildProcess = spawn(
    binary,
    [
      "--port",
      String(port),
      "--chain-id",
      String(options.chainId ?? TEST_CHAIN_ID),
      ...(options.blockTimeSeconds ? ["--block-time", String(options.blockTimeSeconds)] : []),
      "--base-fee",
      "0",
      "--gas-price",
      "0",
      "--silent",
    ],
    { stdio: "ignore" },
  );
  return { rpcUrl: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

/** Every validator of the scenario pointing at one local node. */
export function localNetwork(scenario: Scenario, rpcUrl: string): Network {
  return {
    scenario: scenario.id,
    chainId: TEST_CHAIN_ID,
    nodes: scenario.participants
      .filter((p) => p.validator)
      .map((p) => ({
        participant: p.id,
        validator: "0x0000000000000000000000000000000000000000",
        rpcUrl,
        wsUrl: "",
        enode: "",
      })),
  };
}

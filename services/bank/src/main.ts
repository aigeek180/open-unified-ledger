/** A bank's service: OUL_PARTICIPANT=bank-a node services/bank/src/main.ts (see configFromEnv). */
import { runService } from "@oul/service";
import { bankRoutes } from "./routes.ts";

await runService("bank", bankRoutes);

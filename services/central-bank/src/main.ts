/** The central bank's service: OUL_PARTICIPANT=central-bank node services/central-bank/src/main.ts. */
import { runService } from "@oul/service";
import { centralBankRoutes } from "./routes.ts";

await runService("central-bank", centralBankRoutes);

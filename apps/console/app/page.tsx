import { redirect } from "next/navigation";
import { NoNetwork } from "@/components/no-network";
import { attempt, readNetwork } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Open on the central bank, the participant every other one settles through. */
export default async function Home() {
  const network = await attempt(readNetwork());
  if (!network.ok) return <NoNetwork error={network.error} />;
  const first = network.value.participants.find((p) => p.kind === "central-bank") ?? network.value.participants[0];
  redirect(`/p/${first?.id ?? network.value.self}`);
}

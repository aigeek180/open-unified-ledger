import { entryUrl } from "@/lib/services";

/** What a participant's view says when no service answers: how to start them. */
export function NoNetwork({ error }: { error: string }) {
  return (
    <section className="offline">
      <h1>No network to read</h1>
      <p>
        The console reads each participant's service, starting from <code>{entryUrl}</code>, which did not answer.
      </p>
      <p>Start the network and the services, then reload:</p>
      <pre>{"pnpm network:up\npnpm deploy ca-interbank\npnpm services:up ca-interbank"}</pre>
      <p>
        The Harness page starts services of its own in serve mode; the Interop page reads saved runs and needs no
        services.
      </p>
      <p className="offline-detail">{error}</p>
    </section>
  );
}

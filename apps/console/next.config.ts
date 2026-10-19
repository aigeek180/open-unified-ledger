import type { NextConfig } from "next";

const config: NextConfig = {
  // The console only reads the participants' services; it has no API of its own.
  poweredByHeader: false,
};

export default config;

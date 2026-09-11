import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  // Pliki czytane dynamicznie z dysku (fs) — Next nie wykryje ich sam, więc trzeba je dołączyć do funkcji na Vercelu.
  outputFileTracingIncludes: {
    '/api/**': ['./mailer/templates/**', './mailer/defaults.json', './benchmarks/*-v0.4.jsonl'],
  },
};

export default nextConfig;

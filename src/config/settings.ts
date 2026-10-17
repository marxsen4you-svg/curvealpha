/**
 * Infrastructure settings: endpoints, file locations, mode. Read once at
 * startup from environment variables (a .env file is supported by Node's
 * --env-file flag). Secrets come only from the environment and are never
 * written to logs, the database or the dashboard.
 */
export interface Settings {
  mode: "paper" | "live";
  rpcUrl: string;
  grpcEndpoint: string;
  grpcToken: string | undefined;
  blockEngineUrl: string;
  bamUrl: string | undefined;
  jitoAuthUuid: string | undefined;
  keypairPath: string | undefined;
  dataDir: string;
  dashboardHost: string;
  dashboardPort: number;
  xBearerToken: string | undefined;
  paperStartingSol: number;
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const mode = env.CURVEALPHA_MODE === "live" ? "live" : "paper";
  const s: Settings = {
    mode,
    rpcUrl: env.CURVEALPHA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    grpcEndpoint: env.CURVEALPHA_GRPC_ENDPOINT ?? "",
    grpcToken: env.CURVEALPHA_GRPC_TOKEN || undefined,
    blockEngineUrl: env.CURVEALPHA_BLOCK_ENGINE_URL ?? "https://mainnet.block-engine.jito.wtf",
    bamUrl: env.CURVEALPHA_BAM_URL || undefined,
    jitoAuthUuid: env.CURVEALPHA_JITO_UUID || undefined,
    keypairPath: env.CURVEALPHA_KEYPAIR || undefined,
    dataDir: env.CURVEALPHA_DATA_DIR ?? "data",
    dashboardHost: env.CURVEALPHA_DASHBOARD_HOST ?? "127.0.0.1",
    dashboardPort: Number(env.CURVEALPHA_DASHBOARD_PORT ?? 7420),
    xBearerToken: env.CURVEALPHA_X_BEARER || undefined,
    paperStartingSol: Number(env.CURVEALPHA_PAPER_SOL ?? 2),
  };
  return s;
}

/** Problems that must stop startup, in plain words. */
export function settingsProblems(s: Settings): string[] {
  const out: string[] = [];
  if (!s.grpcEndpoint) out.push("CURVEALPHA_GRPC_ENDPOINT is not set (a Yellowstone gRPC endpoint is required, even for paper trading)");
  if (s.mode === "live") {
    if (!s.keypairPath) out.push("live mode needs CURVEALPHA_KEYPAIR pointing to a local keypair file");
    if (s.rpcUrl.includes("api.mainnet-beta.solana.com")) out.push("live mode needs a private RPC (the public endpoint rate limits simulation and confirmation)");
  }
  if (!(s.paperStartingSol > 0)) out.push("CURVEALPHA_PAPER_SOL must be a positive number");
  if (s.dashboardHost !== "127.0.0.1" && s.dashboardHost !== "localhost") {
    out.push("the dashboard can edit live parameters; bind it to 127.0.0.1 and reach it through an SSH tunnel");
  }
  return out;
}

/** Settings as shown on the dashboard: secrets reduced to whether they are set. */
export function publicSettings(s: Settings): Record<string, string | number | boolean> {
  return {
    mode: s.mode,
    rpcUrl: redactUrl(s.rpcUrl),
    grpcEndpoint: redactUrl(s.grpcEndpoint),
    grpcToken: Boolean(s.grpcToken),
    blockEngineUrl: s.blockEngineUrl,
    bamUrl: s.bamUrl ? redactUrl(s.bamUrl) : false,
    jitoAuth: Boolean(s.jitoAuthUuid),
    keypair: Boolean(s.keypairPath),
    xApi: Boolean(s.xBearerToken),
    dataDir: s.dataDir,
  };
}

function redactUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}`;
  } catch {
    return u ? "(set)" : "";
  }
}

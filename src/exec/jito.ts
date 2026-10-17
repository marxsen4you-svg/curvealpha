/**
 * Jito Block Engine / BAM bundle client (JSON-RPC over HTTPS).
 *
 * Bundles of up to five signed transactions execute atomically and in order;
 * the tip is a SOL transfer inside the bundle and is paid only if it lands.
 * BAM Direct Bundle Ingest skips the Block Engine auction hop (~50 ms) but is
 * whitelist-only; when a BAM URL is configured and enabled it is tried first,
 * and the Block Engine is the fallback. Jito announced BAM nodes go into
 * maintenance in the days around Alpenglow activation, so the fallback is
 * not optional.
 */

export interface BundleClientOptions {
  blockEngineUrl: string;
  bamUrl?: string;
  authUuid?: string;
  fetchFn?: typeof fetch;
}

export type InflightStatus = "Invalid" | "Pending" | "Failed" | "Landed" | "Unknown";

export class BundleClient {
  private tipAccounts: string[] = [];
  private lastCallMs = 0;
  private f: typeof fetch;

  constructor(private o: BundleClientOptions) {
    this.f = o.fetchFn ?? fetch;
  }

  private async rpc<T>(base: string, path: string, method: string, params: unknown[]): Promise<T> {
    // the default limit is one request per second per IP per region
    const wait = this.lastCallMs + 1_050 - Date.now();
    if (wait > 0 && path !== "/api/v1/bundles") await new Promise((r) => setTimeout(r, wait));
    this.lastCallMs = Date.now();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.o.authUuid) headers["x-jito-auth"] = this.o.authUuid;
    const res = await this.f(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (!res.ok || body.error) throw new Error(`${method} failed: ${body.error?.message ?? res.status}`);
    return body.result as T;
  }

  async getTipAccounts(): Promise<string[]> {
    if (this.tipAccounts.length === 0) {
      this.tipAccounts = await this.rpc<string[]>(this.o.blockEngineUrl, "/api/v1/getTipAccounts", "getTipAccounts", []);
    }
    return this.tipAccounts;
  }

  /** A random tip account, so concurrent bundles do not contend for one write lock. */
  async randomTipAccount(rand = Math.random): Promise<string> {
    const a = await this.getTipAccounts();
    if (a.length === 0) throw new Error("no Jito tip accounts");
    return a[Math.floor(rand() * a.length)]!;
  }

  /** Send base64 transactions as one bundle; returns the bundle id and the route used. */
  async sendBundle(txsBase64: string[], useBam: boolean): Promise<{ bundleId: string; route: "bam" | "block-engine" }> {
    if (txsBase64.length === 0 || txsBase64.length > 5) throw new Error("a bundle holds 1 to 5 transactions");
    const params = [txsBase64, { encoding: "base64" }];
    if (useBam && this.o.bamUrl) {
      try {
        const id = await this.rpc<string>(this.o.bamUrl, "/api/v1/bundles", "sendBundle", params);
        return { bundleId: id, route: "bam" };
      } catch {
        /* fall through to the Block Engine */
      }
    }
    const id = await this.rpc<string>(this.o.blockEngineUrl, "/api/v1/bundles", "sendBundle", params);
    return { bundleId: id, route: "block-engine" };
  }

  async inflightStatus(bundleId: string): Promise<{ status: InflightStatus; landedSlot: number | null }> {
    const r = await this.rpc<{ value: Array<{ bundle_id: string; status: InflightStatus; landed_slot: number | null }> }>(
      this.o.blockEngineUrl,
      "/api/v1/getInflightBundleStatuses",
      "getInflightBundleStatuses",
      [[bundleId]],
    );
    const v = r?.value?.[0];
    return v ? { status: v.status, landedSlot: v.landed_slot } : { status: "Unknown", landedSlot: null };
  }
}

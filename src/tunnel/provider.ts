import type { TransportProviderName } from "../runtime/state.js";

export interface TunnelStartContext {
  localPort: number;
  localEndpoint: string;
  workspace: string;
  instanceName: string;
  openaiTunnelId?: string;
  cloudflareManagement?: "remote" | "local";
  cloudflareTunnelToken?: string;
  cloudflareTunnel?: string;
  cloudflareHostname?: string;
  cloudflareConfigPath?: string;
  cloudflareCredentialsFile?: string;
}

export interface TunnelProcess {
  provider: TransportProviderName;
  pid: number;
  baseUrl?: string;
  healthUrl?: string;
  tunnelId?: string;
  logPath: string;
  executablePath: string;
  executableSource: "path" | "cache" | "download";
  executableVersion: string;
}

export interface TunnelProvider {
  readonly name: TransportProviderName;
  isAvailable(context?: TunnelStartContext): Promise<boolean>;
  start(context: TunnelStartContext): Promise<TunnelProcess>;
  healthCheck(process: TunnelProcess): Promise<boolean>;
  stop(process: TunnelProcess): Promise<void>;
}

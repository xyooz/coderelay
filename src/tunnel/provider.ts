export interface TunnelProcess {
  pid: number;
  baseUrl: string;
  logPath: string;
  executablePath: string;
  executableSource: "path" | "cache" | "download";
  executableVersion: string;
}

export interface TunnelProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  start(localPort: number): Promise<TunnelProcess>;
  healthCheck(baseUrl: string): Promise<boolean>;
  stop(pid: number): Promise<void>;
}

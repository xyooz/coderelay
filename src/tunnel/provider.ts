export interface TunnelProcess {
  pid: number;
  baseUrl: string;
  logPath: string;
}

export interface TunnelProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  start(localPort: number): Promise<TunnelProcess>;
  healthCheck(baseUrl: string): Promise<boolean>;
  stop(pid: number): Promise<void>;
}

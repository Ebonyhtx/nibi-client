export interface HelloMessage {
  type: "nibi-hello";
  version: string;
  platform: string;
  arch: string;
  pid: number;
}

export interface HelloAckMessage {
  type: "nibi-hello-ack";
  version: string;
  clientId: string;
}

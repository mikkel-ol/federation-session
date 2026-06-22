export interface BaseSchema {
  target: string;
}

export interface HostSchema extends BaseSchema {
  yatsiServerUrl: string;
  capacity?: number;
  gatewayPort?: number;
  open?: boolean;
  panel?: boolean;
}

export interface RemoteSchema extends BaseSchema {
  remoteName: string;
  sessionUrl: string;
}

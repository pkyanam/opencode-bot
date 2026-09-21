export interface Ownership {
  state: Record<string, any>;
  resources: Record<string, any>;
  workerName: string;
  bucketName: string;
  accountId: string;
  workerOwned?: boolean;
  alreadyUninstalled?: boolean;
}
export function readOwnership(options: any): Ownership;
export function uninstallPlan(ownership: Ownership, options?: any): Record<string, any>;
export function uninstallResources(options: any): Promise<void>;

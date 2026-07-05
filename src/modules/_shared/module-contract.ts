export type ModuleStatus = "active" | "experimental" | "deprecated";

export type ModuleApiContract = {
  openApiPath: string;
  basePath: string;
};

export type ModuleEventContract = {
  asyncApiPath?: string;
  publishes?: string[];
  subscribes?: string[];
};

export type ModuleDescriptor = {
  key: string;
  name: string;
  version: string;
  status: ModuleStatus;
  description: string;
  dependencies: string[];
  api?: ModuleApiContract;
  events?: ModuleEventContract;
};

export function defineModule(descriptor: ModuleDescriptor): ModuleDescriptor {
  return descriptor;
}

import { GatewayError } from "../core/errors.js";
import type { ModelProvider } from "./provider.js";

export interface ModelDeployment {
  id: string;
  logicalModel: string;
  provider: ModelProvider;
  priority: number;
  weight: number;
}

export class ProviderRegistry {
  private readonly deployments = new Map<string, ModelDeployment[]>();

  register(
    logicalModel: string,
    provider: ModelProvider,
    options: { id?: string; priority?: number; weight?: number } = {},
  ): void {
    const deployment: ModelDeployment = {
      id: options.id ?? provider.id,
      logicalModel,
      provider,
      priority: options.priority ?? 100,
      weight: options.weight ?? 1,
    };
    if (deployment.priority < 0 || !Number.isSafeInteger(deployment.priority)) {
      throw new Error("Deployment priority must be a non-negative integer");
    }
    if (deployment.weight <= 0 || !Number.isSafeInteger(deployment.weight)) {
      throw new Error("Deployment weight must be a positive integer");
    }
    const current = this.deployments.get(logicalModel) ?? [];
    if (current.some((item) => item.id === deployment.id)) {
      throw new Error(`Deployment id '${deployment.id}' is already registered for '${logicalModel}'`);
    }
    this.deployments.set(logicalModel, [...current, deployment]);
  }

  upsert(
    logicalModel: string,
    provider: ModelProvider,
    options: { id: string; priority?: number; weight?: number },
  ): void {
    this.remove(options.id);
    this.register(logicalModel, provider, options);
  }

  remove(deploymentId: string): void {
    for (const [model, items] of this.deployments.entries()) {
      const next = items.filter((item) => item.id !== deploymentId);
      if (next.length === 0) this.deployments.delete(model);
      else if (next.length !== items.length) this.deployments.set(model, next);
    }
  }

  resolve(logicalModel: string): ModelDeployment {
    return this.getDeployments(logicalModel)[0] as ModelDeployment;
  }

  getDeployments(logicalModel: string): readonly ModelDeployment[] {
    const deployments = this.deployments.get(logicalModel);
    if (!deployments || deployments.length === 0) {
      throw new GatewayError({
        message: `The model '${logicalModel}' does not exist or is not accessible`,
        statusCode: 404,
        code: "model_not_found",
      });
    }
    return deployments;
  }

  listModels(): string[] {
    return [...this.deployments.keys()].sort();
  }
}

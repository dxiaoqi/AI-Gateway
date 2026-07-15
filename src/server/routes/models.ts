import type { FastifyInstance } from "fastify";
import type { AuthService } from "../../auth/service.js";
import type { ProviderRegistry } from "../../providers/registry.js";

interface ModelRouteDependencies {
  authService: AuthService;
  registry: ProviderRegistry;
}

export const registerModelRoutes = async (
  app: FastifyInstance,
  dependencies: ModelRouteDependencies,
): Promise<void> => {
  app.get("/v1/models", async (request) => {
    const context = request.authContext;
    if (!context) throw new Error("Authenticated request context is missing");

    const models = dependencies.registry
      .listModels()
      .filter((model) => dependencies.authService.canAccessModel(context, model));

    return {
      object: "list",
      data: models.map((model) => ({
        id: model,
        object: "model",
        created: 0,
        owned_by: "enterprise-ai-gateway",
      })),
    };
  });
};

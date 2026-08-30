import { ProviderCatalog } from "../../../shared/types";

export const testCatalog = {
  version: 1,
  updated_at: "2026-08-25T00:00:00.000Z",
  providers: [
    {
      id: "fixture-official",
      title: "Fixture Provider",
      description: "Provider metadata used by tests",
      locked: true,
      provider_id: "fixture-provider",
      provider_name: "Fixture Provider",
      base_url: "https://provider.invalid/",
      wire_api: "responses",
      auth: {
        type: "bearer_token",
        config_key: "experimental_bearer_token",
      },
      default_model: "fixture-fast",
      models: [
        {
          slug: "fixture-fast",
          display_name: "Fixture Fast",
          description: "速度优先的官方 Responses 模型",
          context_window: 1048576,
          default_reasoning_level: "high",
          model_messages: {
            base_instructions: "from-test-fixture",
          },
        },
        {
          slug: "fixture-pro",
          display_name: "Fixture Pro",
          description: "复杂任务优先的官方 Responses 模型",
          context_window: 1048576,
          default_reasoning_level: "high",
        },
      ],
      editable_fields: ["apiKey", "model"],
    },
  ],
} satisfies ProviderCatalog;

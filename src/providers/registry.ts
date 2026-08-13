export interface ProviderDescriptor {
  id: string;
  label: string;
  authMethod: "access-key" | "api-key" | "env";
}

export const PROVIDERS: ProviderDescriptor[] = [
  { id: "aws", label: "Amazon Web Services", authMethod: "access-key" },
  { id: "datadog", label: "Datadog", authMethod: "api-key" },
  { id: "env", label: "Local environment variables", authMethod: "env" },
];

export function findProvider(id: string): ProviderDescriptor | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

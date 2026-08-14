export interface ProviderDescriptor {
  id: string;
  label: string;
  authMethod: "access-key" | "api-key";
}

export const PROVIDERS: ProviderDescriptor[] = [
  { id: "aws", label: "Amazon Web Services", authMethod: "access-key" },
  { id: "datadog", label: "Datadog", authMethod: "api-key" },
];

export function findProvider(id: string): ProviderDescriptor | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

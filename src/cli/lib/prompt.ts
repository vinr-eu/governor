import prompts from "prompts";

export async function promptPassword(message: string): Promise<string> {
  const { password } = await prompts({
    type: "password",
    name: "password",
    message,
  });
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("Password is required.");
  }
  return password;
}

export async function promptText(message: string): Promise<string> {
  const { value } = await prompts({
    type: "text",
    name: "value",
    message,
  });
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("A value is required.");
  }
  return value;
}

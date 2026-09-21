import * as SecureStore from "expo-secure-store";
const TOKEN_KEY = "opencode-bot.device-token";
const CONNECTION_KEY = "opencode-bot.connection";
export type StoredConnection = { baseUrl: string; token: string };
export const readToken = () => SecureStore.getItemAsync(TOKEN_KEY);
export const saveToken = (token: string) =>
  SecureStore.setItemAsync(TOKEN_KEY, token);
export const clearToken = () => SecureStore.deleteItemAsync(TOKEN_KEY);

/** Read the URL and credential as one persisted record. */
export async function readConnection(): Promise<StoredConnection | null> {
  const raw = await SecureStore.getItemAsync(CONNECTION_KEY);
  if (raw) {
    try {
      const value = JSON.parse(raw) as Partial<StoredConnection>;
      if (typeof value.baseUrl === "string" && typeof value.token === "string" && value.baseUrl && value.token)
        return { baseUrl: value.baseUrl, token: value.token };
    } catch { /* recover through the legacy token migration below */ }
  }
  const token = (await readToken())?.trim() ?? "";
  return token ? null : null;
}

/** Persist both connection fields in one SecureStore write. */
export function saveConnection(connection: StoredConnection) {
  return SecureStore.setItemAsync(CONNECTION_KEY, JSON.stringify(connection));
}

export async function clearConnection() {
  await Promise.all([SecureStore.deleteItemAsync(CONNECTION_KEY), clearToken()]);
}
